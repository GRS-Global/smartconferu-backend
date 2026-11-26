import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import {
  auditLog,
  conferenceMembers,
  conferences,
  submissionAuthors,
  submissions,
} from '../../core/database/schema/index.js';
import { EmailRecipientsService } from '../../core/email/email-recipients.service.js';
import { AppException } from '../../core/errors/app.exception.js';
import { canViewEmailLog } from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import { paperId } from '../submissions/submission.mapper.js';
import type { ActivityEntryResponse } from './dto/activity.dto.js';

type Data = Record<string, unknown>;

interface Shown {
  module: string;
  action: string;
  description: string;
  reviewerName?: string;
  previousValue?: string;
  newValue?: string;
}

interface Facts {
  /** "ICX-3" for a submission id (null when the paper is gone). */
  paper: (submissionId: string | null | undefined) => string;
  person: (userId: unknown) => string;
  /** The committee member an invitation was about (by the member's id). */
  member: (memberId: string | null | undefined) => string;
}

const OUTCOMES: Record<string, string> = {
  accept: 'Accepted',
  reject: 'Rejected',
  revise: 'Revision requested',
  waitlist: 'Waitlisted',
  registered: 'Registered',
  no_decision: 'No decision',
};
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const PAYMENTS: Record<string, string> = {
  not_paid: 'Not paid',
  paid: 'Paid',
  waived: 'Waived',
};
const ATTENDANCE: Record<string, string> = {
  physical: 'Physical',
  virtual: 'Virtual',
};
const METHODS: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  online: 'Online',
  card: 'Card',
  cash: 'Cash',
  other: 'Other',
};
const CATEGORIES: Record<string, string> = {
  standard: 'Standard',
  student: 'Student',
  co_author: 'Co-author',
};
const asData = (v: unknown) => (typeof v === 'object' && v ? v : {}) as Data;
/** "Paid 2500.00 INR by Bank transfer" from the payment fields of an entry. */
const paymentText = (r: Data, currency: unknown) => {
  const status = PAYMENTS[text(r.payment)];
  if (!status) return '';
  const amount =
    typeof r.amount === 'number'
      ? ` ${r.amount.toFixed(2)}${text(currency) ? ` ${text(currency)}` : ''}`
      : '';
  const method = METHODS[text(r.method)];
  return `${status}${amount}${method ? ` by ${method}` : ''}`;
};
/** "Paid 2500.00 INR by Card · Physical · ana@uni.edu" from a recorded registration. */
const registrationText = (v: unknown, currency: unknown) => {
  const r = asData(v);
  return [
    paymentText(r, currency),
    ATTENDANCE[text(r.attendance)] ?? 'Attendance not known',
    text(r.presenterEmail),
  ]
    .filter(Boolean)
    .join(' · ');
};
/** "Student · Paid 1000.00 INR by Online · Virtual" from a participant entry. */
const participantText = (v: unknown, currency: unknown) => {
  const r = asData(v);
  return [
    CATEGORIES[text(r.category)],
    text(r.paperId),
    paymentText(r, currency),
    ATTENDANCE[text(r.attendance)],
  ]
    .filter(Boolean)
    .join(' · ');
};
/** "Ana Ruiz (ana@uni.edu)" */
const participantName = (d: Data) =>
  text(d.email) ? `${text(d.name)} (${text(d.email)})` : text(d.name);
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * What each recorded action looks like in Settings › Activity Logs. Actions not listed here
 * (sign-ins, draft saves, file uploads...) are not shown.
 */
const SHOWN: Record<
  string,
  (
    d: Data,
    f: Facts,
    submissionId: string | null,
    entityId: string | null,
  ) => Shown
