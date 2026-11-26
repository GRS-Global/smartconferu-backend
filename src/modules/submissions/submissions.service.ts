import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor, Tx } from '../../core/database/database.types.js';
import { EmailQueueService } from '../../core/email/email-queue.service.js';
import { EmailRecipientsService } from '../../core/email/email-recipients.service.js';
import { emailDate, stripTags } from '../../core/email/email-render.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import * as rules from '../../core/rbac/access-rules.js';
import type {
  ConferenceAccess,
  SubmissionAccess,
} from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import { FileStorage } from '../../core/storage/file-storage.js';
import { storagePaths } from '../../core/storage/storage-paths.js';
import type {
  AuthorDto,
  CountResponse,
  CreateSubmissionDto,
  DuplicateResponse,
  EmailsQueuedResponse,
  FixRequestDto,
  PaperEmailDto,
  PaperEmailQueuedResponse,
  SubmissionResponse,
  UpdateDetailsDto,
} from './dto/submission.dto.js';
import {
  type PaperContext,
  SubmissionEmailsService,
} from './submission-emails.service.js';
import { accessFor, paperId, toSubmission } from './submission.mapper.js';
import {
  type ConferenceInfo,
  type NewAuthor,
  type PaperBundle,
  SubmissionsRepository,
} from './submissions.repository.js';
import { appPaths } from '../../core/http/app-paths.js';

/** One email per author, at least one corresponding. */
function checkAuthors(authors: readonly AuthorDto[]): NewAuthor[] {
  const seen = new Set<string>();
  for (const author of authors) {
    const email = author.email.toLowerCase();
    if (seen.has(email)) {
      throw AppException.validation(
        'Two authors have the same email — give each author their own.',
      );
    }
    seen.add(email);
  }
  if (!authors.some((a) => a.corresponding)) {
    throw AppException.validation('Mark at least one corresponding author.');
  }
  return authors.map((a) => ({
    name: a.name,
    email: a.email,
    affiliation: a.affiliation ?? null,
    country: a.country ?? null,
    corresponding: a.corresponding ?? false,
  }));
}

/**
 * Papers: submitting (by an author, or a chair on an author's behalf), the lists, the paper page,
 * changing details and authors, and withdrawing. Every change and its notifications and emails are
 * saved in one transaction.
 */
