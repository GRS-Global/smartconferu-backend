import { Injectable } from '@nestjs/common';
import type { Executor } from '../../core/database/database.types.js';
import {
  emailDate,
  escapeHtml,
  firstName,
  VALID_EMAIL,
} from '../../core/email/email-render.js';
import type {
  EmailConference,
  OutgoingEmail,
  TemplateEmail,
} from '../../core/email/email-queue.service.js';
import {
  EmailRecipientsService,
  type Person,
} from '../../core/email/email-recipients.service.js';
import { paperId } from './submission.mapper.js';
import type { AuthorRow, SubmissionRow } from './submissions.repository.js';

/** Everything the paper emails are built from. */
export interface PaperContext {
  conference: EmailConference & {
    slug: string;
    submissionDeadline: Date | null;
  };
  submission: SubmissionRow;
  authors: AuthorRow[];
  /** Who did the action. */
  actor: Person;
}

interface Recipient {
  email: string;
  name: string;
  hasAccount: boolean;
  corresponding: boolean;
}

const key = (email: string) => email.trim().toLowerCase();

function unique(list: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    if (!VALID_EMAIL.test(r.email.trim()) || seen.has(key(r.email))) {
      return false;
    }
    seen.add(key(r.email));
    return true;
  });
}

/**
 * Builds the emails about a paper (who gets which template, with which values), as the app's old
 * src/shared/emailRequest.js did. The callers queue them in the same transaction as the change.
 *
 * Who hears what:
 * - updates (received, screening, withdrawal) go to the submitter and every corresponding author;
 * - the other authors are told once that they were added as a co-author;
 * - people without an account are also welcomed to Smartconferu (once).
 */
@Injectable()
export class SubmissionEmailsService {
  constructor(private readonly recipients: EmailRecipientsService) {}

  private link(path: string) {
    return this.recipients.link(path);
  }

  /** The submitter and the corresponding authors; the other authors separately. */
  private async authorRecipients(executor: Executor, ctx: PaperContext) {
    const submitter = (
      await this.recipients.people(executor, [ctx.submission.submitterId])
    ).get(ctx.submission.submitterId);
    const person = (a: AuthorRow): Recipient => ({
      email: a.email,
      name: a.name,
      hasAccount: a.userId !== null,
      corresponding: a.isCorresponding,
    });
    const updates = unique([
      ...(submitter
        ? [
            {
              email: submitter.email,
              name: submitter.name,
              hasAccount: true,
              corresponding: true,
            },
          ]
        : []),
      ...ctx.authors.filter((a) => a.isCorresponding).map(person),
    ]);
    const submitterEmail = submitter ? key(submitter.email) : '';
    const coAuthors = unique(ctx.authors.map(person)).filter(
      (a) => key(a.email) !== submitterEmail,
    );
    return { updates, coAuthors, submitterEmail };
  }

  private common(ctx: PaperContext) {
    const details = ctx.submission.details as Record<string, unknown>;
    return {
      submission_id: this.paperId(ctx),
      paper_title: ctx.submission.title,
      track:
        typeof details.track === 'string' ? details.track : 'General Track',
      presentation_type:
        typeof details.presentationType === 'string'
          ? details.presentationType
          : 'Paper Presentation',
      edit_deadline:
        emailDate(ctx.conference.submissionDeadline) ||
        'the submission deadline',
      submitter_name: ctx.actor.name,
    };
  }

  private paperId(ctx: PaperContext) {
    return paperId(ctx.conference.acronym, ctx.submission.paperNo);
  }

  private base(ctx: PaperContext) {
    return { conference: ctx.conference, submissionId: ctx.submission.id };
  }

  private coAuthorAdded(
    ctx: PaperContext,
    to: Recipient,
    submitterIsAuthor: boolean,
  ): TemplateEmail {
    return {
      ...this.base(ctx),
      template: 'coAuthorAdded',
      recipientType: 'Co-author',
      to,
      values: {
        ...this.common(ctx),
        first_name: firstName(to.name, to.email),
        claim_link: this.link(
          to.hasAccount ? '/prototype/login' : '/prototype/register',
        ),
        updates_note:
          submitterIsAuthor && to.corresponding
            ? 'You are marked as a corresponding author, so you will receive every update about this paper by email.'
            : 'You can follow the paper from your dashboard; the corresponding authors receive the email updates.',
      },
    };
  }

  private async chairAlerts(executor: Executor, ctx: PaperContext) {
    const pid = this.paperId(ctx);
    return (await this.recipients.chairs(executor, ctx.conference.id)).map(
      (c): TemplateEmail => ({
        ...this.base(ctx),
        template: 'newSubmissionAlert',
        recipientType: 'Chair',
        to: c,
        values: {
          ...this.common(ctx),
          first_name: firstName(c.name, c.email),
          submission_link: this.link(`/prototype/submissions/${pid}/chair`),
        },
      }),
    );
  }

