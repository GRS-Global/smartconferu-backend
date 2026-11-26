import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Tx } from '../../core/database/database.types.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import * as rules from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import { storagePaths } from '../../core/storage/storage-paths.js';
import type {
  SaveRegistrationDto,
  SubmissionResponse,
} from './dto/submission.dto.js';
import { paymentProblems, todayUtc, type FieldProblem } from './payment.js';
import {
  NO_RECEIPT,
  PaymentReceiptsService,
  type ReceiptFile,
  type ReceiptUpload,
  type StoredReceipt,
} from './payment-receipts.service.js';
import { ACCEPTED_OUTCOMES } from './submission.mapper.js';
import {
  SubmissionsRepository,
  type RegistrationRow,
  type SubmissionRow,
} from './submissions.repository.js';
import { SubmissionsService } from './submissions.service.js';

/** Throws the payment's problems as one validation error (the first one is the message). */
export function assertPayment(problems: FieldProblem[]): void {
  if (problems.length > 0) {
    throw AppException.validation(problems[0].errors[0], problems);
  }
}

/** What the Activity Logs keep of a payment (the note stays out of it). */
export function paymentAudit(
  row: Partial<
    Pick<
      RegistrationRow,
      'payment' | 'amount' | 'method' | 'paidOn' | 'transactionRef'
    >
  > | null,
) {
  return {
    payment: row?.payment ?? 'not_paid',
    amount: row?.amount ?? null,
    method: row?.method ?? null,
    paidOn: row?.paidOn ?? null,
    transactionRef: row?.transactionRef ?? null,
  };
}

/**
 * An accepted paper's payment and attendance, recorded by hand by a chair (until the conference
 * has a registration module), and the payment receipt the chair may attach. No email goes out;
 * every change is in the Activity Logs.
 */
