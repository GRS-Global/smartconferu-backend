import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Reads a conference website as text for "Fill from website": the home page, the pages its menu
 * points to, fragments it loads itself and, on script-built sites, the text inside its JavaScript.
 * Emails are pulled out up front with the words before each one. Only public http(s) addresses are
 * fetched (no localhost or private networks, also through DNS or redirects). Ported from the app's
 * src/shared/conferenceAiRequest.js.
 */

const PAGE_TIMEOUT_MS = 8000;
const PAGE_BYTE_LIMIT = 1_500_000;
const SCRIPT_BYTE_LIMIT = 4_000_000;
const MAX_SCRIPTS = 2;
const MAIN_TEXT_LIMIT = 16_000;
const SUBPAGE_TEXT_LIMIT = 7000;
const MAX_SUBPAGES = 4;
const MAX_REDIRECTS = 3;

/** A failure to show the chair as is (unreachable, not public, not a page…). */
export class WebsiteError extends Error {}

interface Page {
  url: URL;
  html: string;
}

// ---------- safe fetching ----------

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) {
      return isPrivateIp(v.slice(7));
    }
    return (
      v === '::' ||
      v === '::1' ||
      v.startsWith('fc') ||
      v.startsWith('fd') ||
      v.startsWith('fe80')
    );
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Blocks requests to localhost / private networks (SSRF), including via DNS names that resolve there. */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (!/^https?:$/.test(url.protocol)) {
    throw new WebsiteError('Only http and https websites are supported.');
  }
  if (url.username || url.password) {
    throw new WebsiteError("That address isn't supported.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$|\.localhost$/i.test(host)) {
    throw new WebsiteError("That address isn't a public website.");
  }
  const addrs = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) {
    throw new WebsiteError("We couldn't find that website. Check the address.");
  }
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new WebsiteError("That address isn't a public website.");
  }
}

/** `script: true` fetches one of the site's own JavaScript files instead of a page. */
async function fetchPage(
  rawUrl: string,
  { script = false } = {},
): Promise<Page> {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: {
        'user-agent': 'SmartconferuBot/1.0 (+conference auto-fill)',
        accept: script
          ? 'application/javascript,text/javascript,*/*'
          : 'text/html,application/xhtml+xml',
      },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) {
      throw new WebsiteError(`The website answered with HTTP ${res.status}.`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (
      script
        ? !/javascript|ecmascript/i.test(type)
        : !/html|xml|text\/plain/i.test(type)
    ) {
      throw new WebsiteError("That address isn't a web page.");
    }
    // At most PAGE_BYTE_LIMIT bytes (more for a script bundle: emails can sit near its end).
    const limit = script ? SCRIPT_BYTE_LIMIT : PAGE_BYTE_LIMIT;
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => undefined);
    return { url, html: new TextDecoder().decode(Buffer.concat(chunks)) };
  }
  throw new WebsiteError('The website redirected too many times.');
}

// ---------- HTML → text ----------

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 16)),
    );

// ---------- emails ----------

/** Cloudflare "email protection": hex string, first byte is the XOR key. */
function decodeCfEmail(hex: string): string {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * ROT13-scrambled addresses (Sciencesconf and others), decoded only when the result clearly is the
 * real one: it ends in a common TLD and the scrambled form doesn't.
 */
const COMMON_TLDS = new Set(
  'com org net edu gov int info io co ac in uk us de fr es it nl be ch at se no dk fi pl pt ie cz gr ru cn jp kr tw hk sg my th id vn ph au nz ca mx br ar cl za ng ke eg ma tn dz sa ae qa tr ir pk bd lk np'.split(
    ' ',
  ),
);
const rot13 = (s: string) =>
  s.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });

export function unscrambleEmail(email: string): string {
  const tld = (e: string) => (e.split('.').pop() ?? '').toLowerCase();
  const flipped = rot13(email);
  return !COMMON_TLDS.has(tld(email)) && COMMON_TLDS.has(tld(flipped))
    ? flipped
    : email;
}

