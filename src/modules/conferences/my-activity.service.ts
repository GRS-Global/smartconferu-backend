import { Injectable } from '@nestjs/common';
import { submittedAsAuthor } from '../../core/rbac/authorship.js';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import {
  auditLog,
  conferenceMembers,
  conferences,
  reviewAssignments,
  reviews,
  submissionAuthors,
  submissions,
} from '../../core/database/schema/index.js';
import { EmailRecipientsService } from '../../core/email/email-recipients.service.js';
import { AccessService } from '../../core/rbac/access.service.js';
import { paperId } from '../submissions/submission.mapper.js';
import type { ActivityEntryResponse } from './dto/activity.dto.js';

type Data = Record<string, unknown>;
interface Shown {
  module: string;
  action: string;
  description: string;
  newValue?: string;
}
const text = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * A reviewer's own log: what they did as a reviewer and what the chair did about them. Written in
 * the second person; never names another reviewer.
 */
const REVIEWER: Record<string, (d: Data, paper: string) => Shown> = {
  'review.assigned': (_d, p) => ({
    module: 'Peer Review',
    action: 'Assigned',
    description: `You were assigned as a reviewer for ${p}.`,
  }),
  'review.unassigned': (_d, p) => ({
    module: 'Peer Review',
    action: 'Unassigned',
    description: `You were taken off ${p}.`,
  }),
  'review.accepted': (_d, p) => ({
    module: 'Peer Review',
    action: 'Approved',
    description: `You accepted ${p}.`,
  }),
  'review.declined': (_d, p) => ({
    module: 'Peer Review',
    action: 'Rejected',
    description: `You declined ${p}.`,
  }),
  'review.submitted': (_d, p) => ({
    module: 'Peer Review',
    action: 'Submitted',
    description: `Submitted your review for ${p}.`,
  }),
  'review.edited_by_chair': (_d, p) => ({
    module: 'Peer Review',
    action: 'Updated',
    description: `The chair updated your review of ${p}.`,
  }),
  'review.extension_requested': (d, p) => ({
    module: 'Peer Review',
    action: 'Created',
    description: `You asked for more time on ${p}.`,
    newValue: text(d.date) || undefined,
  }),
  'review.extension_approved': (d, p) => ({
    module: 'Peer Review',
    action: 'Approved',
    description: `The chair approved more time on ${p}.`,
    newValue: text(d.date) || undefined,
  }),
  'review.extension_declined': (_d, p) => ({
    module: 'Peer Review',
    action: 'Rejected',
    description: `The chair declined more time on ${p}.`,
  }),
  'review.due_date_changed': (d, p) => ({
    module: 'Peer Review',
    action: 'Changed',
    description: `The chair moved your deadline on ${p}.`,
    newValue: text(d.date) || undefined,
  }),
  'review.reminded': (_d, p) => ({
    module: 'Peer Review',
    action: 'Sent',
    description: `The chair sent you a reminder about ${p}.`,
  }),
  'review.messaged': (_d, p) => ({
    module: 'Peer Review',
    action: 'Sent',
    description: `The chair wrote to you about ${p}.`,
  }),
};
/** What only the reviewer themselves can have done (the rest is done to them). */
const REVIEWER_OWN = new Set([
  'review.accepted',
  'review.declined',
  'review.submitted',
  'review.extension_requested',
]);

/** An author's own log: Submissions only, what they did and what the chair did to their papers. */
const AUTHOR: Record<string, (d: Data, paper: string) => Shown> = {
  'submission.created': (_d, p) => ({
    module: 'Submissions',
    action: 'Submitted',
    description: `Submitted ${p}.`,
  }),
  'submission.details_updated': (_d, p) => ({
    module: 'Submissions',
    action: 'Updated',
    description: `The details of ${p} were updated.`,
  }),
  'submission.authors_updated': (_d, p) => ({
    module: 'Submissions',
    action: 'Updated',
    description: `The authors of ${p} were updated.`,
  }),
  'submission.file_uploaded': (_d, p) => ({
    module: 'Submissions',
    action: 'Updated',
    description: `A file was uploaded for ${p}.`,
  }),
  'submission.withdrawn': (_d, p) => ({
    module: 'Submissions',
    action: 'Changed',
    description: `${p} was withdrawn.`,
  }),
  'submission.fix_requested': (d, p) => ({
    module: 'Submissions',
    action: 'Sent',
    description: `The chair asked you to fix something in ${p}.`,
    newValue: text(d.fixBy) || undefined,
  }),
  'submission.screening_notified': (_d, p) => ({
    module: 'Submissions',
    action: 'Sent',
    description: `The screening result of ${p} was sent to you.`,
  }),
  'submission.track_changed': (d, p) => ({
    module: 'Submissions',
    action: 'Changed',
    description: `${p} was moved to another track.`,
    newValue: text(d.track) || undefined,
  }),
};

