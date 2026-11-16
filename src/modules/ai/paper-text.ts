/**
 * A paper's text for the AI features: PDF → text (pdf.js), text → section-aware chunks. Ported from
 * the app's src/shared/paperIngest.js.
 */

const MAX_PAGES = 60;
/** Characters; a long journal-length paper is ~100k. */
export const MAX_TEXT = 250_000;
const CHUNK_WORDS = 400;
/** Words repeated at the start of the next chunk, so no sentence is lost at a cut. */
const CHUNK_OVERLAP = 50;
const MAX_CHUNKS = 150;

interface TextItem {
  str: string;
  hasEOL?: boolean;
  transform: number[];
}

/**
 * The full text of a PDF, one line per text row (pdf.js hands back loose fragments; a change in the
 * vertical position starts a new line), pages separated by a blank line.
 */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    let text = '';
    for (
      let p = 1;
      p <= Math.min(pdf.numPages, MAX_PAGES) && text.length < MAX_TEXT;
      p++
    ) {
      const content = await (await pdf.getPage(p)).getTextContent();
      let lastY: number | null = null;
      let line = '';
      for (const raw of content.items) {
        if (!('str' in raw)) {
          continue;
        }
        const item = raw as TextItem;
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          text += line.replace(/\s+/g, ' ').trim() + '\n';
          line = '';
        }
        line += item.str + (item.hasEOL ? ' ' : '');
        lastY = y;
      }
      text += line.replace(/\s+/g, ' ').trim() + '\n\n';
    }
    return text
      .slice(0, MAX_TEXT)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } finally {
    await task.destroy();
  }
}

const KNOWN_HEADINGS =
  /^(abstract|introduction|background|related work|literature review|preliminaries|method(s|ology)?|approach|proposed (method|model|system|approach|framework)|system (model|design|architecture)|materials and methods|experiment(s|al (setup|results))?|evaluation|results?( and discussion)?|discussion|analysis|limitations|future work|conclusions?( and future work)?|acknowledge?ments?|references|bibliography|appendix)\b/i;
/** "3. Results", "3.2 Data Set", "IV. EVALUATION", "A. Data": short, numbered, starts with a capital. */
const NUMBERED_HEADING =
  /^((\d+(\.\d+){0,2})\.?|[IVX]{1,5}\.|[A-H]\.)\s+[A-Z][^.!?]{1,70}$/;

function headingOf(line: string): string | null {
  const l = line.trim();
  if (!l || l.length > 80 || /[,;:]$/.test(l)) {
    return null;
  }
  const bare = l.replace(/^((\d+(\.\d+){0,2})\.?|[IVX]{1,5}\.|[A-H]\.)\s+/, '');
  if (KNOWN_HEADINGS.test(bare) && bare.split(/\s+/).length <= 6) {
    return l;
  }
  if (
    NUMBERED_HEADING.test(l) &&
    l.split(/\s+/).length <= 9 &&
    !/\d{3,}/.test(bare)
  ) {
    return l;
  }
  return null;
}

export interface Chunk {
  section: string;
  content: string;
  words: number;
}

/**
 * Sections first, then ~400-word windows inside each section with 50 words carried over. Very short
 * sections join the next one.
 */
export function chunkPaper(text: string): Chunk[] {
  const sections: { section: string; lines: string[] }[] = [];
  let current = { section: 'Front matter', lines: [] as string[] };
  for (const line of text.split('\n')) {
    const heading = headingOf(line);
    if (heading) {
      if (current.lines.length) {
        sections.push(current);
      }
      current = { section: heading, lines: [] };
    } else if (line.trim()) {
      current.lines.push(line.trim());
    }
  }
  if (current.lines.length) {
    sections.push(current);
  }

  const merged: { section: string; words: string[] }[] = [];
  for (const s of sections) {
    const words = s.lines
      .join(' ')
      .replace(/-\s+(?=[a-z])/g, '')
      .split(/\s+/)
      .filter(Boolean);
    const prev = merged.at(-1);
    if (prev && prev.words.length < 40) {
      prev.section = `${prev.section} / ${s.section}`;
      prev.words.push(...words);
    } else {
      merged.push({ section: s.section, words });
    }
  }

  const chunks: Chunk[] = [];
  for (const s of merged) {
    for (
      let start = 0;
      start < s.words.length;
      start += CHUNK_WORDS - CHUNK_OVERLAP
    ) {
      const piece = s.words.slice(start, start + CHUNK_WORDS);
      // A tail shorter than the overlap is already in the previous chunk.
      if (start > 0 && piece.length <= CHUNK_OVERLAP) {
        break;
      }
      chunks.push({
        section: s.section.slice(0, 120),
        content: piece.join(' '),
        words: piece.length,
      });
      if (start + CHUNK_WORDS >= s.words.length) {
        break;
      }
    }
  }
  return chunks.slice(0, MAX_CHUNKS);
}
