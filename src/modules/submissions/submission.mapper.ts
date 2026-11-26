import * as rules from '../../core/rbac/access-rules.js';
import type {
  AssignmentStatus,
  ConferenceAccess,
  SubmissionAccess,
} from '../../core/rbac/access-rules.js';
import type {
  PaperParticipantResponse,
  PaymentResponse,
  RegistrationResponse,
  SubmissionResponse,
  SubmissionView,
} from './dto/submission.dto.js';
import type {
  PaperBundle,
  ParticipantRow,
  RegistrationRow,
} from './submissions.repository.js';

type PaymentRow = Pick<
  RegistrationRow | ParticipantRow,
  | 'payment'
  | 'amount'
  | 'method'
  | 'paidOn'
  | 'transactionRef'
  | 'payerName'
  | 'receiptPath'
  | 'receiptName'
  | 'receiptSize'
  | 'receiptUploadedAt'
>;

/** Outcomes that are stages of a paper, not decisions. */
export const STAGE_OUTCOMES = [
  'upload_pending',
  'no_decision',
  'plagiarism_clear',
];

/** Decisions that make a paper accepted: payment and attendance apply to these. */
export const ACCEPTED_OUTCOMES: readonly string[] = ['accept', 'registered'];

/**
 * An accepted paper's payment and attendance: the chair sees it once the paper is accepted, an
 * author once they were told so; nobody sees it on a paper that isn't (or is no longer) accepted.
 */
function registrationOf(
  bundle: PaperBundle,
  view: SubmissionView,
): RegistrationResponse | null {
  const { submission: s, registration: r, authors } = bundle;
  const accepted =
    view === 'chair'
      ? ACCEPTED_OUTCOMES.includes(s.outcome)
      : view === 'author' &&
        s.notifiedOutcome !== null &&
        ACCEPTED_OUTCOMES.includes(s.notifiedOutcome);
  if (!accepted || s.status === 'withdrawn') return null;
  const presenterEmail = r?.presenterEmail ?? null;
  const presenter = presenterEmail
    ? authors.find(
        (a) => a.email.toLowerCase() === presenterEmail.toLowerCase(),
      )
    : undefined;
  return {
    ...paymentOf(r, bundle.currency),
    attendance: r?.attendance ?? null,
    presenterEmail,
    presenterName: presenter?.name ?? null,
    note: view === 'chair' ? (r?.note ?? null) : null,
    updatedAt: iso(r?.updatedAt ?? null),
  };
}

/** The fields of PaymentResponse as a plain object type, so it can be spread into a response. */
type PaymentFields = { [K in keyof PaymentResponse]: PaymentResponse[K] };

/** The payment part of a registration or a participant (a missing row: not paid). */
export function paymentOf(
  row: PaymentRow | null,
  currency: string | null,
): PaymentFields {
  return {
    payment: row?.payment ?? 'not_paid',
    amount: row?.amount ?? null,
    currency,
    method: row?.method ?? null,
    paidOn: row?.paidOn ?? null,
    transactionRef: row?.transactionRef ?? null,
    payerName: row?.payerName ?? null,
    receipt:
      row?.receiptPath && row.receiptName
        ? {
            fileName: row.receiptName,
            sizeBytes: row.receiptSize,
            uploadedAt: iso(row.receiptUploadedAt),
          }
        : null,
  };
}

/**
 * The paper's co-authors registered as participants: chairs see them all while the paper is
 * accepted; an author sees only their own (an author line linked to their account with that
 * email) once told the paper is accepted.
 */
function participantsOf(
  bundle: PaperBundle,
  view: SubmissionView,
  userId: string,
): PaperParticipantResponse[] {
  const { submission: s, authors } = bundle;
  if (s.status === 'withdrawn') return [];
  if (view === 'chair') {
    if (!ACCEPTED_OUTCOMES.includes(s.outcome)) return [];
  } else if (
    view !== 'author' ||
    s.notifiedOutcome === null ||
    !ACCEPTED_OUTCOMES.includes(s.notifiedOutcome)
  ) {
    return [];
  }
  const mine = new Set(
    authors
      .filter((a) => a.userId === userId)
      .map((a) => a.email.toLowerCase()),
  );
  return bundle.participants
    .filter((p) => view === 'chair' || mine.has(p.email.toLowerCase()))
    .map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      attendance: p.attendance,
      ...paymentOf(p, bundle.currency),
      note: view === 'chair' ? p.note : null,
      updatedAt: p.updatedAt.toISOString(),
    }));
}

/** "ISBM 2026-27" → "ISBM": the prefix of a conference's paper ids. */
export function paperPrefix(acronym: string): string {
  return (
    (acronym.split(/\s+/)[0] || 'PAPER')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase() || 'PAPER'
  );
}

