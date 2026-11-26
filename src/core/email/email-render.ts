/**
 * Filling in an email template and putting it in the platform frame. Ported from the app's
 * src/shared/emailRequest.js (render) and src/shared/emailFrameCore.js (the "Brand stripe" frame), so
 * a template preview in the app and the email really sent look the same.
 */

export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  );

export const stripTags = (value: unknown): string =>
  String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Values that are already HTML (built by the API from escaped parts, such as a list of papers);
 * every other value is escaped.
 */
export const HTML_VALUES = new Set([
  'paper_list',
  'pending_list',
  'chair_note',
  'reviews_for_author',
  'review_copy',
  'correction_reasons',
  'revision_reasons',
  'reason',
]);

export type TemplateValues = Record<string, string | number | null | undefined>;

/** `{{name}}` → its value. In HTML, values are escaped and `*_link` URLs become links. */
export function renderTemplate(
  text: string,
  values: TemplateValues,
  { html }: { html: boolean },
): string {
  return String(text || '').replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => {
    const value = String(values[key] ?? '');
    if (!html) {
      return stripTags(value);
    }
    if (HTML_VALUES.has(key)) {
      return value;
    }
    if (key.endsWith('_link') && /^https?:\/\//.test(value)) {
      return `<a href="${escapeHtml(value)}" style="color:#4F46E5">${escapeHtml(value)}</a>`;
    }
    return escapeHtml(value);
  });
}

/** Plain text typed in a box → HTML paragraphs (a blank line starts a new one). `{{placeholders}}` are kept. */
export function textToHtml(text: string): string {
  return String(text || '')
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

/** The plain-text version of an email body. */
export function htmlToText(html: string): string {
  return String(html || '')
    .replace(
      /<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi,
      (_, href: string, label: string) => {
        const text = stripTags(label);
        return text === href ? href : `${text} (${href})`;
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAVY = '#17233F';
const BLUE = '#0B4FF2';
const FONT = 'Arial,Helvetica,sans-serif';
const RULE = '1px solid #E5E7EB';
const SUPPORT_EMAIL = 'support@smartconferu.com';

/**
 * Templates end with their own "Best regards, The … Team"; the frame signs off itself, so that last
 * paragraph is dropped to keep it from appearing twice.
 */
function stripSignOff(bodyHtml: string): string {
  const html = String(bodyHtml || '');
  const end = html.lastIndexOf('</p>');
  const start = end < 0 ? -1 : html.lastIndexOf('<p', end);
  if (start < 0) {
    return html;
  }
  const text = html
    .slice(start, end)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(best regards,?\s*)?the\s.{1,80}\steam$/i.test(text)
    ? html.slice(0, start) + html.slice(end + 4)
    : html;
}

/** Hosts a mail client cannot reach: this computer or a private network. */
const PRIVATE_HOST =
  /^(localhost|.*\.(local|localhost|internal|lan)|127\..*|10\..*|192\.168\..*|172\.(1[6-9]|2\d|3[01])\..*|0\.0\.0\.0|\[?::1\]?)$/i;

/**
 * The logo URL for emails: the one configured, else the app's own logo when the app is on a public
 * address; undefined (the name is written out) when it is not, so a mail client never shows a
 * broken image.
 */
export function emailLogoUrl(
  appUrl: string,
  configured?: string | null,
): string | undefined {
  if (configured) {
    return configured;
  }
  try {
    const { hostname } = new URL(appUrl);
    return PRIVATE_HOST.test(hostname)
      ? undefined
      : `${appUrl.replace(/\/$/, '')}/smartconferu-lockup.png`;
  } catch {
    return undefined;
  }
}

export interface FrameOptions {
  /** The email's name ("Submission received"), shown as its heading. */
  title: string;
  conferenceName?: string | null;
  conferenceAcronym?: string | null;
  /** Public URL of the Smartconferu logo; without it the name is written out. */
  logoUrl?: string;
}

/** The full HTML document of an email: the body in the platform frame. */
export function frameEmail(bodyHtml: string, options: FrameOptions): string {
  const conf = options.conferenceAcronym || options.conferenceName || '';
  const logo = options.logoUrl
    ? `<img src="${escapeHtml(options.logoUrl)}" alt="Smartconferu" height="40" style="display:block;height:40px;width:auto;border:0;" />`
    : `<div style="font-size:20px;font-weight:700;color:${NAVY};">Smartconferu</div>`;
  const right = conf
    ? `<span style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${BLUE};">${escapeHtml(conf)}</span>`
    : '';
  const frame =
    `<div style="border:1px solid #E5E7EB;border-top:5px solid ${NAVY};border-radius:10px;overflow:hidden;background:#FFFFFF;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>` +
    `<td style="padding:22px 36px 0;font-family:${FONT};">${logo}</td>` +
    `<td align="right" style="padding:22px 36px 0;font-family:${FONT};">${right}</td>` +
    `</tr></table>` +
    `<div style="padding:18px 36px 34px;font-family:${FONT};font-size:14px;line-height:1.6;color:#111827;">` +
    (options.title
      ? `<h2 style="margin:0 0 16px;font-size:22px;line-height:1.25;color:${NAVY};">${escapeHtml(options.title)}</h2>`
      : '') +
    stripSignOff(bodyHtml) +
    `<div style="margin-top:26px;padding-top:20px;border-top:${RULE};font-family:${FONT};font-size:14px;line-height:1.6;color:#111827;">` +
    `<div style="font-weight:700;">Best regards,</div><div>The Smartconferu Team</div></div>` +
    `</div>` +
    `<div style="padding:18px 36px 24px;background:#F8F9FB;border-top:${RULE};font-family:${FONT};font-size:12.5px;line-height:1.7;color:#9CA3AF;text-align:center;">` +
    `<div>Please be aware that this is an unmonitored email alias, so please do not reply to this email.</div>` +
    `<div>To contact Smartconferu use our <a href="mailto:${SUPPORT_EMAIL}" style="color:#6B7280;font-weight:700;">contact page</a>.</div>` +
    `<div style="margin-top:6px;font-size:11px;">Sent with <b style="color:#6B7280;">Smartconferu</b></div>` +
    `</div></div>`;
  return (
    `<!doctype html><html><body style="margin:0;padding:24px;background:#F8FAFC;font-family:${FONT};color:#0F172A">` +
    `<div style="max-width:640px;margin:0 auto">${frame}</div></body></html>`
  );
}

/** "Dr. Ada Lovelace" → "Ada"; falls back to the email's name, then "there". */
export function firstName(
  name: string | null | undefined,
  email?: string | null,
): string {
  return (
    String(name || '')
      .replace(/^(Dr\.?|Prof\.?|Mr\.?|Ms\.?|Mrs\.?)\s+/i, '')
      .trim()
      .split(/\s+/)[0] ||
    String(email || '').split('@')[0] ||
    'there'
  );
}

/** "12 Mar 2027", as the app's emails write dates. */
export function emailDate(value: Date | string | null | undefined): string {
  if (!value) {
    return '';
  }
  const date =
    typeof value === 'string' && value.length === 10
      ? new Date(`${value}T00:00:00Z`)
      : new Date(value);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
