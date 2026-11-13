import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../core/auth/auth-user.js';
import type { Tx } from '../../core/database/database.types.js';
import { EmailQueueService } from '../../core/email/email-queue.service.js';
import { AppException } from '../../core/errors/app.exception.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import {
  type ScreeningRecord,
  screeningReasons,
  SubmissionEmailsService,
} from './submission-emails.service.js';
import { paperId } from './submission.mapper.js';
import {
  type SubmissionRow,
  SubmissionsRepository,
} from './submissions.repository.js';
import { SubmissionsService } from './submissions.service.js';

export interface ScreeningNotice {
  stage: 'correction' | 'revision' | 'reject';
  kind: 'main' | 'reminder' | 'last';
  coAuthors: boolean;
}

/**
 * Tells the authors a screening decision saved on a version: their bell, and the email (queued in
 * the caller's transaction). Used by the chair's "send" and by AI mode's automatic send-back.
 */
@Injectable()
export class ScreeningNoticeService {
  constructor(
    private readonly submissions: SubmissionsRepository,
    private readonly papers: SubmissionsService,
    private readonly notifications: NotificationsService,
    private readonly emails: EmailQueueService,
    private readonly paperEmails: SubmissionEmailsService,
  ) {}

  /** `by` is the chair, or null when AI mode sends it. */
  async send(
    tx: Tx,
    submission: SubmissionRow,
    version: number,
    notice: ScreeningNotice,
    by: AuthUser | null,
  ) {
    const record = (
      submission.screening as Record<string, ScreeningRecord | undefined>
    )[String(version)];
    if (!record) {
      throw AppException.businessRule(
        'Save the screening decision before emailing the authors.',
      );
    }
    const info = (await this.submissions.conferenceInfo(
      tx,
      submission.conferenceId,
    ))!;
    const ctx = await this.papers.context(tx, by, info, submission.id);
    const pid = paperId(info.acronym, submission.paperNo);
    await this.notifications.notify(
      tx,
      await this.submissions.linkedUserIds(tx, submission.id),
      {
        kind: 'screening',
        title: {
          correction: `Correction needed: ${pid}`,
          revision: `Revision required: ${pid}`,
          reject: `Not accepted at screening: ${pid}`,
        }[notice.stage],
        body: screeningReasons(record, notice.stage).text.slice(0, 300),
        conferenceId: info.id,
        submissionId: submission.id,
        link: `/submissions/${pid}/author`,
      },
    );
    return this.emails.enqueue(
      tx,
      'screening_notified',
      await this.paperEmails.screening(tx, ctx, { record, ...notice }),
      { sentBy: by?.id ?? null },
    );
  }
}