  /** An author submitted: "Submission received", co-authors told, chairs alerted. */
  async received(
    executor: Executor,
    ctx: PaperContext,
  ): Promise<OutgoingEmail[]> {
    const pid = this.paperId(ctx);
    const { updates, coAuthors, submitterEmail } = await this.authorRecipients(
      executor,
      ctx,
    );
    const receipt = updates
      .filter((a) => key(a.email) === submitterEmail)
      .map((a): TemplateEmail => ({
        ...this.base(ctx),
        template: 'submissionReceived',
        recipientType: 'Author',
        to: a,
        values: {
          ...this.common(ctx),
          first_name: firstName(a.name, a.email),
          submission_link: this.link(`/prototype/submissions/${pid}/author`),
        },
      }));
    return [
      ...receipt,
      ...(await this.recipients.welcomeEmails(
        executor,
        coAuthors.filter((a) => !a.hasAccount),
      )),
      ...coAuthors.map((a) => this.coAuthorAdded(ctx, a, true)),
      ...(await this.chairAlerts(executor, ctx)),
    ];
  }

  /**
   * A chair submitted for an author: the corresponding authors get "Submitted on your behalf", the
   * others "added as a co-author", the chairs the alert. `only`: resend to these authors only.
   */
  async onBehalf(
    executor: Executor,
    ctx: PaperContext,
    only?: readonly string[],
  ): Promise<OutgoingEmail[]> {
    const pid = this.paperId(ctx);
    const { updates, coAuthors, submitterEmail } = await this.authorRecipients(
      executor,
      ctx,
    );
    const forAuthors = updates.filter((a) => key(a.email) !== submitterEmail);
    const behalf = (a: Recipient): TemplateEmail => ({
      ...this.base(ctx),
      template: 'submittedOnBehalf',
      recipientType: 'Author',
      to: a,
      values: {
        ...this.common(ctx),
        chair_name: ctx.actor.name,
        first_name: firstName(a.name, a.email),
        submission_link: this.link(
          a.hasAccount
            ? `/prototype/submissions/${pid}/author`
            : '/prototype/register',
        ),
      },
    });

    if (only) {
      const wanted = new Set(only.map(key));
      const sendTo = forAuthors.filter(
        (a) => wanted.size === 0 || wanted.has(key(a.email)),
      );
      return [
        ...sendTo.map(behalf),
        ...(await this.recipients.welcomeEmails(
          executor,
          sendTo.filter((a) => !a.hasAccount),
        )),
      ];
    }

    const forKeys = new Set(forAuthors.map((a) => key(a.email)));
    return [
      ...forAuthors.map(behalf),
      ...(await this.recipients.welcomeEmails(
        executor,
        coAuthors.filter((a) => !a.hasAccount),
      )),
      ...coAuthors
        .filter((a) => !forKeys.has(key(a.email)))
        .map((a) => this.coAuthorAdded(ctx, a, false)),
      ...(await this.chairAlerts(executor, ctx)),
    ];
  }

  /**
   * Authors were added to the list. On a paper a chair submitted for its authors, a new
   * corresponding author is who it was submitted for ("Submitted on your behalf"); everyone else is
   * told they were added as a co-author.
   */
  async authorsAdded(
    executor: Executor,
    ctx: PaperContext,
    added: readonly AuthorRow[],
    onBehalf: boolean,
  ): Promise<OutgoingEmail[]> {
    if (added.length === 0) {
      return [];
    }
    const { coAuthors } = await this.authorRecipients(executor, ctx);
    const addedKeys = new Set(added.map((a) => key(a.email)));
    const list = coAuthors.filter((a) => addedKeys.has(key(a.email)));
    const behalfTo = onBehalf ? list.filter((a) => a.corresponding) : [];
    const others = list.filter((a) => !behalfTo.includes(a));
    return [
      ...(behalfTo.length > 0
        ? await this.onBehalf(
            executor,
            ctx,
            behalfTo.map((a) => a.email),
          )
        : []),
      ...others.map((a) => this.coAuthorAdded(ctx, a, !onBehalf)),
      ...(await this.recipients.welcomeEmails(
        executor,
        others.filter((a) => !a.hasAccount),
      )),
    ];
  }