@Injectable()
export class SubmissionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly submissions: SubmissionsRepository,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly emails: EmailQueueService,
    private readonly recipients: EmailRecipientsService,
    private readonly paperEmails: SubmissionEmailsService,
    private readonly audit: AuditService,
    private readonly storage: FileStorage,
  ) {}

  // Submitting --------------------------------------------------------------------------------

  /** Is a paper with this title already in the conference (and is it mine)? */
  async duplicate(
    user: AuthUser,
    conferenceId: string,
    title: string,
  ): Promise<DuplicateResponse> {
    await this.openConference(this.database.db, user, conferenceId);
    return this.submissions.duplicate(
      this.database.db,
      conferenceId,
      title,
      user.id,
    );
  }

  async create(
    user: AuthUser,
    conferenceId: string,
    dto: CreateSubmissionDto,
    client: ClientInfo,
  ): Promise<SubmissionResponse> {
    const authors = checkAuthors(dto.authors);
    return this.database.transaction(async (tx) => {
      const { access, info } = await this.openConference(
        tx,
        user,
        conferenceId,
      );
      const onBehalf = dto.onBehalf === true;
      if (onBehalf && !rules.isChair(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can submit on behalf of an author.',
        );
      }
      if (
        !rules.canSubmit(access, {
          cfpStatus: info.cfpStatus,
          submissionDeadline: info.submissionDeadline,
          now: new Date(),
        })
      ) {
        throw AppException.businessRule(
          info.cfpStatus !== 'published'
            ? "This conference isn't taking submissions: its Call for Papers isn't published."
            : 'The submission deadline has passed.',
        );
      }

      const submission = await this.submissions.insert(tx, {
        conferenceId,
        paperNo: await this.submissions.nextPaperNo(tx, conferenceId),
        submitterId: user.id,
        title: dto.title,
        abstract: dto.abstract,
        keywords: dto.keywords ?? [],
        details: {
          track: dto.track ?? 'General Track',
          presentationType: dto.presentationType ?? 'Paper Presentation',
          responses: dto.responses ?? {},
          ...(onBehalf ? { onBehalf: true } : {}),
        },
        status: 'submitted',
      });
      const added = await this.submissions.replaceAuthors(
        tx,
        submission.id,
        authors,
      );
      const ctx = await this.context(tx, user, info, submission.id);
      const pid = paperId(info.acronym, submission.paperNo);

      // The bell: the chairs, and co-authors who already have an account.
      const chairs = (await this.recipients.chairs(tx, conferenceId))
        .map((c) => c.userId!)
        .filter((id) => id !== user.id);
      await this.notifications.notify(tx, chairs, {
        kind: 'new_submission',
        title: `New submission ${pid}`,
        body: submission.title,
        conferenceId,
        submissionId: submission.id,
        link: appPaths.chairPaper(ctx.conference.slug, pid),
      });
      await this.notifyCoAuthors(tx, ctx, added, user.id);

      await this.emails.enqueue(
        tx,
        onBehalf ? 'submission_on_behalf' : 'submission_received',
        onBehalf
          ? await this.paperEmails.onBehalf(tx, ctx)
          : await this.paperEmails.received(tx, ctx),
        { sentBy: user.id },
      );
      await this.record(tx, user, client, 'submission.created', submission.id, {
        conferenceId,
        paperNo: submission.paperNo,
        onBehalf,
      });
      return this.view(tx, user, submission.id);
    });
  }

  // Reading -----------------------------------------------------------------------------------

  /** My papers in every conference (submitted or co-authored). */
  async listMine(user: AuthUser): Promise<SubmissionResponse[]> {
    const db = this.database.db;
    const bundles = await this.submissions.authoredPapers(db, user.id);
    return this.present(db, user, bundles);
  }

  /**
   * The papers of a conference the user may see: all of them for chairs; otherwise their own and
   * the ones given to them to review.
   */
  async listForConference(
    user: AuthUser,
    conferenceId: string,
    paperNo?: number,
  ): Promise<SubmissionResponse[]> {
    const all = await this.listAllForConference(user, conferenceId);
    return paperNo === undefined
      ? all
      : all.filter((p) => p.paperNo === paperNo);
  }

  private async listAllForConference(
    user: AuthUser,
    conferenceId: string,
  ): Promise<SubmissionResponse[]> {
    const db = this.database.db;
    const access = await this.access.requireConference(user, conferenceId);
    if (rules.isChair(access)) {
      return this.present(
        db,
        user,
        await this.submissions.conferencePapers(db, conferenceId),
      );
    }
    const [own, assigned] = await Promise.all([
      this.submissions.authoredPapers(db, user.id, conferenceId),
      this.submissions.assignedPapers(db, user.id, conferenceId),
    ]);
    const ids = new Set(own.map((b) => b.submission.id));
    return this.present(db, user, [
      ...own,
      ...assigned.filter((b) => !ids.has(b.submission.id)),
    ]);
  }

  /**
   * The paper page found by its paper id ("ICX-12") instead of its UUID. Several conferences can
   * share a prefix: the first one the user may see wins. 404 when none.
   */
  async getByLabel(user: AuthUser, label: string): Promise<SubmissionResponse> {
    const match = /^([A-Za-z0-9]{1,40})-(\d{1,9})$/.exec(label);
    if (match) {
      const db = this.database.db;
      const ids = await this.submissions.idsByLabel(
        db,
        match[1],
        Number(match[2]),
      );
      for (const id of ids) {
        try {
          return await this.view(db, user, id);
        } catch (error) {
          if (!(error instanceof AppException)) throw error;
        }
      }
    }
    throw AppException.notFound('The paper');
  }

  /** The paper page. 404 for anyone who may not see it. */
  async get(user: AuthUser, submissionId: string): Promise<SubmissionResponse> {
    return this.view(this.database.db, user, submissionId);
  }

  // Changing ----------------------------------------------------------------------------------

  async updateDetails(
    user: AuthUser,
    submissionId: string,
    dto: UpdateDetailsDto,
    client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.database.transaction(async (tx) => {
      const { access } = await this.lock(tx, user, submissionId);
      if (!rules.isOpenForChanges(access)) {
        throw AppException.businessRule('This paper can no longer be changed.');
      }
      if (!rules.canEditDetails(access)) {
        throw AppException.forbidden(
          'Only the authors of this paper can change its details (a chair can until an author claims it).',
        );
      }
      await this.submissions.update(tx, submissionId, {
        title: dto.title,
        abstract: dto.abstract,
        keywords: dto.keywords ?? [],
      });
      await this.record(
        tx,
        user,
        client,
        'submission.details_updated',
        submissionId,
      );
      return this.view(tx, user, submissionId);
    });
  }

  /**
   * Replaces the author list: the submitter, or a chair until an author claims the paper. New
   * authors are linked to their account (if they have one) and told by email.
   */
  async replaceAuthors(
    user: AuthUser,
    submissionId: string,
    authors: readonly AuthorDto[],
    client: ClientInfo,
  ): Promise<SubmissionResponse> {
    const list = checkAuthors(authors);
    return this.database.transaction(async (tx) => {
      const { access, submission } = await this.lock(tx, user, submissionId);
      if (!rules.isOpenForChanges(access)) {
        throw AppException.businessRule('This paper can no longer be changed.');
      }
      if (!rules.canEditAuthors(access)) {
        throw AppException.forbidden(
          'Only the person who submitted this paper can change its authors (a chair can until an author claims it).',
        );
      }
      const added = await this.submissions.replaceAuthors(
        tx,
        submissionId,
        list,
      );
      const info = (await this.submissions.conferenceInfo(
        tx,
        submission.conferenceId,
      ))!;
      const ctx = await this.context(tx, user, info, submissionId);
      await this.notifyCoAuthors(tx, ctx, added, user.id);
      const onBehalf =
        (submission.details as Record<string, unknown>).onBehalf === true;
      await this.emails.enqueue(
        tx,
        'paper_authors_updated',
        await this.paperEmails.authorsAdded(tx, ctx, added, onBehalf),
        { sentBy: user.id },
      );
      await this.record(
        tx,
        user,
        client,
        'submission.authors_updated',
        submissionId,
        {
          added: added.map((a) => a.email),
        },
      );
      return this.view(tx, user, submissionId);
    });
  }

  /**
   * Sends "Submitted on your behalf" again (a chair, for a paper they submitted for its authors),
   * to every corresponding author or only the given addresses.
   */
  async resendOnBehalf(
    user: AuthUser,
    submissionId: string,
    emails: readonly string[] | undefined,
  ): Promise<EmailsQueuedResponse> {
    return this.database.transaction(async (tx) => {
      const { access, submission } = await this.lock(tx, user, submissionId);
      if (
        !rules.isChair(access.conference) ||
        submission.submitterId !== user.id
      ) {
        throw AppException.forbidden(
          'Only the chair who submitted this paper can send this.',
        );
      }
      const info = (await this.submissions.conferenceInfo(
        tx,
        submission.conferenceId,
      ))!;
      const ctx = await this.context(tx, user, info, submissionId);
      return this.emails.enqueue(
        tx,
        'submission_on_behalf',
        await this.paperEmails.onBehalf(tx, ctx, emails ?? []),
        { sentBy: user.id },
      );
    });
  }

  /**
   * Withdraws the paper (final). It leaves review: open assignments are removed, sent reviews stay
   * on record. The other authors and the chairs hear about it.
   */
  async withdraw(
    user: AuthUser,
    submissionId: string,
    client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.database.transaction(async (tx) => {
      const { access, submission } = await this.lock(tx, user, submissionId);
      if (submission.status === 'withdrawn') {
        throw AppException.businessRule(
          'This paper has already been withdrawn.',
        );
      }
      if (!rules.isAuthorOf(access) && !rules.isChair(access.conference)) {
        throw AppException.forbidden(
          'Only an author of this paper (or a chair of the conference) can withdraw it.',
        );
      }
      if (!rules.canWithdraw(access)) {
        throw AppException.businessRule(
          'A final decision has been made, so this paper can no longer be withdrawn.',
        );
      }
      const by = rules.isAuthorOf(access) ? 'author' : 'chair';
      await this.submissions.update(tx, submissionId, {
        status: 'withdrawn',
        withdrawnAt: new Date(),
        withdrawnBy: by,
      });
      await this.submissions.removeOpenAssignments(tx, submissionId);

      const info = (await this.submissions.conferenceInfo(
        tx,
        submission.conferenceId,
      ))!;
      const ctx = await this.context(tx, user, info, submissionId);
      const pid = paperId(info.acronym, submission.paperNo);
      const chairs = (await this.recipients.chairs(tx, info.id)).map(
        (c) => c.userId!,
      );
      await this.notifications.notify(
        tx,
        [
          ...(await this.submissions.linkedUserIds(tx, submissionId)),
          ...chairs,
        ].filter((id) => id !== user.id),
        {
          kind: 'withdrawn',
          title: `Paper withdrawn: ${pid}`,
          body:
            by === 'chair'
              ? `${submission.title} was withdrawn by the chair.`
              : `${submission.title} was withdrawn.`,
          conferenceId: info.id,
          submissionId,
          link: `/submissions/${pid}`,
        },
      );
      await this.emails.enqueue(
        tx,
        'submission_withdrawn',
        await this.paperEmails.withdrawn(tx, ctx),
        { sentBy: user.id },
      );
      await this.record(
        tx,
        user,
        client,
        'submission.withdrawn',
        submissionId,
        { by },
      );
      return this.view(tx, user, submissionId);
    });
  }

  // Chairs -----------------------------------------------------------------------------------

  /**
   * "Ask author to fix": the chair names a fixable problem and a date. It stays on the paper (the
   * authors see it on the paper page) until a new version is uploaded; the authors are told by bell
   * and email.
   */
  async requestFix(
    user: AuthUser,
    submissionId: string,
    dto: FixRequestDto,
    client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.database.transaction(async (tx) => {
      const { access, submission } = await this.lock(tx, user, submissionId);
      if (!rules.canDecide(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can ask authors to fix a paper.',
        );
      }
      if (submission.status === 'withdrawn') {
        throw AppException.businessRule('This paper has been withdrawn.');
      }
      if (dto.fixBy < new Date().toISOString().slice(0, 10)) {
        throw AppException.businessRule(
          'Choose a date that is not in the past.',
        );
      }
      const at = new Date().toISOString();
      await this.submissions.update(tx, submissionId, {
        details: {
          ...(submission.details as Record<string, unknown>),
          fixRequest: { issue: dto.issue, fixBy: dto.fixBy, at, by: user.id },
        },
      });
      const info = (await this.submissions.conferenceInfo(
        tx,
        submission.conferenceId,
      ))!;
      const ctx = await this.context(tx, user, info, submissionId);
      const pid = paperId(info.acronym, submission.paperNo);
      await this.notifications.notify(
        tx,
        await this.submissions.linkedUserIds(tx, submissionId),
        {
          kind: 'fix_requested',
          // The same wording as the email about it ("by 1 Mar 2099"), not the raw 2099-03-01.
          title: `Please fix ${pid} by ${emailDate(dto.fixBy)}`,
          body: dto.issue,
          conferenceId: info.id,
          submissionId,
          link: `/submissions/${pid}`,
        },
      );
      await this.emails.enqueue(
        tx,
        'paper_fix_requested',
        await this.paperEmails.fixRequested(tx, ctx, {
          issue: dto.issue,
          fixBy: dto.fixBy,
        }),
        { sentBy: user.id },
      );
      await this.record(
        tx,
        user,
        client,
        'submission.fix_requested',
        submissionId,
        {
          fixBy: dto.fixBy,
        },
      );
      return this.view(tx, user, submissionId);
    });
  }

  /**
   * The chair writes to some of a paper's authors ("Email authors"). Only addresses of this paper's
   * authors (or its submitter) are accepted; each person gets one email, placeholders filled in.
   */
  async emailAuthors(
    user: AuthUser,
    submissionId: string,
    dto: PaperEmailDto,
    client: ClientInfo,
  ): Promise<PaperEmailQueuedResponse> {
    if (!stripTags(dto.body)) {
      throw AppException.validation('The email needs a message.');
    }
    return this.database.transaction(async (tx) => {
      const { access, submission } = await this.lock(tx, user, submissionId);
      if (!rules.canDecide(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can email the authors of a paper.',
        );
      }
      const info = (await this.submissions.conferenceInfo(
        tx,
        submission.conferenceId,
      ))!;
      const ctx = await this.context(tx, user, info, submissionId);
      const known = new Map<string, { email: string; name: string }>();
      for (const a of ctx.authors) {
        known.set(a.email.trim().toLowerCase(), {
          email: a.email.trim(),
          name: a.name,
        });
      }
      for (const a of await this.paperEmails.authorUpdates(tx, ctx)) {
        known.set(a.email.trim().toLowerCase(), a);
      }
      const wanted = [...new Set(dto.to.map((e) => e.trim().toLowerCase()))];
      const people = wanted.flatMap((e) => known.get(e) ?? []);
      if (people.length !== wanted.length) {
        throw AppException.businessRule(
          'You can only email authors of this paper.',
        );
      }
      const result = await this.emails.enqueue(
        tx,
        'paper_message',
        this.paperEmails.message(ctx, people, dto),
        { sentBy: user.id },
      );
      await this.record(
        tx,
        user,
        client,
        'submission.authors_emailed',
        submissionId,
        { recipients: people.length },
      );
      return { queued: result.queued, skipped: result.skipped };
    });
  }

  /** Moves papers to another track (a chair of their conference). */
  async changeTrack(
    user: AuthUser,
    conferenceId: string,
    ids: readonly string[],
    track: string,
    client: ClientInfo,
  ): Promise<CountResponse> {
    return this.database.transaction(async (tx) => {
      const access = await this.access.requireConference(
        user,
        conferenceId,
        tx,
      );
      if (!rules.isChair(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can change tracks.',
        );
      }
      const found = await this.submissions.idsInConference(
        tx,
        access.conferenceId,
        ids,
      );
      await this.submissions.setTrack(tx, found, track);
      await this.audit.record(
        {
          action: 'submission.track_changed',
          actorId: user.id,
          entityType: 'conference',
          entityId: access.conferenceId,
          client,
          data: { ids: found, track },
        },
        tx,
      );
      return { count: found.length };
    });
  }

  /**
   * Deletes papers for good with their authors, files, assignments and reviews (a chair of their
   * conference). The stored files go once the deletion is saved.
   */
  async deleteMany(
    user: AuthUser,
    conferenceId: string,
    ids: readonly string[],
    client: ClientInfo,
  ): Promise<CountResponse> {
    const done = await this.database.transaction(async (tx) => {
      const access = await this.access.requireConference(
        user,
        conferenceId,
        tx,
      );
      if (!rules.isChair(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can delete papers.',
        );
      }
      const found = await this.submissions.idsInConference(
        tx,
        access.conferenceId,
        ids,
      );
      await this.submissions.deleteMany(tx, found);
      await this.audit.record(
        {
          action: 'submission.deleted',
          actorId: user.id,
          entityType: 'conference',
          entityId: access.conferenceId,
          client,
          data: { ids: found },
        },
        tx,
      );
      return { conferenceId: access.conferenceId, ids: found };
    });
    for (const id of done.ids) {
      await this.storage
        .deleteFolder(storagePaths.paperFolder(done.conferenceId, id))
        .catch(() => undefined);
    }
    return { count: done.ids.length };
  }

  // Helpers -----------------------------------------------------------------------------------

  /**
   * A conference that takes papers from this user: active (an outsider may submit to it), or one
   * the user can see. 404 otherwise.
   */
  private async openConference(
    executor: Executor,
    user: AuthUser,
    conferenceId: string,
  ): Promise<{ access: ConferenceAccess; info: ConferenceInfo }> {
    const access = await this.access.conferenceAccess(
      user,
      conferenceId,
      executor,
    );
    const info = await this.submissions.conferenceInfo(executor, conferenceId);
    if (
      !access ||
      !info ||
      (access.status !== 'active' && !rules.canViewConference(access))
    ) {
      throw AppException.notFound('The conference');
    }
    return { access, info };
  }

  /** The paper locked for a change, and the user's standing on it (404 if they can't see it). */
  private async lock(tx: Tx, user: AuthUser, submissionId: string) {
    const submission = await this.submissions.findForUpdate(tx, submissionId);
    if (!submission) {
      throw AppException.notFound('The paper');
    }
    const access = await this.access.requireSubmission(user, submissionId, tx);
    return { access, submission };
  }

  async context(
    executor: Executor,
    /** Who acted; null for the system (the automatic initial check). */
    user: AuthUser | null,
    info: ConferenceInfo,
    submissionId: string,
  ): Promise<PaperContext> {
    const bundle = (await this.submissions.bundle(executor, submissionId))!;
    const actor = (user
      ? (await this.recipients.people(executor, [user.id])).get(user.id)
      : undefined) ?? {
      userId: user?.id ?? null,
      email: '',
      name: user ? 'A chair' : 'Smartconferu',
    };
    return {
      conference: {
        id: info.id,
        slug: info.slug,
        title: info.title,
        acronym: info.acronym,
        contactEmail: info.contactEmail,
        submissionDeadline: info.submissionDeadline,
      },
      submission: bundle.submission,
      authors: bundle.authors,
      actor,
    };
  }

  /** Co-authors with an account are told in their bell that they were added. */
  private async notifyCoAuthors(
    tx: Tx,
    ctx: PaperContext,
    added: readonly { userId: string | null }[],
    actorId: string,
  ): Promise<void> {
    const pid = paperId(ctx.conference.acronym, ctx.submission.paperNo);
    await this.notifications.notify(
      tx,
      added
        .map((a) => a.userId)
        .filter(
          (id): id is string =>
            id !== null && id !== actorId && id !== ctx.submission.submitterId,
        ),
      {
        kind: 'coauthor_added',
        title: 'You were added as a co-author',
        body: ctx.submission.title,
        conferenceId: ctx.conference.id,
        submissionId: ctx.submission.id,
        link: appPaths.authorPaper(ctx.conference.slug, pid),
      },
    );
  }

  /** One paper, as this user may see it (404 if they can't). */
  async view(
    executor: Executor,
    user: AuthUser,
    submissionId: string,
  ): Promise<SubmissionResponse> {
    const access = await this.access.requireSubmission(
      user,
      submissionId,
      executor,
    );
    const bundle = (await this.submissions.bundle(executor, submissionId))!;
    const labels = await this.submissions.conferenceLabels(executor, [
      bundle.submission.conferenceId,
    ]);
    return toSubmission(
      bundle,
      labels.get(bundle.submission.conferenceId)!,
      access,
      user.id,
    );
  }

  /** Several papers, each as this user may see it (conference standing read once per conference). */
  private async present(
    executor: Executor,
    user: AuthUser,
    bundles: PaperBundle[],
  ): Promise<SubmissionResponse[]> {
    const conferenceIds = [
      ...new Set(bundles.map((b) => b.submission.conferenceId)),
    ];
    const labels = await this.submissions.conferenceLabels(
      executor,
      conferenceIds,
    );
    const standing = new Map<
      string,
      { access: ConferenceAccess; info: ConferenceInfo }
    >();
    for (const id of conferenceIds) {
      const access = await this.access.conferenceAccess(user, id, executor);
      const info = await this.submissions.conferenceInfo(executor, id);
      if (access && info) {
        standing.set(id, { access, info });
      }
    }
    const statuses = await this.access.assignmentStatuses(
      user,
      bundles.map((b) => b.submission.id),
      executor,
    );
    const result: SubmissionResponse[] = [];
    for (const bundle of bundles) {
      const conference = standing.get(bundle.submission.conferenceId);
      if (!conference) {
        continue; // a deleted conference
      }
      const access: SubmissionAccess = accessFor(
        bundle,
        conference.access,
        user.id,
        conference.info.reviewMode,
        statuses.get(bundle.submission.id) ?? null,
      );
      if (rules.canViewSubmission(access)) {
        result.push(
          toSubmission(
            bundle,
            labels.get(bundle.submission.conferenceId)!,
            access,
            user.id,
          ),
        );
      }
    }
    return result;
  }

  private record(
    tx: Tx,
    user: AuthUser,
    client: ClientInfo,
    action: string,
    submissionId: string,
    data: Record<string, unknown> = {},
  ) {
    return this.audit.record(
      {
        action,
        actorId: user.id,
        entityType: 'submission',
        entityId: submissionId,
        client,
        data,
      },
      tx,
    );
  }
}
