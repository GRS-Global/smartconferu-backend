import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import type { Executor } from '../../core/database/database.types.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NO_RECEIPT } from '../submissions/payment-receipts.service.js';
import {
  parseAmount,
  parseAttendance,
  parseCategory,
  parseDate,
  parseMethod,
  parsePaperNo,
  parsePayment,
  paymentProblems,
  todayUtc,
  type AttendanceMode,
  type ParticipantCategory,
  type PaymentValues,
} from '../submissions/payment.js';
import { paymentAudit } from '../submissions/registration.service.js';
import {
  ACCEPTED_OUTCOMES,
  paperId,
  paperPrefix,
} from '../submissions/submission.mapper.js';
import {
  SubmissionsRepository,
  type ConferenceInfo,
  type ParticipantRow,
  type RegistrationRow,
} from '../submissions/submissions.repository.js';
import type {
  ImportChange,
  ImportKind,
  ImportRowResult,
  RegistrationImportDto,
  RegistrationImportResponse,
} from './dto/participant.dto.js';
import {
  ParticipantsRepository,
  type PaperRef,
} from './participants.repository.js';
import {
  CATEGORY_LABELS,
  ParticipantsService,
  participantAudit,
} from './participants.service.js';

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** A cell as text ('' when empty). Numbers come as they are, e.g. an amount or a paper number. */
function cell(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** How a value looks in the preview's "from → to". */
function shown(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

/** The row's payment, or what's wrong with it. */
function readPayment(
  row: Record<string, unknown>,
  errors: string[],
): PaymentValues | null {
  const status = cell(row, 'payment');
  const payment = parsePayment(status);
  if (!status) errors.push('Payment is missing (Paid, Not paid or Waived).');
  else if (!payment)
    errors.push(
      `Payment "${status}" isn't known: use Paid, Not paid or Waived.`,
    );

  const amountText = cell(row, 'amount');
  const amount = amountText ? parseAmount(amountText) : null;
  if (amountText && amount === null)
    errors.push(`Amount "${amountText}" isn't a number.`);

  const methodText = cell(row, 'method');
  const method = methodText ? parseMethod(methodText) : null;
  if (methodText && !method)
    errors.push(
      `Method "${methodText}" isn't known: use Bank transfer, Online, Card, Cash or Other.`,
    );

  const dateText = cell(row, 'paidOn');
  const paidOn = dateText ? parseDate(dateText) : null;
  if (dateText && !paidOn)
    errors.push(
      `Payment date "${dateText}" isn't a date: use YYYY-MM-DD or DD/MM/YYYY.`,
    );

  const transactionRef = cell(row, 'transactionRef') || null;
  const payerName = cell(row, 'payerName') || null;
  if ((transactionRef?.length ?? 0) > 200)
    errors.push('Transaction ID is longer than 200 characters.');
  if ((payerName?.length ?? 0) > 200)
    errors.push('Payer name is longer than 200 characters.');
  if (!payment) return null;
  return {
    payment,
    amount,
    method: method ?? null,
    paidOn,
    transactionRef,
    payerName,
  };
}

const PAYMENT_FIELDS = [
  'payment',
  'amount',
  'method',
  'paidOn',
  'transactionRef',
  'payerName',
] as const;

/** The fields that change from `before` to `after` (only the keys `after` has). */
function changesOf(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): ImportChange[] {
  return Object.entries(after).flatMap(([field, to]) => {
    const from = before ? before[field] : null;
    return shown(from) === shown(to)
      ? []
      : [{ field, from: shown(from), to: shown(to) }];
  });
}

interface PaperPlan {
  result: ImportRowResult;
  paper?: PaperRef;
  before?: RegistrationRow;
  values?: PaymentValues & { note: string | null };
}

interface ParticipantPlan {
  result: ImportRowResult;
  paper?: PaperRef;
  before?: ParticipantRow;
  values?: {
    category: ParticipantCategory;
    submissionId: string | null;
    name: string;
    email: string;
    affiliation: string | null;
    country: string | null;
    attendance: AttendanceMode | null;
    note: string | null;
  } & PaymentValues;
}

/**
 * Registration payments from a sheet: first a preview (every row checked and compared with what's
 * recorded), then saved all at once, only when no row has an error.
 *
 * - Paper payments are matched by paper ID. A row replaces the paper's payment (status, amount,
 *   method, date, transaction ID, payer); attendance and presenter stay; a note replaces the
 *   chair's note only when the cell has one.
 * - Participants are matched by email, and by paper ID too for co-authors. A row sets the
 *   participant's payment; their other details change only where a cell has a value.
 */
@Injectable()
export class RegistrationImportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly participantsService: ParticipantsService,
    private readonly participants: ParticipantsRepository,
    private readonly submissions: SubmissionsRepository,
    private readonly audit: AuditService,
  ) {}

  async run(
    user: AuthUser,
    conferenceId: string,
    dto: RegistrationImportDto,
    client: ClientInfo,
  ): Promise<RegistrationImportResponse> {
    if (!dto.apply) {
      const db = this.database.db;
      const conference = await this.participantsService.requireChair(
        db,
        user,
        conferenceId,
      );
      return this.respond(
        dto.kind,
        false,
        (await this.plan(db, conference, dto)).map((p) => p.result),
      );
    }
    return this.database.transaction(async (tx) => {
      const conference = await this.participantsService.requireChair(
        tx,
        user,
        conferenceId,
      );
      const plans = await this.plan(tx, conference, dto);
      const results = plans.map((p) => p.result);
      if (results.some((r) => r.status === 'error')) {
        return this.respond(dto.kind, false, results);
      }
      const today = todayUtc();
      for (const plan of plans) {
        if (plan.result.status === 'unchanged' || !plan.values) continue;
        if (dto.kind === 'papers') {
          const p = plan as PaperPlan;
          const before = p.before;
          const values = p.values!;
          await this.submissions.saveRegistration(
            tx,
            p.paper!.id,
            {
              ...values,
              note: values.note ?? before?.note ?? null,
              attendance: before?.attendance ?? null,
              presenterEmail: before?.presenterEmail ?? null,
            },
            user.id,
          );
          const receiptRemoved =
            values.payment !== 'paid' && Boolean(before?.receiptPath);
          if (receiptRemoved) {
            await this.submissions.setRegistrationReceipt(
              tx,
              p.paper!.id,
              NO_RECEIPT,
              user.id,
            );
          }
          await this.audit.record(
            {
              action: 'submission.registration_updated',
              actorId: user.id,
              entityType: 'submission',
              entityId: p.paper!.id,
              client,
              data: {
                source: 'import',
                currency: conference.currency,
                before: {
                  ...paymentAudit(before ?? null),
                  attendance: before?.attendance ?? null,
                  presenterEmail: before?.presenterEmail ?? null,
                },
                after: {
                  ...paymentAudit(values),
                  attendance: before?.attendance ?? null,
                  presenterEmail: before?.presenterEmail ?? null,
                },
                ...(receiptRemoved ? { receiptRemoved: true } : {}),
              },
            },
            tx,
          );
        } else {
          const p = plan as ParticipantPlan;
          const v = p.values!;
          if (p.before) {
            const receiptRemoved =
              v.payment !== 'paid' && Boolean(p.before.receiptPath);
            const row = await this.participants.update(tx, p.before.id, {
              ...v,
              ...(receiptRemoved ? NO_RECEIPT : {}),
              updatedBy: user.id,
            });
            await this.audit.record(
              {
                action: 'participant.updated',
                actorId: user.id,
                entityType: 'conference_participant',
                entityId: row.id,
                client,
                data: {
                  source: 'import',
                  ...participantAudit(row, conference, p.paper),
                  before: participantAudit(p.before, conference, p.paper),
                  ...(receiptRemoved ? { receiptRemoved: true } : {}),
                },
              },
              tx,
            );
          } else {
            const row = await this.participants.insert(tx, {
              conferenceId,
              ...v,
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
                data: {
                  source: 'import',
                  ...participantAudit(row, conference, p.paper),
                },
              },
              tx,
            );
          }
        }
      }
      const response = this.respond(dto.kind, true, results);
      await this.audit.record(
        {
          action: 'conference.registrations_imported',
          actorId: user.id,
          entityType: 'conference',
          entityId: conferenceId,
          client,
          data: {
            kind: dto.kind,
            new: response.counts.new,
            update: response.counts.update,
            unchanged: response.counts.unchanged,
            error: response.counts.error,
            on: today,
          },
        },
        tx,
      );
      return response;
    });
  }

  private respond(
    kind: ImportKind,
    applied: boolean,
    rows: ImportRowResult[],
  ): RegistrationImportResponse {
    const counts = { new: 0, update: 0, unchanged: 0, error: 0 };
    for (const r of rows) counts[r.status] += 1;
    return { kind, applied, counts, rows };
  }

  private async plan(
    executor: Executor,
    conference: ConferenceInfo,
    dto: RegistrationImportDto,
  ): Promise<Array<PaperPlan | ParticipantPlan>> {
    const papers = await this.participants.papers(executor, conference.id);
    return dto.kind === 'papers'
      ? this.planPapers(executor, conference, papers, dto.rows)
      : this.planParticipants(executor, conference, papers, dto.rows);
  }

  private async planPapers(
    executor: Executor,
    conference: ConferenceInfo,
    papers: PaperRef[],
    rows: Record<string, unknown>[],
  ): Promise<PaperPlan[]> {
    const prefix = paperPrefix(conference.acronym);
    const byNo = new Map(papers.map((p) => [p.paperNo, p]));
    const registrations = new Map(
      (
        await this.participants.registrations(
          executor,
          papers.map((p) => p.id),
        )
      ).map((r) => [r.submissionId, r]),
    );
    const seen = new Map<string, number>();
    const today = todayUtc();
    return rows.map((row, i) => {
      const rowNo = rowNumber(row, i);
      const errors: string[] = [];
      const idText = cell(row, 'paperId');
      const no = idText ? parsePaperNo(idText, prefix) : null;
      const paper = no === null ? undefined : byNo.get(no);
      if (!idText) errors.push('Paper ID is missing.');
      else if (no === null)
        errors.push(
          `Paper ID "${idText}" isn't one of this conference's (e.g. ${prefix}-12 or 12).`,
        );
      else if (!paper) errors.push(`There is no paper ${prefix}-${no}.`);
      else if (paper.status === 'withdrawn')
        errors.push(`${prefix}-${no} has been withdrawn.`);
      else if (!ACCEPTED_OUTCOMES.includes(paper.outcome))
        errors.push(`${prefix}-${no} is not accepted.`);
      const key = paper ? paperId(conference.acronym, paper.paperNo) : idText;
      if (paper) {
        const first = seen.get(paper.id);
        if (first !== undefined)
          errors.push(`${key} is already in row ${first}.`);
        else seen.set(paper.id, rowNo);
      }

      const payment = readPayment(row, errors);
      const note = cell(row, 'note') || null;
      if ((note?.length ?? 0) > 1000)
        errors.push('Note is longer than 1000 characters.');
      if (payment) {
        for (const p of paymentProblems(payment, conference.currency, today))
          errors.push(...p.errors.map((e) => `${fieldLabel(p.field)}: ${e}`));
      }

      const result: ImportRowResult = {
        row: rowNo,
        status: 'error',
        key,
        label: paper?.title ?? '',
        changes: [],
        errors,
        warnings: [],
      };
      if (errors.length > 0 || !paper || !payment) return { result };
      const before = registrations.get(paper.id);
      const after: Record<string, unknown> = { ...payment };
      if (note) after.note = note;
      result.changes = changesOf(
        before ? { ...before, payment: before.payment } : null,
        after,
      );
      if (!before) {
        // No row yet means "not paid"; only a real change creates one.
        result.changes = changesOf({ payment: 'not_paid' }, after);
      }
      result.status =
        result.changes.length === 0 ? 'unchanged' : before ? 'update' : 'new';
      if (before?.receiptPath && payment.payment !== 'paid')
        result.warnings.push('Its receipt will be removed (no longer paid).');
      return { result, paper, before, values: { ...payment, note } };
    });
  }

  private async planParticipants(
    executor: Executor,
    conference: ConferenceInfo,
    papers: PaperRef[],
    rows: Record<string, unknown>[],
  ): Promise<ParticipantPlan[]> {
    const prefix = paperPrefix(conference.acronym);
    const byNo = new Map(papers.map((p) => [p.paperNo, p]));
    const existing = await this.participants.list(executor, conference.id);
    const keyOf = (email: string, submissionId: string | null) =>
      `${email.toLowerCase()}|${submissionId ?? ''}`;
    const byKey = new Map(
      existing.map((p) => [keyOf(p.email, p.submissionId), p]),
    );
    const seen = new Map<string, number>();
    const today = todayUtc();
    return rows.map((row, i) => {
      const rowNo = rowNumber(row, i);
      const errors: string[] = [];
      const warnings: string[] = [];

      const categoryText = cell(row, 'category');
      const category = categoryText ? parseCategory(categoryText) : undefined;
      if (!categoryText)
        errors.push('Category is missing (Standard, Student or Co-author).');
      else if (!category)
        errors.push(
          `Category "${categoryText}" isn't known: use Standard, Student or Co-author.`,
        );

      const email = cell(row, 'email');
      if (!email) errors.push('Email is missing.');
      else if (!EMAIL.test(email) || email.length > 320)
        errors.push(`Email "${email}" isn't a valid address.`);

      let paper: PaperRef | undefined;
      const idText = cell(row, 'paperId');
      if (category === 'co_author') {
        const no = idText ? parsePaperNo(idText, prefix) : null;
        paper = no === null ? undefined : byNo.get(no);
        if (!idText)
          errors.push('Paper ID is missing (needed for a co-author).');
        else if (no === null)
          errors.push(
            `Paper ID "${idText}" isn't one of this conference's (e.g. ${prefix}-12 or 12).`,
          );
        else if (!paper) errors.push(`There is no paper ${prefix}-${no}.`);
      } else if (category && idText) {
        errors.push(
          'Only a Co-author is linked to a paper: clear the paper ID or change the category.',
        );
      }

      const before =
        email && category
          ? byKey.get(keyOf(email, paper?.id ?? null))
          : undefined;
      if (
        paper &&
        paper.id !== before?.submissionId &&
        (paper.status === 'withdrawn' ||
          !ACCEPTED_OUTCOMES.includes(paper.outcome))
      ) {
        errors.push(
          `${paperId(conference.acronym, paper.paperNo)} is not an accepted paper.`,
        );
      }
      if (paper && email && !paper.authorEmails.includes(email.toLowerCase()))
        warnings.push(
          `${email} is not on the author list of ${paperId(conference.acronym, paper.paperNo)}.`,
        );

      const name = cell(row, 'name');
      if (!name && !before) errors.push('Name is missing.');
      const text = (key: string, label: string, max: number) => {
        const value = cell(row, key);
        if (value.length > max)
          errors.push(`${label} is longer than ${max} characters.`);
        return value || null;
      };
      if (name.length > 200) errors.push('Name is longer than 200 characters.');
      const affiliation = text('affiliation', 'Affiliation', 300);
      const country = text('country', 'Country', 100);
      const note = text('note', 'Note', 1000);
      const attendanceText = cell(row, 'attendance');
      const attendance = attendanceText
        ? parseAttendance(attendanceText)
        : undefined;
      if (attendanceText && !attendance)
        errors.push(
          `Attendance "${attendanceText}" isn't known: use Physical or Virtual.`,
        );

      const payment = readPayment(row, errors);
      if (payment) {
        for (const p of paymentProblems(payment, conference.currency, today))
          errors.push(...p.errors.map((e) => `${fieldLabel(p.field)}: ${e}`));
      }

      const key = paper
        ? `${email} · ${paperId(conference.acronym, paper.paperNo)}`
        : email;
      if (email && category) {
        const k = keyOf(email, paper?.id ?? null);
        const first = seen.get(k);
        if (first !== undefined) errors.push(`Already in row ${first}.`);
        else seen.set(k, rowNo);
      }

      const result: ImportRowResult = {
        row: rowNo,
        status: 'error',
        key: key || `Row ${rowNo}`,
        label: name || before?.name || '',
        changes: [],
        errors,
        warnings,
      };
      if (errors.length > 0 || !category || !payment) return { result };

      const values = {
        category,
        submissionId: paper?.id ?? null,
        name: name || before!.name,
        email: before && !name ? before.email : email,
        affiliation: affiliation ?? before?.affiliation ?? null,
        country: country ?? before?.country ?? null,
        attendance: attendance ?? before?.attendance ?? null,
        note: note ?? before?.note ?? null,
        ...payment,
      };
      const compared: Record<string, unknown> = {
        category: CATEGORY_LABELS[values.category],
        name: values.name,
        affiliation: values.affiliation,
        country: values.country,
        attendance: values.attendance,
        note: values.note,
      };
      for (const f of PAYMENT_FIELDS) compared[f] = values[f];
      result.changes = changesOf(
        before
          ? {
              ...before,
              category: CATEGORY_LABELS[before.category],
            }
          : null,
        compared,
      );
      result.status = !before
        ? 'new'
        : result.changes.length === 0
          ? 'unchanged'
          : 'update';
      if (before?.receiptPath && payment.payment !== 'paid')
        warnings.push('Their receipt will be removed (no longer paid).');
      return { result, paper, before, values };
    });
  }
}

/** The row number the chair sees: the one the app sent, else the sheet's (headers on row 1). */
function rowNumber(row: Record<string, unknown>, index: number): number {
  const sent = row.row;
  return typeof sent === 'number' && Number.isInteger(sent) && sent > 0
    ? sent
    : index + 2;
}

const FIELD_LABELS: Record<string, string> = {
  amount: 'Amount',
  method: 'Method',
  paidOn: 'Payment date',
  transactionRef: 'Transaction ID',
  payerName: 'Payer name',
};
const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;
