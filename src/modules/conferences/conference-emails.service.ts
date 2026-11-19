import { Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../../core/database/database.types.js';
import { conferences, submissions } from '../../core/database/schema/index.js';
import {
  emailDate,
  escapeHtml,
  firstName,
} from '../../core/email/email-render.js';
import {
  type EmailConference,
  EmailQueueService,
  type OutgoingEmail,
  type WrittenEmail,
} from '../../core/email/email-queue.service.js';
import {
  EmailRecipientsService,
  type Person,
} from '../../core/email/email-recipients.service.js';
import { paperId } from '../submissions/submission.mapper.js';

/** A conference, as the emails about it need it. */
interface ConferenceFacts extends EmailConference {
  slug: string;
  startDate?: string | null;
  endDate?: string | null;
  city?: string | null;
  country?: string | null;
  adminNote?: string | null;
  reviewDeadline?: Date | null;
}

/**
 * The emails about conferences and their teams, as the app's old src/shared/emailRequest.js sent
 * them. Each method queues its emails in the caller's transaction.
 */
@Injectable()
export class ConferenceEmailsService {
  constructor(
    private readonly queue: EmailQueueService,
    private readonly recipients: EmailRecipientsService,
  ) {}

  /** The conference as these emails need it. */
  async facts(
    executor: Executor,
    conferenceId: string,
  ): Promise<ConferenceFacts> {
    const [row] = await executor
      .select()
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    if (!row) {
      throw new Error(`Conference ${conferenceId} not found`);
    }
    return row;
  }

  private conference(c: ConferenceFacts): EmailConference {
    return {
      id: c.id,
      title: c.title,
      acronym: c.acronym,
      contactEmail: c.contactEmail ?? null,
    };
  }

  private one(executor: Executor, userId: string) {
    return this.recipients
      .people(executor, [userId])
      .then((people) => people.get(userId));
  }

  /** A chair asked for a conference → the super admins. */
  async requested(
    executor: Executor,
    conference: ConferenceFacts,
    requesterId: string,
  ): Promise<void> {
    const requester = await this.one(executor, requesterId);
    const admins = await this.recipients.superAdmins(executor);
    const review = this.recipients.link('/super-admin/conference-requests');
    const place =
      [conference.city, conference.country].filter(Boolean).join(', ') || '—';
    const emails = admins.map((admin): WrittenEmail => ({
      key: 'conferenceRequestAdmin',
      label: 'New conference request',
      recipientType: 'Super Admin',
      to: admin,
      subject: `New conference request: ${conference.acronym}`,
      body:
        `<p>Hi ${escapeHtml(firstName(admin.name, admin.email))},</p>` +
        `<p>${escapeHtml(requester?.name ?? 'Someone')} (${escapeHtml(requester?.email ?? '')}) has asked to host <b>${escapeHtml(conference.acronym)}</b> — ${escapeHtml(conference.title)} on Smartconferu.</p>` +
        `<p>Dates: ${escapeHtml(emailDate(conference.startDate))} – ${escapeHtml(emailDate(conference.endDate))}<br>Location: ${escapeHtml(place)}</p>` +
        `<p>Review it in the Super Admin console: <a href="${escapeHtml(review)}" style="color:#4F46E5">${escapeHtml(review)}</a></p>`,
    }));
    await this.queue.enqueue(executor, 'conference_requested', emails, {
      sentBy: requesterId,
    });
  }

  /** A chair or CFP manager sent the Call for Papers for approval → the super admins. */
  async cfpSubmitted(
    executor: Executor,
    conference: ConferenceFacts,
    senderId: string,
  ): Promise<void> {
    const sender = await this.one(executor, senderId);
    const admins = await this.recipients.superAdmins(executor);
    const review = this.recipients.link('/super-admin/cfp-requests');
    const emails = admins.map((admin): WrittenEmail => ({
      key: 'cfpReviewAdmin',
      label: 'Call for Papers waiting for approval',
      recipientType: 'Super Admin',
      to: admin,
      subject: `Call for Papers to approve: ${conference.acronym}`,
      body:
        `<p>Hi ${escapeHtml(firstName(admin.name, admin.email))},</p>` +
        `<p>${escapeHtml(sender?.name ?? 'Someone')} (${escapeHtml(sender?.email ?? '')}) has sent the Call for Papers of <b>${escapeHtml(conference.acronym)}</b> — ${escapeHtml(conference.title)} for approval. Submissions open once you approve it.</p>` +
        `<p>Review it in the Super Admin console: <a href="${escapeHtml(review)}" style="color:#4F46E5">${escapeHtml(review)}</a></p>`,
    }));
    await this.queue.enqueue(executor, 'conference_cfp_submitted', emails, {
      sentBy: senderId,
    });
  }

  /** A super admin approved or declined a Call for Papers → the conference's chairs. */
  async cfpDecided(
    executor: Executor,
    conference: ConferenceFacts,
    approved: boolean,
    note: string | null,
    adminId: string,
  ): Promise<void> {
    const chairs = await this.recipients.chairs(executor, conference.id);
    const cfp = this.recipients.link(`/cfp-manager/${conference.slug}`);
    const acronym = escapeHtml(conference.acronym);
    const emails = chairs.map((chair): WrittenEmail => ({
      key: approved ? 'cfpApproved' : 'cfpDeclined',
      label: approved
        ? 'Call for Papers approved'
        : 'Call for Papers not approved',
      recipientType: 'Chair',
      conference: approved ? this.conference(conference) : null,
      to: chair,
      subject: approved
        ? `The Call for Papers of ${conference.acronym} is live`
        : `The Call for Papers of ${conference.acronym} was not approved`,
      body:
        `<p>Dear ${escapeHtml(firstName(chair.name, chair.email))},</p>` +
        (approved
          ? `<p>The Call for Papers of <b>${acronym}</b> has been approved. Submissions are open now.</p>`
          : `<p>The Call for Papers of <b>${acronym}</b> was not approved${note ? `:</p><p>“${escapeHtml(note)}”</p><p>` : '. '}Please update it and send it for approval again.</p>`) +
        `<p><a href="${escapeHtml(cfp)}" style="color:#4F46E5">${escapeHtml(cfp)}</a></p>`,
    }));
    await this.queue.enqueue(executor, 'conference_cfp_decided', emails, {
      sentBy: adminId,
    });
  }

  /** A super admin approved or declined a request → the chair who asked. */
  async decided(
    executor: Executor,
    conference: ConferenceFacts & { createdBy: string },
    approved: boolean,
    adminId: string,
  ): Promise<void> {
    const chair = await this.one(executor, conference.createdBy);
    if (!chair) {
      return;
    }
    const hi = `<p>Dear ${escapeHtml(firstName(chair.name, chair.email))},</p>`;
    const dashboard = this.recipients.link(
      `/conference/${conference.slug}/chair`,
    );
    const acronym = escapeHtml(conference.acronym);
    await this.queue.enqueue(
      executor,
      'conference_decided',
      {
        key: approved ? 'conferenceApproved' : 'conferenceDeclined',
        label: approved ? 'Conference approved' : 'Conference request declined',
        recipientType: 'Chair',
        conference: approved ? this.conference(conference) : null,
        to: chair,
        subject: approved
          ? `${conference.acronym} is approved`
          : `Your request for ${conference.acronym}`,
        body: approved
          ? `${hi}<p>Your request to host <b>${acronym}</b> (${escapeHtml(conference.title)}) on Smartconferu has been approved. Open your conference to add the call for papers, tracks, deadlines and reviewers:</p><p><a href="${escapeHtml(dashboard)}" style="color:#4F46E5">${escapeHtml(dashboard)}</a></p>`
          : `${hi}<p>Thank you for your interest in hosting <b>${acronym}</b> on Smartconferu. We weren't able to approve the request${conference.adminNote ? `:</p><p>“${escapeHtml(conference.adminNote)}”</p>` : '.</p>'}<p>You can send a new request any time from My Conferences.</p>`,
      },
      { sentBy: adminId },
    );
  }

  /** A super admin decided a deletion request → the chair who asked. */
  async deletionDecided(
    executor: Executor,
    conference: ConferenceFacts,
    requesterId: string,
    approved: boolean,
    note: string | null,
    adminId: string,
  ): Promise<void> {
    const chair = await this.one(executor, requesterId);
    if (!chair) {
      return;
    }
    await this.queue.enqueue(
      executor,
      'conference_deletion_decided',
      {
        template: approved ? 'deletionApproved' : 'deletionRejected',
        recipientType: 'Chair',
        conference: this.conference(conference),
        to: chair,
        values: {
          first_name: firstName(chair.name, chair.email),
          admin_note: note || 'No reason was given.',
        },
      },
      { sentBy: adminId },
    );
  }

  /** A super admin brought a deleted conference back → the chair who asked for the deletion. */
  async restored(
    executor: Executor,
    conference: ConferenceFacts,
    chairId: string,
    adminId: string,
  ): Promise<void> {
    const chair = await this.one(executor, chairId);
    if (!chair) {
      return;
    }
    await this.queue.enqueue(
      executor,
      'conference_restored',
      {
        template: 'conferenceRestored',
        recipientType: 'Chair',
        conference: this.conference(conference),
        to: chair,
        values: {
          first_name: firstName(chair.name, chair.email),
          dashboard_link: this.recipients.link(
            `/conference/${conference.slug}/chair`,
          ),
        },
      },
      { sentBy: adminId },
    );
  }

  /** A chair invited someone to the reviewer committee → that person (welcomed if new). */
  async reviewerInvited(
    executor: Executor,
    conference: ConferenceFacts,
    invited: { userId: string | null; email: string; name: string | null },
    chairId: string,
  ): Promise<void> {
    const account = invited.userId
      ? await this.one(executor, invited.userId)
      : undefined;
    const to = {
      email: account?.email ?? invited.email,
      name: account?.name ?? invited.name ?? '',
    };
    const emails: OutgoingEmail[] = [
      ...(account ? [] : await this.recipients.welcomeEmails(executor, [to])),
      {
        template: 'reviewerInvited',
        recipientType: 'Reviewer',
        conference: this.conference(conference),
        to,
        values: {
          first_name: firstName(to.name, to.email),
          tracks: 'All tracks',
          review_period: conference.reviewDeadline
            ? `until ${emailDate(conference.reviewDeadline)}`
            : 'dates to be announced by the chair',
          activate_link: this.recipients.link(
            account ? '/dashboard' : '/register',
          ),
          login_link: this.recipients.link('/login'),
        },
      },
    ];
    await this.queue.enqueue(executor, 'reviewer_invited', emails, {
      sentBy: chairId,
    });
  }

  /**
   * Someone accepted a committee invitation → the chairs ("joined the team"), and the reviewer
   * the papers that were waiting for them.
   */
  async invitationAccepted(
    executor: Executor,
    conference: ConferenceFacts,
    member: { userId: string; role: string },
    papers: readonly { submissionId: string; dueAt: Date | null }[],
  ): Promise<void> {
    const person = await this.one(executor, member.userId);
    if (!person) {
      return;
    }
    const conf = this.conference(conference);
    const chairs = await this.recipients.chairs(executor, conference.id);
    const emails: OutgoingEmail[] = chairs
      .filter((c) => c.userId !== member.userId)
      .map((c: Person) => ({
        template: 'teamMemberJoined',
        recipientType: 'Chair',
        conference: conf,
        to: c,
        values: {
          first_name: firstName(c.name, c.email),
          member_name: person.name,
          role:
            member.role === 'reviewer'
              ? 'Reviewer'
              : member.role.replace('_', ' '),
        },
      }));
    if (papers.length > 0) {
      const rows = await executor
        .select({ paperNo: submissions.paperNo, title: submissions.title })
        .from(submissions)
        .where(
          inArray(
            submissions.id,
            papers.map((p) => p.submissionId),
          ),
        )
        .orderBy(asc(submissions.paperNo));
      const due = papers
        .map((p) => p.dueAt)
        .filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      emails.push({
        template: 'reviewAssignment',
        recipientType: 'Reviewer',
        conference: conf,
        to: person,
        values: {
          first_name: firstName(person.name, person.email),
          paper_list: rows
            .map(
              (r) =>
                `${escapeHtml(paperId(conference.acronym, r.paperNo))} · ${escapeHtml(r.title)}`,
            )
            .join('<br>'),
          review_deadline:
            emailDate(due) ||
            emailDate(conference.reviewDeadline) ||
            'the date the chair set',
          review_link: this.recipients.link(`/reviewer/${conference.slug}`),
        },
      });
    }
    await this.queue.enqueue(executor, 'invitation_answered', emails, {
      sentBy: member.userId,
    });
  }
}
