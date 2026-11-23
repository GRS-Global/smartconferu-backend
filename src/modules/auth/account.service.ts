import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { AccessTokenService } from '../../core/auth/access-token.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { PasswordService } from '../../core/auth/password.service.js';
import { normalizeEmail } from '../../core/auth/secrets.js';
import { DatabaseService } from '../../core/database/database.service.js';
import {
  profileDetails,
  userIdentities,
  users,
} from '../../core/database/schema/index.js';
import { EmailService } from '../../core/email/email.service.js';
import { AppException, ErrorCode } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { AccountLinkingService } from '../users/account-linking.service.js';
import {
  EMAIL_SLOTS,
  type EmailSlot,
  readSlot,
} from '../users/profile-emails.js';
import * as emails from './auth-emails.js';
import { AuthRepository, type UserRow } from './auth.repository.js';
import { AuthService, type SignInOutcome } from './auth.service.js';
import { MfaService, type TotpSetup } from './mfa.service.js';
import { OneTimeTokensService } from './one-time-tokens.service.js';
import { type ActiveSession, SessionsService } from './sessions.service.js';

export interface MfaStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
  /** Super admins must have it on to use admin features. */
  required: boolean;
}

/**
 * The signed-in user managing their own account: email address, signed-in devices, two-step
 * verification, and merging a new provider-only account into the one that owns an address.
 */
