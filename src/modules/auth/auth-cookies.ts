import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import type { Env } from '../../config/env.js';
import { MFA_CHALLENGE_TTL_SECONDS } from '../../core/auth/access-token.service.js';
import { AppException } from '../../core/errors/app.exception.js';
import { API_PREFIX } from '../../setup-app.js';

export const REFRESH_COOKIE = 'sc_refresh';
export const MFA_COOKIE = 'sc_mfa';
export const OAUTH_STATE_COOKIE = 'sc_oauth';
export const OAUTH_STATE_TTL_SECONDS = 600;

/**
 * The httpOnly cookies the auth endpoints use: the refresh token, the pending second-factor
 * challenge, and the state of a provider sign-in in progress. All are scoped to /api/v1/auth, so
 * they never travel with ordinary API calls.
 */
@Injectable()
export class AuthCookies {
  private readonly base: CookieOptions;
  private readonly allowedOrigins: Set<string>;

  constructor(config: ConfigService<Env, true>) {
    this.base = {
      httpOnly: true,
      secure:
        config.get('REFRESH_COOKIE_SECURE', { infer: true }) ??
        config.get('NODE_ENV', { infer: true }) !== 'development',
      sameSite: config.get('REFRESH_COOKIE_SAMESITE', { infer: true }),
      path: `/${API_PREFIX}/auth`,
    };
    // The web app, plus the API's own origin: its pages (the /docs console) are same-origin, which
    // a cross-site attacker can't be.
    this.allowedOrigins = new Set([
      ...config.get('CORS_ORIGINS', { infer: true }),
      new URL(config.get('API_URL', { infer: true })).origin,
    ]);
  }

  setRefresh(res: Response, token: string, expires: Date): void {
    res.cookie(REFRESH_COOKIE, token, { ...this.base, expires });
  }

  setMfaChallenge(res: Response, token: string): void {
    res.cookie(MFA_COOKIE, token, {
      ...this.base,
      maxAge: MFA_CHALLENGE_TTL_SECONDS * 1000,
    });
  }

  /**
   * The provider redirects back with a top-level GET from its own site, which SameSite=Lax
   * cookies survive (Strict ones would not).
   */
  setOAuthState(res: Response, value: string): void {
    res.cookie(OAUTH_STATE_COOKIE, value, {
      ...this.base,
      sameSite: this.base.sameSite === 'none' ? 'none' : 'lax',
      maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
    });
  }

  clear(res: Response, name: string): void {
    res.clearCookie(name, this.base);
  }

  read(req: Request, name: string): string | undefined {
    const value: unknown = req.cookies?.[name];
    return typeof value === 'string' && value ? value : undefined;
  }

  /**
   * Cookie-authenticated endpoints are reachable only from our own web app (CSRF protection on
   * top of SameSite). Requests without an Origin header don't come from a browser page.
   */
  assertAllowedOrigin(req: Request): void {
    const origin = req.headers.origin;
    if (origin && !this.allowedOrigins.has(origin)) {
      throw AppException.forbidden('Requests from this site are not allowed.');
    }
  }
}
