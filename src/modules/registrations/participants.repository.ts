import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../../core/database/database.types.js';
import {
  conferenceParticipants,
  submissionAuthors,
  submissionRegistrations,
  submissions,
} from '../../core/database/schema/index.js';
import type {
  ParticipantRow,
  RegistrationRow,
} from '../submissions/submissions.repository.js';

export type ParticipantInsert = typeof conferenceParticipants.$inferInsert;
export type ParticipantValues = Omit<
  ParticipantInsert,
  'id' | 'conferenceId' | 'createdAt' | 'updatedAt' | 'createdBy'
>;

/** A paper of the conference, as the participants page and an import need it. */
export interface PaperRef {
  id: string;
  paperNo: number;
  title: string;
  status: (typeof submissions.$inferSelect)['status'];
  outcome: (typeof submissions.$inferSelect)['outcome'];
  /** The authors' emails, lower case. */
  authorEmails: string[];
}

@Injectable()
export class ParticipantsRepository {
  list(executor: Executor, conferenceId: string): Promise<ParticipantRow[]> {
    return executor
      .select()
      .from(conferenceParticipants)
      .where(eq(conferenceParticipants.conferenceId, conferenceId))
      .orderBy(
        asc(conferenceParticipants.createdAt),
        asc(conferenceParticipants.id),
      );
  }

  /** The participant, locked for the rest of the transaction. */
  async findForUpdate(
    tx: Tx,
    conferenceId: string,
    id: string,
  ): Promise<ParticipantRow | undefined> {
    const [row] = await tx
      .select()
      .from(conferenceParticipants)
      .where(
        and(
          eq(conferenceParticipants.id, id),
          eq(conferenceParticipants.conferenceId, conferenceId),
        ),
      )
      .for('update');
    return row;
  }

  /** Who already holds this email: in the conference (no paper) or on that paper (co-authors). */
  async findByKey(
    executor: Executor,
    conferenceId: string,
    email: string,
    submissionId: string | null,
  ): Promise<ParticipantRow | undefined> {
    const [row] = await executor
      .select()
      .from(conferenceParticipants)
      .where(
        and(
          eq(conferenceParticipants.conferenceId, conferenceId),
          sql`lower(${conferenceParticipants.email}) = ${email.toLowerCase()}`,
          submissionId === null
            ? isNull(conferenceParticipants.submissionId)
            : eq(conferenceParticipants.submissionId, submissionId),
        ),
      );
    return row;
  }

  async insert(tx: Tx, values: ParticipantInsert): Promise<ParticipantRow> {
    const [row] = await tx
      .insert(conferenceParticipants)
      .values(values)
      .returning();
    return row;
  }

  async update(
    tx: Tx,
    id: string,
    values: Partial<ParticipantValues>,
  ): Promise<ParticipantRow> {
    const [row] = await tx
      .update(conferenceParticipants)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(conferenceParticipants.id, id))
      .returning();
    return row;
  }

  async delete(tx: Tx, id: string): Promise<void> {
    await tx
      .delete(conferenceParticipants)
      .where(eq(conferenceParticipants.id, id));
  }

  /** The conference's submitted papers (or just `ids`), with their authors' emails. */
  async papers(
    executor: Executor,
    conferenceId: string,
    ids?: readonly string[],
  ): Promise<PaperRef[]> {
    if (ids && ids.length === 0) return [];
    const rows = await executor
      .select({
        id: submissions.id,
        paperNo: submissions.paperNo,
        title: submissions.title,
        status: submissions.status,
        outcome: submissions.outcome,
      })
      .from(submissions)
      .where(
        and(
          eq(submissions.conferenceId, conferenceId),
          ids ? inArray(submissions.id, [...ids]) : undefined,
        ),
      )
      .orderBy(asc(submissions.paperNo));
    if (rows.length === 0) return [];
    const authors = await executor
      .select({
        submissionId: submissionAuthors.submissionId,
        email: submissionAuthors.email,
      })
      .from(submissionAuthors)
      .where(
        inArray(
          submissionAuthors.submissionId,
          rows.map((r) => r.id),
        ),
      );
    return rows.map((r) => ({
      ...r,
      authorEmails: authors
        .filter((a) => a.submissionId === r.id)
        .map((a) => a.email.toLowerCase()),
    }));
  }

  /** The recorded registrations of these papers. */
  registrations(
    executor: Executor,
    submissionIds: readonly string[],
  ): Promise<RegistrationRow[]> {
    if (submissionIds.length === 0) return Promise.resolve([]);
    return executor
      .select()
      .from(submissionRegistrations)
      .where(inArray(submissionRegistrations.submissionId, [...submissionIds]));
  }
}
