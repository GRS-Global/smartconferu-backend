import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns.js';
import { authProvider, authTokenPurpose, userStatus } from './enums.js';

/**
 * Accounts: who can sign in and how. Public-facing details live in `profiles` (same id).
 * `email` is null for an account created by an ORCID sign-in until an address is confirmed.
 */
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text(),
    emailVerifiedAt: timestamptz('email_verified_at'),
    /** argon2id hash, or a bcrypt hash carried over from the old system until next sign-in. Null for SSO-only accounts. */
    passwordHash: text('password_hash'),
    status: userStatus().notNull().default('active'),
    isSuperAdmin: boolean('is_super_admin').notNull().default(false),
    failedSignInCount: integer('failed_sign_in_count').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    lastSignInAt: timestamptz('last_sign_in_at'),
    /** When the user accepted the Terms of Service, and which version (set by the API, never by the client). */
    termsAcceptedAt: timestamptz('terms_accepted_at'),
    termsVersion: text('terms_version'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

/** A Google, Microsoft or ORCID account linked to a user. */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProvider().notNull(),
    /** The provider's stable id for the account (OIDC `sub`, or the ORCID iD). */
    providerUserId: text('provider_user_id').notNull(),
    email: text(),
    /** Claims as last received from the provider. */
    profile: jsonb().notNull().default({}),
    createdAt: createdAt(),
    lastUsedAt: timestamptz('last_used_at'),
  },
  (t) => [
    unique('user_identities_provider_account_key').on(
      t.provider,
      t.providerUserId,
    ),
    index('user_identities_user_idx').on(t.userId),
  ],
);

/**
 * One row per refresh token. Rotating a token creates a new row in the same family and marks the
 * old one rotated; presenting a rotated token again means it was stolen, so the whole family is
 * revoked.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    /** SHA-256 of the refresh token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamptz('expires_at').notNull(),
    rotatedAt: timestamptz('rotated_at'),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),
    /** When the user completed a second factor in this session family (super admin). */
    mfaVerifiedAt: timestamptz('mfa_verified_at'),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
  },
  (t) => [
    unique('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_family_idx').on(t.familyId),
  ],
);

/**
 * Single-use secrets sent by email: verification and reset links, sign-in codes. Only a hash is
 * stored; codes are short, so they also count failed attempts.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    purpose: authTokenPurpose().notNull(),
    tokenHash: text('token_hash').notNull(),
    attempts: integer().notNull().default(0),
    createdAt: createdAt(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
  },
  (t) => [
    unique('auth_tokens_token_hash_key').on(t.tokenHash),
    index('auth_tokens_lookup_idx').on(sql`lower(${t.email})`, t.purpose),
  ],
);

/**
 * An authenticator-app (TOTP) second factor. The secret is stored encrypted (AES-256-GCM,
 * MFA_ENCRYPTION_KEY); `enabled_at` is null until the user has entered a first valid code.
 */
export const userMfa = pgTable('user_mfa', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  totpSecret: text('totp_secret').notNull(),
  enabledAt: timestamptz('enabled_at'),
  /** The last 30-second time step accepted, so a code can't be used twice. */
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** One-time codes for when the authenticator app is lost. Stored hashed. */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamptz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('mfa_recovery_codes_user_idx').on(t.userId)],
);

/** What other people see about a user (reviewer pickers, author lists). */
export const profiles = pgTable('profiles', {
  id: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  designation: text(),
  affiliation: text(),
  country: text(),
  orcidId: text('orcid_id'),
  photoPath: text('photo_path'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** The rest of a user's profile, visible only to its owner. */
export const profileDetails = pgTable('profile_details', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  data: jsonb().notNull().default({}),
  updatedAt: updatedAt(),
});