@Injectable()
export class AccountService {
  private readonly appUrl: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly accounts: AuthRepository,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly oneTimeTokens: OneTimeTokensService,
    private readonly mfa: MfaService,
    private readonly accessTokens: AccessTokenService,
    private readonly linking: AccountLinkingService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true }).replace(/\/+$/, '');
  }

  // Email address ------------------------------------------------------------------------------

  /** Emails a confirmation link to the new address; nothing changes until it's confirmed. */
  async requestEmailChange(
    auth: AuthUser,
    newEmail: string,
    currentPassword: string | undefined,
    client: ClientInfo,
  ): Promise<void> {
    const user = await this.load(auth.id);
    const address = normalizeEmail(newEmail);
    if (user.passwordHash) {
      const { valid } = await this.passwords.verify(
        user.passwordHash,
        currentPassword ?? '',
      );
      if (!valid) {
        throw new AppException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.AUTH_INVALID_CREDENTIALS,
          'Your current password is incorrect.',
        );
      }
    }
    if (address === user.email) {
      throw AppException.validation('That is already your email address.');
    }
    const owner = await this.accounts.findByEmail(address);
    if (owner) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.AUTH_EMAIL_IN_USE,
        this.canMerge(user)
          ? 'That address already has an account. You can connect this sign-in to it instead.'
          : 'That address is already used by another account.',
        { canMerge: this.canMerge(user) },
      );
    }

    const token = await this.oneTimeTokens.issueLink(
      'change_email',
      address,
      user.id,
      emails.CHANGE_EMAIL_TTL_MINUTES,
    );
    await this.email.sendQuietly(
      emails.confirmEmailChange(
        address,
        `${this.appUrl}/confirm-email?token=${encodeURIComponent(token)}`,
      ),
    );
    if (user.email) {
      await this.email.sendQuietly(
        emails.emailChangeRequested(user.email, address),
      );
    }
    await this.audit.record({
      action: 'auth.email_change_requested',
      actorId: user.id,
      client,
      data: { to: address },
    });
  }

  /** From the emailed link: the address is proven, so it becomes the account's email. */
  async confirmEmailChange(token: string, client: ClientInfo): Promise<void> {
    const previous = await this.database.transaction(async (tx) => {
      const consumed = await this.oneTimeTokens.consumeLink(
        'change_email',
        token,
        tx,
      );
      const user = consumed?.userId
        ? await this.accounts.findById(consumed.userId, tx)
        : undefined;
      if (!consumed || !user) {
        throw new AppException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.AUTH_INVALID_LINK,
          'This link has expired or was already used. Please ask for a new one.',
        );
      }
      this.auth.assertActive(user);
      // Someone may have taken the address since the link was sent.
      if (await this.accounts.findByEmail(consumed.email, tx)) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.AUTH_EMAIL_IN_USE,
          'That address is already used by another account.',
        );
      }
      await tx
        .update(users)
        .set({ email: consumed.email, emailVerifiedAt: new Date() })
        .where(eq(users.id, user.id));
      await this.linking.linkByEmail(tx, user.id, consumed.email);
      await this.audit.record(
        {
          action: 'auth.email_changed',
          actorId: user.id,
          client,
          data: { from: user.email, to: consumed.email },
        },
        tx,
      );
      return { old: user.email, next: consumed.email };
    });
    if (previous.old) {
      await this.email.sendQuietly(
        emails.emailChanged(previous.old, previous.next),
      );
    }
  }

  // Profile email addresses --------------------------------------------------------------------

  /**
   * Emails a verification link to the personal / professional address saved on the profile.
   * The sign-in email is not touched; this only proves the address is the user's.
   */
  async sendProfileEmailLink(
    auth: AuthUser,
    slot: EmailSlot,
    client: ClientInfo,
  ): Promise<void> {
    const [row] = await this.database.db
      .select({ data: profileDetails.data })
      .from(profileDetails)
      .where(eq(profileDetails.userId, auth.id));
    const saved = readSlot(
      (row?.data as Record<string, unknown> | undefined)?.emails,
      slot,
    );
    if (!saved.value) {
      throw AppException.businessRule('Save an email address first.');
    }
    if (saved.status === 'verified') {
      throw AppException.businessRule('That address is already verified.');
    }
    const token = await this.oneTimeTokens.issueLink(
      'verify_profile_email',
      saved.value,
      auth.id,
      emails.VERIFY_PROFILE_EMAIL_TTL_MINUTES,
    );
    await this.email.sendQuietly(
      emails.verifyProfileEmail(
        saved.value,
        `${this.appUrl}/verify-profile-email?token=${encodeURIComponent(token)}`,
      ),
    );
    await this.audit.record({
      action: 'profile.email_verification_sent',
      actorId: auth.id,
      client,
      data: { slot },
    });
  }

  /** From the emailed link: the address is proven, so its slot becomes "verified". */
  async confirmProfileEmail(token: string, client: ClientInfo): Promise<void> {
    await this.database.transaction(async (tx) => {
      const consumed = await this.oneTimeTokens.consumeLink(
        'verify_profile_email',
        token,
        tx,
      );
      const invalid = () =>
        new AppException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.AUTH_INVALID_LINK,
          'This link has expired or was already used. Please ask for a new one.',
        );
      if (!consumed?.userId) throw invalid();
      const [row] = await tx
        .select({ data: profileDetails.data })
        .from(profileDetails)
        .where(eq(profileDetails.userId, consumed.userId))
        .for('update');
      const data = {
        ...((row?.data as Record<string, unknown> | undefined) ?? {}),
      };
      const stored = (data.emails ?? {}) as Record<string, unknown>;
      // The address may have been changed or removed after the link was sent.
      const slot = EMAIL_SLOTS.find(
        (s) => readSlot(stored, s).value.toLowerCase() === consumed.email,
      );
      if (!slot) throw invalid();
      data.emails = {
        ...stored,
        [slot]: { value: readSlot(stored, slot).value, status: 'verified' },
      };
      await tx
        .update(profileDetails)
        .set({ data })
        .where(eq(profileDetails.userId, consumed.userId));
      await this.audit.record(
        {
          action: 'profile.email_verified',
          actorId: consumed.userId,
          client,
          data: { slot },
        },
        tx,
      );
    });
  }

  // Sessions -----------------------------------------------------------------------------------

  listSessions(auth: AuthUser): Promise<ActiveSession[]> {
    return this.sessions.listActive(auth.id);
  }

  async revokeSession(
    auth: AuthUser,
    sessionId: string,
    client: ClientInfo,
  ): Promise<void> {
    if (
      !(await this.sessions.revokeOwn(auth.id, sessionId, 'revoked_by_user'))
    ) {
      throw AppException.notFound('That session');
    }
    await this.audit.record({
      action: 'auth.session_revoked',
      actorId: auth.id,
      entityType: 'session',
      entityId: sessionId,
      client,
    });
  }

  // Two-step verification ----------------------------------------------------------------------

  async mfaStatus(auth: AuthUser): Promise<MfaStatus> {
    const user = await this.load(auth.id);
    const enabled = await this.mfa.isEnabled(user.id);
    return {
      enabled,
      recoveryCodesLeft: enabled
        ? await this.mfa.unusedRecoveryCodeCount(user.id)
        : 0,
      // Super admins may use an authenticator app, or the code emailed at each admin sign-in.
      required: false,
    };
  }

  async beginMfaSetup(auth: AuthUser): Promise<TotpSetup> {
    const user = await this.load(auth.id);
    return this.mfa.beginSetup(user.id, user.email ?? user.id);
  }

  /**
   * Turns two-step verification on with a first code. This session counts as verified from now
   * on, so it gets a fresh access token that says so.
   */
  async enableMfa(
    auth: AuthUser,
    code: string,
    client: ClientInfo,
  ): Promise<{ recoveryCodes: string[]; accessToken: string }> {
    const user = await this.load(auth.id);
    const recoveryCodes = await this.mfa.enable(user.id, code);
    await this.sessions.markMfaVerified(auth.sessionId);
    await this.sessions.revokeAllForUser(
      user.id,
      'mfa_enabled',
      auth.sessionId,
    );
    await this.audit.record({
      action: 'auth.mfa_enabled',
      actorId: user.id,
      client,
    });
    if (user.email) {
      await this.email.sendQuietly(emails.mfaTurnedOn(user.email));
    }
    return {
      recoveryCodes,
      accessToken: await this.accessTokens.issue(user.id, auth.sessionId, true),
    };
  }

  async disableMfa(
    auth: AuthUser,
    code: string,
    client: ClientInfo,
  ): Promise<void> {
    const user = await this.load(auth.id);
    await this.mfa.verify(user.id, code);
    await this.mfa.disable(user.id);
    await this.audit.record({
      action: 'auth.mfa_disabled',
      actorId: user.id,
      client,
    });
    if (user.email) {
      await this.email.sendQuietly(emails.mfaTurnedOff(user.email));
    }
  }

  async regenerateRecoveryCodes(
    auth: AuthUser,
    code: string,
    client: ClientInfo,
  ): Promise<string[]> {
    await this.mfa.verify(auth.id, code);
    const codes = await this.mfa.regenerateRecoveryCodes(auth.id);
    await this.audit.record({
      action: 'auth.mfa_recovery_codes_regenerated',
      actorId: auth.id,
      client,
    });
    return codes;
  }

  // Merging a new provider-only account into an existing one -----------------------------------

  /**
   * Someone signed in with ORCID (no email) whose address already has an account: prove the
   * address with a code, and the ORCID sign-in moves to that account.
   */
  async requestMerge(auth: AuthUser, email: string): Promise<void> {
    const user = await this.load(auth.id);
    if (!this.canMerge(user)) {
      throw AppException.forbidden(
        'Only a new sign-in without an email can be connected to another account.',
      );
    }
    const target = await this.accounts.findByEmail(email);
    if (!target?.email || target.id === user.id || target.status !== 'active') {
      return; // same answer as for an address with an account
    }
    const code = await this.oneTimeTokens.issueCode(
      'merge_account',
      target.email,
      target.id,
      emails.MERGE_CODE_TTL_MINUTES,
    );
    await this.email.sendQuietly(emails.mergeCode(target.email, code));
  }

  /** Moves this account's sign-ins to the account that owns `email`, then signs in to it. */
  async completeMerge(
    auth: AuthUser,
    email: string,
    code: string,
    client: ClientInfo,
  ): Promise<SignInOutcome> {
    const user = await this.load(auth.id);
    if (!this.canMerge(user)) {
      throw AppException.forbidden(
        'Only a new sign-in without an email can be connected to another account.',
      );
    }
    const consumed = await this.oneTimeTokens.verifyCode(
      'merge_account',
      email,
      code,
    );
    const target = consumed?.userId
      ? await this.accounts.findById(consumed.userId)
      : undefined;
    if (
      !consumed ||
      !target ||
      target.email !== consumed.email ||
      target.id === user.id
    ) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.AUTH_INVALID_CODE,
        'That code is wrong or has expired.',
      );
    }

    try {
      return await this.database.transaction(async (tx) => {
        await tx
          .update(userIdentities)
          .set({ userId: target.id })
          .where(eq(userIdentities.userId, user.id));
        // Deleting fails if the new account already did anything (submitted, joined a committee…).
        await tx.delete(users).where(eq(users.id, user.id));
        await this.audit.record(
          {
            action: 'auth.account_merged',
            actorId: target.id,
            client,
            data: { mergedUserId: user.id },
          },
          tx,
        );
        return this.auth.completeSignIn(target, client, 'account_merge', tx);
      });
    } catch (error) {
      if ((error as { cause?: { code?: string } })?.cause?.code === '23503') {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'This sign-in already has activity of its own, so it can no longer be connected to another account.',
        );
      }
      throw error;
    }
  }

  /** A provider-only account with no email of its own (a fresh ORCID sign-in). */
  private canMerge(user: UserRow): boolean {
    return !user.email && !user.passwordHash;
  }

  private async load(id: string): Promise<UserRow> {
    const user = await this.accounts.findById(id);
    if (!user) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.AUTH_SESSION_EXPIRED,
        'Your session has expired. Please sign in again.',
      );
    }
    this.auth.assertActive(user);
    return user;
  }
}
