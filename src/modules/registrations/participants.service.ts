import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor, Tx } from '../../core/database/database.types.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import * as rules from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import { storagePaths } from '../../core/storage/storage-paths.js';
import {
  NO_RECEIPT,
  PaymentReceiptsService,
  type ReceiptFile,
  type ReceiptUpload,
  type StoredReceipt,
} from '../submissions/payment-receipts.service.js';
import { paymentProblems, todayUtc } from '../submissions/payment.js';
import {
  assertPayment,
  paymentAudit,
} from '../submissions/registration.service.js';
import {
  ACCEPTED_OUTCOMES,
  paperId,
  paymentOf,
} from '../submissions/submission.mapper.js';
import {
  SubmissionsRepository,
  type ConferenceInfo,
  type ParticipantRow,
} from '../submissions/submissions.repository.js';
import type {
  ParticipantResponse,
  SaveParticipantDto,
} from './dto/participant.dto.js';
import {
  ParticipantsRepository,
  type PaperRef,
} from './participants.repository.js';

export const CATEGORY_LABELS: Record<ParticipantRow['category'], string> = {
  standard: 'Standard',
  student: 'Student',
  co_author: 'Co-author',
};

/** What the Activity Logs keep of a participant (the note stays out of it). */
export function participantAudit(
  row: Pick<
    ParticipantRow,
    | 'name'
    | 'email'
    | 'category'
    | 'attendance'
    | 'payment'
    | 'amount'
    | 'method'
    | 'paidOn'
    | 'transactionRef'
  >,
  conference: { id: string; acronym: string; currency: string | null },
  paper: PaperRef | undefined,
) {
  return {
    conferenceId: conference.id,
    name: row.name,
    email: row.email,
    category: row.category,
    paperId: paper ? paperId(conference.acronym, paper.paperNo) : null,
    attendance: row.attendance,
    currency: conference.currency,
    ...paymentAudit(row),
  };
}

