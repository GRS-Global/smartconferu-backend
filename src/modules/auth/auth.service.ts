import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { AccessTokenService } from '../../core/auth/access-token.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { PasswordService } from '../../core/auth/password.service.js';
import { normalizeEmail } from '../../core/auth/secrets.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import { EmailService } from '../../core/email/email.service.js';
import { AppException, ErrorCode } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { AccountLinkingService } from '../users/account-linking.service.js';
import * as emails from './auth-emails.js';
import { AuthRepository, type UserRow } from './auth.repository.js';
import type { RegisterDto } from './dto/auth.dto.js';
import { MfaService } from './mfa.service.js';
import { OneTimeTokensService } from './one-time-tokens.service.js';
import { SessionsService } from './sessions.service.js';

const MAX_FAILED_SIGN_INS = 5;
const LOCK_MINUTES = 15;

export interface AccountSummary {
  id: string;
  email: string | null;
  emailVerified: boolean;
  isSuperAdmin: boolean;
}

export interface SignInResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: AccountSummary;
}

/** A sign-in either starts a session, or waits for the second factor first. */
export type SignInOutcome =
  | { kind: 'session'; session: SignInResult }
  | { kind: 'mfa_required'; challenge: string };

const fail = (status: HttpStatus, code: ErrorCode, message: string) =>
  new AppException(status, code, message);

const invalidCredentials = () =>
  fail(
    HttpStatus.UNAUTHORIZED,
    ErrorCode.AUTH_INVALID_CREDENTIALS,
    'The email or password is incorrect.',
  );
const invalidLink = () =>
  fail(
    HttpStatus.BAD_REQUEST,
    ErrorCode.AUTH_INVALID_LINK,
    'This link has expired or was already used. Please ask for a new one.',
  );
const sessionExpired = () =>
  fail(
    HttpStatus.UNAUTHORIZED,
    ErrorCode.AUTH_SESSION_EXPIRED,
    'Your session has expired. Please sign in again.',
  );

/**
 * Every way to get, keep and end a session. Endpoints that take an email address answer the same
 * whether or not an account exists, so they can't be used to find out who has one.
 */
