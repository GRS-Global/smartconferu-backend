import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A request the fake received: the path and its JSON body. */
export interface FakeCall {
  path: string;
  body: Record<string, unknown>;
}

/**
 * Plays the Claude Messages API and Voyage AI embeddings for the AI tests, so no real calls (or
 * money) are made. `answer` decides the JSON (or text) Claude replies with for each request.
 */
export class FakeAi {
  readonly calls: FakeCall[] = [];
  /** The text Claude answers with; by default `{}`. */
  answer: (body: Record<string, unknown>) => unknown = () => ({});
  /** Answer with stop_reason "refusal" instead. */
  refuse = false;
  private server?: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void readJson(req).then((body) => {
        const path = req.url ?? '';
        this.calls.push({ path, body });
        res.setHeader('content-type', 'application/json');
        if (path.endsWith('/v1/embeddings')) {
          const input = body.input as string[];
          res.end(
            JSON.stringify({
              data: input.map((text, index) => ({
                index,
                embedding: vectorFor(text),
              })),
              usage: { total_tokens: input.length * 10 },
            }),
          );
          return;
        }
        const reply = this.answer(body);
        res.end(
          JSON.stringify({
            id: `msg_${this.calls.length}`,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [
              {
                type: 'text',
                text: typeof reply === 'string' ? reply : JSON.stringify(reply),
              },
            ],
            stop_reason: this.refuse ? 'refusal' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 20 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  /** The Claude requests so far (not the embeddings). */
  messages(): Record<string, unknown>[] {
    return this.calls
      .filter((c) => c.path.endsWith('/v1/messages'))
      .map((c) => c.body);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()));
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
  });
}

/** A 1024-dimension vector that depends on the text's words, so similar texts are close. */
function vectorFor(text: string): number[] {
  const v = Array.from({ length: 1024 }, () => 0.001);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const c of word) {
      h = (h * 31 + c.charCodeAt(0)) % 1024;
    }
    v[h] += 1;
  }
  return v;
}

/** A real one-page PDF whose text is these lines (Helvetica), readable by pdf.js. */
export function textPdf(lines: readonly string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = [
    'BT /F1 9 Tf 40 800 Td 11 TL',
    ...lines.map((l) => `(${esc(l)}) Tj T*`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