  /** The paper was withdrawn: its authors (updates list) and the chairs. */
  async withdrawn(
    executor: Executor,
    ctx: PaperContext,
  ): Promise<OutgoingEmail[]> {
    const values = {
      submission_id: this.paperId(ctx),
      paper_title: ctx.submission.title,
    };
    const { updates } = await this.authorRecipients(executor, ctx);
    const chairs = await this.recipients.chairs(executor, ctx.conference.id);
    const email = (
      to: { email: string; name: string },
      recipientType: string,
    ): TemplateEmail => ({
      ...this.base(ctx),
      template: 'submissionWithdrawn',
      recipientType,
      to,
      values: { ...values, first_name: firstName(to.name, to.email) },
    });
    return [
      ...updates.map((a) => email(a, 'Author')),
      ...chairs.map((c) => email(c, 'Chair')),
    ];
  }

  /**
   * A screening decision on version n: correction (Initial Check), revision (Plagiarism Check) or
   * a rejection. Uses what the chair saved on that version. Co-authors only when asked.
   */
  async screening(
    executor: Executor,
    ctx: PaperContext,
    notice: {
      record: ScreeningRecord;
      stage: 'correction' | 'revision' | 'reject';
      kind: 'main' | 'reminder' | 'last';
      coAuthors: boolean;
    },
  ): Promise<OutgoingEmail[]> {
    const { record, stage, kind } = notice;
    const pid = this.paperId(ctx);
    const reasons = screeningReasons(record, stage);
    const suffix =
      stage === 'reject'
        ? ''
        : ({ reminder: 'Reminder', last: 'LastChance', main: '' } as const)[
            kind
          ];
    const template =
      stage === 'correction'
        ? `screeningCorrection${suffix}`
        : stage === 'revision'
          ? `screeningRevision${suffix}`
          : 'deskRejection';
    const values = {
      submission_id: pid,
      paper_title: ctx.submission.title,
      upload_link: this.link(`/prototype/submissions/${pid}/author`),
      correction_reasons: reasons.html,
      correction_deadline:
        reasons.deadline || 'the date on your submission page',
      revision_reasons: reasons.html,
      revision_deadline: reasons.deadline || 'the date on your submission page',
      similarity_percent:
        record.report?.similarity != null
          ? String(record.report.similarity)
          : '—',
      reason: reasons.html,
    };
    const { updates, coAuthors } = await this.authorRecipients(executor, ctx);
    const out: OutgoingEmail[] = updates.map((a): TemplateEmail => ({
      ...this.base(ctx),
      template,
      recipientType: 'Author',
      to: a,
      values: { ...values, first_name: firstName(a.name, a.email) },
    }));
    if (notice.coAuthors && stage !== 'reject') {
      const already = new Set(updates.map((a) => key(a.email)));
      const corresponding =
        (updates.find((a) => a.corresponding) ?? updates[0])?.name ??
        'the corresponding author';
      for (const a of coAuthors.filter((c) => !already.has(key(c.email)))) {
        out.push({
          ...this.base(ctx),
          template: 'screeningCoAuthor',
          recipientType: 'Author',
          to: a,
          values: {
            first_name: firstName(a.name, a.email),
            paper_title: ctx.submission.title,
            submission_id: pid,
            corresponding_name: corresponding,
            kind_note: {
              reminder: 'Reminder: ',
              last: 'Final reminder: ',
              main: '',
            }[kind],
            deadline: reasons.deadline || 'the date on the submission page',
          },
        });
      }
    }
    return out;
  }
}

/** The parts of a screening record the emails use. */
export interface ScreeningRecord {
  check?: { comment?: string };
  correction?: { reasons?: string[]; note?: string; deadline?: string };
  outcome?: {
    kind?: string;
    reasons?: string[];
    note?: string;
    deadline?: string;
  };
  report?: { similarity?: number | string | null };
}

/** The reasons and note of a screening decision, as an HTML list, and its deadline. */
export function screeningReasons(
  record: ScreeningRecord,
  stage: 'correction' | 'revision' | 'reject',
): { html: string; text: string; deadline: string } {
  const plagiarism =
    stage === 'revision' ||
    (stage === 'reject' && record.outcome?.kind === 'reject');
  const reasons =
    (plagiarism
      ? record.outcome?.reasons
      : (record.correction?.reasons ?? record.outcome?.reasons)) ?? [];
  const note = String(
    (plagiarism
      ? record.outcome?.note
      : (record.check?.comment ?? record.correction?.note)) ?? '',
  ).trim();
  const lines = [
    ...reasons.map((r) => `• ${String(r)}`),
    ...(note ? [note] : []),
  ];
  return {
    html:
      lines.map(escapeHtml).join('<br>') || 'Please see your submission page.',
    text: lines.join(' ') || 'Please see your submission page.',
    deadline: emailDate(
      plagiarism ? record.outcome?.deadline : record.correction?.deadline,
    ),
  };
}
