import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  ATTENDANCE_MODES,
  PaymentFieldsDto,
  PaymentResponse,
  type AttendanceMode,
} from '../../submissions/dto/submission.dto.js';
import {
  PARTICIPANT_CATEGORIES,
  type ParticipantCategory,
} from '../../submissions/payment.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

/** The most rows one import takes. */
export const MAX_IMPORT_ROWS = 2000;

/** A participant as the chair enters them. Every field is sent each time. */
export class SaveParticipantDto extends PaymentFieldsDto {
  @ApiProperty({
    enum: PARTICIPANT_CATEGORIES,
    description:
      'standard: a delegate without a paper; student: a full-time student; co_author: a co-author of an accepted paper (needs submissionId).',
  })
  @IsIn(PARTICIPANT_CATEGORIES)
  category: ParticipantCategory;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description:
      'The accepted paper of a co-author participant; null for the other categories.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  submissionId: string | null;

  @ApiProperty({ maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter the participant’s name.' })
  @MaxLength(200)
  name: string;

  @ApiProperty({ maxLength: 320 })
  @Transform(trim)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(320)
  email: string;

  @ApiProperty({ nullable: true, type: String, maxLength: 300 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(300)
  affiliation: string | null;

  @ApiProperty({ nullable: true, type: String, maxLength: 100 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  country: string | null;

  @ApiProperty({
    enum: ATTENDANCE_MODES,
    nullable: true,
    type: String,
    description: 'null: not known yet.',
  })
  @IsOptional()
  @IsIn(ATTENDANCE_MODES)
  attendance: AttendanceMode | null;

  @ApiProperty({
    nullable: true,
    type: String,
    maxLength: 1000,
    description: "The chair's own note; never shown to the participant.",
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(1000)
  note: string | null;
}

export const IMPORT_KINDS = ['papers', 'participants'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export class RegistrationImportDto {
  @ApiProperty({
    enum: IMPORT_KINDS,
    description:
      'papers: payments of accepted papers, matched by paper ID. participants: participants without a paper (and co-authors), matched by email (and paper ID for co-authors).',
  })
  @IsIn(IMPORT_KINDS)
  kind: ImportKind;

  @ApiProperty({
    description: `The sheet's rows (at most ${MAX_IMPORT_ROWS}), as cell text keyed by column: paperId, payment, amount, method, paidOn, transactionRef, payerName, note; participants also category, name, email, affiliation, country, attendance. "row" is the row number shown back in the preview.`,
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  @IsArray()
  @ArrayMaxSize(MAX_IMPORT_ROWS, {
    message: `An import takes at most ${MAX_IMPORT_ROWS} rows: split the sheet.`,
  })
  @IsObject({ each: true })
  rows: Record<string, unknown>[];

  @ApiProperty({
    description:
      'false: only check the rows (the preview). true: save them, all or none: nothing is saved while any row has an error.',
  })
  @IsBoolean()
  apply: boolean;
}

// Responses ----------------------------------------------------------------------------------

export class ParticipantResponse extends PaymentResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: PARTICIPANT_CATEGORIES }) category: ParticipantCategory;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  submissionId: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'ICX-12' })
  paperId: string | null;
  @ApiProperty({ nullable: true, type: String }) paperTitle: string | null;
  @ApiProperty({
    nullable: true,
    enum: ['accepted', 'not_accepted', 'withdrawn'],
    type: String,
    description: "Where the co-author's paper stands now (null: no paper).",
  })
  paperStatus: 'accepted' | 'not_accepted' | 'withdrawn' | null;
  @ApiProperty({
    nullable: true,
    type: Boolean,
    description:
      'A co-author whose email is on the paper’s author list (false: check it). null: no paper.',
  })
  onAuthorList: boolean | null;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty({ nullable: true, type: String }) affiliation: string | null;
  @ApiProperty({ nullable: true, type: String }) country: string | null;
  @ApiProperty({ enum: ATTENDANCE_MODES, nullable: true, type: String })
  attendance: AttendanceMode | null;
  @ApiProperty({ nullable: true, type: String }) note: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

export class ImportChange {
  @ApiProperty({ example: 'amount' }) field: string;
  @ApiProperty({ nullable: true, type: String }) from: string | null;
  @ApiProperty({ nullable: true, type: String }) to: string | null;
}

export class ImportRowResult {
  @ApiProperty({ description: 'The row number in the sheet.' }) row: number;
  @ApiProperty({ enum: ['new', 'update', 'unchanged', 'error'] })
  status: 'new' | 'update' | 'unchanged' | 'error';
  @ApiProperty({
    description: 'What the row is about: "ICX-12", or the email.',
  })
  key: string;
  @ApiProperty({ description: 'The paper title or the participant’s name.' })
  label: string;
  @ApiProperty({ type: [ImportChange] }) changes: ImportChange[];
  @ApiProperty({ type: [String] }) errors: string[];
  @ApiProperty({
    type: [String],
    description: 'Saved anyway, but worth a look.',
  })
  warnings: string[];
}

export class ImportCounts {
  @ApiProperty() new: number;
  @ApiProperty() update: number;
  @ApiProperty() unchanged: number;
  @ApiProperty() error: number;
}

export class RegistrationImportResponse {
  @ApiProperty({ enum: IMPORT_KINDS }) kind: ImportKind;
  @ApiProperty({
    description:
      'The rows were saved. false for a preview, and when any row has an error (then nothing was saved).',
  })
  applied: boolean;
  @ApiProperty({ type: ImportCounts }) counts: ImportCounts;
  @ApiProperty({ type: [ImportRowResult] }) rows: ImportRowResult[];
}