@Injectable()
export class RegistrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly submissions: SubmissionsRepository,
    private readonly papers: SubmissionsService,
    private readonly access: AccessService,
    private readonly receipts: PaymentReceiptsService,
    private readonly audit: AuditService,
  ) {}

  async save(
    user: AuthUser,
    submissionId: string,
    dto: SaveRegistrationDto,
    client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.database.transaction(async (tx) => {
      const submission = await this.lockAccepted(tx, user, submissionId);
      const info = (await this.submissions.conferenceInfo(
        tx,
        submission.conferenceId,
      ))!;
      const payment = {
        payment: dto.payment,
        amount: dto.amount ?? null,
        method: dto.method ?? null,
        paidOn: dto.paidOn ?? null,
        transactionRef: dto.transactionRef ?? null,
        payerName: dto.payerName ?? null,
      };
      assertPayment(paymentProblems(payment, info.currency, todayUtc()));

      let presenterEmail: string | null = null;
      if (dto.presenterEmail) {
        const wanted = dto.presenterEmail.toLowerCase();
        const author = (await this.submissions.authors(tx, submissionId)).find(
          (a) => a.email.toLowerCase() === wanted,
        );
        if (!author) {
          throw AppException.validation(
            'The presenter must be one of the paper’s authors.',
            [
              {
                field: 'presenterEmail',
                errors: ['must be an author of this paper'],
              },
            ],
          );
        }
        presenterEmail = author.email;
      }

      const before = await this.submissions.registration(tx, submissionId);
      const after = {
        ...payment,
        attendance: dto.attendance ?? null,
        presenterEmail,
        note: dto.note ?? null,
      };
      await this.submissions.saveRegistration(tx, submissionId, after, user.id);
      // A receipt belongs to a paid fee: it goes when the fee is no longer paid (the file stays in storage).
      const receiptRemoved =
        after.payment !== 'paid' && Boolean(before?.receiptPath);
      if (receiptRemoved) {
        await this.submissions.setRegistrationReceipt(
          tx,
          submissionId,
          NO_RECEIPT,
          user.id,
        );
      }
      await this.audit.record(
        {
          action: 'submission.registration_updated',
          actorId: user.id,
          entityType: 'submission',
          entityId: submissionId,
          client,
          data: {
            currency: info.currency,
            before: {
              ...paymentAudit(before ?? null),
              attendance: before?.attendance ?? null,
              presenterEmail: before?.presenterEmail ?? null,
            },
            after: {
              ...paymentAudit(after),
              attendance: after.attendance,
              presenterEmail: after.presenterEmail,
            },
            ...(receiptRemoved ? { receiptRemoved: true } : {}),
          },
        },
        tx,
      );
      return this.papers.view(tx, user, submissionId);
    });
  }

  /** Attaches the payment receipt (chairs; the fee must be recorded as paid). Replaces the current one. */
  async uploadReceipt(
    user: AuthUser,
    submissionId: string,
    file: ReceiptUpload | undefined,
    client: ClientInfo,
  ): Promise<SubmissionResponse> {
    let stored: StoredReceipt | undefined;
    try {
      return await this.database.transaction(async (tx) => {
        const submission = await this.lockAccepted(tx, user, submissionId);
        const current = await this.submissions.registration(tx, submissionId);
        if (current?.payment !== 'paid') {
          throw AppException.businessRule(
            'Record the fee as Paid before uploading its receipt.',
          );
        }
        stored = await this.receipts.store(file, (id, ext) =>
          storagePaths.paperReceipt(
            submission.conferenceId,
            submissionId,
            id,
            ext,
          ),
        );
        await this.submissions.setRegistrationReceipt(
          tx,
          submissionId,
          stored,
          user.id,
        );
        await this.audit.record(
          {
            action: 'submission.registration_receipt_uploaded',
            actorId: user.id,
            entityType: 'submission',
            entityId: submissionId,
            client,
            data: {
              fileName: stored.receiptName,
              replaced: current.receiptName,
            },
          },
          tx,
        );
        return this.papers.view(tx, user, submissionId);
      });
    } catch (error) {
      await this.receipts.discard(stored);
      throw error;
    }
  }

  /** Takes the receipt off the paper (chairs). The file stays in storage. */
  async removeReceipt(
    user: AuthUser,
    submissionId: string,
    client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.database.transaction(async (tx) => {
      await this.lockAccepted(tx, user, submissionId);
      const current = await this.submissions.registration(tx, submissionId);
      if (!current?.receiptPath) {
        throw AppException.notFound('The receipt');
      }
      await this.submissions.setRegistrationReceipt(
        tx,
        submissionId,
        NO_RECEIPT,
        user.id,
      );
      await this.audit.record(
        {
          action: 'submission.registration_receipt_removed',
          actorId: user.id,
          entityType: 'submission',
          entityId: submissionId,
          client,
          data: { fileName: current.receiptName },
        },
        tx,
      );
      return this.papers.view(tx, user, submissionId);
    });
  }

  /** The paper's receipt, for whoever sees the paper's registration (chairs; authors once told it's accepted). */
  async downloadReceipt(
    user: AuthUser,
    submissionId: string,
  ): Promise<ReceiptFile> {
    const db = this.database.db;
    const view = await this.papers.view(db, user, submissionId);
    if (!view.registration?.receipt) {
      throw AppException.notFound('The receipt');
    }
    const row = await this.submissions.registration(db, submissionId);
    return this.receipts.read({
      receiptPath: row?.receiptPath ?? null,
      receiptName: row?.receiptName ?? null,
    });
  }

  /**
   * A co-author participant's receipt, from the paper page: for the chairs, and for that co-author
   * (see the paper's `participants`).
   */
  async downloadParticipantReceipt(
    user: AuthUser,
    submissionId: string,
    participantId: string,
  ): Promise<ReceiptFile> {
    const db = this.database.db;
    const view = await this.papers.view(db, user, submissionId);
    if (!view.participants.find((p) => p.id === participantId)?.receipt) {
      throw AppException.notFound('The receipt');
    }
    const row = await this.submissions.participant(db, participantId);
    return this.receipts.read(row ?? { receiptPath: null, receiptName: null });
  }

  /** Locks the paper for a chair's change to its registration: it must be accepted and not withdrawn. */
  private async lockAccepted(
    tx: Tx,
    user: AuthUser,
    submissionId: string,
  ): Promise<SubmissionRow> {
    // Locks the paper, so a decision recorded at the same moment can't slip in between.
    const submission = await this.submissions.findForUpdate(tx, submissionId);
    if (!submission) throw AppException.notFound('The paper');
    const access = await this.access.requireSubmission(user, submissionId, tx);
    if (!rules.canDecide(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can record payment and attendance.',
      );
    }
    if (submission.status === 'withdrawn') {
      throw AppException.businessRule(
        'This paper has been withdrawn, so it takes no payment or attendance.',
      );
    }
    if (!ACCEPTED_OUTCOMES.includes(submission.outcome)) {
      throw AppException.businessRule(
        'Payment and attendance can be recorded once the paper is accepted.',
      );
    }
    return submission;
  }
}