export function toParticipant(
  row: ParticipantRow,
  conference: Pick<ConferenceInfo, 'acronym' | 'currency'>,
  paper: PaperRef | undefined,
): ParticipantResponse {
  return {
    id: row.id,
    category: row.category,
    submissionId: row.submissionId,
    paperId: paper ? paperId(conference.acronym, paper.paperNo) : null,
    paperTitle: paper?.title ?? null,
    paperStatus: paper
      ? paper.status === 'withdrawn'
        ? 'withdrawn'
        : ACCEPTED_OUTCOMES.includes(paper.outcome)
          ? 'accepted'
          : 'not_accepted'
      : null,
    onAuthorList: paper
      ? paper.authorEmails.includes(row.email.toLowerCase())
      : null,
    name: row.name,
    email: row.email,
    affiliation: row.affiliation,
    country: row.country,
    attendance: row.attendance,
    ...paymentOf(row, conference.currency),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The conference's participants without a paper of their own (Standard, Student) and the
 * co-authors who register for an accepted paper, each with their own payment. Chairs add them by
 * hand (or import them) after they registered on the conference's site. No email goes out;
 * every change is in the Activity Logs.
 */
@Injectable()
export class ParticipantsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly participants: ParticipantsRepository,
    private readonly submissions: SubmissionsRepository,
    private readonly access: AccessService,
    private readonly receipts: PaymentReceiptsService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthUser,
    conferenceId: string,
  ): Promise<ParticipantResponse[]> {
    const db = this.database.db;
    const conference = await this.requireChair(db, user, conferenceId);
    const rows = await this.participants.list(db, conferenceId);
    const papers = await this.participants.papers(db, conferenceId, [
      ...new Set(rows.flatMap((r) => (r.submissionId ? [r.submissionId] : []))),
    ]);
    return rows.map((r) =>
      toParticipant(
        r,
        conference,
        papers.find((p) => p.id === r.submissionId),
      ),
    );
  }

  async create(
    user: AuthUser,
    conferenceId: string,
    dto: SaveParticipantDto,
    client: ClientInfo,
  ): Promise<ParticipantResponse> {
    return this.database.transaction(async (tx) => {
      const conference = await this.requireChair(tx, user, conferenceId);
      const paper = await this.check(tx, conference, dto, null);
      const row = await this.participants.insert(tx, {
        conferenceId,
        ...this.values(dto),
        createdBy: user.id,
        updatedBy: user.id,
      });
      await this.audit.record(
        {
          action: 'participant.created',
          actorId: user.id,
          entityType: 'conference_participant',
          entityId: row.id,
          client,
          data: participantAudit(row, conference, paper),
        },
        tx,
      );
      return toParticipant(row, conference, paper);
    });
  }

  async update(
    user: AuthUser,
    conferenceId: string,
    participantId: string,
    dto: SaveParticipantDto,
    client: ClientInfo,
  ): Promise<ParticipantResponse> {
    return this.database.transaction(async (tx) => {
      const conference = await this.requireChair(tx, user, conferenceId);
      const before = await this.participants.findForUpdate(
        tx,
        conferenceId,
        participantId,
      );
      if (!before) throw AppException.notFound('The participant');
      const paper = await this.check(tx, conference, dto, before);
      const beforePaper = before.submissionId
        ? (
            await this.participants.papers(tx, conferenceId, [
              before.submissionId,
            ])
          )[0]
        : undefined;
      // A receipt belongs to a paid fee: it goes when the fee is no longer paid (the file stays in storage).
      const receiptRemoved = dto.payment !== 'paid' && !!before.receiptPath;
      const row = await this.participants.update(tx, participantId, {
        ...this.values(dto),
        ...(receiptRemoved ? NO_RECEIPT : {}),
        updatedBy: user.id,
      });
      await this.audit.record(
        {
          action: 'participant.updated',
          actorId: user.id,
          entityType: 'conference_participant',
          entityId: participantId,
          client,
          data: {
            ...participantAudit(row, conference, paper),
            before: participantAudit(before, conference, beforePaper),
            ...(receiptRemoved ? { receiptRemoved: true } : {}),
          },
        },
        tx,
      );
      return toParticipant(row, conference, paper);
    });
  }

  /** Removes the participant (their receipts stay in storage, the record in the Activity Logs). */
  async remove(
    user: AuthUser,
    conferenceId: string,
    participantId: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const conference = await this.requireChair(tx, user, conferenceId);
      const row = await this.participants.findForUpdate(
        tx,
        conferenceId,
        participantId,
      );
      if (!row) throw AppException.notFound('The participant');
      const paper = row.submissionId
        ? (
            await this.participants.papers(tx, conferenceId, [row.submissionId])
          )[0]
        : undefined;
      await this.participants.delete(tx, participantId);
      await this.audit.record(
        {
          action: 'participant.deleted',
          actorId: user.id,
          entityType: 'conference_participant',
          entityId: participantId,
          client,
          data: participantAudit(row, conference, paper),
        },
        tx,
      );
    });
  }

  /** Attaches the payment receipt (the fee must be recorded as paid). Replaces the current one. */
  async uploadReceipt(
    user: AuthUser,
    conferenceId: string,
    participantId: string,
    file: ReceiptUpload | undefined,
    client: ClientInfo,
  ): Promise<ParticipantResponse> {
    let stored: StoredReceipt | undefined;
    try {
      return await this.database.transaction(async (tx) => {
        const conference = await this.requireChair(tx, user, conferenceId);
        const current = await this.participants.findForUpdate(
          tx,
          conferenceId,
          participantId,
        );
        if (!current) throw AppException.notFound('The participant');
        if (current.payment !== 'paid') {
          throw AppException.businessRule(
            'Record the fee as Paid before uploading its receipt.',
          );
        }
        stored = await this.receipts.store(file, (id, ext) =>
          storagePaths.participantReceipt(conferenceId, participantId, id, ext),
        );
        const row = await this.participants.update(tx, participantId, {
          ...stored,
          updatedBy: user.id,
        });
        await this.audit.record(
          {
            action: 'participant.receipt_uploaded',
            actorId: user.id,
            entityType: 'conference_participant',
            entityId: participantId,
            client,
            data: {
              conferenceId,
              name: row.name,
              fileName: stored.receiptName,
              replaced: current.receiptName,
            },
          },
          tx,
        );
        return toParticipant(row, conference, await this.paperOf(tx, row));
      });
    } catch (error) {
      await this.receipts.discard(stored);
      throw error;
    }
  }

  /** Takes the receipt off (the file stays in storage). */
  async removeReceipt(
    user: AuthUser,
    conferenceId: string,
    participantId: string,
    client: ClientInfo,
  ): Promise<ParticipantResponse> {
    return this.database.transaction(async (tx) => {
      const conference = await this.requireChair(tx, user, conferenceId);
      const current = await this.participants.findForUpdate(
        tx,
        conferenceId,
        participantId,
      );
      if (!current) throw AppException.notFound('The participant');
      if (!current.receiptPath) throw AppException.notFound('The receipt');
      const row = await this.participants.update(tx, participantId, {
        ...NO_RECEIPT,
        updatedBy: user.id,
      });
      await this.audit.record(
        {
          action: 'participant.receipt_removed',
          actorId: user.id,
          entityType: 'conference_participant',
          entityId: participantId,
          client,
          data: {
            conferenceId,
            name: row.name,
            fileName: current.receiptName,
          },
        },
        tx,
      );
      return toParticipant(row, conference, await this.paperOf(tx, row));
    });
  }

  async downloadReceipt(
    user: AuthUser,
    conferenceId: string,
    participantId: string,
  ): Promise<ReceiptFile> {
    const db = this.database.db;
    await this.requireChair(db, user, conferenceId);
    const row = await this.submissions.participant(db, participantId);
    if (!row || row.conferenceId !== conferenceId) {
      throw AppException.notFound('The participant');
    }
    return this.receipts.read(row);
  }

  /** The conference (its acronym and currency), for one of its chairs. */
  async requireChair(
    executor: Executor,
    user: AuthUser,
    conferenceId: string,
  ): Promise<ConferenceInfo> {
    const access = await this.access.requireConference(
      user,
      conferenceId,
      executor,
    );
    if (!rules.canManageParticipants(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can manage its participants.',
      );
    }
    const conference = await this.submissions.conferenceInfo(
      executor,
      conferenceId,
    );
    if (!conference) throw AppException.notFound('The conference');
    return conference;
  }

  private async paperOf(
    executor: Executor,
    row: ParticipantRow,
  ): Promise<PaperRef | undefined> {
    return row.submissionId
      ? (
          await this.participants.papers(executor, row.conferenceId, [
            row.submissionId,
          ])
        )[0]
      : undefined;
  }

  private values(dto: SaveParticipantDto) {
    return {
      category: dto.category,
      submissionId: dto.category === 'co_author' ? dto.submissionId : null,
      name: dto.name,
      email: dto.email,
      affiliation: dto.affiliation ?? null,
      country: dto.country ?? null,
      attendance: dto.attendance ?? null,
      payment: dto.payment,
      amount: dto.amount ?? null,
      method: dto.method ?? null,
      paidOn: dto.paidOn ?? null,
      transactionRef: dto.transactionRef ?? null,
      payerName: dto.payerName ?? null,
      note: dto.note ?? null,
    };
  }

  /**
   * The rules of a participant: a co-author comes with an accepted paper of this conference and
   * the other categories with none, the payment follows the payment rules, and the email isn't
   * registered already (in the conference, or on that paper for a co-author).
   */
  private async check(
    tx: Tx,
    conference: ConferenceInfo,
    dto: SaveParticipantDto,
    current: ParticipantRow | null,
  ): Promise<PaperRef | undefined> {
    let paper: PaperRef | undefined;
    if (dto.category === 'co_author') {
      if (!dto.submissionId) {
        throw AppException.validation('Choose the paper of this co-author.', [
          { field: 'submissionId', errors: ['required for a co-author'] },
        ]);
      }
      paper = (
        await this.participants.papers(tx, conference.id, [dto.submissionId])
      )[0];
      if (!paper) {
        throw AppException.validation('Choose a paper of this conference.', [
          { field: 'submissionId', errors: ['not a paper of this conference'] },
        ]);
      }
      // A co-author kept on a paper that stopped being accepted can still be edited.
      const samePaper = current?.submissionId === paper.id;
      if (
        !samePaper &&
        (paper.status === 'withdrawn' ||
          !ACCEPTED_OUTCOMES.includes(paper.outcome))
      ) {
        throw AppException.businessRule(
          'Co-authors can register for accepted papers only.',
        );
      }
    } else if (dto.submissionId) {
      throw AppException.validation(
        'Only a co-author participant is linked to a paper.',
        [{ field: 'submissionId', errors: ['only for co-authors'] }],
      );
    }
    assertPayment(
      paymentProblems(
        {
          payment: dto.payment,
          amount: dto.amount ?? null,
          method: dto.method ?? null,
          paidOn: dto.paidOn ?? null,
          transactionRef: dto.transactionRef ?? null,
          payerName: dto.payerName ?? null,
        },
        conference.currency,
        todayUtc(),
      ),
    );
    const taken = await this.participants.findByKey(
      tx,
      conference.id,
      dto.email,
      paper?.id ?? null,
    );
    if (taken && taken.id !== current?.id) {
      throw AppException.conflict(
        paper
          ? `${taken.email} is already registered as a co-author of ${paperId(conference.acronym, paper.paperNo)}.`
          : `${taken.email} is already registered as a participant.`,
      );
    }
    return paper;
  }
}
