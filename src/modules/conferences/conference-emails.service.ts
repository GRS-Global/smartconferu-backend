import { Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../../core/database/database.types.js';
import {
  conferences,
  emailTemplates,
  submissions,
} from '../../core/database/schema/index.js';
import {
  emailDate,
  escapeHtml,
  firstName,
  htmlToText,
  renderTemplate,
} from '../../core/email/email-render.js';
import {
  DECISION_FALLBACKS,
  type DecisionTemplateKey,
} from './decision-emails.js';
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
import { appPaths } from '../../core/http/app-paths.js';

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
    const cfp = this.recipients.link(appPaths.cfpManager(conference.slug));
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

  /** A chair asked for a license extension → the Super Admins (as the Call for Papers and deletion requests do). */
  async licenseRequested(
    executor: Executor,
    conference: ConferenceFacts,
    requesterId: string,
    requestedDate: string,
    reason: string | null,
  ): Promise<void> {
    const requester = await this.one(executor, requesterId);
    const admins = await this.recipients.superAdmins(executor);
    const review = this.recipients.link('/super-admin/license-requests');
    const emails = admins.map((admin): WrittenEmail => ({
      key: 'licenseRequestAdmin',
      label: 'License extension requested',
      recipientType: 'Super Admin',
      to: admin,
      subject: `License extension requested: ${conference.acronym}`,
      body:
        `<p>Hi ${escapeHtml(firstName(admin.name, admin.email))},</p>` +
        `<p>${escapeHtml(requester?.name ?? 'A chair')} (${escapeHtml(requester?.email ?? '')}) asked to extend the license of <b>${escapeHtml(conference.acronym)}</b> — ${escapeHtml(conference.title)} until <b>${escapeHtml(requestedDate)}</b>.</p>` +
        (reason ? `<p>Reason: “${escapeHtml(reason)}”</p>` : '') +
        `<p>Decide in the Super Admin console: <a href="${escapeHtml(review)}" style="color:#4F46E5">${escapeHtml(review)}</a></p>`,
    }));
    await this.queue.enqueue(executor, 'conference_license_requested', emails, {
      sentBy: requesterId,
    });
  }

  /** A Super Admin decided a license extension → the conference's chairs. */
  async licenseDecided(
    executor: Executor,
    conference: ConferenceFacts,
    approved: boolean,
    until: string | null,
    reason: string | null,
    adminId: string,
  ): Promise<void> {
    const chairs = await this.recipients.chairs(executor, conference.id);
    const settings = this.recipients.link(
      appPaths.chairDashboard(conference.slug),
    );
    const acronym = escapeHtml(conference.acronym);
    const emails = chairs.map((chair): WrittenEmail => ({
      key: approved ? 'licenseApproved' : 'licenseDeclined',
      label: approved ? 'License extended' : 'License extension not approved',
      recipientType: 'Chair',
      conference: this.conference(conference),
      to: chair,
      subject: approved
        ? `The license of ${conference.acronym} was extended`
        : `The license extension of ${conference.acronym} was not approved`,
      body:
        `<p>Dear ${escapeHtml(firstName(chair.name, chair.email))},</p>` +
        (approved
          ? `<p>The license of <b>${acronym}</b> now runs until <b>${escapeHtml(until ?? '')}</b>.</p>`
          : `<p>The request to extend the license of <b>${acronym}</b> was not approved${reason ? `:</p><p>“${escapeHtml(reason)}”</p><p>` : '. '}You can send a new request from Conference Settings.</p>`) +
        `<p><a href="${escapeHtml(settings)}" style="color:#4F46E5">${escapeHtml(settings)}</a></p>`,
    }));
    await this.queue.enqueue(executor, 'conference_license_decided', emails, {
      sentBy: adminId,
    });
  }

  /** The platform's text for a decision email: the stored template, else the built-in one. */
  private async decisionTemplate(executor: Executor, key: DecisionTemplateKey) {
    const [row] = await executor
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.key, key));
    const fallback = DECISION_FALLBACKS[key];
    return {
      label: row?.label ?? fallback.label,
      subject: row?.subject ?? fallback.subject,
      body: row?.body ?? fallback.body,
    };
  }

  /** What the decision popup shows and edits: both emails as plain text, and the logo they carry. */
  async decisionDefaults(executor: Executor) {
    const one = async (key: DecisionTemplateKey) => {
      const t = await this.decisionTemplate(executor, key);
      return { subject: t.subject, body: htmlToText(t.body).trim() };
    };
    return {
      approved: await one('conferenceApproved'),
      declined: await one('conferenceDeclined'),
      logoUrl: this.queue.logoUrl ?? null,
    };
  }

  /** "Save as the default": the next decisions start from this text. */
  async saveDecisionDefault(
    executor: Executor,
    approved: boolean,
    text: { subject?: string; body?: string },
    adminId: string,
  ): Promise<void> {
    const key: DecisionTemplateKey = approved
      ? 'conferenceApproved'
      : 'conferenceDeclined';
    const current = await this.decisionTemplate(executor, key);
    await executor
      .update(emailTemplates)
      .set({
        subject: text.subject || current.subject,
        body: text.body || current.body,
        updatedBy: adminId,
        updatedAt: new Date(),
      })
      .where(eq(emailTemplates.key, key));
  }

  /** A super admin decided a conference request → the chair who asked. `override` is the text typed in the popup (body as HTML). */
  async decided(
    executor: Executor,
    conference: ConferenceFacts & { createdBy: string },
    approved: boolean,
    adminId: string,
    override?: { subject?: string; body?: string },
  ): Promise<void> {
    const chair = await this.one(executor, conference.createdBy);
    if (!chair) {
      return;
    }
    const template = await this.decisionTemplate(
      executor,
      approved ? 'conferenceApproved' : 'conferenceDeclined',
    );
    const values = {
      first_name: firstName(chair.name, chair.email),
      conference_name: conference.title,
      conference_acronym: conference.acronym,
      dashboard_link: this.recipients.link(
        appPaths.chairDashboard(conference.slug),
      ),
      // The reason is written as HTML by the renderer (see HTML_VALUES), so it is escaped here.
      reason: escapeHtml(conference.adminNote || 'No reason was given.'),
    };
    await this.queue.enqueue(
      executor,
      'conference_decided',
      {
        key: approved ? 'conferenceApproved' : 'conferenceDeclined',
        label: template.label,
        recipientType: 'Chair',
        conference: approved ? this.conference(conference) : null,
        to: chair,
        subject: renderTemplate(override?.subject || template.subject, values, {
          html: false,
        }),
        body: renderTemplate(override?.body || template.body, values, {
          html: true,
        }),
      },
      { sentBy: adminId },
    );
  }

  /** A super admin needs more before deciding a conference request ("Ask for info") → the chair who asked. */
  async infoRequested(
    executor: Executor,
    conference: ConferenceFacts & { createdBy: string },
    message: string,
    adminId: string,
  ): Promise<void> {
    const chair = await this.one(executor, conference.createdBy);
    if (!chair) {
      return;
    }
    const requests = this.recipients.link('/conferences');
    await this.queue.enqueue(
      executor,
      'conference_info_requested',
      {
        key: 'conferenceInfoRequested',
        label: 'More information needed for a conference request',
        recipientType: 'Chair',
        conference: null,
        to: chair,
        subject: `About your request for ${conference.acronym}`,
        body:
          `<p>Dear ${escapeHtml(firstName(chair.name, chair.email))},</p>` +
          `<p>Before we can approve your request to host <b>${escapeHtml(conference.acronym)}</b> on Smartconferu, we need a little more:</p>` +
          `<p>“${escapeHtml(message)}”</p>` +
          `<p>Please reply to this email or update your request from My Conferences:</p>` +
          `<p><a href="${escapeHtml(requests)}" style="color:#4F46E5">${escapeHtml(requests)}</a></p>`,
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
            appPaths.chairDashboard(conference.slug),
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