/** "My Activity Logs" for an author or a reviewer of one conference (their own entries only). */
@Injectable()
export class MyActivityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly recipients: EmailRecipientsService,
  ) {}

  async list(
    user: AuthUser,
    conferenceId: string,
    role: 'author' | 'reviewer',
    limit: number,
  ): Promise<ActivityEntryResponse[]> {
    return this.database.transaction(async (tx) => {
      await this.access.requireConference(user, conferenceId, tx);
      const [conference] = await tx
        .select({ acronym: conferences.acronym })
        .from(conferences)
        .where(eq(conferences.id, conferenceId));
      const papers = await tx
        .select({
          id: submissions.id,
          paperNo: submissions.paperNo,
          submitterId: submissions.submitterId,
          details: submissions.details,
        })
        .from(submissions)
        .where(eq(submissions.conferenceId, conferenceId));
      const label = new Map(
        papers.map((p) => [p.id, paperId(conference.acronym, p.paperNo)]),
      );
      const paperIds = papers.map((p) => p.id);
      if (paperIds.length === 0) {
        return [];
      }

      // The papers this person is concerned with, and the ids that tie an audit row to them. A
      // paper a chair submitted on an author's behalf is not the chair's as an author.
      const mineAsAuthor = new Set<string>(
        papers.filter((p) => submittedAsAuthor(p, user.id)).map((p) => p.id),
      );
      for (const a of await tx
        .select({ submissionId: submissionAuthors.submissionId })
        .from(submissionAuthors)
        .where(
          and(
            inArray(submissionAuthors.submissionId, paperIds),
            eq(submissionAuthors.userId, user.id),
          ),
        )) {
        mineAsAuthor.add(a.submissionId);
      }
      const myAssignments = await tx
        .select({
          id: reviewAssignments.id,
          submissionId: reviewAssignments.submissionId,
        })
        .from(reviewAssignments)
        .where(
          and(
            inArray(reviewAssignments.submissionId, paperIds),
            eq(reviewAssignments.reviewerId, user.id),
          ),
        );
      const myReviews = new Set(
        (
          await tx
            .select({ id: reviews.id })
            .from(reviews)
            .where(
              and(
                inArray(reviews.submissionId, paperIds),
                eq(reviews.reviewerId, user.id),
              ),
            )
        ).map((r) => r.id),
      );
      const myAssignmentIds = new Set(myAssignments.map((a) => a.id));
      const mySubmissions =
        role === 'author'
          ? mineAsAuthor
          : new Set(myAssignments.map((a) => a.submissionId));
      if (mySubmissions.size === 0) {
        return [];
      }

      const table = role === 'author' ? AUTHOR : REVIEWER;
      const rows = await tx
        .select()
        .from(auditLog)
        .where(
          and(
            inArray(auditLog.action, Object.keys(table)),
            or(
              and(
                eq(auditLog.entityType, 'submission'),
                inArray(auditLog.entityId, [...mySubmissions]),
              ),
              and(
                eq(auditLog.entityType, 'review'),
                inArray(sql`${auditLog.data}->>'submissionId'`, [
                  ...mySubmissions,
                ]),
              ),
              and(
                eq(auditLog.entityType, 'conference'),
                eq(auditLog.entityId, conferenceId),
                eq(auditLog.action, 'submission.track_changed'),
              ),
            ),
          ),
        )
        .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
        .limit(limit * 3);

      const chairs = new Set(
        (
          await tx
            .select({ userId: conferenceMembers.userId })
            .from(conferenceMembers)
            .where(
              and(
                eq(conferenceMembers.conferenceId, conferenceId),
                inArray(conferenceMembers.role, ['chair', 'track_chair']),
              ),
            )
        ).map((m) => m.userId),
      );

      const kept: { r: (typeof rows)[number]; sid: string }[] = [];
      for (const r of rows) {
        const d = r.data as Data;
        let sid: string | null = null;
        if (r.entityType === 'conference') {
          // a bulk track change names its papers in the data
          const ids = Array.isArray(d.ids) ? (d.ids as string[]) : [];
          sid = ids.find((id) => mySubmissions.has(id)) ?? null;
        } else if (r.entityType === 'submission') {
          sid = r.entityId;
        } else {
          sid = text(d.submissionId) || null;
        }
        if (!sid || !mySubmissions.has(sid)) {
          continue;
        }
        if (role === 'reviewer') {
          const isMine =
            r.action === 'review.assigned'
              ? Array.isArray(d.assigned) && d.assigned.includes(user.id)
              : r.action === 'review.unassigned'
                ? d.reviewerId === user.id
                : r.action === 'review.edited_by_chair'
                  ? myReviews.has(r.entityId ?? '')
                  : r.action === 'review.submitted'
                    ? r.actorId === user.id
                    : myAssignmentIds.has(text(d.assignmentId)) &&
                      (!REVIEWER_OWN.has(r.action) || r.actorId === user.id);
          if (!isMine) {
            continue;
          }
        }
        kept.push({ r, sid });
        if (kept.length >= limit) {
          break;
        }
      }

      const people = await this.recipients.people(
        tx,
        kept.flatMap(({ r }) => (r.actorId ? [r.actorId] : [])),
      );
      return kept.map(({ r, sid }): ActivityEntryResponse => {
        const shown = table[r.action](
          r.data as Data,
          label.get(sid) ?? 'a paper',
        );
        const mine = r.actorId === user.id;
        const chair = r.actorId ? chairs.has(r.actorId) : false;
        return {
          id: String(r.id),
          at: r.occurredAt.toISOString(),
          // A reviewer never sees another person's name; an author sees who did something to their paper.
          actorName: mine
            ? (people.get(r.actorId!)?.name ?? 'You')
            : role === 'reviewer'
              ? 'The chair'
              : (people.get(r.actorId ?? '')?.name ?? 'Smartconferu'),
          actorRole: mine ? role : chair ? 'chair' : 'system',
          action: shown.action,
          module: shown.module,
          description: shown.description,
          status: 'success',
          reviewerName: null,
          previousValue: null,
          newValue: shown.newValue ?? null,
        };
      });
    });
  }
}
