import type {
  assignmentStatus,
  cfpStatus,
  conferenceStatus,
  decisionOutcome,
  memberRole,
  memberStatus,
  reviewMode,
  reviewStatus,
  submissionStatus,
} from '../database/schema/index.js';

/**
 * Every permission rule of the platform, as plain functions over a snapshot of who the user is in a
 * conference (ConferenceAccess) or on a paper (SubmissionAccess). AccessService loads the
 * snapshots; services call these rules. Nothing here touches the database, so each rule is unit
 * tested on its own (access-rules.spec.ts).
 *
 * These replace the RLS policies and the checks inside the SQL functions of the old Supabase
 * schema (supabase/migrations). Each rule names what it replaces. Three rules on a user's own rows
 * need no snapshot and are applied by the queries themselves (`where user_id = me`): profile
 * details and profile edits (profiles: update own, profile_details: own), notifications
 * (notifications: own, mark read) and one's own AI usage. Every signed-in user may read another
 * user's public profile (profiles: signed-in users read).
 *
 * "Chair" always means chair or track chair, and a super admin in a two-step-verified session
 * counts as a chair of every conference (the old is_chair()).
 */

type Enum<T extends { enumValues: readonly string[] }> =
  T['enumValues'][number];

export type MemberRole = Enum<typeof memberRole>;
export type MemberStatus = Enum<typeof memberStatus>;
export type ConferenceStatus = Enum<typeof conferenceStatus>;
export type CfpStatus = Enum<typeof cfpStatus>;
export type ReviewMode = Enum<typeof reviewMode>;
export type SubmissionStatus = Enum<typeof submissionStatus>;
export type DecisionOutcome = Enum<typeof decisionOutcome>;
export type AssignmentStatus = Enum<typeof assignmentStatus>;
export type ReviewStatus = Enum<typeof reviewStatus>;

/** Chairs run the conference: settings, committee, decisions. */
export const CHAIR_ROLES = [
  'chair',
  'track_chair',
] as const satisfies MemberRole[];
/** Who may edit and publish the Call for Papers. */
export const CFP_ROLES = [
  ...CHAIR_ROLES,
  'cfp_manager',
] as const satisfies MemberRole[];

/** Outcomes before a decision: the authors may still change the paper. */
export const AUTHOR_EDITABLE_OUTCOMES = [
  'upload_pending',
  'no_decision',
  'revise',
] as const satisfies DecisionOutcome[];
/** Outcomes before a decision: a reviewer may still correct a sent review. */
export const REVIEW_EDITABLE_OUTCOMES = [
  'upload_pending',
  'no_decision',
  'plagiarism_clear',
] as const satisfies DecisionOutcome[];
/** Assignments that let the reviewer see the paper. */
export const SEEING_ASSIGNMENTS = [
  'assigned',
  'accepted',
  'submitted',
] as const satisfies AssignmentStatus[];
/** Assignments that still let the reviewer write a review. */
export const REVIEWING_ASSIGNMENTS = [
  'assigned',
  'accepted',
] as const satisfies AssignmentStatus[];

/** Everything needed to decide what a user may do with one conference. */
export interface ConferenceAccess {
  conferenceId: string;
  status: ConferenceStatus;
  isCreator: boolean;
  /** A super admin in a two-step-verified session. */
  isSuperAdmin: boolean;
  /** Roles the user holds actively (accepted). */
  activeRoles: MemberRole[];
  /** On the team in any role and not removed (an open invitation counts). */
  isTeamMember: boolean;
  /** Submitted or co-authors a paper in the conference. */
  isAuthor: boolean;
}

/** Everything needed to decide what a user may do with one paper. */
export interface SubmissionAccess {
  submissionId: string;
  conference: ConferenceAccess;
  reviewMode: ReviewMode;
  status: SubmissionStatus;
  outcome: DecisionOutcome;
  /** The outcome the authors have been told (null until the chair sends a decision). */
  notifiedOutcome: DecisionOutcome | null;
  /** The account that made the submission (a chair, when submitted on an author's behalf). */
  isSubmitter: boolean;
  /** Listed among the paper's authors with this account linked. */
  isListedAuthor: boolean;
  /** At least one listed author has an account linked ("claimed" the paper). */
  isClaimed: boolean;
  /** The user's own review assignment on the paper, if any. */
  assignmentStatus: AssignmentStatus | null;
}

const has = <T>(list: readonly T[], value: T | null): boolean =>
  value !== null && list.includes(value);

// ── Conference ────────────────────────────────────────────────────────────────────────────

/** Holds one of `roles` actively, or is a verified super admin (old has_conf_role / is_chair). */
export function hasRole(
  access: ConferenceAccess,
  roles: readonly MemberRole[],
): boolean {
  return (
    access.isSuperAdmin || access.activeRoles.some((r) => roles.includes(r))
  );
}

/** Chair or track chair, or a verified super admin (old is_chair). */
export function isChair(access: ConferenceAccess): boolean {
  return hasRole(access, CHAIR_ROLES);
}