> = {
  'submission.created': (_d, f, s) => ({
    module: 'Submissions',
    action: 'Submitted',
    description: `Submitted ${f.paper(s)}.`,
  }),
  'submission.details_updated': (_d, f, s) => ({
    module: 'Submissions',
    action: 'Updated',
    description: `Updated the details of ${f.paper(s)}.`,
  }),
  'submission.authors_updated': (_d, f, s) => ({
    module: 'Submissions',
    action: 'Updated',
    description: `Updated the authors of ${f.paper(s)}.`,
  }),
  'submission.file_uploaded': (_d, f, s) => ({
    module: 'Submissions',
    action: 'Updated',
    description: `Uploaded a file for ${f.paper(s)}.`,
  }),
  'submission.withdrawn': (_d, f, s) => ({
    module: 'Submissions',
    action: 'Changed',
    description: `Withdrew ${f.paper(s)}.`,
  }),
  'submission.deleted': (d) => ({
    module: 'Submissions',
    action: 'Deleted',
    description: `Deleted ${plural(count(d.ids), 'paper')}.`,
  }),
  'submission.track_changed': (d) => ({
    module: 'Submissions',
    action: 'Changed',
    description: `Moved ${plural(count(d.ids), 'paper')} to another track.`,
    newValue: text(d.track),
  }),
  'submission.fix_requested': (d, f, s) => ({
    module: 'Submissions',
    action: 'Sent',
    description: `Asked the authors of ${f.paper(s)} to fix something${text(d.fixBy) ? ` by ${text(d.fixBy)}` : ''}.`,
  }),
  'submission.authors_emailed': (_d, f, s) => ({
    module: 'Submissions',
    action: 'Sent',
    description: `Emailed the authors of ${f.paper(s)}.`,
  }),
  'submission.screening_notified': (_d, f, s) => ({
    module: 'Screening',
    action: 'Sent',
    description: `Sent the screening result of ${f.paper(s)} to its authors.`,
  }),
  'conference.screening_settings_updated': () => ({
    module: 'Screening',
    action: 'Updated',
    description: 'Updated the screening settings.',
  }),
  'submission.decision_recorded': (d, f, s) => ({
    module: 'Decision',
    action: 'Updated',
    description: `Recorded a decision for ${f.paper(s)}.`,
    newValue: OUTCOMES[text(d.outcome)] ?? text(d.outcome),
  }),
  'submission.decision_notified': (d, f, s) => ({
    module: 'Decision',
    action: 'Sent',
    description: `Sent the decision of ${f.paper(s)} to its authors.`,
    newValue: OUTCOMES[text(d.outcome)] ?? undefined,
  }),
  'submission.registration_updated': (d, f, s) => ({
    module: 'Registration',
    action: 'Updated',
    description: `Recorded payment and attendance for ${f.paper(s)}${d.source === 'import' ? ' (import)' : ''}.`,
    previousValue: registrationText(d.before, d.currency) || undefined,
    newValue: registrationText(d.after, d.currency) || undefined,
  }),
  'submission.registration_receipt_uploaded': (d, f, s) => ({
    module: 'Registration',
    action: 'Updated',
    description: `${text(d.replaced) ? 'Replaced' : 'Uploaded'} the payment receipt of ${f.paper(s)}.`,
    previousValue: text(d.replaced) || undefined,
    newValue: text(d.fileName) || undefined,
  }),
  'submission.registration_receipt_removed': (d, f, s) => ({
    module: 'Registration',
    action: 'Deleted',
    description: `Removed the payment receipt of ${f.paper(s)}.`,
    previousValue: text(d.fileName) || undefined,
  }),
  'participant.created': (d) => ({
    module: 'Participants',
    action: 'Created',
    description: `Added participant ${participantName(d)}${d.source === 'import' ? ' (import)' : ''}.`,
    newValue: participantText(d, d.currency) || undefined,
  }),
  'participant.updated': (d) => ({
    module: 'Participants',
    action: 'Updated',
    description: `Updated participant ${participantName(d)}${d.source === 'import' ? ' (import)' : ''}.`,
    previousValue: participantText(d.before, d.currency) || undefined,
    newValue: participantText(d, d.currency) || undefined,
  }),
  'participant.deleted': (d) => ({
    module: 'Participants',
    action: 'Deleted',
    description: `Removed participant ${participantName(d)}.`,
    previousValue: participantText(d, d.currency) || undefined,
  }),
  'participant.receipt_uploaded': (d) => ({
    module: 'Participants',
    action: 'Updated',
    description: `${text(d.replaced) ? 'Replaced' : 'Uploaded'} the payment receipt of ${text(d.name)}.`,
    previousValue: text(d.replaced) || undefined,
    newValue: text(d.fileName) || undefined,
  }),
  'participant.receipt_removed': (d) => ({
    module: 'Participants',
    action: 'Deleted',
    description: `Removed the payment receipt of ${text(d.name)}.`,
    previousValue: text(d.fileName) || undefined,
  }),
  'conference.registrations_imported': (d) => ({
    module: d.kind === 'participants' ? 'Participants' : 'Registration',
    action: 'Imported',
    description: `Imported ${d.kind === 'participants' ? 'participants' : 'paper payments'}: ${num(d.new)} new, ${num(d.update)} updated, ${num(d.unchanged)} unchanged.`,
  }),
  'conference.decision_types_updated': () => ({
    module: 'Decision',
    action: 'Updated',
    description: 'Updated the list of decisions.',
  }),
  'review.assigned': (d, f, s) => {
    const names = Array.isArray(d.assigned)
      ? d.assigned.map((id) => f.person(id))
      : [];
    const later = count(d.waiting);
    return {
      module: 'Peer Review',
      action: 'Assigned',
      description: `${plural(names.length + later, 'reviewer')} assigned to ${f.paper(s)}${later ? ` (${later} still to accept the invitation)` : ''}.`,
      reviewerName: names.join(', ') || undefined,
    };
  },
  'review.unassigned': (d, f, s) => ({
    module: 'Peer Review',
    action: 'Unassigned',
    description: `A reviewer was taken off ${f.paper(s)}.`,
    reviewerName: f.person(d.reviewerId) || undefined,
  }),
  'review.pending_removed': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Unassigned',
    description: `A paper waiting for an invited reviewer was dropped: ${f.paper(s)}.`,
  }),
  'review.accepted': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Approved',
    description: `A reviewer accepted ${f.paper(s)}.`,
  }),
  'review.declined': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Rejected',
    description: `A reviewer declined ${f.paper(s)}.`,
  }),
  'review.submitted': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Submitted',
    description: `A review of ${f.paper(s)} was sent.`,
  }),
  'review.chair_review_saved': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Submitted',
    description: `The chair's own review of ${f.paper(s)} was saved.`,
  }),
  'review.edited_by_chair': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Updated',
    description: `The chair changed a review of ${f.paper(s)}.`,
  }),
  'review.shared': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Changed',
    description: `A review of ${f.paper(s)} is shared with the authors.`,
  }),
  'review.unshared': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Changed',
    description: `A review of ${f.paper(s)} is no longer shared with the authors.`,
  }),
  'review.due_date_changed': (d, f, s) => ({
    module: 'Peer Review',
    action: 'Changed',
    description: `Moved a reviewer's deadline on ${f.paper(s)}.`,
    newValue: text(d.date) || undefined,
  }),
  'review.extension_requested': (d, f, s) => ({
    module: 'Peer Review',
    action: 'Created',
    description: `A reviewer asked for more time on ${f.paper(s)}.`,
    newValue: text(d.date) || undefined,
  }),
  'review.extension_approved': (d, f, s) => ({
    module: 'Peer Review',
    action: 'Approved',
    description: `More time approved on ${f.paper(s)}.`,
    newValue: text(d.date) || undefined,
  }),
  'review.extension_declined': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Rejected',
    description: `More time declined on ${f.paper(s)}.`,
  }),
  'review.reminded': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Sent',
    description: `Reminded a reviewer about ${f.paper(s)}.`,
  }),
  'review.messaged': (_d, f, s) => ({
    module: 'Peer Review',
    action: 'Sent',
    description: `Wrote to a reviewer about ${f.paper(s)}.`,
  }),
  'conference.email_template_updated': (d) => ({
    module: 'Email Templates',
    action: d.enabled === false ? 'Disabled' : 'Updated',
    description: `${d.enabled === false ? 'Turned off' : 'Updated'} the email "${text(d.key)}".`,
  }),
  'conference.email_template_reset': (d) => ({
    module: 'Email Templates',
    action: 'Changed',
    description: `Put the email "${text(d.key)}" back to the default.`,
  }),
  'conference.custom_email_sent': (d) => ({
    module: 'Email Templates',
    action: 'Sent',
    description: `Sent "${text(d.label) || 'an email'}" to ${plural(Number(d.queued) || 0, 'person', 'people')}.`,
  }),
  'conference.updated': () => ({
    module: 'Conference Details',
    action: 'Updated',
    description: 'Updated the conference details.',
  }),
  'conference.approved': () => ({
    module: 'Conference',
    action: 'Approved',
    description: 'The conference was approved.',
  }),
  'conference.declined': () => ({
    module: 'Conference',
    action: 'Rejected',
    description: 'The conference request was declined.',
  }),
  'conference.archived': () => ({
    module: 'Conference',
    action: 'Changed',
    description: 'The conference was archived.',
  }),
  'conference.restored': () => ({
    module: 'Conference',
    action: 'Changed',
    description: 'The conference was made active again.',
  }),
  'conference.deletion_requested': () => ({
    module: 'Conference',
    action: 'Created',
    description: 'Asked for the conference to be deleted.',
  }),
  'conference.deletion_cancelled': () => ({
    module: 'Conference',
    action: 'Changed',
    description: 'Took back the deletion request.',
  }),
  'conference.deletion_rejected': () => ({
    module: 'Conference',
    action: 'Rejected',
    description: 'The deletion request was not approved.',
  }),
  'conference.license_requested': (d) => ({
    module: 'Conference Details',
    action: 'Created',
    description: 'Asked to extend the license.',
    newValue: text(d.requestedDate) || undefined,
  }),
  'conference.license_withdrawn': () => ({
    module: 'Conference Details',
    action: 'Changed',
    description: 'Took back the license extension request.',
  }),
  'conference.license_extended': (d) => ({
    module: 'Conference Details',
    action: 'Approved',
    description: 'The license was extended.',
    newValue: text(d.newExpiry) || undefined,
  }),
  'conference.license_declined': () => ({
    module: 'Conference Details',
    action: 'Rejected',
    description: 'The license extension was not approved.',
  }),
  'cfp.submitted': () => ({
    module: 'Call for Papers',
    action: 'Submitted',
    description: 'Sent the Call for Papers for approval.',
  }),
  'cfp.approved': () => ({
    module: 'Call for Papers',
    action: 'Approved',
    description: 'The Call for Papers was approved and is open.',
  }),
  'cfp.declined': () => ({
    module: 'Call for Papers',
    action: 'Rejected',
    description: 'The Call for Papers was not approved.',
  }),
  'cfp.closed': () => ({
    module: 'Call for Papers',
    action: 'Changed',
    description: 'Closed the Call for Papers.',
  }),
  'cfp.reopened': () => ({
    module: 'Call for Papers',
    action: 'Published',
    description: 'Opened the Call for Papers again.',
  }),
  'member.invited': (d, f, _s, entityId) => ({
    module: 'Committee',
    action: 'Created',
    description: `Invited ${f.member(entityId) || 'someone'} to the committee as ${text(d.role).replace('_', ' ') || 'a member'}.`,
  }),
  'member.accepted': () => ({
    module: 'Committee',
    action: 'Approved',
    description: 'An invitation to the committee was accepted.',
  }),
  'member.declined': () => ({
    module: 'Committee',
    action: 'Rejected',
    description: 'An invitation to the committee was declined.',
  }),
  'member.removed': (_d, f, _s, entityId) => ({
    module: 'Committee',
    action: 'Deleted',
    description: `${f.member(entityId) || 'Someone'} was removed from the committee.`,
  }),
};

