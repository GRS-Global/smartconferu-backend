import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, notExists, sql } from 'drizzle-orm';
import type { Tx } from '../../../core/database/database.types.js';
import {
  conferences,
  emailLog,
  reviewAssignments,
  reviews,
  submissions,
} from '../../../core/database/schema/index.js';
import {
  emailDate,
  escapeHtml,
  firstName,
} from '../../../core/email/email-render.js';
import {
  EmailQueueService,
  type TemplateEmail,
} from '../../../core/email/email-queue.service.js';
import { EmailRecipientsService } from '../../../core/email/email-recipients.service.js';
import { NotificationsService } from '../../../core/notifications/notifications.service.js';
import { paperId } from '../../submissions/submission.mapper.js';
import {
  daysLabel,
  offsetMinutes,
  planReviewReminders,
  timelineOf,
} from './review-reminders.js';

const TEMPLATES = { 1: 'reviewDueSoon', 2: 'reviewLastDay' } as const;
/** Nobody gets the same reminder from the same conference twice within this many hours. */
const ONCE_PER_HOURS = 20;

export interface ReminderRun {
  conferences: number;
  remindersDue: number;
  queued: number;
}

/**
 * Sends the review reminders due today: one email per reviewer listing their pending papers (and
 * a bell notification), only for reviews not sent yet. Replaces netlify/functions/
 * send-review-reminders.mjs. Safe to run every hour: a reminder already queued or sent in the
 * last 20 hours is not sent again.
 */
@Injectable()
export class ReviewRemindersService {
  constructor(
    private readonly emails: EmailQueueService,
    private readonly recipients: EmailRecipientsService,
    private readonly notifications: NotificationsService,
  ) {}

  async run(tx: Tx, now: Date = new Date()): Promise<ReminderRun> {
    const active = await tx
      .select({
        id: conferences.id,
        slug: conferences.slug,
        title: conferences.title,
        acronym: conferences.acronym,
        contactEmail: conferences.contactEmail,
        details: conferences.details,
        settings: conferences.settings,
      })
      .from(conferences)
      .where(eq(conferences.status, 'active'));
    let remindersDue = 0;
    let queued = 0;

    for (const conf of active) {
      const waiting = await tx
        .select({
          id: reviewAssignments.id,
          reviewerId: reviewAssignments.reviewerId,
          submissionId: reviewAssignments.submissionId,
          assignedAt: reviewAssignments.assignedAt,
          dueAt: reviewAssignments.dueAt,
          paperNo: submissions.paperNo,
          title: submissions.title,
        })
        .from(reviewAssignments)
        .innerJoin(
          submissions,
          eq(submissions.id, reviewAssignments.submissionId),
        )
        .where(
          and(
            eq(submissions.conferenceId, conf.id),
            eq(submissions.status, 'submitted'),
            inArray(reviewAssignments.status, ['assigned', 'accepted']),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(reviews)
                .where(
                  and(
                    eq(reviews.assignmentId, reviewAssignments.id),
                    eq(reviews.status, 'submitted'),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(submissions.paperNo));
      if (waiting.length === 0) {
        continue;
      }
      const settings = conf.settings as Record<string, unknown>;
      const details = conf.details as Record<string, unknown>;
      const plan = planReviewReminders({
        now,
        offsetMin: offsetMinutes(details.timezone),
        timeline: timelineOf(settings.reviewTimeline),
        assignments: waiting,
      });
      if (plan.length === 0) {
        continue;
      }
      remindersDue += plan.length;

      const byReviewer = new Map<string, typeof plan>();
      for (const p of plan) {
        byReviewer.set(p.reviewerId, [
          ...(byReviewer.get(p.reviewerId) ?? []),
          p,
        ]);
      }
      const people = await this.recipients.people(tx, [...byReviewer.keys()]);
      const earlier = await tx
        .select({
          key: emailLog.templateKey,
          email: sql<string>`lower(${emailLog.toEmail})`,
        })
        .from(emailLog)
        .where(
          and(
            eq(emailLog.conferenceId, conf.id),
            inArray(emailLog.templateKey, Object.values(TEMPLATES)),
            inArray(emailLog.status, ['queued', 'sending', 'sent']),
            gt(
              emailLog.createdAt,
              new Date(now.getTime() - ONCE_PER_HOURS * 3_600_000),
            ),
          ),
        );
      const already = new Set(earlier.map((e) => `${e.key}:${e.email}`));
      const titles = new Map(waiting.map((w) => [w.submissionId, w]));

      const messages: TemplateEmail[] = [];
      for (const [reviewerId, list] of byReviewer) {
        const person = people.get(reviewerId);
        if (!person) {
          continue;
        }
        const kind = list.some((p) => p.kind === 2) ? 2 : 1;
        const template = TEMPLATES[kind];
        if (already.has(`${template}:${person.email.toLowerCase()}`)) {
          continue;
        }
        const soonest = [...list].sort((a, b) =>
          a.dueDay.localeCompare(b.dueDay),
        )[0];
        const pending = list
          .map((p) => {
            const paper = titles.get(p.submissionId)!;
            return `<li>${escapeHtml(paperId(conf.acronym, paper.paperNo))} · ${escapeHtml(paper.title)} — due ${escapeHtml(emailDate(p.dueDay))}</li>`;
          })
          .join('');
        messages.push({
          template,
          recipientType: 'Reviewer',
          conference: conf,
          to: person,
          values: {
            first_name: firstName(person.name, person.email),
            pending_list: `<ul>${pending}</ul>`,
            review_deadline: emailDate(soonest.dueDay),
            days_left: daysLabel(soonest.daysLeft),
            review_link: this.recipients.link(
              `/prototype/reviewer/${conf.slug}`,
            ),
          },
        });
        await this.notifications.notify(tx, [reviewerId], {
          kind: 'review_reminder',
          title:
            kind === 2
              ? `Last day to review — ${conf.acronym}`
              : `${daysLabel(soonest.daysLeft)} left to review — ${conf.acronym}`,
          body: `${list.length} review${list.length === 1 ? ' is' : 's are'} still waiting. Due ${emailDate(soonest.dueDay)}.`,
          conferenceId: conf.id,
          link: `/prototype/reviewer/${conf.slug}`,
        });
      }
      if (messages.length > 0) {
        queued += (await this.emails.enqueue(tx, 'review_reminders', messages))
          .queued;
      }
    }
    return { conferences: active.length, remindersDue, queued };
  }
}