/**
 * May see the conference's full record: its creator (who follows a request still waiting for
 * approval), the team, super admins, and authors while it is active or archived. Anyone may see
 * the public details of an active conference.
 * Replaces: conferences: members/admin read, conferences: authors read archived.
 */
export function canViewConference(access: ConferenceAccess): boolean {
  return (
    access.isCreator ||
    access.isSuperAdmin ||
    access.isTeamMember ||
    (access.isAuthor &&
      (access.status === 'active' || access.status === 'archived'))
  );
}

/** Change details, settings, archive (conferences: chairs update). */
export const canManageConference = isChair;

/**
 * See the Call for Papers: anyone once published or closed, otherwise the team and super admins.
 * Replaces: cfps: public read published, cfps: team/admin read.
 */
export function canViewCfp(
  access: ConferenceAccess | undefined,
  status: CfpStatus,
): boolean {
  if (status === 'published' || status === 'closed') {
    return true;
  }
  return access !== undefined && (access.isTeamMember || access.isSuperAdmin);
}

/** Edit, publish and close the CFP (cfps: team edit). */
export function canEditCfp(access: ConferenceAccess): boolean {
  return hasRole(access, CFP_ROLES);
}

/**
 * See the team list (members: read). Everyone also sees their own invitations, through
 * /invitations.
 */
export function canViewTeam(access: ConferenceAccess): boolean {
  return access.isTeamMember || access.isSuperAdmin;
}

/** Invite, change and remove team members (members: chairs manage). */
export const canManageTeam = isChair;

/** See the tracks: whoever can see the conference (tracks: read). */
export function canViewTracks(access: ConferenceAccess): boolean {
  return access.status === 'active' || canViewConference(access);
}

/** Add, change and remove tracks (tracks: chairs manage). */
export const canManageTracks = isChair;

/**
 * See the decision types (what a decision is called): the team, super admins and the
 * conference's authors (decision_types: read).
 */
export function canViewDecisionTypes(access: ConferenceAccess): boolean {
  return access.isTeamMember || access.isSuperAdmin || access.isAuthor;
}

/** Add, rename and remove decision types (decision_types: chairs manage). */
export const canManageDecisionTypes = isChair;

/** The conference's own email templates (conference_email_templates: chairs). */
export const canManageEmailTemplates = isChair;

/** The conference's sent-email log (email_log: chairs and admins read). */
export const canViewEmailLog = isChair;

/** The conference's deletion requests (deletion requests: read). */
export const canViewDeletionRequests = isChair;

/** AI usage of everyone in the conference (ai_usage: own, chairs and admins read). */
export const canViewConferenceAiUsage = isChair;

/** See and record the conference's participants, their payments and receipts, and import them. */
export const canManageParticipants = isChair;

/**
 * Make a new submission. The conference must be active and its CFP published, for everyone
 * (a draft or closed CFP takes no papers, not even from a chair). Authors must also be before the
 * submission deadline; a chair may submit on an author's behalf after it.
 * Replaces: submissions: author creates (0006, 0021).
 */
export function canSubmit(
  access: ConferenceAccess,
  window: {
    cfpStatus: CfpStatus;
    submissionDeadline: Date | null;
    now: Date;
  },
): boolean {
  if (access.status !== 'active' || window.cfpStatus !== 'published') {
    return false;
  }
  return (
    isChair(access) ||
    window.submissionDeadline === null ||
    window.now.getTime() <= window.submissionDeadline.getTime()
  );
}

/**
 * Whether a team member can be given a paper to review: active reviewers get a normal assignment,
 * invited ones a pending assignment that starts when they accept, anyone else none.
 * Replaces the checks in: assignments: chairs manage, pending assignments: chairs manage.
 */
export function reviewerAssignment(member: {
  role: MemberRole;
  status: MemberStatus;
}): 'assign' | 'pending' | null {
  if (member.role !== 'reviewer') {
    return null;
  }
  if (member.status === 'active') {
    return 'assign';
  }
  return member.status === 'invited' ? 'pending' : null;
}

// ── Submission ────────────────────────────────────────────────────────────────────────────

/** The submitter or a linked co-author (old is_submission_author). */
export function isAuthorOf(s: SubmissionAccess): boolean {
  return s.isSubmitter || s.isListedAuthor;
}

/** Has an assignment that shows the paper (old is_assigned_reviewer). */
export function isAssignedReviewer(s: SubmissionAccess): boolean {
  return has(SEEING_ASSIGNMENTS, s.assignmentStatus);
}

/**
 * See the paper: its authors, the conference's chairs and its assigned reviewers.
 * Replaces: submissions: read.
 */
export function canViewSubmission(s: SubmissionAccess): boolean {
  return isAuthorOf(s) || isChair(s.conference) || isAssignedReviewer(s);
}

/**
 * See who wrote the paper. Reviewers see the authors except under double-blind review.
 * Replaces: submission_authors: read.
 */