/** Settings › Activity Logs for chairs: what was done in the conference, read from the audit log. */
@Injectable()
export class ActivityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly recipients: EmailRecipientsService,
  ) {}

  async list(
    user: AuthUser,
    conferenceId: string,
    limit: number,
  ): Promise<ActivityEntryResponse[]> {
    return this.database.transaction(async (tx) => {
      const access = await this.access.requireConference(
        user,
        conferenceId,
        tx,
      );
      if (!canViewEmailLog(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can see its Activity Logs.',
        );
      }
      const [conference] = await tx
        .select({ acronym: conferences.acronym })
        .from(conferences)
        .where(eq(conferences.id, conferenceId));
      const papers = await tx
        .select({
          id: submissions.id,
          paperNo: submissions.paperNo,
          submitterId: submissions.submitterId,
        })
        .from(submissions)
        .where(eq(submissions.conferenceId, conferenceId));
      const members = await tx
        .select({
          id: conferenceMembers.id,
          userId: conferenceMembers.userId,
          role: conferenceMembers.role,
          displayName: conferenceMembers.displayName,
          invitedEmail: conferenceMembers.invitedEmail,
        })
        .from(conferenceMembers)
        .where(eq(conferenceMembers.conferenceId, conferenceId));
      const coAuthors = papers.length
        ? await tx
            .select({ userId: submissionAuthors.userId })
            .from(submissionAuthors)
            .where(
              inArray(
                submissionAuthors.submissionId,
                papers.map((p) => p.id),
              ),
            )
        : [];

      const paperIds = papers.map((p) => p.id);
      const here = or(
        and(
          eq(auditLog.entityType, 'conference'),
          eq(auditLog.entityId, conferenceId),
        ),
        and(
          inArray(auditLog.entityType, [
            'conference_member',
            'review',
            'conference_participant',
          ]),
          eq(sql`${auditLog.data}->>'conferenceId'`, conferenceId),
        ),
        paperIds.length
          ? or(
              and(
                eq(auditLog.entityType, 'submission'),
                inArray(auditLog.entityId, paperIds),
              ),
              and(
                eq(auditLog.entityType, 'review'),
                inArray(sql`${auditLog.data}->>'submissionId'`, paperIds),
              ),
            )
          : undefined,
      );
      const rows = await tx
        .select()
        .from(auditLog)
        .where(and(here, inArray(auditLog.action, Object.keys(SHOWN))))
        .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
        .limit(limit);

      const label = new Map(
        papers.map((p) => [p.id, paperId(conference.acronym, p.paperNo)]),
      );
      // Everyone named in the rows: who acted, and the reviewers inside the data.
      const wanted = new Set<string>();
      for (const r of rows) {
        if (r.actorId) wanted.add(r.actorId);
        const d = r.data as Data;
        if (typeof d.reviewerId === 'string') wanted.add(d.reviewerId);
        if (r.entityType === 'conference_member') {
          const m = members.find((x) => x.id === r.entityId);
          if (m?.userId) wanted.add(m.userId);
        }
        if (Array.isArray(d.assigned)) {
          for (const id of d.assigned)
            if (typeof id === 'string') wanted.add(id);
        }
      }
      const people = await this.recipients.people(tx, [...wanted]);
      const nameOf = (id: unknown) =>
        typeof id === 'string' ? (people.get(id)?.name ?? '') : '';

      const chairs = new Set(
        members.filter((m) => m.role !== 'reviewer').map((m) => m.userId),
      );
      const reviewers = new Set(
        members.filter((m) => m.role === 'reviewer').map((m) => m.userId),
      );
      const authors = new Set([
        ...papers.map((p) => p.submitterId),
        ...coAuthors.map((a) => a.userId),
      ]);
      const roleOf = (id: string | null) =>
        !id
          ? 'system'
          : chairs.has(id)
            ? 'chair'
            : reviewers.has(id)
              ? 'reviewer'
              : authors.has(id)
                ? 'author'
                : 'system';

      return rows.map((r): ActivityEntryResponse => {
        const d = r.data as Data;
        const submissionId =
          r.entityType === 'submission'
            ? r.entityId
            : typeof d.submissionId === 'string'
              ? d.submissionId
              : null;
        const shown = SHOWN[r.action](
          d,
          {
            paper: (id) => (id ? (label.get(id) ?? 'a paper') : 'a paper'),
            person: nameOf,
            member: (id) => {
              const m = members.find((x) => x.id === id);
              return m
                ? m.displayName || nameOf(m.userId) || m.invitedEmail || ''
                : '';
            },
          },
          submissionId,
          r.entityId,
        );
        return {
          id: String(r.id),
          at: r.occurredAt.toISOString(),
          actorName:
            nameOf(r.actorId) ||
            (roleOf(r.actorId) === 'system' ? 'Smartconferu' : 'Someone'),
          actorRole: roleOf(r.actorId),
          action: shown.action,
          module: shown.module,
          description: shown.description,
          status: 'success',
          reviewerName: shown.reviewerName ?? null,
          previousValue: shown.previousValue ?? null,
          newValue: shown.newValue ?? null,
        };
      });
    });
  }
}
