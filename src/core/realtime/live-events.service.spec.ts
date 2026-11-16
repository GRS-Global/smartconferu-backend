import type { ConfigService } from '@nestjs/config';
import type postgres from 'postgres';
import type { Env } from '../../config/env.js';
import type { DatabaseService } from '../database/database.service.js';
import { type LiveEvent, LiveEventsService } from './live-events.service.js';

/** A database whose every select returns `rows` (deliver reads notifications, then counts). */
function fakeDatabase(rows: unknown[]) {
  // where() is awaited for the unread count, or continued with orderBy() for the rows.
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () =>
      Object.assign(Promise.resolve([{ count: 3 }]), {
        orderBy: () => Promise.resolve(rows),
      }),
  };
  return { db: chain } as unknown as DatabaseService;
}

function fakeClient() {
  let handler: ((payload: string) => void) | undefined;
  const sent: { channel: string; payload: string }[] = [];
  const client = {
    listen: (_channel: string, fn: (payload: string) => void) => {
      handler = fn;
      return Promise.resolve({ unlisten: () => Promise.resolve() });
    },
    notify: (channel: string, payload: string) => {
      sent.push({ channel, payload });
      return Promise.resolve();
    },
  };
  return {
    client: client as unknown as postgres.Sql,
    sent,
    receive: (payload: object) => handler?.(JSON.stringify(payload)),
  };
}

const config = (fanout: boolean) =>
  ({ get: () => fanout }) as unknown as ConfigService<Env, true>;

const row = {
  id: '00000000-0000-4000-8000-000000000001',
  userId: 'u1',
  kind: 'test',
  title: 'Hello',
  body: null,
  link: null,
  conferenceId: null,
  submissionId: null,
  readAt: null,
  createdAt: new Date('2027-01-01T00:00:00Z'),
};

describe('LiveEventsService fan-out', () => {
  it('announces new notifications in chunks, tagged with this instance', async () => {
    const pg = fakeClient();
    const live = new LiveEventsService(
      fakeDatabase([]),
      pg.client,
      config(true),
    );
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    await live.publish(ids);
    expect(pg.sent.map((m) => m.channel)).toEqual([
      'sc_live_events',
      'sc_live_events',
      'sc_live_events',
    ]);
    const first = JSON.parse(pg.sent[0].payload) as {
      from: string;
      ids: string[];
    };
    expect(first.ids).toHaveLength(100);
    expect(first.from).toEqual(expect.any(String));
  });

  it('pushes what another instance announces, and ignores its own', async () => {
    const pg = fakeClient();
    const live = new LiveEventsService(
      fakeDatabase([row]),
      pg.client,
      config(true),
    );
    await live.onApplicationBootstrap();
    const got: LiveEvent[] = [];
    live.subscribe({
      userId: 'u1',
      send: (e) => got.push(e),
      close: () => undefined,
    });

    await live.publish([row.id]); // delivered here directly, announced once
    const own = JSON.parse(pg.sent[0].payload) as object;
    pg.receive(own); // our own announcement coming back: ignored
    pg.receive({ from: 'other-instance', ids: [row.id] });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(2);
    expect(got[1]).toMatchObject({
      type: 'notification',
      data: { notification: { title: 'Hello' }, unread: 3 },
    });
  });

  it('stays on this instance when fan-out is off', async () => {
    const pg = fakeClient();
    const live = new LiveEventsService(
      fakeDatabase([]),
      pg.client,
      config(false),
    );
    await live.onApplicationBootstrap();
    await live.publish(['x']);
    expect(pg.sent).toEqual([]);
  });
});
