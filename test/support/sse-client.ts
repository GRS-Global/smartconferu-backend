import { request as httpRequest, type ClientRequest } from 'node:http';

export interface SseEvent {
  id?: string;
  event: string;
  data: unknown;
}

/** A minimal EventSource for tests: opens the stream and collects the events it sends. */
export class SseClient {
  readonly events: SseEvent[] = [];
  status = 0;
  ended = false;
  private req?: ClientRequest;
  private buffer = '';
  private waiters: (() => void)[] = [];

  /** Resolves once the response headers arrive (status set); the body keeps streaming. */
  open(url: string, headers: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.req = httpRequest(
        url,
        { headers: { accept: 'text/event-stream', ...headers } },
        (res) => {
          this.status = res.statusCode ?? 0;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => this.feed(chunk));
          res.on('end', () => {
            this.ended = true;
            this.wake();
          });
          resolve();
        },
      );
      this.req.on('error', (error) =>
        this.status ? undefined : reject(error),
      );
      this.req.end();
    });
  }

  /** Waits until an event matches (default: any `notification`), up to `ms`. */
  async next(
    match: (e: SseEvent) => boolean = (e) => e.event === 'notification',
    ms = 3000,
  ): Promise<SseEvent> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.events.find(match);
      if (found) {
        return found;
      }
      if (this.ended || Date.now() > deadline) {
        throw new Error(
          `No matching event; got ${JSON.stringify(this.events.map((e) => e.event))}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  /** The notification events so far. */
  notifications(): SseEvent[] {
    return this.events.filter((e) => e.event === 'notification');
  }

  close(): void {
    this.req?.destroy();
  }

  private feed(chunk: string) {
    this.buffer += chunk;
    let cut: number;
    while ((cut = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      const event: SseEvent = { event: 'message', data: null };
      let data: string | undefined;
      for (const line of block.split('\n')) {
        const i = line.indexOf(':');
        if (i <= 0) {
          continue; // comment (heartbeat) or blank
        }
        const field = line.slice(0, i);
        const value = line.slice(i + 1).replace(/^ /, '');
        if (field === 'id') event.id = value;
        if (field === 'event') event.event = value;
        if (field === 'data') data = value;
      }
      if (data !== undefined) {
        event.data = JSON.parse(data);
        this.events.push(event);
      }
    }
    this.wake();
  }

  private wake() {
    for (const w of this.waiters.splice(0)) {
      w();
    }
  }
}
