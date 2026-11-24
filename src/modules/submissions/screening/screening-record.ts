import { AppException } from '../../../core/errors/app.exception.js';
import { COLUMNS } from './screening-rules.js';

/** Initial check decisions (the screening tables' list). */
export const CHECK_DECISIONS = [
  'pending',
  'passed',
  'hold',
  'revision',
  'reject',
] as const;
/** Plagiarism check outcomes. */
export const PLAG_OUTCOMES = [
  'pending',
  'clear',
  'hold',
  'revision',
  'reject',
] as const;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks a chair's screening record of one version before it is saved. The fields that drive
 * the process are checked strictly (types, allowed values, ranges, dates, file paths); the other
 * fields the screening tables keep for themselves (who/when stamps, edit flags) pass through.
 * Throws a 400 listing every problem.
 */
export function validateScreeningRecord(
  record: Json,
  context: {
    /** The paper's folder (its versions and plagiarism reports); the record may point only inside it. */
    folder: string;
    /** The conference runs the initial check (then the plagiarism step needs it passed). */
    initialCheck: boolean;
  },
): void {
  const problems: string[] = [];
  const bool = (path: string, v: unknown) => {
    if (v !== undefined && typeof v !== 'boolean')
      problems.push(`${path} must be true or false.`);
  };
  const text = (path: string, v: unknown, max: number) => {
    if (v === undefined || v === null) return;
    if (typeof v !== 'string') problems.push(`${path} must be text.`);
    else if (v.length > max)
      problems.push(`${path} is too long (at most ${max} characters).`);
  };
  const oneOf = (path: string, v: unknown, allowed: readonly string[]) => {
    if (v !== undefined && !allowed.includes(v as string)) {
      problems.push(`${path} must be one of: ${allowed.join(', ')}.`);
    }
  };
  const textList = (path: string, v: unknown) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length > 20) {
      problems.push(`${path} must be a list of at most 20 sentences.`);
      return;
    }
    v.forEach((item, i) => text(`${path}[${i}]`, item, 1000));
  };
  const date = (path: string, v: unknown) => {
    if (v === undefined || v === null || v === '') return;
    if (typeof v !== 'string' || Number.isNaN(new Date(v).getTime())) {
      problems.push(`${path} must be a date.`);
    }
  };
  const percent = (path: string, v: unknown) => {
    if (v === undefined || v === null || v === '') return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100)
      problems.push(`${path} must be a percentage (0–100).`);
  };
  const section = (name: string): Json | undefined => {
    const v = record[name];
    if (v === undefined || v === null) return undefined;
    if (!isObject(v)) {
      problems.push(`${name} must be an object.`);
      return undefined;
    }
    return v;
  };

  const check = section('check');
  if (check) {
    bool('check.editable', check.editable);
    bool('check.english', check.english);
    bool('check.valid', check.valid);
    oneOf('check.column', check.column, COLUMNS);
    oneOf('check.decision', check.decision, CHECK_DECISIONS);
    text('check.comment', check.comment, 5000);
    const pages = check.pages;
    if (pages !== undefined && pages !== null && String(pages).trim() !== '') {
      const n = Number(pages);
      if (!Number.isInteger(n) || n < 1 || n > 2000) {
        problems.push('check.pages must be a whole number of pages (1–2000).');
      }
    }
    if (check.other !== undefined) {
      if (!Array.isArray(check.other) || check.other.length > 20) {
        problems.push('check.other must be a list of at most 20 problems.');
      } else {
        check.other.forEach((o, i) => {
          if (!isObject(o)) {
            problems.push(`check.other[${i}] must be an object.`);
            return;
          }
          text(`check.other[${i}].label`, o.label, 200);
          text(`check.other[${i}].problem`, o.problem, 1000);
        });
      }
    }
  }

  const correction = section('correction');
  if (correction) {
    textList('correction.reasons', correction.reasons);
    text('correction.note', correction.note, 5000);
    date('correction.deadline', correction.deadline);
  }

  const report = section('report');
  if (report) {
    percent('report.similarity', report.similarity);
    percent('report.ai', report.ai);
    text('report.note', report.note, 5000);
  }

  const outcome = section('outcome');
  if (outcome) {
    oneOf('outcome.kind', outcome.kind, PLAG_OUTCOMES);
    textList('outcome.reasons', outcome.reasons);
    text('outcome.note', outcome.note, 5000);
    date('outcome.deadline', outcome.deadline);
    bool('outcome.shareReport', outcome.shareReport);
  }

  const paths = section('paths');
  if (paths) {
    for (const [name, path] of Object.entries(paths)) {
      if (
        typeof path !== 'string' ||
        !path.startsWith(context.folder) ||
        path.includes('..')
      ) {
        problems.push(`paths.${name} must be a file of this paper.`);
      }
    }
  }

  // The plagiarism step follows a passed initial check.
  const plagiarismStarted =
    (outcome && outcome.kind !== undefined && outcome.kind !== 'pending') ||
    report !== undefined;
  if (
    context.initialCheck &&
    plagiarismStarted &&
    check?.decision !== 'passed'
  ) {
    problems.push(
      'The plagiarism check can only be recorded once the initial check has passed.',
    );
  }

  if (problems.length > 0) {
    throw AppException.validation(problems.join(' '), { problems });
  }
}
