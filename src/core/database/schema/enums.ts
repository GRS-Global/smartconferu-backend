import { pgEnum } from 'drizzle-orm/pg-core';

// Identity -----------------------------------------------------------------------------------

export const userStatus = pgEnum('user_status', ['active', 'disabled']);

/** External sign-in providers; email + password is not an identity row. */
export const authProvider = pgEnum('auth_provider', [
  'google',
  'microsoft',
  'orcid',
]);

export const authTokenPurpose = pgEnum('auth_token_purpose', [
  'verify_email',
  'reset_password',
  'login_code',
  'change_email',
  /** Proves an address before a new SSO-only account is merged into the account that owns it. */
  'merge_account',
  /** The emailed second step of a super admin's password sign-in (admin console). */
  'mfa_email_code',
  /** Proves a personal / professional address saved under My Profile › Email addresses. */
  'verify_profile_email',
]);

// Conferences --------------------------------------------------------------------------------

export const conferenceStatus = pgEnum('conference_status', [
  'pending_approval',
  'active',
  'rejected',
  'archived',
  'deleted',
]);

export const cfpStatus = pgEnum('cfp_status', [
  'draft',
  'in_review',
  'published',
  'rejected',
  'closed',
]);

export const memberRole = pgEnum('member_role', [
  'chair',
  'track_chair',
  'cfp_manager',
  'reviewer',
]);

export const memberStatus = pgEnum('member_status', [
  'invited',
  'active',
  'declined',
  'removed',
]);

export const reviewMode = pgEnum('review_mode', [
  'double_blind',
  'single_blind',
  'open',
]);

// Submissions and reviews --------------------------------------------------------------------

export const submissionStatus = pgEnum('submission_status', [
  'draft',
  'submitted',
  'withdrawn',
]);

export const decisionOutcome = pgEnum('decision_outcome', [
  'upload_pending',
  'no_decision',
  'plagiarism_clear',
  'revise',
  'waitlist',
  'accept',
  'registered',
  'reject',
]);

/** A paper's conference fee, as the chair records it (accepted papers). */
export const paymentStatus = pgEnum('payment_status', [
  'not_paid',
  'paid',
  'waived',
]);

/** How a paper is presented at the conference. */
export const attendanceMode = pgEnum('attendance_mode', [
  'physical',
  'virtual',
]);

/** How a registration fee was paid (recorded by the chair; the payment itself happens outside). */
export const paymentMethod = pgEnum('payment_method', [
  'bank_transfer',
  'online',
  'card',
  'cash',
  'other',
]);

/** A conference participant without a paper of their own (registered on the conference's site). */
export const participantCategory = pgEnum('participant_category', [
  /** A delegate attending sessions without presenting a paper. */
  'standard',
  /** A full-time student (student ID on request). */
  'student',
  /** A co-author of an accepted paper attending to support the presenting author. */
  'co_author',
]);

export const fileKind = pgEnum('file_kind', [
  'paper',
  'revision',
  'camera_ready',
  'supplementary',
]);

export const assignmentStatus = pgEnum('assignment_status', [
  'assigned',
  'accepted',
  'declined',
  'submitted',
  'removed',
]);

export const reviewStatus = pgEnum('review_status', ['draft', 'submitted']);

/** A reviewer's "Ask for more time": waits for a chair, then is approved (the due date moves) or declined. */
export const extensionStatus = pgEnum('extension_status', [
  'pending',
  'approved',
  'declined',
]);
