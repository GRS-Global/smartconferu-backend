import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { SseClient } from './support/sse-client.js';
import {
  createTestApp,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('Live events (Server-Sent Events)', () => {
  let t: TestApp;
  let base: string;
  let notify: (userIds: string[], title: string) => Promise<void>;
  let live: { openStreams: number };
  const clients: SseClient[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    const server = t.app.getHttpServer() as Server;
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

    const { NotificationsService } =
      await import('../src/core/notifications/notifications.service.js');
    const { DatabaseService } =
      await import('../src/core/database/database.service.js');
    const { LiveEventsService } =
      await import('../src/core/realtime/live-events.service.js');
    const service = t.app.get(NotificationsService);
    const database = t.app.get(DatabaseService);
    live = t.app.get(LiveEventsService);
    notify = (userIds, title) =>
      database.transaction((tx) =>
        service.notify(tx, userIds, { kind: 'test', title }),
      );
  });
  afterAll(() => t.close());
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t.reset();
  });

  const http = () => request(t.app.getHttpServer());

  async function person(): Promise<TestUser & { token: string }> {
    const user = await t.createUser();
    return { ...user, token: await t.tokenFor(user.id) };
  }

  async function ticketFor(token: string): Promise<string> {
    const res = await http()
      .post('/api/v1/me/events/ticket')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.expiresIn).toBe(60);
    return res.body.ticket as string;
  }

  async function stream(
    token: string,
    extra = '',
    headers: Record<string, string> = {},
  ) {
    const client = new SseClient();
    clients.push(client);
    await client.open(
      `${base}/me/events?ticket=${encodeURIComponent(await ticketFor(token))}${extra}`,
      headers,
    );
    await client.next((e) => e.event === 'ready');
    return client;
  }

  it('pushes a new notification to its user the moment it is saved', async () => {
    const me = await person();
    await notify([me.id], 'Before');
    const client = await stream(me.token);
    expect(client.status).toBe(200);
    expect(client.events[0]).toMatchObject({
      event: 'ready',
      data: { unread: 1 },
    });

    await notify([me.id], 'New paper to review');
    const event = await client.next();
    expect(event.id).toEqual(expect.any(String));
    expect(event.data).toMatchObject({
      notification: {
        kind: 'test',
        title: 'New paper to review',
        readAt: null,
      },
      unread: 2,
    });
  });

  it('sends nothing for a rolled-back change, and only to the right user', async () => {
    const me = await person();
    const other = await person();
    const mine = await stream(me.token);
    const theirs = await stream(other.token);

    const { DatabaseService } =
      await import('../src/core/database/database.service.js');
    const { NotificationsService } =
      await import('../src/core/notifications/notifications.service.js');
    await t.app
      .get(DatabaseService)
      .transaction(async (tx) => {
        await t.app
          .get(NotificationsService)
          .notify(tx, [me.id], { kind: 'test', title: 'Rolled back' });
        throw new Error('roll back');
      })
      .catch(() => undefined);

    await notify([other.id], 'For the other user');
    await theirs.next();
    await new Promise((r) => setTimeout(r, 200));
    expect(mine.notifications()).toEqual([]);
  });

  it('works for a real change: an invitation reaches the invitee live', async () => {
    const chair = await person();
    const invitee = await person();
    const created = await http()
      .post('/api/v1/conferences')
      .set('Authorization', `Bearer ${chair.token}`)
      .send({
        acronym: 'ICX 2027',
        title: 'International Conference X 2027',
        startDate: '2027-06-01',
        endDate: '2027-06-03',
      })
      .expect(201);
    const client = await stream(invitee.token);
    await http()
      .post(`/api/v1/conferences/${created.body.id}/members`)
      .set('Authorization', `Bearer ${chair.token}`)
      .send({ email: invitee.email })
      .expect(201);
    const event = await client.next();
    expect(event.data).toMatchObject({
      notification: { conferenceId: created.body.id },
      unread: 1,
    });
  });

  it('sends what was missed after a reconnect (Last-Event-ID)', async () => {
    const me = await person();
    const first = await stream(me.token);
    await notify([me.id], 'One');
    const seen = await first.next();
    first.close();

    await notify([me.id], 'Two');
    await notify([me.id], 'Three');
    const again = await stream(me.token, '', { 'last-event-id': seen.id! });
    await again.next(
      (e) =>
        (e.data as { notification?: { title: string } }).notification?.title ===
        'Three',
    );
    expect(
      again
        .notifications()
        .map(
          (e) =>
            (e.data as { notification: { title: string } }).notification.title,
        ),
    ).toEqual(['Two', 'Three']);

    // The query parameter works the same (for an app that opens a new EventSource).
    const third = await stream(
      me.token,
      `&lastEventId=${encodeURIComponent(seen.id!)}`,
    );
    await third.next();
    expect(third.notifications()).toHaveLength(2);
  });

  it('accepts a bearer token, refuses bad tickets and access tokens as tickets', async () => {
    const me = await person();
    const withBearer = new SseClient();
    clients.push(withBearer);
    await withBearer.open(`${base}/me/events`, {
      authorization: `Bearer ${me.token}`,
    });
    expect(withBearer.status).toBe(200);

    await http().get('/api/v1/me/events').expect(401);
    await http().get('/api/v1/me/events?ticket=nonsense').expect(401);
    // An access token is not a ticket (different audience), and a ticket is not an access token.
    await http().get(`/api/v1/me/events?ticket=${me.token}`).expect(401);
    const ticket = await ticketFor(me.token);
    await http()
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${ticket}`)
      .expect(401);
    await http().post('/api/v1/me/events/ticket').expect(401);

    await t.db.query(`update users set status = 'disabled' where id = $1`, [
      me.id,
    ]);
    await http().get(`/api/v1/me/events?ticket=${ticket}`).expect(401);
  });

  it('keeps at most five streams per user, closing the oldest', async () => {
    const me = await person();
    const opened: SseClient[] = [];
    for (let i = 0; i < 6; i++) {
      opened.push(await stream(me.token));
    }
    await opened[0].next((e) => e.event === 'expired');
    expect(opened[0].events.at(-1)).toMatchObject({
      event: 'expired',
      data: { reason: 'replaced' },
    });
    expect(live.openStreams).toBe(5);
    opened.forEach((c) => c.close());
    await new Promise((r) => setTimeout(r, 200));
    expect(live.openStreams).toBe(0);
  });
});
