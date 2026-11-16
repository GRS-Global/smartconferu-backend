import { chunkPaper } from './paper-text.js';

const words = (n: number, word = 'data') => Array(n).fill(word).join(' ');

describe('chunkPaper', () => {
  it('splits by section and joins very short sections to the next', () => {
    const text = [
      'A Title Line',
      'Abstract',
      words(40, 'short'),
      '1. Introduction',
      words(100, 'intro'),
      '2. Method',
      words(120, 'method'),
    ].join('\n');
    const chunks = chunkPaper(text);
    expect(chunks.map((c) => c.section)).toEqual([
      'Front matter / Abstract',
      '1. Introduction',
      '2. Method',
    ]);
    expect(chunks[1].words).toBe(100);
  });

  it('cuts long sections into overlapping windows', () => {
    const chunks = chunkPaper(['Results', words(900)].join('\n'));
    expect(chunks.map((c) => c.words)).toEqual([400, 400, 200]);
  });

  it('keeps sentences with a comma-ended line out of the headings', () => {
    const chunks = chunkPaper(
      ['Introduction', words(50), 'Results show that,', words(50)].join('\n'),
    );
    expect(chunks).toHaveLength(1);
  });
});
