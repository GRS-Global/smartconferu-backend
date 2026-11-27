import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { AuditService } from '../../core/audit/audit.service.js';
import {
  AccessTokenService,
  type MfaFactor,
} from '../../core/auth/access-token.service.js';
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
import { TrustedDevicesService } from './trusted-devices.service.js';

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
  /** "Keep me signed in": false makes the refresh cookie end with the browser. */
  refreshPersistent: boolean;
  user: AccountSummary;
  /** Set when this sign-in trusted the browser ("Trust this device"): the cookie to store. */
  trustedDevice?: { token: string; expiresAt: Date };
}

/** How a sign-in should treat this browser. */
export interface SignInOptions {
  /** "Keep me signed in on this device" (default on). */
  remember?: boolean;
  /** The browser's "Trust this device" cookie, if any. */
  trustedDeviceToken?: string;
}

/** A sign-in either starts a session, or waits for the second factor first. */
export type SignInOutcome =
  | { kind: 'session'; session: SignInResult }
  | {
      kind: 'mfa_required';
      challenge: string;
      factor: MfaFactor;
      /** The emailed code, only with DEV_SHOW_EMAIL_CODES (development). */
      devCode?: string;
    };

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
  private readonly showDevCodes: boolean;

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
    private readonly trustedDevices: TrustedDevicesService,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true }).replace(/\/+$/, '');
    this.showDevCodes = config.get('DEV_SHOW_EMAIL_CODES', { infer: true });
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
    options: SignInOptions = {},
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
      return this.completeSignIn(user, client, 'password', tx, options);
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
    options: SignInOptions = {},
  ): Promise<SignInOutcome> {
    this.assertActive(user);
    const remember = options.remember ?? true;
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
        factor: 'totp',
        challenge: await this.accessTokens.issueMfaChallenge(
          user.id,
          method,
          'totp',
          remember,
        ),
      };
    }
    // A super admin without an authenticator app proves the second step with a code emailed to
    // them (the admin console's sign-in). Other ways in (code, link, Google…) give an ordinary
    // session: fine for the app, not for admin features.
    if (user.isSuperAdmin && method === 'password' && user.email) {
      // "Trust this device": this browser passed the emailed code lately, so the password is enough.
      if (
        await this.trustedDevices.isTrusted(
          user.id,
          options.trustedDeviceToken,
          tx,
        )
      ) {
        return {
          kind: 'session',
          session: await this.startSession(
            user,
            client,
            'auth.sign_in',
            { method, secondFactor: 'trusted_device' },
            tx,
            true,
            remember,
          ),
        };
      }
      const code = await this.sendMfaEmailCode(user.id, user.email, tx);
      await this.audit.record(
        {
          action: 'auth.mfa_challenged',
          actorId: user.id,
          client,
          data: { method, factor: 'email' },
        },
        tx,
      );
      return {
        kind: 'mfa_required',
        factor: 'email',
        challenge: await this.accessTokens.issueMfaChallenge(
          user.id,
          method,
          'email',
          remember,
        ),
        ...this.devCode(code),
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
        false,
        remember,
      ),
    };
  }

  /**
   * Second step of a sign-in: a code from the authenticator app, a recovery code, or the emailed
   * admin code. `trustDevice` (emailed code only) lets this browser skip the code for a while.
   */
  async completeMfaChallenge(
    challenge: string | undefined,
    code: string,
    client: ClientInfo,
    trustDevice = false,
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
    const via =
      pending.factor === 'email'
        ? await this.verifyMfaEmailCode(user, code, client)
        : (await this.mfa.verify(user.id, code)).via;
    return this.database.transaction(async (tx) => {
      const trust =
        trustDevice && pending.factor === 'email'
          ? await this.trustedDevices.trust(user.id, client, tx)
          : undefined;
      const session = await this.startSession(
        user,
        client,
        'auth.sign_in',
        {
          method: pending.method,
          secondFactor: via,
          ...(trust ? { trustedDevice: true } : {}),
        },
        tx,
        true,
        pending.remember,
      );
      return trust ? { ...session, trustedDevice: trust } : session;
    });
  }

  /**
   * "Confirm it's you" before a high-risk admin action: an authenticator-app user types a code from
   * the app; otherwise a code is emailed. The answer says which (and the code, in development).
   */
  async requestStepUpCode(
    auth: AuthUser,
  ): Promise<{ factor: MfaFactor; devCode?: string }> {
    const user = await this.accounts.findById(auth.id);
    if (!user) {
      throw sessionExpired();
    }
    if (await this.mfa.isEnabled(user.id)) {
      return { factor: 'totp' };
    }
    if (!user.email) {
      throw AppException.businessRule('This account has no email address.');
    }
    const code = await this.sendMfaEmailCode(user.id, user.email);
    return { factor: 'email', ...this.devCode(code) };
  }

  /** Checks the step-up code; this session may then do high-risk actions for a few minutes. */
  async verifyStepUp(
    auth: AuthUser,
    code: string,
    client: ClientInfo,
  ): Promise<void> {
    const user = await this.accounts.findById(auth.id);
    if (!user) {
      throw sessionExpired();
    }
    const via = (await this.mfa.isEnabled(user.id))
      ? (await this.mfa.verify(user.id, code)).via
      : await this.verifyMfaEmailCode(user, code, client);
    await this.sessions.markSteppedUp(auth.sessionId, user.id);
    await this.audit.record({
      action: 'auth.step_up',
      actorId: user.id,
      entityType: 'session',
      entityId: auth.sessionId,
      client,
      data: { via },
    });
  }

  /** "Forget this device": the browser asks for the emailed code again next time. */
  async forgetTrustedDevice(
    token: string | undefined,
    client: ClientInfo,
  ): Promise<void> {
    await this.trustedDevices.forget(token);
    if (token) {
      await this.audit.record({
        action: 'auth.trusted_device_forgotten',
        client,
      });
    }
  }

  /** Emails a new code for a pending email second step (the "Send a new code" link). */
  async resendMfaEmailCode(
    challenge: string | undefined,
  ): Promise<{ devCode?: string }> {
    const pending = challenge
      ? await this.accessTokens.verifyMfaChallenge(challenge).catch(() => null)
      : null;
    const user = pending ? await this.accounts.findById(pending.userId) : null;
    if (!pending || pending.factor !== 'email' || !user?.email) {
      throw sessionExpired();
    }
    this.assertActive(user);
    return this.devCode(await this.sendMfaEmailCode(user.id, user.email));
  }

  /** The code for the response, only when DEV_SHOW_EMAIL_CODES is on (development). */
  private devCode(code: string): { devCode?: string } {
    return this.showDevCodes ? { devCode: code } : {};
  }

  private async sendMfaEmailCode(
    userId: string,
    email: string,
    executor?: Executor,
  ): Promise<string> {
    const code = await this.oneTimeTokens.issueCode(
      'mfa_email_code',
      email,
      userId,
      emails.LOGIN_CODE_TTL_MINUTES,
      executor,
    );
    await this.email.sendQuietly(emails.adminSignInCode(email, code));
    return code;
  }

  private async verifyMfaEmailCode(
    user: UserRow,
    code: string,
    client: ClientInfo,
  ): Promise<'email_code'> {
    const consumed = user.email
      ? await this.oneTimeTokens.verifyCode('mfa_email_code', user.email, code)
      : null;
    if (!consumed || consumed.userId !== user.id) {
      await this.audit.record({
        action: 'auth.sign_in_failed',
        actorId: user.id,
        client,
        data: { method: 'mfa_email_code' },
      });
      throw fail(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.AUTH_INVALID_CODE,
        'That code is wrong or has expired. Send a new one and try again.',
      );
    }
    return 'email_code';
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
      refreshPersistent: result.token.persistent,
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
    await this.trustedDevices.forgetAllForUser(user.id);
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

  /**
   * "Forgot password?" on the Super Admin console: only an active super admin gets an email, and its
   * link opens the console's own reset page (/super-admin/reset-password). Any other address gets
   * nothing, and the caller answers the same either way. The new password is set through resetPassword().
   */
  async forgotAdminPassword(email: string): Promise<void> {
    const user = await this.accounts.findByEmail(email);
    if (!user?.email || user.status !== 'active' || !user.isSuperAdmin) {
      return;
    }
    const token = await this.oneTimeTokens.issueLink(
      'reset_password',
      user.email,
      user.id,
      emails.RESET_PASSWORD_TTL_MINUTES,
    );
    await this.email.sendQuietly(
      emails.adminResetPassword(
        user.email,
        this.link('super-admin/reset-password', token),
      ),
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
      await this.trustedDevices.forgetAllForUser(found.id, tx);
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
      await this.trustedDevices.forgetAllForUser(user.id, tx);
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
    persistent = true,
  ): Promise<SignInResult> {
    const session = await this.sessions.start(
      user.id,
      client,
      tx,
      mfaVerified,
      persistent,
    );
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
      refreshPersistent: session.persistent,
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
