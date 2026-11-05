import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import { safeReturnTo } from './oauth.service.js';
import { OAuthProviders } from './providers.js';

describe('safeReturnTo', () => {
  it.each(['/', '/dashboard', '/conferences/icx?tab=reviews#top'])(
    'keeps %j',
    (path) => {
      expect(safeReturnTo(path)).toBe(path);
    },
  );

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'dashboard',
    '/a b',
    undefined,
    42,
  ])('replaces %j with /', (value) => {
    expect(safeReturnTo(value)).toBe('/');
  });
});

describe('provider profiles', () => {
  const config = (values: Partial<Record<keyof Env, string>>) =>
    ({ get: (key: keyof Env) => values[key] }) as unknown as ConfigService<
      Env,
      true
    >;
  const providers = new OAuthProviders(
    config({
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 'g',
      GOOGLE_ISSUER: 'https://accounts.google.com',
      MICROSOFT_CLIENT_ID: 'm',
      MICROSOFT_CLIENT_SECRET: 'm',
      MICROSOFT_TENANT: 'common',
      ORCID_CLIENT_ID: 'o',
      ORCID_CLIENT_SECRET: 'o',
      ORCID_ISSUER: 'https://orcid.org',
    }),
  );
  const profile = (id: string, claims: Record<string, unknown>) =>
    providers.get(id)!.profile(claims);

  it('offers only providers with both id and secret', () => {
    expect(
      new OAuthProviders(config({ GOOGLE_CLIENT_ID: 'g' })).enabled(),
    ).toEqual([]);
    expect(providers.enabled()).toEqual(['google', 'microsoft', 'orcid']);
  });

  it('trusts a Google email only when email_verified is true', () => {
    expect(
      profile('google', { sub: '1', email: 'a@b.c', email_verified: true })
        .verifiedEmail,
    ).toBe('a@b.c');
    expect(
      profile('google', { sub: '1', email: 'a@b.c', email_verified: 'true' })
        .verifiedEmail,
    ).toBeNull();
  });

  it('trusts a Microsoft email for personal accounts or with xms_edov only', () => {
    const base = { sub: '1', email: 'a@contoso.com' };
    expect(
      profile('microsoft', { ...base, tid: 'some-tenant' }).verifiedEmail,
    ).toBeNull();
    expect(
      profile('microsoft', { ...base, tid: 'some-tenant', xms_edov: true })
        .verifiedEmail,
    ).toBe('a@contoso.com');
    expect(
      profile('microsoft', {
        ...base,
        tid: '9188040d-6c67-4c5b-b112-36a304b66dad',
      }).verifiedEmail,
    ).toBe('a@contoso.com');
  });

  it('takes the ORCID iD as the account id and splits a full name', () => {
    expect(
      profile('orcid', {
        sub: '0000-0002-1825-0097',
        name: 'Josiah Stinkney Carberry',
      }),
    ).toEqual({
      providerUserId: '0000-0002-1825-0097',
      email: null,
      verifiedEmail: null,
      firstName: 'Josiah',
      lastName: 'Stinkney Carberry',
    });
  });
});
