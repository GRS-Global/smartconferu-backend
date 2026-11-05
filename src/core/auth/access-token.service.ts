import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exportJWK, type JWK, jwtVerify, SignJWT } from 'jose';
import type { Env } from '../../config/env.js';
import type { AuthUser } from './auth-user.js';

export const TOKEN_ISSUER = 'smartconferu-api';
export const TOKEN_AUDIENCE = 'smartconferu';
const MFA_CHALLENGE_AUDIENCE = 'smartconferu-mfa';
export const MFA_CHALLENGE_TTL_SECONDS = 300;

/**
 * Short-lived access tokens: Ed25519-signed JWTs carrying the user id (`sub`) and session
 * family (`sid`). Anything holding the public key (JWKS at /.well-known/jwks.json) can verify them.
 */
@Injectable()
export class AccessTokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly keyId: string;
  readonly ttlSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    this.privateKey = createPrivateKey(
      config.get('JWT_PRIVATE_KEY', { infer: true }),
    );
    if (this.privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('JWT_PRIVATE_KEY must be an Ed25519 key');
    }
    this.publicKey = createPublicKey(this.privateKey);
    this.keyId = config.get('JWT_KEY_ID', { infer: true });
    this.ttlSeconds = config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true });
  }

  /** `mfa`: the session passed a second factor (required for super-admin powers). */
  issue(userId: string, sessionId: string, mfa = false): Promise<string> {
    return new SignJWT({ sid: sessionId, ...(mfa ? { mfa: true } : {}) })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keyId, typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .setJti(randomUUID())
      .sign(this.privateKey);
  }

  /** Resolves to the user, or rejects if the token is invalid or expired. */
  async verify(token: string): Promise<AuthUser> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      algorithms: ['EdDSA'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new Error('Token is missing sub or sid');
    }
    return {
      id: payload.sub,
      sessionId: payload.sid,
      mfa: payload.mfa === true,
    };
  }

  /**
   * Proof that a user passed the first step of sign-in and now owes a second factor. Signed with
   * the same key but for a different audience, so it can never be used as an access token.
   */
  issueMfaChallenge(userId: string, method: string): Promise<string> {
    return new SignJWT({ method })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keyId, typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(MFA_CHALLENGE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${MFA_CHALLENGE_TTL_SECONDS}s`)
      .setJti(randomUUID())
      .sign(this.privateKey);
  }

  async verifyMfaChallenge(
    token: string,
  ): Promise<{ userId: string; method: string }> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: TOKEN_ISSUER,
      audience: MFA_CHALLENGE_AUDIENCE,
      algorithms: ['EdDSA'],
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('Challenge is missing sub');
    }
    return {
      userId: payload.sub,
      method: typeof payload.method === 'string' ? payload.method : 'unknown',
    };
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    const jwk = await exportJWK(this.publicKey);
    return { keys: [{ ...jwk, kid: this.keyId, alg: 'EdDSA', use: 'sig' }] };
  }
}
