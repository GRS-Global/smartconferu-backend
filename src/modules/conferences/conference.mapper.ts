import type {
  ConferenceResponse,
  DeletionRequestSummary,
  PublicConferenceResponse,
} from './dto/conference.dto.js';
import type { ConferenceMode } from './dto/conference.dto.js';
import type {
  ConferenceWithCfp,
  DeletionRequestRow,
} from './conferences.repository.js';

/** The plain-object shape of a response class (mappers build plain objects, not instances). */
type Plain<T> = { [K in keyof T]: T[K] };

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * Outside the team a CFP is only ever "published" or "closed"; drafts and CFPs under review look
 * like drafts (the old "cfps: public read published" policy).
 */
export function publicCfpStatus(status: string): string {
  return status === 'published' || status === 'closed' ? status : 'draft';
}

export function toPublicConference(
  row: ConferenceWithCfp,
): Plain<PublicConferenceResponse> {
  return {
    id: row.id,
    slug: row.slug,
    acronym: row.acronym,
    title: row.title,
    about: row.about,
    mode: row.mode as ConferenceMode | null,
    venue: row.venue,
    city: row.city,
    state: row.state,
    country: row.country,
    webPage: row.webPage,
    contactEmail: row.contactEmail,
    primaryArea: row.primaryArea,
    secondaryArea: row.secondaryArea,
    startDate: row.startDate,
    endDate: row.endDate,
    submissionDeadline: iso(row.submissionDeadline),
    reviewMode: row.reviewMode,
    registrationUrl: row.registrationUrl,
    participantRegistrationUrl: row.participantRegistrationUrl,
    registrationDeadline: row.registrationDeadline,
    currency: row.currency,
    details: row.details as Record<string, unknown>,
    cfpStatus: publicCfpStatus(row.cfpStatus),
  };
}

export function toDeletionSummary(
  row: DeletionRequestRow,
): DeletionRequestSummary {
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    adminNote: row.adminNote,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ConferenceView {
  myRoles: string[];
  /** Chairs (and super admins) see settings, the real CFP status and deletion requests. */
  isChair: boolean;
  deletionRequest?: DeletionRequestRow;
}

export function toConference(
  row: ConferenceWithCfp,
  view: ConferenceView,
): Plain<ConferenceResponse> {
  return {
    ...toPublicConference(row),
    // The team sees the CFP's real status (in review, rejected…).
    cfpStatus:
      view.isChair || view.myRoles.some((r) => r !== 'author')
        ? row.cfpStatus
        : publicCfpStatus(row.cfpStatus),
    status: row.status,
    adminNote: row.adminNote,
    reviewDeadline: iso(row.reviewDeadline),
    notificationDate: row.notificationDate,
    cameraReadyDeadline: iso(row.cameraReadyDeadline),
    logoPath: row.logoPath,
    myRoles: view.myRoles,
    settings: view.isChair ? (row.settings as Record<string, unknown>) : null,
    deletionRequest:
      view.isChair && view.deletionRequest
        ? toDeletionSummary(view.deletionRequest)
        : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** "Ada Lovelace", or the email, or a fallback. */
export function displayName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  fallback: string,
): string {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || fallback;
}
