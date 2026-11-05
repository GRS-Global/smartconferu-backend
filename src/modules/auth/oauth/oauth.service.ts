import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, eq, isNull, ne } from 'drizzle-orm';
import { EncryptJWT, jwtDecrypt } from 'jose';
import type { Env } from '../../../config/env.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { pkcePair, safeEqual } from '../../../core/auth/secrets.js';
import { DatabaseService } from '../../../core/database/database.service.js';
import type { Executor } from '../../../core/database/database.types.js';
import {
  profiles,
  userIdentities,
  users,
} from '../../../core/database/schema/index.js';
import { EmailService } from '../../../core/email/email.service.js';
import { AppException, ErrorCode } from '../../../core/errors/app.exception.js';
import type { ClientInfo } from '../../../core/http/client-info.js';
import { API_PREFIX } from '../../../setup-app.js';
import * as emails from '../auth-emails.js';
import { OAUTH_STATE_TTL_SECONDS } from '../auth-cookies.js';
import { AuthRepository, type UserRow } from '../auth.repository.js';
import { AuthService, type SignInOutcome } from '../auth.service.js';
import {
  OAuthProviders,
  type Provider,
  type ProviderId,
  type ProviderProfile,
} from './providers.js';
import { TERMS_VERSION_PATTERN } from '../../../core/validation/validators.js';

/** Kept encrypted in a cookie between the redirect to the provider and its redirect back. */
interface PendingSignIn {
  provider: ProviderId;
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  /** Set when a signed-in user is connecting this provider to their account. */
  linkUserId?: string;
  /** The Terms version shown next to the sign-in buttons ("by continuing you agree…"). */
  termsVersion?: string;
}

export type CallbackResult =
  | { kind: 'signed_in'; outcome: SignInOutcome; returnTo: string }
  | { kind: 'linked'; provider: ProviderId; returnTo: string }
  | { kind: 'error'; error: CallbackError; returnTo: string };

export type CallbackError =
  | 'cancelled'
  | 'invalid_state'
  | 'provider_error'
  | 'identity_in_use'
  | 'account_disabled';

export interface IdentitySummary {
  id: string;
  provider: ProviderId;
  email: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Only paths inside the web app: never another site (open-redirect protection). */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && /^\/(?![/\\])[^\s\\]{0,511}$/.test(value)
    ? value
    : '/';
}