export const paperId = (acronym: string, paperNo: number) =>
  `${paperPrefix(acronym)}-${paperNo}`;

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** The user's standing on a paper, from data already loaded (no query). */
export function accessFor(
  bundle: PaperBundle,
  conference: ConferenceAccess,
  userId: string,
  reviewMode: SubmissionAccess['reviewMode'],
  assignmentStatus: AssignmentStatus | null = null,
): SubmissionAccess {
  const { submission, authors } = bundle;
  return {
    submissionId: submission.id,
    conference,
    reviewMode,
    status: submission.status,
    outcome: submission.outcome,
    notifiedOutcome: submission.notifiedOutcome,
    isSubmitter: submission.submitterId === userId,
    isListedAuthor: authors.some((a) => a.userId === userId),
    isClaimed: authors.some((a) => a.userId !== null),
    assignmentStatus,
  };
}

export function viewOf(access: SubmissionAccess): SubmissionView {
  if (rules.isChair(access.conference)) {
    return 'chair';
  }
  return rules.isAuthorOf(access) ? 'author' : 'reviewer';
}

/** The chair's open "Ask author to fix", kept in the paper's details. */
function fixRequestOf(
  details: Record<string, unknown>,
): { issue: string; fixBy: string; at: string } | null {
  const f = details.fixRequest;
  if (typeof f !== 'object' || !f) return null;
  const r = f as Record<string, unknown>;
  return typeof r.issue === 'string' && r.issue
    ? {
        issue: r.issue,
        fixBy: typeof r.fixBy === 'string' ? r.fixBy : '',
        at: typeof r.at === 'string' ? r.at : '',
      }
    : null;
}

/** The paper as this user may see it. */
export function toSubmission(
  bundle: PaperBundle,
  conference: { slug: string; acronym: string },
  access: SubmissionAccess,
  userId: string,
): SubmissionResponse {
  const { submission: s, authors, files } = bundle;
  const view = viewOf(access);
  const details = s.details as Record<string, unknown>;
  const text = (key: string) =>
    typeof details[key] === 'string' ? (details[key] as string) : null;
  const paperFiles = files.filter((f) => f.kind !== 'supplementary');

  // Authors see only what they were told: an unsent decision still reads as under review.
  const told = s.notifiedOutcome;
  const authorOutcome =
    told ?? (STAGE_OUTCOMES.includes(s.outcome) ? s.outcome : 'no_decision');

  // The chair's screening record per version, with each version's automatic check.
  const screening =
    view === 'reviewer'
      ? null
      : {
          ...(s.screening as Record<string, unknown>),
          ...Object.fromEntries(
            paperFiles.map((f, i) => {
              const key = String(i + 1);
              const record = (s.screening as Record<string, unknown>)[key];
              return [
                key,
                {
                  ...(typeof record === 'object' && record ? record : {}),
                  ...(view === 'chair' && f.autoCheck
                    ? { auto: f.autoCheck }
                    : {}),
                },
              ];
            }),
          ),
        };

  return {
    id: s.id,
    paperId: paperId(conference.acronym, s.paperNo),
    paperNo: s.paperNo,
    conferenceId: s.conferenceId,
    conferenceSlug: conference.slug,
    conferenceAcronym: conference.acronym,
    view,
    title: s.title,
    abstract: s.abstract,
    keywords: s.keywords,
    track: text('track'),
    presentationType: text('presentationType'),
    responses:
      typeof details.responses === 'object' && details.responses
        ? (details.responses as Record<string, unknown>)
        : {},
    authors: rules.canSeeAuthors(access)
      ? authors.map((a) => ({
          name: a.name,
          email: a.email,
          affiliation: a.affiliation,
          country: a.country,
          corresponding: a.isCorresponding,
          hasAccount: a.userId !== null,
        }))
      : null,
    status: s.status,
    outcome: view === 'author' ? authorOutcome : s.outcome,
    decisionTypeId:
      view === 'author'
        ? told
          ? s.notifiedDecisionTypeId
          : STAGE_OUTCOMES.includes(s.outcome)
            ? s.decisionTypeId
            : null
        : s.decisionTypeId,
    decisionNote:
      view === 'chair'
        ? s.decisionNote
        : view === 'author'
          ? s.notifiedNote
          : null,
    notifiedOutcome: view === 'chair' ? s.notifiedOutcome : null,
    notifiedAt: view === 'reviewer' ? null : iso(s.notifiedAt),
    screening,
    files: files.map((f) => ({
      id: f.id,
      kind: f.kind,
      version: f.version,
      fileName: f.fileName,
      sizeBytes: f.sizeBytes,
      uploadedAt: f.uploadedAt.toISOString(),
      autoCheck:
        view === 'chair'
          ? (f.autoCheck as Record<string, unknown> | null)
          : null,
    })),
    fixRequest: view === 'reviewer' ? null : fixRequestOf(details),
    registration: registrationOf(bundle, view),
    participants: participantsOf(bundle, view, userId),
    withdrawnAt: iso(s.withdrawnAt),
    withdrawnBy: s.withdrawnBy,
    submittedAt: s.submittedAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    mySubmission: s.submitterId === userId,
    myCorresponding:
      s.submitterId === userId ||
      authors.some((a) => a.userId === userId && a.isCorresponding),
    can: {
      editDetails: rules.canEditDetails(access),
      editAuthors: rules.canEditAuthors(access),
      withdraw: rules.canWithdraw(access),
      uploadFile: rules.canUploadFile(access),
      decide: rules.canDecide(access),
    },
  };
}
