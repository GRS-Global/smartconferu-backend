import { AppException } from '../../../core/errors/app.exception.js';
import {
  type Column,
  COLUMNS,
  MISSING_PARTS,
  type MissingPart,
} from './screening-rules.js';

export type Confidence = 'high' | 'low';

/**
 * The automatic check of one paper version, as the app runs it in the browser when the file is
 * picked (src/chair-plagiarism/autoCheck.js: the rules read the PDF, then Claude through
 * /api/screen-paper when the rules aren't sure). The API keeps it with the file
 * (submission_files.auto_check) and, with AI mode on, decides the initial check from it.
 * `decision` is added by the API: what AI mode did with the result.
 */
export interface AutoCheck {
  status: 'done' | 'failed';
  error?: string;
  pages?: number;
  editable?: boolean;
  english?: boolean | null;
  column?: Column | null;
  confidence?: { column: Confidence; english: Confidence };
  source?: { column: 'rules' | 'ai'; english: 'rules' | 'ai' };
  missing?: MissingPart[];
  aiNote?: string;
  aiError?: string;
  at: string;
  ms?: number;
  decision?: {
    outcome: 'passed' | 'sent_back' | 'left_for_chair' | 'already_decided';
    reason?: string;
    at: string;
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks a result sent by the app and returns it cleaned: only the known fields, with valid
 * values. Throws a 400 listing the problems. `decision` is never taken from the client.
 */
export function parseAutoCheck(input: unknown): AutoCheck {
  const value: unknown =
    typeof input === 'string'
      ? (() => {
          try {
            return JSON.parse(input) as unknown;
          } catch {
            throw AppException.validation('autoCheck must be valid JSON.');
          }
        })()
      : input;
  if (!isObject(value)) {
    throw AppException.validation('autoCheck must be an object.');
  }
  const problems: string[] = [];
  const text = (key: string, max: number): string | undefined => {
    const v = value[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') {
      problems.push(`autoCheck.${key} must be text.`);
      return undefined;
    }
    return v.slice(0, max);
  };
  const confidence = (v: unknown, key: string): Confidence => {
    if (v !== 'high' && v !== 'low')
      problems.push(`autoCheck.confidence.${key} must be high or low.`);
    return v as Confidence;
  };
  const source = (v: unknown, key: string): 'rules' | 'ai' => {
    if (v !== 'rules' && v !== 'ai')
      problems.push(`autoCheck.source.${key} must be rules or ai.`);
    return v as 'rules' | 'ai';
  };

  const status = value.status;
  if (status !== 'done' && status !== 'failed') {
    problems.push('autoCheck.status must be done or failed.');
  }
  const at =
    typeof value.at === 'string' && !Number.isNaN(new Date(value.at).getTime())
      ? new Date(value.at).toISOString()
      : new Date().toISOString();
  const result: AutoCheck = { status: status as AutoCheck['status'], at };

  if (status === 'failed') {
    result.error =
      text('error', 500) ?? 'The file could not be checked automatically.';
  }
  if (status === 'done') {
    const pages = value.pages;
    if (
      !Number.isInteger(pages) ||
      (pages as number) < 1 ||
      (pages as number) > 2000
    ) {
      problems.push(
        'autoCheck.pages must be a whole number of pages (1–2000).',
      );
    } else {
      result.pages = pages as number;
    }
    if (typeof value.editable !== 'boolean') {
      problems.push('autoCheck.editable must be true or false.');
    } else {
      result.editable = value.editable;
    }
    if (
      value.english !== null &&
      value.english !== undefined &&
      typeof value.english !== 'boolean'
    ) {
      problems.push('autoCheck.english must be true, false or null.');
    } else {
      result.english = (value.english as boolean | null | undefined) ?? null;
    }
    if (
      value.column !== null &&
      value.column !== undefined &&
      !COLUMNS.includes(value.column as Column)
    ) {
      problems.push('autoCheck.column must be single, double or null.');
    } else {
      result.column = (value.column as Column | null | undefined) ?? null;
    }
    if (isObject(value.confidence)) {
      result.confidence = {
        column: confidence(value.confidence.column, 'column'),
        english: confidence(value.confidence.english, 'english'),
      };
    } else {
      // No confidence given: nothing in it can be relied on.
      result.confidence = { column: 'low', english: 'low' };
    }
    if (isObject(value.source)) {
      result.source = {
        column: source(value.source.column, 'column'),
        english: source(value.source.english, 'english'),
      };
    }
    if (value.missing !== undefined) {
      if (
        !Array.isArray(value.missing) ||
        value.missing.some((m) => !MISSING_PARTS.includes(m as MissingPart))
      ) {
        problems.push(
          `autoCheck.missing must list only: ${MISSING_PARTS.join(', ')}.`,
        );
      } else {
        result.missing = [...new Set(value.missing as MissingPart[])];
      }
    }
    const aiNote = text('aiNote', 500);
    if (aiNote) result.aiNote = aiNote;
  }
  const aiError = text('aiError', 500);
  if (aiError) result.aiError = aiError;
  if (
    typeof value.ms === 'number' &&
    Number.isFinite(value.ms) &&
    value.ms >= 0
  ) {
    result.ms = Math.round(value.ms);
  }

  if (problems.length > 0) {
    throw AppException.validation(problems.join(' '), { problems });
  }
  return result;
}
