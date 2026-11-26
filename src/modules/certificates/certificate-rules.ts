import type { CertTypeKey } from './dto/certificates.dto.js';

/* Rules shared by the certificate services. Kept in step with the designer's own rules in
   frontend/src/features/certificates/data.ts (serial format, merge fields). */

const TYPE_CODE: Record<CertTypeKey, string> = {
  presentation: 'PRS',
  participation: 'PAR',
  appreciation: 'APP',
  publication: 'PUB',
  author: 'AUT',
};

/** "ISBM 2026-27" -> "ISBM26": letters and the year are pulled out separately so a blind cut can never split a year. */
export function serialPrefix(acronym: string, typeKey: CertTypeKey): string {
  const letters = (acronym.match(/[A-Za-z]+/g) ?? [])
    .join('')
    .toUpperCase()
    .slice(0, 8);
  const year = /\d{4}/.exec(acronym)?.[0];
  return `${letters || 'CNF'}${year ? year.slice(2) : ''}-${TYPE_CODE[typeKey] ?? 'GEN'}-`;
}

export const serialOf = (prefix: string, index: number) =>
  `${prefix}${String(index).padStart(3, '0')}`;

/** The numeric tail of a serial that starts with `prefix`; -1 when it does not. */
export function serialIndex(serial: string, prefix: string): number {
  if (!serial.startsWith(prefix)) return -1;
  const tail = serial.slice(prefix.length);
  return /^\d+$/.test(tail) ? Number(tail) : -1;
}

export interface MergeConference {
  title: string;
  acronym: string;
  startDate: string | null;
  endDate: string | null;
  city: string | null;
  country: string | null;
}
export interface MergeRecipient {
  name: string;
  affiliation?: string;
  roleLabel?: string;
  serial: string;
  paperTitle?: string;
  paperId?: string;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function conferenceDates(c: MergeConference): string {
  if (!c.startDate) return '';
  return c.endDate && c.endDate !== c.startDate
    ? `${formatDate(c.startDate)} – ${formatDate(c.endDate)}`
    : formatDate(c.startDate);
}

const TYPE_LABEL: Record<CertTypeKey, string> = {
  presentation: 'Certificate of Presentation',
  participation: 'Certificate of Participation',
  appreciation: 'Certificate of Appreciation',
  publication: 'Certificate of Publication',
  author: 'Certificate to Author',
};

/** What an email also knows about the certificate being issued (the designer's own fields {{signatoryName}} / {{signatoryTitle}} are not for emails). */
export interface MergeExtras {
  typeKey: CertTypeKey;
  issuedAt: Date;
  verificationUrl: string;
}

export function mergeValues(
  r: MergeRecipient,
  c: MergeConference,
  extras?: MergeExtras,
): Record<string, string> {
  return {
    recipientName: r.name,
    affiliation: r.affiliation ?? '',
    roleLabel: r.roleLabel ?? '',
    serial: r.serial,
    paperTitle: r.paperTitle ?? '',
    paperId: r.paperId ?? '',
    conferenceName: c.title,
    conferenceAcronym: c.acronym,
    conferenceDates: conferenceDates(c),
    conferenceVenue: [c.city, c.country].filter(Boolean).join(', '),
    conferenceCity: c.city ?? '',
    conferenceCountry: c.country ?? '',
    conferenceYear: c.startDate ? c.startDate.slice(0, 4) : '',
    certificateType: extras ? TYPE_LABEL[extras.typeKey] : '',
    issueDate: extras
      ? formatDate(extras.issuedAt.toISOString().slice(0, 10))
      : '',
    verificationUrl: extras?.verificationUrl ?? '',
  };
}

/** An unresolved token becomes empty text rather than printing braces. */
export function applyMerge(
  text: string,
  values: Record<string, string>,
): string {
  return text.replace(
    /\{\{\s*(\w+)\s*\}\}/g,
    (_m, token: string) => values[token] ?? '',
  );
}

export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** A plain-text message as email HTML: blank lines separate paragraphs, single line breaks stay. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replaceAll('\n', '<br>')}</p>`)
    .join('');
}

/** What the public verify page names as the signatory: the studio's "Signatory name / title" blocks, else the first v1 signatory. */
export function signatoryOf(design: unknown): {
  name?: string;
  title?: string;
} {
  const d = (design ?? {}) as {
    studio?: { elements?: Array<{ name?: string; text?: string }> };
    signatories?: Array<{ name?: string; title?: string }>;
  };
  const els = d.studio?.elements ?? [];
  const name = els.find((e) => e.name === 'Signatory name')?.text;
  const title = els.find((e) => e.name === 'Signatory title')?.text;
  if (name || title)
    return { name: name || undefined, title: title || undefined };
  const first = d.signatories?.[0];
  return { name: first?.name || undefined, title: first?.title || undefined };
}

/** The asset-library ids a design uses (`asset:<uuid>` image sources). */
export function assetIdsIn(design: unknown): string[] {
  return [
    ...new Set(
      [...JSON.stringify(design ?? {}).matchAll(/asset:([0-9a-f-]{36})/gi)].map(
        (m) => m[1].toLowerCase(),
      ),
    ),
  ];
}

/** The signature-library ids a design uses (`sig:<uuid>` image sources). */
export function signatureIdsIn(design: unknown): string[] {
  return [
    ...new Set(
      [...JSON.stringify(design ?? {}).matchAll(/sig:([0-9a-f-]{36})/gi)].map(
        (m) => m[1].toLowerCase(),
      ),
    ),
  ];
}

/**
 * The design without every use of a library picture or signature (`ref` is `sig:<id>` or `asset:<id>`): the studio elements that show it
 * go (with `wholeGroup`, the rest of their group too: a signature is one group of picture, line and wording), and any other place that
 * names it (a page background) is cleared.
 */
export function withoutReference(
  design: Record<string, unknown>,
  ref: string,
  wholeGroup: boolean,
): Record<string, unknown> {
  const key = ref.toLowerCase();
  const hit = (v: unknown) =>
    typeof v === 'string' && v.toLowerCase().includes(key);
  const clean = (v: unknown): unknown =>
    hit(v)
      ? ''
      : Array.isArray(v)
        ? v.map(clean)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]))
          : v;
  const studio = design.studio as
    { elements?: Array<Record<string, unknown>> } | undefined;
  let next: Record<string, unknown> = design;
  if (studio && Array.isArray(studio.elements)) {
    const gone = studio.elements.filter((e) => hit(e.src));
    const ids = new Set(gone.map((e) => e.id));
    const groups = new Set(
      wholeGroup ? gone.map((e) => e.groupId).filter(Boolean) : [],
    );
    next = {
      ...design,
      studio: {
        ...studio,
        elements: studio.elements.filter(
          (e) => !ids.has(e.id) && !(e.groupId && groups.has(e.groupId)),
        ),
      },
    };
  }
  return clean(next) as Record<string, unknown>;
}
