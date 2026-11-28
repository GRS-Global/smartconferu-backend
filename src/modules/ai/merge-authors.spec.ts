import { mergeRepeatedAuthors } from './ai-tools.service.js';

const author = (over: Record<string, unknown>) => ({
  name: 'Ada Lovelace',
  affiliation: 'IIT Bombay',
  department: '',
  city: 'Mumbai',
  country: 'India',
  otherAffiliations: [],
  email: '',
  corresponding: false,
  ...over,
});

describe('mergeRepeatedAuthors', () => {
  it('joins a name listed once per affiliation into one author', () => {
    const out = mergeRepeatedAuthors({
      title: 'T',
      authors: [
        author({}),
        author({ name: 'Ben Two', affiliation: 'MIT', country: 'USA' }),
        author({
          name: 'ada  LOVELACE',
          affiliation: 'MIT',
          city: 'Boston',
          country: 'USA',
          email: 'ada@x.org',
        }),
      ],
    });
    const authors = out.authors as Array<Record<string, unknown>>;
    expect(authors.map((a) => a.name)).toEqual(['Ada Lovelace', 'Ben Two']);
    expect(authors[0].affiliation).toBe('IIT Bombay');
    expect(authors[0].otherAffiliations).toEqual([
      { affiliation: 'MIT', department: '', city: 'Boston', country: 'USA' },
    ]);
    expect(authors[0].email).toBe('ada@x.org');
  });

  it('keeps the affiliations the model already put in one entry, without repeats', () => {
    const out = mergeRepeatedAuthors({
      authors: [
        author({
          otherAffiliations: [
            { affiliation: 'MIT', department: '', city: '', country: 'USA' },
            { affiliation: 'mit', department: '', city: '', country: 'USA' },
            { affiliation: '', department: '', city: '', country: '' },
          ],
        }),
        author({ affiliation: 'IIT Bombay' }),
      ],
    });
    const authors = out.authors as Array<Record<string, unknown>>;
    expect(authors).toHaveLength(1);
    expect(
      (authors[0].otherAffiliations as Array<{ affiliation: string }>).map(
        (p) => p.affiliation,
      ),
    ).toEqual(['MIT']);
  });

  it('leaves papers without an author list alone', () => {
    expect(mergeRepeatedAuthors({ title: 'T' })).toEqual({ title: 'T' });
  });
});
