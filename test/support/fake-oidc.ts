import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  type CryptoKey,
  SignJWT,
} from 'jose';

interface PendingCode {
  claims: JWTPayload;
  challenge: string;
  clientId: string;
}

/**
 * A stand-in for Google, Microsoft and ORCID: discovery, JWKS and a token endpoint that checks
 * PKCE and issues signed ID tokens. Tests take the authorization URL the API redirects to, pick
 * the claims the "provider" should return with `approve`, and call the API's callback.
 *
 * Microsoft advertises its issuer as a `{tenantid}` template, like the real multi-tenant endpoint.
 */
export class FakeOidcProvider {
  private server?: Server;
  private privateKey?: CryptoKey;
  private jwk?: Record<string, unknown>;
  private readonly codes = new Map<string, PendingCode>();
  baseUrl = '';

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    this.privateKey = privateKey;
    this.jwk = {
      ...(await exportJWK(publicKey)),
      kid: 'fake-1',
      alg: 'RS256',
      use: 'sig',
    };
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  issuer(provider: string): string {
    return `${this.baseUrl}/${provider}`;
  }

  /**
   * Plays the user approving the sign-in at `authorizeUrl`: returns the `code` and `state` the
   * provider would send back. `claims` become the ID token (iss, aud, nonce are filled in).
   */
  approve(
    authorizeUrl: string,
    claims: JWTPayload,
  ): { code: string; state: string } {
    const url = new URL(authorizeUrl);
    const provider = url.pathname.split('/')[1];
    const nonce = url.searchParams.get('nonce') ?? '';
    const tid = typeof claims.tid === 'string' ? claims.tid : 'tenant-0';
    const iss =
      provider === 'microsoft'
        ? `${this.issuer(provider)}/${tid}/v2.0`
        : this.issuer(provider);
    const code = `code-${this.codes.size + 1}-${Date.now()}`;
    this.codes.set(code, {
      claims: { ...claims, iss, nonce },
      challenge: url.searchParams.get('code_challenge') ?? '',
      clientId: url.searchParams.get('client_id') ?? '',
    });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    const [, provider, ...rest] = url.pathname.split('/');
    const path = rest.join('/');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (path === '.well-known/openid-configuration') {
      const issuer =
        provider === 'microsoft'
          ? `${this.issuer(provider)}/{tenantid}/v2.0`
          : this.issuer(provider);
      return json(200, {
        issuer,
        authorization_endpoint: `${this.issuer(provider)}/authorize`,
        token_endpoint: `${this.issuer(provider)}/token`,
        jwks_uri: `${this.issuer(provider)}/jwks`,
      });
    }
    if (path === 'jwks') {
      return json(200, { keys: [this.jwk] });
    }
    if (path === 'token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const form = new URLSearchParams(raw);
      const pending = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256')
        .update(verifier)
        .digest('base64url');
      if (
        !pending ||
        challenge !== pending.challenge ||
        form.get('client_id') !== pending.clientId
      ) {
        return json(400, { error: 'invalid_grant' });
      }
      const idToken = await new SignJWT(pending.claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'fake-1' })
        .setAudience(pending.clientId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.privateKey!);
      return json(200, {
        access_token: 'unused',
        token_type: 'Bearer',
        id_token: idToken,
      });
    }
    json(404, { error: 'not_found' });
  }
}