export function canSeeAuthors(s: SubmissionAccess): boolean {
  return (
    isAuthorOf(s) ||
    isChair(s.conference) ||
    (isAssignedReviewer(s) && s.reviewMode !== 'double_blind')
  );
}

/** Download the paper's files (submission_files: read, papers: read). */
export const canViewFiles = canViewSubmission;

/**
 * Upload a file (a version, the camera-ready copy…): the authors, and chairs (screening, papers
 * received by email). Not once the paper is withdrawn.
 * Replaces: submission_files: author uploads, submission_files: chairs upload, papers: upload,
 * papers: chairs upload.
 */
export function canUploadFile(s: SubmissionAccess): boolean {
  return s.status !== 'withdrawn' && (isAuthorOf(s) || isChair(s.conference));
}

/** The paper has no decision yet and isn't withdrawn, so its details can change. */
export function isOpenForChanges(s: SubmissionAccess): boolean {
  return s.status !== 'withdrawn' && has(AUTHOR_EDITABLE_OUTCOMES, s.outcome);
}

/**
 * Change the title, abstract and keywords until there is a decision: a linked author, the
 * submitter (unless a chair, who keeps the paper only until an author claims it), or a chair
 * while no author has claimed it.
 * Replaces: submissions: author edits until decided, update_paper_details() (0022).
 */
export function canEditDetails(s: SubmissionAccess): boolean {
  const chair = isChair(s.conference);
  return (
    isOpenForChanges(s) &&
    (s.isListedAuthor || (s.isSubmitter && !chair) || (chair && !s.isClaimed))
  );
}

/**
 * Change the author list until there is a decision: the submitter, or a chair while no author has
 * claimed the paper.
 * Replaces: submission_authors: submitter manages, save_paper_authors() (0022).
 */
export function canEditAuthors(s: SubmissionAccess): boolean {
  return (
    isOpenForChanges(s) &&
    (s.isSubmitter || (isChair(s.conference) && !s.isClaimed))
  );
}

/**
 * Withdraw the paper: an author or a chair, once, and not after a rejection. An author only knows
 * of a rejection once it has been sent; a chair knows as soon as it is recorded.
 * Replaces: withdraw_submission() (0007).
 */
export function canWithdraw(s: SubmissionAccess): boolean {
  const chair = isChair(s.conference);
  const author = isAuthorOf(s);
  if (!(chair || author) || s.status === 'withdrawn') {
    return false;
  }
  if (chair) {
    return s.outcome !== 'reject';
  }
  return s.notifiedOutcome !== 'reject';
}

/** The decision history (decision_events: read). */
export function canViewDecisions(s: SubmissionAccess): boolean {
  return isAuthorOf(s) || isChair(s.conference);
}

/**
 * Record a decision or a screening result and send it to the authors.
 * Replaces: record_decision(), notify_decision(), screening decisions (0002, 0004).
 */
export function canDecide(s: SubmissionAccess): boolean {
  return isChair(s.conference);
}

/**
 * See every assignment and review of the paper and assign reviewers. Reviewers see only their
 * own (their assignment, their review).
 * Replaces: assignments: read / chairs manage, pending assignments: chairs manage,
 * reviews: reviewer reads own.
 */
export function canManageReviews(s: SubmissionAccess): boolean {
  return isChair(s.conference);
}

/**
 * Start a review: a reviewer whose assignment is still open.
 * Replaces: reviews: reviewer creates.
 */
export function canWriteReview(s: SubmissionAccess): boolean {
  return (
    s.status !== 'withdrawn' && has(REVIEWING_ASSIGNMENTS, s.assignmentStatus)
  );
}

/**
 * Correct one's own review (draft or sent) until the paper has a decision.
 * Replaces: reviews: reviewer edits until decided.
 */
export function canEditOwnReview(s: SubmissionAccess): boolean {
  return (
    s.assignmentStatus !== null &&
    s.status !== 'withdrawn' &&
    has(REVIEW_EDITABLE_OUTCOMES, s.outcome)
  );
}

/**
 * A chair corrects a review the reviewer has sent, unless the paper is withdrawn.
 * Replaces: chair_edit_review() (0008).
 */
export function canChairEditReview(
  s: SubmissionAccess,
  reviewStatus: ReviewStatus,
): boolean {
  return (
    isChair(s.conference) &&
    reviewStatus === 'submitted' &&
    s.status !== 'withdrawn'
  );
}

/**
 * A chair reviews the paper themselves, once it is submitted and not withdrawn.
 * Replaces: chair_submit_review() (0008).
 */
export function canReviewAsChair(s: SubmissionAccess): boolean {
  return isChair(s.conference) && s.status === 'submitted';
}

/**
 * The paper's AI material (text chunks, digest, assistant): chairs and assigned reviewers.
 * Replaces: paper_chunks / paper_digests: chairs and assigned reviewers read.
 */
export function canUsePaperAi(s: SubmissionAccess): boolean {
  return isChair(s.conference) || isAssignedReviewer(s);
}
