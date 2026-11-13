import { parseAutoCheck } from './auto-check.js';
import {
  DEFAULT_CRITERIA,
  evaluateCheck,
  pageRange,
  withoutBlindMissing,
} from './screening-rules.js';

describe('screening rules', () => {
  it('judges length against the layout’s own range', () => {
    expect(pageRange(DEFAULT_CRITERIA, 'single')).toEqual({ min: 8, max: 30 });
    expect(pageRange(DEFAULT_CRITERIA, 'double')).toEqual({ min: 4, max: 15 });
    const failing = (pages: number, column: 'single' | 'double') =>
      evaluateCheck(
        { editable: true, english: true, column, pages },
        DEFAULT_CRITERIA,
      )
        .filter((i) => !i.ok)
        .map((i) => i.key);
    expect(failing(10, 'single')).toEqual([]);
    expect(failing(5, 'single')).toEqual(['pages']);
    expect(failing(10, 'double')).toEqual(['column']);
    expect(
      evaluateCheck(
        { editable: true, english: true, column: 'double', pages: 10 },
        { ...DEFAULT_CRITERIA, column: 'either' },
      ).every((i) => i.ok),
    ).toBe(true);
  });

  it('writes the sentence the author receives', () => {
    const items = evaluateCheck(
      { editable: false, english: false, column: 'single', pages: 40 },
      DEFAULT_CRITERIA,
    );
    expect(items.filter((i) => !i.ok).map((i) => i.problem)).toEqual([
      'The paper is not editable (scanned or image-only PDF). Please upload a text-based PDF or Word file.',
      'The paper must be written in English.',
      'The paper is too long (40 pages). In single column the maximum is 30 pages.',
    ]);
  });

  it('does not ask for author names under double-blind review', () => {
    expect(
      withoutBlindMissing(['author_names', 'affiliations', 'keywords'], true),
    ).toEqual(['keywords']);
    expect(withoutBlindMissing(['author_names'], false)).toEqual([
      'author_names',
    ]);
  });
});

describe("parseAutoCheck (the app's result, checked before it is kept)", () => {
  const good = {
    status: 'done',
    pages: 12,
    editable: true,
    english: true,
    column: 'single',
    confidence: { column: 'high', english: 'low' },
    source: { column: 'rules', english: 'ai' },
    missing: ['keywords', 'keywords'],
    aiNote: 'Fine.',
    at: '2026-11-13T10:00:00Z',
    ms: 1234.6,
    decision: { outcome: 'passed' },
    somethingElse: 'dropped',
  };

  it('keeps the known fields, cleaned, and never takes a decision from the client', () => {
    expect(parseAutoCheck(good)).toEqual({
      status: 'done',
      pages: 12,
      editable: true,
      english: true,
      column: 'single',
      confidence: { column: 'high', english: 'low' },
      source: { column: 'rules', english: 'ai' },
      missing: ['keywords'],
      aiNote: 'Fine.',
      at: '2026-11-13T10:00:00.000Z',
      ms: 1235,
    });
  });

  it('accepts the result as a JSON string (a multipart field)', () => {
    expect(parseAutoCheck(JSON.stringify(good)).pages).toBe(12);
  });

  it('treats a result without confidence as unsure', () => {
    const { confidence: _c, ...rest } = good;
    expect(parseAutoCheck(rest).confidence).toEqual({
      column: 'low',
      english: 'low',
    });
  });

  it('keeps a failed check with its reason', () => {
    expect(
      parseAutoCheck({
        status: 'failed',
        error: 'Only PDF files can be checked.',
      }),
    ).toMatchObject({
      status: 'failed',
      error: 'Only PDF files can be checked.',
    });
  });

  it('refuses a malformed result, listing what is wrong', () => {
    expect(() => parseAutoCheck('{not json')).toThrow(
      'autoCheck must be valid JSON.',
    );
    expect(() => parseAutoCheck([])).toThrow('autoCheck must be an object.');
    try {
      parseAutoCheck({
        status: 'maybe',
        pages: -1,
        editable: 'yes',
        column: 'triple',
        missing: ['everything'],
      });
      throw new Error('expected a refusal');
    } catch (error) {
      const problems = (
        error as { getResponse(): { details: { problems: string[] } } }
      ).getResponse().details.problems;
      // An unknown status: nothing else can be judged.
      expect(problems).toEqual(['autoCheck.status must be done or failed.']);
    }
    try {
      parseAutoCheck({
        status: 'done',
        pages: 0,
        editable: 'yes',
        column: 'x',
        missing: ['x'],
      });
      throw new Error('expected a refusal');
    } catch (error) {
      const problems = (
        error as { getResponse(): { details: { problems: string[] } } }
      ).getResponse().details.problems;
      expect(problems).toEqual([
        expect.stringMatching(/pages/),
        expect.stringMatching(/editable/),
        expect.stringMatching(/column/),
        expect.stringMatching(/missing/),
      ]);
    }
  });
});
