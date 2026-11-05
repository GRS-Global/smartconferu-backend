import type { JWTPayload } from 'jose';
import request from 'supertest';
import {
  API_URL,
  APP_ORIGIN,
  APP_URL,
  cookieFrom,
  createTestApp,
  emailCode,
  linkToken,
  type TestApp,
} from './support/test-app.js';

const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

describe('Sign-in with Google, Microsoft and ORCID', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());

  /** Runs the whole browser flow; returns where the API sent the browser back to, and its cookies. */
  async function providerSignIn(
    provider: string,
    claims: JWTPayload,
    {
      returnTo = '/dashboard',
      bearer,
      terms,
    }: { returnTo?: string; bearer?: string; terms?: string } = {},
  ) {
    let authorizeUrl: string;
    let stateCookie: string | undefined;
    if (bearer) {
      const res = await http()
        .post(`/api/v1/auth/oauth/${provider}/link`)
        .set('Authorization', `Bearer ${bearer}`)
        .send({ returnTo })
        .expect(200);
      authorizeUrl = res.body.url;
      stateCookie = cookieFrom(res.headers['set-cookie'], 'sc_oauth');
    } else {
      const res = await http()
        .get(`/api/v1/auth/oauth/${provider}/start`)
        .query({ returnTo, ...(terms ? { terms } : {}) })
        .expect(302);
      authorizeUrl = res.headers.location;
      stateCookie = cookieFrom(res.headers['set-cookie'], 'sc_oauth');
    }
    const { code, state } = t.oidc.approve(authorizeUrl, claims);
    const callback = await http()
      .get(`/api/v1/auth/oauth/${provider}/callback`)
      .query({ code, state })
      .set('Cookie', stateCookie ?? '')
      .expect(302);
    const landing = new URL(callback.headers.location);
    return {
      authorizeUrl: new URL(authorizeUrl),
      landing,
      params: Object.fromEntries(landing.searchParams),
      refresh: cookieFrom(callback.headers['set-cookie'], 'sc_refresh'),
      mfa: cookieFrom(callback.headers['set-cookie'], 'sc_mfa'),
    };
  }

  const accessTokenFrom = async (refresh: string) =>
    (
      await http()
        .post('/api/v1/auth/refresh')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', refresh)
        .expect(200)
    ).body.accessToken as string;

  const userCount = async () =>
    (await t.db.query<{ n: number }>('select count(*)::int as n from users'))
      .rows[0].n;

  it('lists the configured providers', async () => {
    const res = await http().get('/api/v1/auth/providers').expect(200);
    expect(res.body).toEqual({ providers: ['google', 'microsoft', 'orcid'] });
  });

  it('sends the browser to the provider with PKCE, state and nonce', async () => {
    const res = await http().get('/api/v1/auth/oauth/google/start').expect(302);
    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe(
      `${t.oidc.issuer('google')}/authorize`,
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'google-client',
      redirect_uri: `${API_URL}/api/v1/auth/oauth/google/callback`,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(String(res.headers['set-cookie'])).toMatch(
      /sc_oauth=.+; Path=\/api\/v1\/auth; .*HttpOnly/,
    );
  });

  describe('Google', () => {
    const ada = {
      sub: 'google-ada',
      email: 'Ada@Gmail.com',
      email_verified: true,
      given_name: 'Ada',
      family_name: 'Lovelace',
    };

    it('creates a verified account for a new Google user and signs in', async () => {
      const result = await providerSignIn('google', ada);
      expect(result.landing.origin + result.landing.pathname).toBe(
        `${APP_URL}/auth/callback`,
      );
      expect(result.params).toEqual({
        next: '/dashboard',
        status: 'signed_in',
      });

      const token = await accessTokenFrom(result.refresh!);
      const me = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body).toMatchObject({
        email: 'ada@gmail.com',
        emailVerified: true,
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
    });

    it('records the Terms accepted next to the sign-in buttons', async () => {
      const result = await providerSignIn('google', ada, {
        terms: '2026-10-01',
      });
      const token = await accessTokenFrom(result.refresh!);
      const me = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body.termsVersion).toBe('2026-10-01');
      expect(me.body.termsAcceptedAt).toBeTruthy();

      // A later sign-in with another version doesn't overwrite the record.
      await providerSignIn('google', ada, { terms: '2027-01-01' });
      const { rows } = await t.db.query<{ terms_version: string }>(
        'select terms_version from users',
      );
      expect(rows).toEqual([{ terms_version: '2026-10-01' }]);
    });

    it('accepts the Terms later through /me/terms', async () => {
      const result = await providerSignIn('google', ada);
      const token = await accessTokenFrom(result.refresh!);
      const before = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(before.body.termsVersion).toBeNull();

      const after = await http()
        .post('/api/v1/me/terms')
        .set('Authorization', `Bearer ${token}`)
        .send({ version: '2026-10-01' })
        .expect(200);
      expect(after.body.termsVersion).toBe('2026-10-01');
    });

    it('signs a returning Google user in to the same account', async () => {
      await providerSignIn('google', ada);
      await providerSignIn('google', { ...ada, given_name: 'Augusta' });
      expect(await userCount()).toBe(1);
    });

    it('links to an existing account when Google has verified the same address', async () => {
      const existing = await t.createUser({ email: 'ada@gmail.com' });
      const result = await providerSignIn('google', ada);
      expect(result.params.status).toBe('signed_in');
      expect(await userCount()).toBe(1);

      const identities = await http()
        .get('/api/v1/auth/identities')
        .set('Authorization', `Bearer ${await t.tokenFor(existing.id)}`)
        .expect(200);
      expect(identities.body).toEqual([
        expect.objectContaining({ provider: 'google', email: 'Ada@Gmail.com' }),
      ]);
      expect(t.outbox().at(-1)?.subject).toBe(
        'Google sign-in added to your account',
      );
    });

    it('never links on an address Google has not verified', async () => {
      await t.createUser({ email: 'ada@gmail.com' });
      await providerSignIn('google', { ...ada, email_verified: false });
      expect(await userCount()).toBe(2);
      const { rows } = await t.db.query<{ email: string | null }>(
        `select u.email from users u join user_identities i on i.user_id = u.id`,
      );
      expect(rows).toEqual([{ email: null }]);
    });
  });

  describe('Microsoft', () => {
    it('accepts tokens from any tenant on the multi-tenant endpoint', async () => {
      const result = await providerSignIn('microsoft', {
        sub: 'ms-1',
        tid: '72f988bf-86f1-41af-91ab-2d7cd011db47',
        email: 'grace@contoso.com',
        name: 'Grace Hopper',
      });
      expect(result.params.status).toBe('signed_in');
    });

    it('does not trust a work-account email without xms_edov', async () => {
      await t.createUser({ email: 'grace@contoso.com' });
      await providerSignIn('microsoft', {
        sub: 'ms-2',
        tid: '72f988bf-86f1-41af-91ab-2d7cd011db47',
        email: 'grace@contoso.com',
      });
      expect(await userCount()).toBe(2);
    });

    it('trusts personal Microsoft accounts and verified domains', async () => {
      await t.createUser({ email: 'grace@outlook.com' });
      await providerSignIn('microsoft', {
        sub: 'ms-3',
        tid: CONSUMER_TENANT,
        email: 'grace@outlook.com',
      });
      expect(await userCount()).toBe(1);
    });
  });

  describe('ORCID', () => {
    const orcid = {
      sub: '0000-0002-1825-0097',
      given_name: 'Josiah',
      family_name: 'Carberry',
    };

    it('creates an account without an email and records the ORCID iD', async () => {
      const result = await providerSignIn('orcid', orcid);
      const token = await accessTokenFrom(result.refresh!);
      const me = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body).toMatchObject({
        email: null,
        emailVerified: false,
        firstName: 'Josiah',
        orcidId: '0000-0002-1825-0097',
      });
    });

    it('lets the new account add an email address by confirming it', async () => {
      const result = await providerSignIn('orcid', orcid);
      const bearer = `Bearer ${await accessTokenFrom(result.refresh!)}`;
      await http()
        .post('/api/v1/auth/email/change')
        .set('Authorization', bearer)
        .send({ newEmail: 'josiah@brown.edu' })
        .expect(202);
      await http()
        .post('/api/v1/auth/email/change/confirm')
        .send({ token: linkToken(t.outbox().at(-1)!.text) })
        .expect(204);
      const me = await http()
        .get('/api/v1/me')
        .set('Authorization', bearer)
        .expect(200);
      expect(me.body).toMatchObject({
        email: 'josiah@brown.edu',
        emailVerified: true,
      });
    });

    it('connects to the existing account that owns the address, after a code', async () => {
      const existing = await t.createUser({ email: 'josiah@brown.edu' });
      const result = await providerSignIn('orcid', orcid);
      const bearer = `Bearer ${await accessTokenFrom(result.refresh!)}`;

      const taken = await http()
        .post('/api/v1/auth/email/change')
        .set('Authorization', bearer)
        .send({ newEmail: 'josiah@brown.edu' })
        .expect(409);
      expect(taken.body).toMatchObject({
        code: 'AUTH_EMAIL_IN_USE',
        details: { canMerge: true },
      });

      await http()
        .post('/api/v1/auth/account/merge')
        .set('Authorization', bearer)
        .send({ email: 'josiah@brown.edu' })
        .expect(202);
      const merged = await http()
        .post('/api/v1/auth/account/merge/verify')
        .set('Authorization', bearer)
        .send({
          email: 'josiah@brown.edu',
          code: emailCode(t.outbox().at(-1)!.text),
        })
        .expect(200);
      expect(merged.body.user.id).toBe(existing.id);
      expect(await userCount()).toBe(1);

      // From now on, ORCID signs in to the existing account.
      const again = await providerSignIn('orcid', orcid);
      const againToken = await accessTokenFrom(again.refresh!);
      const me = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${againToken}`)
        .expect(200);
      expect(me.body.id).toBe(existing.id);
    });

    it('refuses to merge an account that has a password', async () => {
      const user = await t.createUser();
      await http()
        .post('/api/v1/auth/account/merge')
        .set('Authorization', `Bearer ${await t.tokenFor(user.id)}`)
        .send({ email: 'someone@example.org' })
        .expect(403);
    });
  });

  describe('linking and unlinking', () => {
    it('connects a provider to the signed-in account', async () => {
      const user = await t.createUser();
      const bearer = await t.tokenFor(user.id);
      const result = await providerSignIn(
        'microsoft',
        { sub: 'ms-link', tid: 'tenant-1', email: 'x@contoso.com' },
        { bearer, returnTo: '/settings' },
      );
      expect(result.params).toEqual({
        next: '/settings',
        status: 'linked',
        provider: 'microsoft',
      });
      expect(result.refresh).toBeUndefined();

      const identities = await http()
        .get('/api/v1/auth/identities')
        .set('Authorization', `Bearer ${bearer}`)
        .expect(200);
      expect(
        identities.body.map((i: { provider: string }) => i.provider),
      ).toEqual(['microsoft']);
    });

    it('refuses a provider account that belongs to someone else', async () => {
      await providerSignIn('google', {
        sub: 'g-shared',
        email: 'a@b.c',
        email_verified: true,
      });
      const other = await t.createUser();
      const result = await providerSignIn(
        'google',
        { sub: 'g-shared', email: 'a@b.c', email_verified: true },
        { bearer: await t.tokenFor(other.id) },
      );
      expect(result.params.error).toBe('identity_in_use');
    });

    it('keeps at least one way to sign in', async () => {
      const result = await providerSignIn('orcid', {
        sub: '0000-0001-0000-0001',
      });
      const bearer = `Bearer ${await accessTokenFrom(result.refresh!)}`;
      const [identity] = (
        await http().get('/api/v1/auth/identities').set('Authorization', bearer)
      ).body;
      const res = await http()
        .delete(`/api/v1/auth/identities/${identity.id}`)
        .set('Authorization', bearer)
        .expect(409);
      expect(res.body.code).toBe('AUTH_LAST_SIGN_IN_METHOD');
    });

    it('unlinks a provider when the account also has a password', async () => {
      const user = await t.createUser();
      const bearer = await t.tokenFor(user.id);
      await providerSignIn(
        'google',
        { sub: 'g-unlink', email: 'q@r.s', email_verified: false },
        { bearer },
      );
      const [identity] = (
        await http()
          .get('/api/v1/auth/identities')
          .set('Authorization', `Bearer ${bearer}`)
      ).body;
      await http()
        .delete(`/api/v1/auth/identities/${identity.id}`)
        .set('Authorization', `Bearer ${bearer}`)
        .expect(204);
    });
  });

  describe('failures', () => {
    it('refuses a callback without the matching state cookie', async () => {
      const start = await http()
        .get('/api/v1/auth/oauth/google/start')
        .expect(302);
      const { code, state } = t.oidc.approve(start.headers.location, {
        sub: 'x',
      });
      const res = await http()
        .get('/api/v1/auth/oauth/google/callback')
        .query({ code, state })
        .expect(302);
      expect(new URL(res.headers.location).searchParams.get('error')).toBe(
        'invalid_state',
      );
    });

    it('reports a cancelled sign-in', async () => {
      const start = await http()
        .get('/api/v1/auth/oauth/google/start')
        .expect(302);
      const state = new URL(start.headers.location).searchParams.get('state');
      const res = await http()
        .get('/api/v1/auth/oauth/google/callback')
        .query({ state, error: 'access_denied' })
        .set('Cookie', cookieFrom(start.headers['set-cookie'], 'sc_oauth')!)
        .expect(302);
      expect(new URL(res.headers.location).searchParams.get('error')).toBe(
        'cancelled',
      );
    });

    it('never redirects outside the app', async () => {
      const result = await providerSignIn(
        'google',
        { sub: 'g-r' },
        { returnTo: '//evil.example/x' },
      );
      expect(result.params.next).toBe('/');
    });

    it('answers 404 for a provider that is not configured', async () => {
      const res = await http()
        .get('/api/v1/auth/oauth/github/start')
        .expect(404);
      expect(res.body.code).toBe('AUTH_PROVIDER_NOT_CONFIGURED');
    });
  });
});