/** Puts the real address back where a page hides it, so it survives the HTML → text step. */
function revealEmails(html: string): string {
  return (
    html
      // An address handed to a script that fills in the link next to it. Scripts are dropped
      // later, so this comes first.
      .replace(
        /<script\b[^>]*>([^<]*?)<\/script>(\s*<a\b[^>]*>([\s\S]*?)<\/a>)?/gi,
        (
          whole: string,
          code: string,
          _a: string,
          label: string | undefined,
        ) => {
          const found =
            /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i.exec(code);
          if (!found) {
            return whole;
          }
          const text = label
            ? label
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/^\s*@\s*/, '')
                .trim()
            : '';
          return ` ${text} (${unscrambleEmail(found[0])}) `;
        },
      )
      .replace(
        /<(a|span)\b[^>]*data-cfemail\s*=\s*["']([0-9a-f]+)["'][^>]*>[\s\S]*?<\/\1>/gi,
        (_: string, _t: string, hex: string) => ` ${decodeCfEmail(hex)} `,
      )
      .replace(
        /<a\b[^>]*href\s*=\s*["'][^"']*email-protection#([0-9a-f]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_: string, hex: string, label: string) =>
          ` ${label} (${decodeCfEmail(hex)}) `,
      )
      // <a href="mailto:x">Email us</a> → "Email us (x)": the label alone would lose the address.
      .replace(
        /<a\b[^>]*href\s*=\s*["']mailto:([^"'?]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_: string, addr: string, label: string) =>
          ` ${label} (${unscrambleEmail(safeDecode(addr).trim())}) `,
      )
  );
}

/** "info [at] conf [dot] org" / "info(at)conf.org" → info@conf.org */
const deobfuscateEmails = (text: string) =>
  text.replace(
    /\b([a-z0-9._%+-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|\s+at\s+)\s*([a-z0-9-]+(?:\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\.)\s*[a-z0-9-]+)+)/gi,
    (m: string, user: string, domain: string) =>
      /\[|\(|\{/.test(m) || /\bdot\b/i.test(m)
        ? `${user}@${domain.replace(/\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\.)\s*/gi, '.')}`
        : m,
  );

const EMAIL_RX = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
/** Image names (logo@2x.png), placeholders and site-builder / tracking addresses. */
const JUNK_EMAIL =
  /\.(png|jpe?g|gif|svg|webp|css|js)$|@(example|domain|email|yourdomain|sentry[\w.-]*|wixpress|sentry)\.|^(user|name|your|you|email|someone)@/i;

function emailsWithContext(text: string): string[] {
  const found = new Map<string, string>();
  for (const m of text.matchAll(EMAIL_RX)) {
    const email = m[0].replace(/\.$/, '').toLowerCase();
    if (JUNK_EMAIL.test(email) || found.has(email)) {
      continue;
    }
    const before = text
      .slice(Math.max(0, m.index - 90), m.index)
      .replace(/\s+/g, ' ')
      .trim();
    found.set(email, before);
  }
  return [...found.entries()]
    .slice(0, 15)
    .map(([email, before]) =>
      before ? `${email} (preceded by: "…${before}")` : email,
    );
}

export function pageToText(rawHtml: string): string {
  const html = revealEmails(rawHtml);
  const meta: string[] = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title) {
    meta.push(`Page title: ${title.trim()}`);
  }
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const name = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (
      name &&
      content &&
      /description|og:title|og:site_name|og:description/i.test(name)
    ) {
      meta.push(`${name}: ${content}`);
    }
  }
  // schema.org Event data is the most reliable source of dates and location when present.
  for (const m of html.matchAll(
    /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    meta.push(`Structured data: ${m[1].trim().slice(0, 3000)}`);
  }
  const body = html
    .replace(
      /<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi,
      ' ',
    )
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/header|\/footer)[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, ' ');
  const text = deobfuscateEmails(
    decodeEntities(body)
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim(),
  );
  // Listed before the body text so the cut-off never drops them.
  const emails = emailsWithContext(text);
  if (emails.length) {
    meta.push(
      `Emails on this page:\n${emails.map((e) => `- ${e}`).join('\n')}`,
    );
  }
  return `${meta.map(decodeEntities).join('\n')}\n\n${text}`;
}

// ---------- emails inside a script-built site ----------

const CHUNK_PRIORITY = [
  /contact|support|help|enquir|quer/i,
  /footer|layout|legal|imprint|about|site|config|settings/i,
];
const MAX_CHUNKS = 3;

async function fetchScripts(urls: readonly URL[]): Promise<Page[]> {
  const results = await Promise.allSettled(
    urls.map((u) => fetchPage(u.href, { script: true })),
  );
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

function emailsInScripts(scripts: readonly Page[], found: Map<string, string>) {
  for (const { html: js } of scripts) {
    for (const m of js.matchAll(EMAIL_RX)) {
      const email = m[0].toLowerCase();
      if (JUNK_EMAIL.test(email) || found.has(email)) {
        continue;
      }
      // Minified code around it: keep only word-ish text so the label shows.
      const before = js
        .slice(Math.max(0, m.index - 160), m.index)
        .replace(/[^A-Za-z&' ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(-90);
      found.set(email, before);
    }
  }
}

/** Lazy chunk files a bundle refers to ("./ContactUs-x1y2.js"), contact pages first. */
function pickChunks(scripts: readonly Page[], base: URL): URL[] {
  const seen = new Set(scripts.map((s) => s.url.href));
  const picks: { u: URL; rank: number; order: number }[] = [];
  for (const { url: scriptUrl, html: js } of scripts) {
    for (const m of js.matchAll(
      /["'`]((?:\.{1,2}\/|\/)?[\w./-]*?([\w-]+)\.m?js)["'`]/g,
    )) {
      const rank = CHUNK_PRIORITY.findIndex((rx) => rx.test(m[2]));
      if (rank === -1) {
        continue;
      }
      let u: URL;
      try {
        u = new URL(
          m[1],
          /^\.{1,2}\//.test(m[1]) ? scriptUrl : new URL('/', base),
        );
      } catch {
        continue;
      }
      if (u.host !== base.host || seen.has(u.href)) {
        continue;
      }
      seen.add(u.href);
      picks.push({ u, rank, order: picks.length });
    }
  }
  return picks
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_CHUNKS)
    .map((p) => p.u);
}

const sameHostUrl = (raw: string, base: URL): URL | null => {
  try {
    const u = new URL(raw, base);
    return u.host === base.host && /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
};

async function scriptEmails(html: string, base: URL): Promise<string[]> {
  const srcs = [
    ...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi),
  ]
    .map((m) => sameHostUrl(m[1], base))
    .filter((u): u is URL => u !== null)
    .slice(0, MAX_SCRIPTS);
  const found = new Map<string, string>();
  const bundles = await fetchScripts(srcs);
  emailsInScripts(bundles, found);
  // Nothing in the main bundle: open the contact / footer chunks it points to.
  if (found.size === 0) {
    emailsInScripts(await fetchScripts(pickChunks(bundles, base)), found);
  }
  return [...found.entries()]
    .slice(0, 15)
    .map(([email, before]) =>
      before ? `- ${email} (preceded by: "…${before}")` : `- ${email}`,
    );
}

// ---------- the whole site, not just the home page ----------

const THIN_PAGE_CHARS = 700;
const MAX_FRAGMENTS = 4;
const MAX_PAGE_CHUNKS = 8;
const MAX_ENTRY_SCRIPTS = 3;
const MORE_PAGES = 6;
const CHUNK_TEXT_LIMIT = 6500;
const FRAGMENT_HINT =
  /head|foot|menu|nav|contact|venue|about|date|info|include|side|top|bottom|banner/i;
const NAV_NOISE =
  /login|log-in|sign|admin|cart|checkout|privacy|policy|terms|cookie|gallery|photo|video|press|news|blog|sitemap|download|faq|sponsor/i;

const visibleTextLength = (html: string) =>
  html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;

/** Fragments a page loads into itself: jQuery .load(), fetch(), $.get(), data-include… */
function fragmentUrls(html: string, base: URL): string[] {
  const found = new Set<string>();
  const add = (raw: string | undefined) => {
    if (
      !raw ||
      /[{}$`]/.test(raw) ||
      !/\.(html?|php|inc|asp|aspx|jsp)(\?|$)/i.test(raw) ||
      !FRAGMENT_HINT.test(raw)
    ) {
      return;
    }
    const u = sameHostUrl(raw, base);
    if (u) {
      found.add(u.href);
    }
  };
  for (const m of html.matchAll(
    /(?:\.load|\.get|\.getJSON|\.ajax|fetch)\s*\(\s*\{?\s*(?:url\s*:\s*)?["']([^"']+)["']/gi,
  )) {
    add(m[1]);
  }
  for (const m of html.matchAll(
    /(?:data-include|w3-include-html|data-src|data-load)\s*=\s*["']([^"']+)["']/gi,
  )) {
    add(m[1]);
  }
  return [...found].slice(0, MAX_FRAGMENTS);
}

/** Which pages usually hold what the form needs, most likely first. */
const PAGE_RANK = [
  /contact|support|help|enquir|quer|reach/i,
  /date|deadline|call.?for.?paper|cfp|important|schedule|submission/i,
  /venue|location|where|travel|accommodation|hotel|map/i,
  /about|overview|scope|topic|track|theme|info|welcome/i,
  /regist|fee|pricing/i,
];
const pageRank = (text: string) => {
  const i = PAGE_RANK.findIndex((rx) => rx.test(text));
  return i === -1 ? PAGE_RANK.length : i;
};

/** Every same-site page the menu links to, ranked; pages that can't hold conference facts are left out. */
function rankedLinks(html: string, base: URL, skip: Set<string>): URL[] {
  const seen = new Set(skip);
  const out: { link: URL; rank: number; order: number }[] = [];
  for (const m of html.matchAll(
    /<a\s[^>]*href\s*=\s*["']?([^"'\s>#]+)[^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    let link: URL;
    try {
      link = new URL(m[1], base);
    } catch {
      continue;
    }
    const label = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (
      link.host !== base.host ||
      !/^https?:$/.test(link.protocol) ||
      /\.(pdf|docx?|xlsx?|zip|jpe?g|png|gif|svg|mp4|css|js)$/i.test(
        link.pathname,
      )
    ) {
      continue;
    }
    const key = link.origin + link.pathname + link.search;
    const hint = `${label} ${link.pathname}`;
    if (seen.has(key) || link.pathname === '/' || NAV_NOISE.test(hint)) {
      continue;
    }
    seen.add(key);
    out.push({ link, rank: pageRank(hint), order: out.length });
  }
  return out
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((c) => c.link);
}

// ---- script-built sites ----

const LITERAL_RX =
  /(?:([A-Za-z_$][\w$]{2,24})\s*:\s*)?(`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
const UTILITY_CLASS =
  /(?:^|[\s:])(?:flex|grid|absolute|relative|fixed|hidden|block|inline|overflow|rounded|border|shadow|blur|opacity|transition|duration|ease|items|justify|gap|space|font|leading|tracking|uppercase|truncate|container|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|bg|text|w|h|z|top|left|right|bottom|inset|min|max|col|row|from|to|via|hover|focus|group|md|lg|xl|sm|dark)(?:[-:/[]|$)/;
const FIELD_KEY =
  /^(name|title|heading|subtitle|label|value|text|description|address|street\w*|locality|region|postal\w*|country|city|state|email|mail|phone|tele\w*|date|start\w*|end\w*|when|where|time|location|venue|hotel|place)$/i;
const CODE_WORDS =
  /=>|[{};]|\bfunction\b|\breturn\b|\.jsx?\b|\bvoid 0\b|\bprototype\b/;

function usefulLiteral(s: string): boolean {
  if (
    s.length < 3 ||
    s.length > 700 ||
    !/[A-Za-z]/.test(s) ||
    CODE_WORDS.test(s)
  ) {
    return false;
  }
  if (/^(https?:)?\/\/|^[./]/.test(s) && !/@/.test(s)) {
    return false;
  }
  if (UTILITY_CLASS.test(s) && !/[.!?]\s/.test(s)) {
    return false;
  }
  if (/\s/.test(s)) {
    return /[A-Za-z]{2}/.test(s);
  }
  return (
    /@/.test(s) ||
    /^[A-Z][A-Za-z]{3,}$/.test(s) ||
    /^\d{1,2}(st|nd|rd|th)?[-–]\d{1,2}$/.test(s)
  );
}

/**
 * Readable text out of a JS file: string and template literals that look like words, with a
 * field's name in front when it has one (`name: Hotel X`). Class names, paths and code are dropped.
 */
export function textLiterals(js: string, limit = CHUNK_TEXT_LIMIT): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  let size = 0;
  for (const m of js.matchAll(LITERAL_RX)) {
    const s = m[2]
      .slice(1, -1)
      .replace(/\\n/g, ' ')
      .replace(/\\(["'`\\])/g, '$1')
      .replace(/\$\{[^}]*\}/g, ' … ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!usefulLiteral(s) || seen.has(s)) {
      continue;
    }
    seen.add(s);
    const line = m[1] && FIELD_KEY.test(m[1]) ? `${m[1]}: ${s}` : s;
    size += line.length + 1;
    if (size > limit) {
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const VENDOR_CHUNK =
  /vendor|runtime|react|router|helmet|jsx-runtime|framer|motion|lodash|axios|polyfill|chunk-|index-[\w-]*\.css|icon|arrow|chevron|lucide|^api|registrationapi|admin|editor|login|notfound|auth|dashboard|payment|legal|terms|policy|participation|guideline|gallery|join/i;
const CHUNK_RANK = [/^(home|index|landing|main|app)\b/i, ...PAGE_RANK];
const chunkRank = (name: string) => {
  const i = CHUNK_RANK.findIndex((rx) => rx.test(name));
  return i === -1 ? CHUNK_RANK.length : i;
};

/** The per-page JS files a bundler left a name for ("assets/Venue-UgJ3xK1z.js"), best pages first. */
function chunkUrls(entries: readonly Page[], base: URL) {
  const seen = new Set(entries.map((e) => e.url.href));
  const found: { u: URL; name: string; rank: number; order: number }[] = [];
  for (const { url: entryUrl, html: js } of entries) {
    for (const m of js.matchAll(
      /["'`]((?:\.{1,2}\/)?(?:[\w.-]+\/)*([A-Za-z][\w]*?)-[\w-]{6,12}\.m?js)["'`]/g,
    )) {
      const [, path, name] = m;
      if (VENDOR_CHUNK.test(name)) {
        continue;
      }
      let u: URL;
      try {
        u = new URL(
          path,
          /^\.{1,2}\//.test(path) ? entryUrl : new URL('/', base),
        );
      } catch {
        continue;
      }
      if (u.host !== base.host || seen.has(u.href)) {
        continue;
      }
      seen.add(u.href);
      found.push({ u, name, rank: chunkRank(name), order: found.length });
    }
  }
  return found.sort((a, b) => a.rank - b.rank || a.order - b.order);
}

async function entryScripts(html: string, base: URL): Promise<Page[]> {
  const srcs = [
    ...html.matchAll(
      /<(?:script\b[^>]*\bsrc|link\b[^>]*\bhref)\s*=\s*["']([^"']+\.m?js[^"']*)["']/gi,
    ),
  ]
    .map((m) => sameHostUrl(m[1], base))
    .filter(
      (u): u is URL =>
        u !== null && !VENDOR_CHUNK.test(u.pathname.split('/').pop() ?? ''),
    )
    .slice(0, MAX_ENTRY_SCRIPTS);
  return fetchScripts([...new Map(srcs.map((u) => [u.href, u])).values()]);
}

const sectionOf = (url: string, text: string, limit: number) =>
  `=== ${url} ===\n${text.slice(0, limit)}`;

/** A page the first read left out, opened only when a key field is still empty. */
export type ExtraPage =
  { kind: 'page'; url: URL } | { kind: 'script'; url: URL; name: string };

export async function readWebsite(
  rawUrl: string,
): Promise<{ text: string; extra: ExtraPage[] }> {
  const main = await fetchPage(rawUrl);
  const read = new Set([main.url.origin + main.url.pathname + main.url.search]);
  // 1. whatever the page pulls in by itself (menu, footer), read as part of the page
  const fragments = await Promise.allSettled(
    fragmentUrls(main.html, main.url).map((u) => fetchPage(u)),
  );
  const fragmentHtml = fragments
    .flatMap((f) => (f.status === 'fulfilled' ? [f.value.html] : []))
    .join('\n');
  const allHtml = `${main.html}\n${fragmentHtml}`;
  const parts = [
    sectionOf(main.url.href, pageToText(allHtml), MAIN_TEXT_LIMIT),
  ];

  // 2. the pages the menu points to
  const ranked = rankedLinks(allHtml, main.url, read);
  const firstPages = ranked.slice(0, MAX_SUBPAGES + 2);
  const subs = await Promise.allSettled(
    firstPages.map((u) => fetchPage(u.href)),
  );
  subs.forEach((s, i) => {
    read.add(
      firstPages[i].origin + firstPages[i].pathname + firstPages[i].search,
    );
    if (s.status === 'fulfilled') {
      parts.push(
        sectionOf(
          s.value.url.href,
          pageToText(s.value.html),
          SUBPAGE_TEXT_LIMIT,
        ),
      );
    }
  });
  let extra: ExtraPage[] = ranked
    .slice(firstPages.length, firstPages.length + MORE_PAGES)
    .map((url) => ({ kind: 'page', url }));

  // 3. a script-built site: the words are in its JS files, one per page
  if (visibleTextLength(main.html) < THIN_PAGE_CHARS) {
    const entries = await entryScripts(main.html, main.url).catch(() => []);
    const chunks = chunkUrls(entries, main.url);
    const first = chunks.slice(0, MAX_PAGE_CHUNKS);
    const loaded = await fetchScripts(first.map((c) => c.u)).catch(() => []);
    const entryText = entries
      .map((e) => textLiterals(e.html, 3000))
      .filter(Boolean)
      .join('\n');
    if (entryText) {
      parts.push(
        sectionOf(
          `${main.url.href} (text inside the site's main script)`,
          entryText,
          3000,
        ),
      );
    }
    for (const c of loaded) {
      const name =
        first.find((f) => f.u.href === c.url.href)?.name ?? c.url.pathname;
      const text = textLiterals(c.html);
      if (text) {
        parts.push(
          sectionOf(
            `${main.url.origin}/${name.toLowerCase()} page (text inside the site's "${name}" script)`,
            text,
            CHUNK_TEXT_LIMIT,
          ),
        );
      }
    }
    extra = chunks
      .slice(MAX_PAGE_CHUNKS, MAX_PAGE_CHUNKS + MORE_PAGES)
      .map((c) => ({ kind: 'script', url: c.u, name: c.name }));
  }

  // 4. still no address anywhere: look in the site's scripts
  if (!parts.some((p) => p.includes('Emails on this page:'))) {
    const emails = await scriptEmails(main.html, main.url).catch(() => []);
    if (emails.length) {
      parts.push(
        `=== Emails found in the site's JavaScript (the pages load their content with JavaScript) ===\nEmails on this page:\n${emails.join('\n')}`,
      );
    }
  }
  return { text: parts.join('\n\n'), extra };
}

export async function readMore(extra: readonly ExtraPage[]): Promise<string> {
  const out = await Promise.allSettled(
    extra.map(async (e) => {
      const page = await fetchPage(e.url.href, { script: e.kind === 'script' });
      return e.kind === 'script'
        ? sectionOf(
            `${e.url.origin}/${e.name.toLowerCase()} page (text inside the site's "${e.name}" script)`,
            textLiterals(page.html),
            CHUNK_TEXT_LIMIT,
          )
        : sectionOf(page.url.href, pageToText(page.html), SUBPAGE_TEXT_LIMIT);
    }),
  );
  return out
    .flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    .join('\n\n');
}
