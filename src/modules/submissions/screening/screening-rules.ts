/**
 * The Initial Check rules, the same as the app's src/chair-plagiarism/data.js (criteria, page
 * ranges, evaluateCheck), so the server and the screening tables judge a paper alike.
 */

export const COLUMNS = ['single', 'double'] as const;
export type Column = (typeof COLUMNS)[number];

/** Per-conference criteria (Conference Settings › Screening). */
export interface ScreeningCriteria {
  /** The layout the conference asks for; `either` accepts both. */
  column: Column | 'either';
  minPages: number;
  maxPages: number;
  doubleMinPages: number;
  doubleMaxPages: number;
  /** Plagiarism check limits, in %. */
  similarityLimit: number;
  aiLimit: number;
  /** Days the author gets to send a corrected / revised version. */
  correctionDays: number;
  revisionDays: number;
}

/** Which screening steps the conference runs, and AI mode. */
export interface ScreeningSettings {
  initialCheck: boolean;
  plagiarism: boolean;
  /** AI mode: the system reads each new version and decides its initial check. */
  autoInitialCheck: boolean;
  /** A paper that fails the automatic check: back to the author, or left for the chair. */
  autoInitialFail: 'send_back' | 'leave';
}

export interface ScreeningConfig {
  settings: ScreeningSettings;
  criteria: ScreeningCriteria;
}

/** The GRS screening SOP: single column, 8–30 pages (4–15 in double column), 20 % limits. */
export const DEFAULT_CRITERIA: ScreeningCriteria = {
  column: 'single',
  minPages: 8,
  maxPages: 30,
  doubleMinPages: 4,
  doubleMaxPages: 15,
  similarityLimit: 20,
  aiLimit: 20,
  correctionDays: 7,
  revisionDays: 10,
};

export const DEFAULT_SETTINGS: ScreeningSettings = {
  initialCheck: true,
  plagiarism: true,
  autoInitialCheck: false,
  autoInitialFail: 'send_back',
};

/** The conference's saved config (conferences.settings.screening) over the defaults. */
export function screeningConfigOf(settings: unknown): ScreeningConfig {
  const saved =
    typeof settings === 'object' && settings
      ? ((settings as Record<string, unknown>).screening as
          | Partial<{
              settings: Partial<ScreeningSettings>;
              criteria: Partial<ScreeningCriteria>;
            }>
          | undefined)
      : undefined;
  return {
    settings: { ...DEFAULT_SETTINGS, ...(saved?.settings ?? {}) },
    criteria: { ...DEFAULT_CRITERIA, ...(saved?.criteria ?? {}) },
  };
}

/** The allowed length of a paper in this layout. */
export function pageRange(
  criteria: ScreeningCriteria,
  column: Column | null | undefined,
): { min: number; max: number } {
  return column === 'double'
    ? { min: criteria.doubleMinPages, max: criteria.doubleMaxPages }
    : { min: criteria.minPages, max: criteria.maxPages };
}

/** What the initial check is judged on. */
export interface CheckValues {
  editable: boolean;
  english: boolean;
  column: Column;
  pages: number | null;
}

export interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  /** The sentence the author receives when it fails. */
  problem: string;
}

/** Each requirement against the criteria (the app's evaluateCheck). */
export function evaluateCheck(
  check: CheckValues,
  criteria: ScreeningCriteria,
): CheckItem[] {
  const want = criteria.column === 'double' ? 'double column' : 'single column';
  const { min, max } = pageRange(criteria, check.column);
  const layout = check.column === 'double' ? 'double column' : 'single column';
  const pages = check.pages ?? 0;
  return [
    {
      key: 'editable',
      label: 'PDF Editable',
      ok: check.editable,
      problem:
        'The paper is not editable (scanned or image-only PDF). Please upload a text-based PDF or Word file.',
    },
    {
      key: 'english',
      label: 'English',
      ok: check.english,
      problem: 'The paper must be written in English.',
    },
    {
      key: 'column',
      label: 'Paper Layout',
      ok: criteria.column === 'either' || check.column === criteria.column,
      problem: `Please use the ${want} conference template.`,
    },
    {
      key: 'pages',
      label: 'Page Count',
      ok: check.pages === null || (pages >= min && pages <= max),
      problem:
        pages < min
          ? `The paper is too short (${pages} pages). In ${layout} the minimum is ${min} pages.`
          : `The paper is too long (${pages} pages). In ${layout} the maximum is ${max} pages.`,
    },
  ];
}

/** Parts of a paper the AI can report missing. */
export const MISSING_PARTS = [
  'title',
  'author_names',
  'affiliations',
  'abstract',
  'keywords',
  'references',
] as const;
export type MissingPart = (typeof MISSING_PARTS)[number];

/** Under double-blind review the PDF must not carry author names or affiliations. */
export function withoutBlindMissing(
  missing: readonly MissingPart[],
  doubleBlind: boolean,
): MissingPart[] {
  return doubleBlind
    ? missing.filter((m) => m !== 'author_names' && m !== 'affiliations')
    : [...missing];
}
