import {
  createRemoteJWKSet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Extra authorization parameters (e.g. prompt). */
  authorizationParams?: Record<string, string>;
}

interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/**
 * Authorization-code flow with PKCE against one OpenID Connect provider. Discovery and keys are
 * fetched once and cached; ID tokens are verified with `jose` (signature, issuer, audience,
 * expiry, nonce).
 */
export class OidcClient {
  private metadata?: Promise<Metadata>;
  private jwks?: JWTVerifyGetKey;

  constructor(private readonly config: OidcProviderConfig) {}

  async authorizationUrl(params: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string> {
    const { authorization_endpoint } = await this.discover();
    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: params.redirectUri,
      scope: this.config.scopes.join(' '),
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      ...this.config.authorizationParams,
    }).toString();
    return url.toString();
  }

  /** Exchanges the code and returns the verified ID token claims. */
  async exchange(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<JWTPayload> {
    const metadata = await this.discover();
    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Token endpoint responded ${response.status}`);
    }
    const body = (await response.json()) as { id_token?: unknown };
    if (typeof body.id_token !== 'string') {
      throw new Error('Token response has no id_token');
    }

    this.jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri));
    const { payload } = await jwtVerify(body.id_token, this.jwks, {
      audience: this.config.clientId,
    });
    if (payload.iss !== expectedIssuer(metadata.issuer, payload)) {
      throw new Error(`Unexpected issuer ${String(payload.iss)}`);
    }
    if (payload.nonce !== params.nonce) {
      throw new Error('Nonce mismatch');
    }
    return payload;
  }

  private discover(): Promise<Metadata> {
    this.metadata ??= (async () => {
      const url = `${this.config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Discovery failed for ${url}: ${response.status}`);
      }
      return (await response.json()) as Metadata;
    })().catch((error: unknown) => {
      this.metadata = undefined; // try again next time
      throw error;
    });
    return this.metadata;
  }
}

/**
 * Microsoft's multi-tenant metadata advertises the issuer as a template
 * (https://login.microsoftonline.com/{tenantid}/v2.0); the token's own tenant fills it in.
 */
function expectedIssuer(advertised: string, claims: JWTPayload): string {
  return advertised.includes('{tenantid}') && typeof claims.tid === 'string'
    ? advertised.replace('{tenantid}', claims.tid)
    : advertised;
}