@Injectable()
export class AuthService {
  private readonly appUrl: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly accounts: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly oneTimeTokens: OneTimeTokensService,
    private readonly accessTokens: AccessTokenService,
    private readonly linking: AccountLinkingService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true }).replace(/\/+$/, '');
  }

  // Registration and email verification ------------------------------------------------------

  async register(dto: RegisterDto, client: ClientInfo): Promise<void> {
    const email = normalizeEmail(dto.email);
    this.assertStrongPassword(dto.password, email);

    // Hashed up front so both branches take the same time.
    const passwordHash = await this.passwords.hash(dto.password);
    const existing = await this.accounts.findByEmail(email);
    if (existing) {
      await this.email.sendQuietly(
        emails.accountAlreadyExists(
          email,
          `${this.appUrl}/login`,
          `${this.appUrl}/forgot-password`,
        ),
      );
      await this.audit.record({
        action: 'auth.register_existing_email',
        actorId: existing.id,
        client,
      });
      return;
    }

    const token = await this.database.transaction(async (tx) => {
      const user = await this.accounts.create(
        {
          email,
          passwordHash,
          emailVerified: false,
          firstName: dto.firstName,
          lastName: dto.lastName,
          designation: dto.designation,
          affiliation: dto.affiliation,
          country: dto.country,
          termsVersion: dto.termsVersion,
          details: dto.details,
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
        },
        tx,
      );
      return this.oneTimeTokens.issueLink(
        'verify_email',
        email,
        user.id,
        emails.VERIFY_EMAIL_TTL_MINUTES,
        tx,
      );
    });
    await this.email.sendQuietly(
      emails.verifyEmail(email, this.link('verify-email', token)),
    );
  }

  /** Confirms the address and signs the user in. */
  async verifyEmail(token: string, client: ClientInfo): Promise<SignInOutcome> {
    return this.database.transaction(async (tx) => {
      const consumed = await this.oneTimeTokens.consumeLink(
        'verify_email',
        token,
        tx,
      );
      const user = consumed?.userId
        ? await this.accounts.findById(consumed.userId, tx)
        : undefined;
      // The link is for the address it was sent to; an account that changed address since can't use it.
      if (!consumed || !user || user.email !== consumed.email) {
        throw invalidLink();
      }
      this.assertActive(user);
      await this.markEmailVerified(user, tx);
      await this.audit.record(
        { action: 'auth.email_verified', actorId: user.id, client },
        tx,
      );
      return this.completeSignIn(user, client, 'verify_email', tx);
    });
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.accounts.findByEmail(email);
    if (!user?.email || user.emailVerifiedAt || user.status !== 'active') {
      return;
    }
    const token = await this.oneTimeTokens.issueLink(
      'verify_email',
      user.email,
      user.id,
      emails.VERIFY_EMAIL_TTL_MINUTES,
    );
    await this.email.sendQuietly(
      emails.verifyEmail(user.email, this.link('verify-email', token)),
    );
  }

  // Signing in ---------------------------------------------------------------------------------

  async signInWithPassword(
    email: string,
    password: string,
    client: ClientInfo,
  ): Promise<SignInOutcome> {
    const user = await this.accounts.findByEmail(email);
    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      throw fail(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.AUTH_ACCOUNT_LOCKED,
        `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`,
      );
    }

    const { valid, needsRehash } = await this.passwords.verify(
      user?.passwordHash ?? null,
      password,
    );
    if (!user || !valid) {
      if (user) {
        await this.accounts.recordFailedSignIn(
          user.id,
          MAX_FAILED_SIGN_INS,
          LOCK_MINUTES,
        );
      }
      await this.audit.record({
        action: 'auth.sign_in_failed',
        actorId: user?.id,
        client,
        data: { method: 'password' },
      });
      throw invalidCredentials();
    }

    this.assertActive(user);
    // Only revealed after the right password, so it says nothing to someone guessing.
    if (!user.emailVerifiedAt) {
      throw fail(
        HttpStatus.FORBIDDEN,
        ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
        'Please confirm your email address first. We can send you a new link.',
      );
    }

    return this.database.transaction(async (tx) => {
      if (needsRehash) {
        await this.accounts.update(
          user.id,
          { passwordHash: await this.passwords.hash(password) },
          tx,
        );
      }
      return this.completeSignIn(user, client, 'password', tx);
    });
  }

  async requestLoginCode(email: string): Promise<void> {
    const user = await this.accounts.findByEmail(email);
    if (!user?.email || user.status !== 'active') {
      return;
    }
    const code = await this.oneTimeTokens.issueCode(
      'login_code',
      user.email,
      user.id,
      emails.LOGIN_CODE_TTL_MINUTES,
    );
    await this.email.sendQuietly(emails.loginCode(user.email, code));
  }

  async signInWithCode(
    email: string,
    code: string,
    client: ClientInfo,
  ): Promise<SignInOutcome> {
    const consumed = await this.oneTimeTokens.verifyCode(
      'login_code',
      email,
      code,
    );
    const user = consumed?.userId
      ? await this.accounts.findById(consumed.userId)
      : undefined;
    if (!consumed || !user || user.email !== consumed.email) {
      await this.audit.record({
        action: 'auth.sign_in_failed',
        actorId: user?.id,
        client,
        data: { method: 'code' },
      });
      throw fail(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.AUTH_INVALID_CODE,
        'That code is wrong or has expired.',
      );
    }
    this.assertActive(user);
    return this.database.transaction(async (tx) => {
      // Receiving the code proves the address.
      await this.markEmailVerified(user, tx);
      return this.completeSignIn(user, client, 'code', tx);
    });
  }

  /**
   * The end of every sign-in (password, code, email link, Google/Microsoft/ORCID): starts the
   * session, or, when the account has two-step verification on, returns a challenge instead.
   */
  async completeSignIn(
    user: UserRow,
    client: ClientInfo,
    method: string,
    tx: Executor,
  ): Promise<SignInOutcome> {
    this.assertActive(user);
    if (await this.mfa.isEnabled(user.id, tx)) {
      await this.audit.record(
        {
          action: 'auth.mfa_challenged',
          actorId: user.id,
          client,
          data: { method },
        },
        tx,
      );
      return {
        kind: 'mfa_required',
        challenge: await this.accessTokens.issueMfaChallenge(user.id, method),
      };
    }
    return {
      kind: 'session',
      session: await this.startSession(
        user,
        client,
        'auth.sign_in',
        { method },
        tx,
      ),
    };
  }

  /** Second step of a sign-in: a code from the authenticator app, or a recovery code. */
  async completeMfaChallenge(
    challenge: string | undefined,
    code: string,
    client: ClientInfo,
  ): Promise<SignInResult> {
    const pending = challenge
      ? await this.accessTokens.verifyMfaChallenge(challenge).catch(() => null)
      : null;
    if (!pending) {
      throw fail(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.AUTH_SESSION_EXPIRED,
        'Your sign-in timed out. Please sign in again.',
      );
    }
    const user = await this.accounts.findById(pending.userId);
    if (!user) {
      throw sessionExpired();
    }
    this.assertActive(user);
    const { via } = await this.mfa.verify(user.id, code);
    return this.database.transaction((tx) =>
      this.startSession(
        user,
        client,
        'auth.sign_in',
        { method: pending.method, secondFactor: via },
        tx,
        true,
      ),
    );
  }

  // Sessions -----------------------------------------------------------------------------------

  async refresh(
    refreshToken: string | undefined,
    client: ClientInfo,
  ): Promise<SignInResult> {
    if (!refreshToken) {
      throw sessionExpired();
    }
    const result = await this.sessions.rotate(refreshToken, client);
    if (!result.ok) {
      if (result.reason === 'reused') {
        await this.audit.record({
          action: 'auth.refresh_token_reused',
          actorId: result.userId,
          entityType: 'session',
          entityId: result.sessionId,
          client,
        });
      }
      throw sessionExpired();
    }
    const user = await this.accounts.findById(result.token.userId);
    if (!user || user.status !== 'active') {
      await this.sessions.revokeFamily(
        result.token.sessionId,
        'account_disabled',
      );
      throw sessionExpired();
    }
    return {
      accessToken: await this.accessTokens.issue(
        user.id,
        result.token.sessionId,
        result.token.mfaVerified,
      ),
      expiresIn: this.accessTokens.ttlSeconds,
      refreshToken: result.token.refreshToken,
      refreshExpiresAt: result.token.expiresAt,
      user: summarize(user),
    };
  }

  async signOut(
    refreshToken: string | undefined,
    client: ClientInfo,
  ): Promise<void> {
    const family = refreshToken
      ? await this.sessions.familyOf(refreshToken)
      : null;
    if (!family) {
      return;
    }
    await this.sessions.revokeFamily(family.familyId, 'signed_out');
    await this.audit.record({
      action: 'auth.sign_out',
      actorId: family.userId,
      entityType: 'session',
      entityId: family.familyId,
      client,
    });
  }

  async signOutEverywhere(user: AuthUser, client: ClientInfo): Promise<void> {
    await this.sessions.revokeAllForUser(user.id, 'signed_out_everywhere');
    await this.audit.record({
      action: 'auth.sign_out_everywhere',
      actorId: user.id,
      client,
    });
  }

  // Passwords ----------------------------------------------------------------------------------

  async forgotPassword(email: string): Promise<void> {
    const user = await this.accounts.findByEmail(email);
    if (!user?.email || user.status !== 'active') {
      return;
    }
    const token = await this.oneTimeTokens.issueLink(
      'reset_password',
      user.email,
      user.id,
      emails.RESET_PASSWORD_TTL_MINUTES,
    );
    await this.email.sendQuietly(
      emails.resetPassword(user.email, this.link('reset-password', token)),
    );
  }

  /** Sets a new password from an emailed link and signs the account out everywhere. */
  async resetPassword(
    token: string,
    password: string,
    client: ClientInfo,
  ): Promise<void> {
    const user = await this.database.transaction(async (tx) => {
      const consumed = await this.oneTimeTokens.consumeLink(
        'reset_password',
        token,
        tx,
      );
      const found = consumed?.userId
        ? await this.accounts.findById(consumed.userId, tx)
        : undefined;
      if (!consumed || !found || found.email !== consumed.email) {
        throw invalidLink();
      }
      this.assertActive(found);
      this.assertStrongPassword(password, found.email);
      await this.accounts.update(
        found.id,
        {
          passwordHash: await this.passwords.hash(password),
          failedSignInCount: 0,
          lockedUntil: null,
        },
        tx,
      );
      await this.markEmailVerified(found, tx);
      await this.sessions.revokeAllForUser(
        found.id,
        'password_reset',
        undefined,
        tx,
      );
      await this.audit.record(
        { action: 'auth.password_reset', actorId: found.id, client },
        tx,
      );
      return found;
    });
    if (user.email) {
      await this.email.sendQuietly(emails.passwordChanged(user.email));
    }
  }

  /** Changes the password of the signed-in user; other devices are signed out. */
  async changePassword(
    auth: AuthUser,
    currentPassword: string | undefined,
    newPassword: string,
    client: ClientInfo,
  ): Promise<void> {
    const user = await this.accounts.findById(auth.id);
    if (!user) {
      throw sessionExpired();
    }
    // Accounts created through Google/Microsoft/ORCID have no password yet and may set one.
    if (user.passwordHash) {
      const { valid } = await this.passwords.verify(
        user.passwordHash,
        currentPassword ?? '',
      );
      if (!valid) {
        throw fail(
          HttpStatus.BAD_REQUEST,
          ErrorCode.AUTH_INVALID_CREDENTIALS,
          'Your current password is incorrect.',
        );
      }
    }
    this.assertStrongPassword(newPassword, user.email);

    await this.database.transaction(async (tx) => {
      await this.accounts.update(
        user.id,
        { passwordHash: await this.passwords.hash(newPassword) },
        tx,
      );
      await this.sessions.revokeAllForUser(
        user.id,
        'password_changed',
        auth.sessionId,
        tx,
      );
      await this.audit.record(
        { action: 'auth.password_changed', actorId: user.id, client },
        tx,
      );
    });
    if (user.email) {
      await this.email.sendQuietly(emails.passwordChanged(user.email));
    }
  }

  // Helpers ------------------------------------------------------------------------------------

  private async startSession(
    user: UserRow,
    client: ClientInfo,
    action: string,
    data: Record<string, unknown>,
    tx: Executor,
    mfaVerified = false,
  ): Promise<SignInResult> {
    const session = await this.sessions.start(user.id, client, tx, mfaVerified);
    await this.accounts.update(
      user.id,
      { lastSignInAt: new Date(), failedSignInCount: 0, lockedUntil: null },
      tx,
    );
    await this.audit.record(
      {
        action,
        actorId: user.id,
        entityType: 'session',
        entityId: session.sessionId,
        client,
        data,
      },
      tx,
    );
    return {
      accessToken: await this.accessTokens.issue(
        user.id,
        session.sessionId,
        mfaVerified,
      ),
      expiresIn: this.accessTokens.ttlSeconds,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.expiresAt,
      user: summarize({
        ...user,
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      }),
    };
  }

  /** Marks the address proven and links what was waiting for it. */
  async markEmailVerified(user: UserRow, tx: Executor): Promise<void> {
    if (user.emailVerifiedAt || !user.email) {
      return;
    }
    await this.accounts.update(user.id, { emailVerifiedAt: new Date() }, tx);
    await this.linking.linkByEmail(tx, user.id, user.email);
  }

  assertActive(user: UserRow): void {
    if (user.status !== 'active') {
      throw fail(
        HttpStatus.FORBIDDEN,
        ErrorCode.AUTH_ACCOUNT_DISABLED,
        'This account has been disabled. Please contact support.',
      );
    }
  }

  private assertStrongPassword(password: string, email: string | null): void {
    const weakness = this.passwords.weakness(password, email);
    if (weakness) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.AUTH_WEAK_PASSWORD,
        weakness,
      );
    }
  }

  private link(path: string, token: string): string {
    return `${this.appUrl}/${path}?token=${encodeURIComponent(token)}`;
  }
}

function summarize(user: UserRow): AccountSummary {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    isSuperAdmin: user.isSuperAdmin,
  };
}