/**
 * Sign-in with Google, Microsoft and ORCID (OpenID Connect, authorization code + PKCE).
 *
 * A returning provider account signs in to the account it is linked to. A new one is linked to
 * the existing account with the same address only when the provider has verified that address;
 * otherwise it gets a new account, without an email until the user adds and confirms one.
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);
  private readonly apiUrl: string;
  private readonly stateKey: Uint8Array;

  constructor(
    private readonly providers: OAuthProviders,
    private readonly database: DatabaseService,
    private readonly accounts: AuthRepository,
    private readonly auth: AuthService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.apiUrl = config.get('API_URL', { infer: true }).replace(/\/+$/, '');
    this.stateKey = createHash('sha256')
      .update(`oauth-state:${config.get('TOKEN_HASH_SECRET', { infer: true })}`)
      .digest();
  }

  enabledProviders(): ProviderId[] {
    return this.providers.enabled();
  }

  /** The provider's sign-in page to send the browser to, and the sealed state for the cookie. */
  async start(
    providerId: string,
    returnTo: unknown,
    linkUserId?: string,
    termsVersion?: unknown,
  ): Promise<{ url: string; state: string }> {
    const provider = this.require(providerId);
    const pkce = pkcePair();
    const pending: PendingSignIn = {
      provider: provider.id,
      state: randomBytes(16).toString('base64url'),
      nonce: randomBytes(16).toString('base64url'),
      codeVerifier: pkce.verifier,
      returnTo: safeReturnTo(returnTo),
      linkUserId,
      termsVersion:
        typeof termsVersion === 'string' &&
        TERMS_VERSION_PATTERN.test(termsVersion)
          ? termsVersion
          : undefined,
    };
    const url = await provider.client.authorizationUrl({
      redirectUri: this.redirectUri(provider.id),
      state: pending.state,
      nonce: pending.nonce,
      codeChallenge: pkce.challenge,
    });
    const state = await new EncryptJWT({ ...pending })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuedAt()
      .setExpirationTime(`${OAUTH_STATE_TTL_SECONDS}s`)
      .encrypt(this.stateKey);
    return { url, state };
  }

  async callback(
    providerId: string,
    query: { code?: string; state?: string; error?: string },
    sealedState: string | undefined,
    client: ClientInfo,
  ): Promise<CallbackResult> {
    const provider = this.require(providerId);
    const pending = await this.open(sealedState);
    const returnTo = pending?.returnTo ?? '/';
    const fail = (error: CallbackError): CallbackResult => ({
      kind: 'error',
      error,
      returnTo,
    });

    if (
      !pending ||
      pending.provider !== provider.id ||
      !query.state ||
      !safeEqual(query.state, pending.state)
    ) {
      return fail('invalid_state');
    }
    if (query.error || !query.code) {
      // The user pressed Cancel, or the provider refused.
      return fail(
        query.error === 'access_denied' ? 'cancelled' : 'provider_error',
      );
    }

    let profile: ProviderProfile;
    try {
      const claims = await provider.client.exchange({
        code: query.code,
        redirectUri: this.redirectUri(provider.id),
        codeVerifier: pending.codeVerifier,
        nonce: pending.nonce,
      });
      profile = provider.profile(claims);
    } catch (error) {
      this.logger.warn(
        { err: error, provider: provider.id },
        'Provider sign-in failed',
      );
      return fail('provider_error');
    }

    return this.database.transaction(async (tx) => {
      const [identity] = await tx
        .select()
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.provider, provider.id),
            eq(userIdentities.providerUserId, profile.providerUserId),
          ),
        );

      if (pending.linkUserId) {
        if (identity && identity.userId !== pending.linkUserId) {
          return fail('identity_in_use');
        }
        const owner = await this.accounts.findById(pending.linkUserId, tx);
        if (!owner || owner.status !== 'active') {
          return fail('account_disabled');
        }
        await this.saveIdentity(
          tx,
          owner,
          provider.id,
          profile,
          identity?.id,
          client,
        );
        return { kind: 'linked', provider: provider.id, returnTo };
      }

      let user: UserRow | undefined;
      if (identity) {
        user = await this.accounts.findById(identity.userId, tx);
        if (user) {
          await this.saveIdentity(
            tx,
            user,
            provider.id,
            profile,
            identity.id,
            client,
          );
        }
      } else {
        user = profile.verifiedEmail
          ? await this.accounts.findByEmail(profile.verifiedEmail, tx)
          : undefined;
        if (user) {
          await this.saveIdentity(
            tx,
            user,
            provider.id,
            profile,
            undefined,
            client,
          );
        } else {
          user = await this.accounts.create(
            {
              email: profile.verifiedEmail,
              passwordHash: null,
              emailVerified: false,
              firstName: profile.firstName,
              lastName: profile.lastName,
              termsVersion: pending.termsVersion,
            },
            tx,
          );
          await this.audit.record(
            {
              action: 'auth.registered',
              actorId: user.id,
              entityType: 'user',
              entityId: user.id,
              client,
              data: { method: provider.id },
            },
            tx,
          );
          await this.saveIdentity(
            tx,
            user,
            provider.id,
            profile,
            undefined,
            client,
            false,
          );
        }
      }
      if (!user) {
        return fail('provider_error');
      }
      if (user.status !== 'active') {
        return fail('account_disabled');
      }
      if (pending.termsVersion && !user.termsAcceptedAt) {
        await this.accounts.update(
          user.id,
          { termsVersion: pending.termsVersion, termsAcceptedAt: new Date() },
          tx,
        );
      }
      // The provider vouches for the address on the account: that proves it.
      if (
        profile.verifiedEmail &&
        user.email === profile.verifiedEmail.toLowerCase()
      ) {
        await this.auth.markEmailVerified(user, tx);
      }
      const outcome = await this.auth.completeSignIn(
        user,
        client,
        provider.id,
        tx,
      );
      return { kind: 'signed_in', outcome, returnTo };
    });
  }

  async listIdentities(userId: string): Promise<IdentitySummary[]> {
    return this.database.db
      .select({
        id: userIdentities.id,
        provider: userIdentities.provider,
        email: userIdentities.email,
        createdAt: userIdentities.createdAt,
        lastUsedAt: userIdentities.lastUsedAt,
      })
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId))
      .orderBy(userIdentities.createdAt);
  }

  /** Removes a linked provider, unless it is the account's only way to sign in. */
  async unlink(
    userId: string,
    identityId: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [identity] = await tx
        .select()
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.id, identityId),
            eq(userIdentities.userId, userId),
          ),
        );
      if (!identity) {
        throw AppException.notFound('That sign-in method');
      }
      const [account] = await tx
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      const [{ others }] = await tx
        .select({ others: count() })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.userId, userId),
            ne(userIdentities.id, identityId),
          ),
        );
      if (!account?.passwordHash && others === 0) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.AUTH_LAST_SIGN_IN_METHOD,
          'This is your only way to sign in. Set a password or connect another account first.',
        );
      }
      await tx.delete(userIdentities).where(eq(userIdentities.id, identityId));
      await this.audit.record(
        {
          action: 'auth.identity_unlinked',
          actorId: userId,
          entityType: 'user_identity',
          entityId: identityId,
          client,
          data: { provider: identity.provider },
        },
        tx,
      );
    });
  }

  private async saveIdentity(
    tx: Executor,
    user: UserRow,
    provider: ProviderId,
    profile: ProviderProfile,
    existingId: string | undefined,
    client: ClientInfo,
    notify = true,
  ): Promise<void> {
    const values = {
      email: profile.email,
      profile: { firstName: profile.firstName, lastName: profile.lastName },
      lastUsedAt: new Date(),
    };
    if (existingId) {
      await tx
        .update(userIdentities)
        .set(values)
        .where(eq(userIdentities.id, existingId));
    } else {
      const [created] = await tx
        .insert(userIdentities)
        .values({
          userId: user.id,
          provider,
          providerUserId: profile.providerUserId,
          ...values,
        })
        .returning({ id: userIdentities.id });
      await this.audit.record(
        {
          action: 'auth.identity_linked',
          actorId: user.id,
          entityType: 'user_identity',
          entityId: created.id,
          client,
          data: { provider },
        },
        tx,
      );
      if (notify && user.email) {
        await this.email.sendQuietly(
          emails.identityLinked(user.email, provider),
        );
      }
    }
    if (provider === 'orcid') {
      // The ORCID iD is verified by ORCID itself: show it on the profile.
      await tx
        .update(profiles)
        .set({ orcidId: profile.providerUserId })
        .where(and(eq(profiles.id, user.id), isNull(profiles.orcidId)));
    }
  }

  private require(providerId: string): Provider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AppException(
        HttpStatus.NOT_FOUND,
        ErrorCode.AUTH_PROVIDER_NOT_CONFIGURED,
        'This sign-in method is not available.',
      );
    }
    return provider;
  }

  private async open(
    sealed: string | undefined,
  ): Promise<PendingSignIn | null> {
    if (!sealed) return null;
    try {
      const { payload } = await jwtDecrypt(sealed, this.stateKey);
      return payload as unknown as PendingSignIn;
    } catch {
      return null;
    }
  }

  private redirectUri(provider: ProviderId): string {
    return `${this.apiUrl}/${API_PREFIX}/auth/oauth/${provider}/callback`;
  }
}
