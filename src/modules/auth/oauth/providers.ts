import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JWTPayload } from 'jose';
import type { Env } from '../../../config/env.js';
import type { authProvider } from '../../../core/database/schema/index.js';
import { OidcClient } from './oidc-client.js';

export type ProviderId = (typeof authProvider.enumValues)[number];
export const PROVIDER_IDS: readonly ProviderId[] = [
  'google',
  'microsoft',
  'orcid',
];

/** What we take from a provider's ID token. */
export interface ProviderProfile {
  providerUserId: string;
  /** Only set when the provider vouches for it. */
  verifiedEmail: string | null;
  /** Whatever address the provider reported, verified or not (kept on the identity). */
  email: string | null;
  firstName: string;
  lastName: string;
}

// Personal Microsoft accounts (outlook.com, hotmail.com…) all sign in through this tenant.
const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function names(claims: JWTPayload): { firstName: string; lastName: string } {
  const first = text(claims.given_name);
  const last = text(claims.family_name);
  if (first || last) {
    return { firstName: first ?? '', lastName: last ?? '' };
  }
  const [head = '', ...rest] = (text(claims.name) ?? '').split(/\s+/);
  return { firstName: head, lastName: rest.join(' ') };
}

const PROFILE: Record<ProviderId, (claims: JWTPayload) => ProviderProfile> = {
  google: (claims) => {
    const email = text(claims.email);
    return {
      providerUserId: String(claims.sub),
      email,
      verifiedEmail: claims.email_verified === true ? email : null,
      ...names(claims),
    };
  },
  microsoft: (claims) => {
    const email = text(claims.email) ?? text(claims.preferred_username);
    // A work or school tenant can set any address on its users, so Microsoft's email is only
    // trusted when Entra says the domain owner verified it (optional claim `xms_edov`), or for
    // personal Microsoft accounts.
    const verified =
      claims.xms_edov === true ||
      claims.xms_edov === 'true' ||
      claims.tid === MICROSOFT_CONSUMER_TENANT;
    return {
      providerUserId: String(claims.sub),
      email,
      verifiedEmail: verified ? email : null,
      ...names(claims),
    };
  },
  // `sub` is the ORCID iD. ORCID gives no email in the ID token; the user adds one afterwards.
  orcid: (claims) => ({
    providerUserId: String(claims.sub),
    email: null,
    verifiedEmail: null,
    ...names(claims),
  }),
};

export interface Provider {
  id: ProviderId;
  client: OidcClient;
  profile: (claims: JWTPayload) => ProviderProfile;
}

/** The sign-in providers that are configured (client id and secret both set). */
@Injectable()
export class OAuthProviders {
  private readonly providers = new Map<ProviderId, Provider>();

  constructor(config: ConfigService<Env, true>) {
    const add = (
      id: ProviderId,
      clientId: string | undefined,
      clientSecret: string | undefined,
      issuer: string,
      scopes: string[],
      authorizationParams?: Record<string, string>,
    ) => {
      if (clientId && clientSecret) {
        this.providers.set(id, {
          id,
          client: new OidcClient({
            issuer,
            clientId,
            clientSecret,
            scopes,
            authorizationParams,
          }),
          profile: PROFILE[id],
        });
      }
    };

    add(
      'google',
      config.get('GOOGLE_CLIENT_ID', { infer: true }),
      config.get('GOOGLE_CLIENT_SECRET', { infer: true }),
      config.get('GOOGLE_ISSUER', { infer: true }),
      ['openid', 'email', 'profile'],
      { prompt: 'select_account' },
    );
    add(
      'microsoft',
      config.get('MICROSOFT_CLIENT_ID', { infer: true }),
      config.get('MICROSOFT_CLIENT_SECRET', { infer: true }),
      config.get('MICROSOFT_ISSUER', { infer: true }) ??
        `https://login.microsoftonline.com/${config.get('MICROSOFT_TENANT', { infer: true })}/v2.0`,
      ['openid', 'email', 'profile'],
      { prompt: 'select_account' },
    );
    add(
      'orcid',
      config.get('ORCID_CLIENT_ID', { infer: true }),
      config.get('ORCID_CLIENT_SECRET', { infer: true }),
      config.get('ORCID_ISSUER', { infer: true }),
      ['openid'],
    );
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id as ProviderId);
  }

  enabled(): ProviderId[] {
    return PROVIDER_IDS.filter((id) => this.providers.has(id));
  }
}
