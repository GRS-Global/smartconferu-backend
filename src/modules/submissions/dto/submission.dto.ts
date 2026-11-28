import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsJsonObjectOfSize } from '../../../core/validation/validators.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;
const cleanKeywords = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .map((v) => (typeof v === 'string' ? v.trim() : v))
            .filter((v) => v !== ''),
        ),
      ]
    : value;

// Requests ----------------------------------------------------------------------------------

export class AuthorDto {
  @ApiProperty({ example: 'Ada Lovelace' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Every author needs a name.' })
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 'ada@university.edu' })
  @Transform(trim)
  @IsEmail({}, { message: 'Every author needs a valid email.' })
  @MaxLength(254)
  email: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(300)
  affiliation?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(300)
  department?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(120)
  city?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  country?: string | null;

  @ApiPropertyOptional({
    default: false,
    description: 'Gets every email update about the paper.',
  })
  @IsOptional()
  @IsBoolean()
  corresponding?: boolean;
}

class PaperDetailsDto {
  @ApiProperty({ example: 'Graph neural networks for protein folding' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: "The title can't be empty." })
  @MaxLength(500)
  title: string;

  @ApiProperty({ example: 'We show that…' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: "The abstract can't be empty." })
  @MaxLength(10_000)
  abstract: string;

  @ApiPropertyOptional({ type: [String], example: ['GNN', 'proteins'] })
  @IsOptional()
  @Transform(cleanKeywords)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  keywords?: string[];
}

export class AuthorListDto {
  @ApiProperty({
    type: [AuthorDto],
    description:
      'In order. At least one, each email once, at least one corresponding.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'A paper needs at least one author.' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AuthorDto)
  authors: AuthorDto[];
}

export class CreateSubmissionDto extends PaperDetailsDto {
  @ApiProperty({ type: [AuthorDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'A paper needs at least one author.' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AuthorDto)
  authors: AuthorDto[];

  @ApiPropertyOptional({ example: 'General Track' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  track?: string | null;

  @ApiPropertyOptional({ example: 'Paper Presentation' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  presentationType?: string | null;

  @ApiPropertyOptional({
    description: "Answers to the conference's own submission questions.",
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsJsonObjectOfSize(50_000)
  responses?: Record<string, unknown>;

  @ApiPropertyOptional({
    default: false,
    description:
      'A chair submitting for an author (Chair › Submissions › Submit on behalf). The authors are emailed "Submitted on your behalf".',
  })
  @IsOptional()
  @IsBoolean()
  onBehalf?: boolean;
}

export class UpdateDetailsDto extends PaperDetailsDto {}

export class ConferencePapersQuery {
  @ApiPropertyOptional({
    description:
      'Only the paper with this number in the conference (the 12 of "ICX-12").',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  paperNo?: number;
}

export class DuplicateQuery {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  title: string;
}

export class ResendOnBehalfDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Only these authors (e.g. after correcting an address); all corresponding authors when left out.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  emails?: string[];
}

export class ScreeningRecordDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      "The chair's screening record of this version, as the screening tables keep it: { check, correction, ithenticate, report, outcome, paths }.",
  })
  @IsJsonObjectOfSize(100_000)
  record: Record<string, unknown>;
}

export const SCREENING_STAGES = ['correction', 'revision', 'reject'] as const;
export const SCREENING_KINDS = ['main', 'reminder', 'last'] as const;

export class ScreeningNoticeDto {
  @ApiProperty({
    enum: SCREENING_STAGES,
    description:
      'correction = fix and upload again (Initial Check), revision = rewrite (Plagiarism Check), reject = not accepted at screening.',
  })
  @IsIn(SCREENING_STAGES)
  stage: (typeof SCREENING_STAGES)[number];

  @ApiPropertyOptional({ enum: SCREENING_KINDS, default: 'main' })
  @IsOptional()
  @IsIn(SCREENING_KINDS)
  kind?: (typeof SCREENING_KINDS)[number];

  @ApiPropertyOptional({
    default: false,
    description: 'Also email the co-authors who are not corresponding.',
  })
  @IsOptional()
  @IsBoolean()
  coAuthors?: boolean;
}

export class RecordDecisionDto {
  @ApiProperty({ description: "One of the conference's decision types." })
  @IsUUID()
  decisionTypeId: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(5000)
  note?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'For a reject at screening (desk rejection): why.',
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  deskRejectReason?: string | null;
}

export const PAYMENT_STATUSES = ['not_paid', 'paid', 'waived'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const ATTENDANCE_MODES = ['physical', 'virtual'] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];

/** An accepted paper's registration, as the chair records it. Every field is sent each time. */
export class SaveRegistrationDto {
  @ApiProperty({ enum: PAYMENT_STATUSES })
  @IsIn(PAYMENT_STATUSES)
  payment: PaymentStatus;

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
    description: "The presenting author: one of the paper's author emails.",
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsEmail()
  @MaxLength(320)
  presenterEmail: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Receipt number, amount... Chairs only.',
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(1000)
  note: string | null;
}

// Responses ---------------------------------------------------------------------------------

export class RegistrationResponse {
  @ApiProperty({ enum: PAYMENT_STATUSES }) payment: PaymentStatus;
  @ApiProperty({ enum: ATTENDANCE_MODES, nullable: true, type: String })
  attendance: AttendanceMode | null;
  @ApiProperty({ nullable: true, type: String }) presenterEmail: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "The presenter's name from the author list.",
  })
  presenterName: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Chairs only.' })
  note: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Last change (null: nothing recorded yet).',
  })
  updatedAt: string | null;
}

export class AuthorResponse {
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty({ nullable: true, type: String }) affiliation: string | null;
  @ApiProperty({ nullable: true, type: String }) department: string | null;
  @ApiProperty({ nullable: true, type: String }) city: string | null;
  @ApiProperty({ nullable: true, type: String }) country: string | null;
  @ApiProperty() corresponding: boolean;
  @ApiProperty({
    description: 'Has a Smartconferu account linked (has claimed the paper).',
  })
  hasAccount: boolean;
}

export class PaperFileResponse {
  @ApiProperty() id: string;
  @ApiProperty() kind: string;
  @ApiProperty() version: number;
  @ApiProperty() fileName: string;
  @ApiProperty({ nullable: true, type: Number }) sizeBytes: number | null;
  @ApiProperty() uploadedAt: string;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'The automatic check of the file (chairs only).',
  })
  autoCheck: Record<string, unknown> | null;
}

export class FixRequestResponse {
  @ApiProperty() issue: string;
  @ApiProperty({ example: '2027-02-10' }) fixBy: string;
  @ApiProperty({ format: 'date-time' }) at: string;
}

export const SUBMISSION_VIEWS = ['chair', 'author', 'reviewer'] as const;
export type SubmissionView = (typeof SUBMISSION_VIEWS)[number];

export class SubmissionResponse {
  @ApiProperty() id: string;
  @ApiProperty({ description: 'e.g. ICX-12', example: 'ICX-12' })
  paperId: string;
  @ApiProperty() paperNo: number;
  @ApiProperty() conferenceId: string;
  @ApiProperty() conferenceSlug: string;
  @ApiProperty() conferenceAcronym: string;
  @ApiProperty({
    enum: SUBMISSION_VIEWS,
    description:
      'Whose view this is: a chair sees everything, an author what they were told, a reviewer the paper (authors hidden under double-blind review).',
  })
  view: SubmissionView;
  @ApiProperty() title: string;
  @ApiProperty() abstract: string;
  @ApiProperty({ type: [String] }) keywords: string[];
  @ApiProperty({ nullable: true, type: String }) track: string | null;
  @ApiProperty({ nullable: true, type: String }) presentationType:
    string | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  responses: Record<string, unknown>;
  @ApiProperty({
    type: [AuthorResponse],
    nullable: true,
    description: 'null when hidden (double-blind review).',
  })
  authors: AuthorResponse[] | null;
  @ApiProperty({ enum: ['draft', 'submitted', 'withdrawn'] }) status: string;
  @ApiProperty({
    description:
      'The stage or decision. Authors see only what they were told: an unsent decision reads as no_decision.',
  })
  outcome: string;
  @ApiProperty({ nullable: true, type: String }) decisionTypeId: string | null;
  @ApiProperty({ nullable: true, type: String }) decisionNote: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Chairs only.' })
  notifiedOutcome: string | null;
  @ApiProperty({ nullable: true, type: String }) notifiedAt: string | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Screening records per version (chairs and authors), with each version’s automatic check.',
  })
  screening: Record<string, unknown> | null;
  @ApiProperty({ type: [PaperFileResponse] }) files: PaperFileResponse[];
  @ApiProperty({
    nullable: true,
    type: FixRequestResponse,
    description: 'An open "Ask author to fix" (chairs and authors).',
  })
  fixRequest: FixRequestResponse | null;
  @ApiProperty({
    nullable: true,
    type: RegistrationResponse,
    description:
      'Payment and attendance of an accepted paper: chairs once it is accepted, authors once they were told it is. null otherwise.',
  })
  registration: RegistrationResponse | null;
  @ApiProperty({ nullable: true, type: String }) withdrawnAt: string | null;
  @ApiProperty({ nullable: true, enum: ['author', 'chair'], type: String })
  withdrawnBy: string | null;
  @ApiProperty() submittedAt: string;
  @ApiProperty() updatedAt: string;
  @ApiProperty({ description: 'The signed-in account submitted it.' })
  mySubmission: boolean;
  @ApiProperty({
    description:
      'The signed-in account gets the email updates (submitter or a corresponding author).',
  })
  myCorresponding: boolean;
  @ApiProperty({
    description: 'What the signed-in account may do now.',
    example: {
      editDetails: true,
      editAuthors: true,
      withdraw: true,
      decide: false,
    },
  })
  can: {
    editDetails: boolean;
    editAuthors: boolean;
    withdraw: boolean;
    uploadFile: boolean;
    decide: boolean;
  };
}

export class DuplicateResponse {
  @ApiProperty({
    description: 'A paper with this title is already in the conference.',
  })
  found: boolean;
  @ApiProperty({ description: 'The signed-in account is one of its authors.' })
  mine: boolean;
}

export class EmailsQueuedResponse {
  @ApiProperty() queued: number;
  @ApiProperty({
    description: 'Turned off by the conference, or duplicate addresses.',
  })
  skipped: number;
}

export class FixRequestDto {
  @ApiProperty({
    description: 'What the authors have to fix.',
    maxLength: 2000,
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Say what needs fixing.' })
  @MaxLength(2000)
  issue: string;

  @ApiProperty({
    example: '2027-02-10',
    description: 'By when (YYYY-MM-DD, not in the past).',
  })
  @IsDateString({ strict: true }, { message: 'Choose a date.' })
  fixBy: string;
}

export class PaperEmailDto {
  @ApiProperty({
    type: [String],
    description: 'Email addresses of authors of this paper (at most 50).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  to: string[];

  @ApiProperty({ maxLength: 300, description: 'May use {{first_name}}...' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'The email needs a subject.' })
  @MaxLength(300)
  subject: string;

  @ApiProperty({ maxLength: 50000, description: 'HTML, with placeholders.' })
  @IsString()
  @IsNotEmpty({ message: 'The email needs a message.' })
  @MaxLength(50000)
  body: string;
}

export class PaperEmailQueuedResponse {
  @ApiProperty() queued: number;
  @ApiProperty() skipped: number;
}

export class PaperIdsDto {
  @ApiProperty({
    type: [String],
    description: 'Papers of this conference (at most 500).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids: string[];
}

export class ChangeTrackDto extends PaperIdsDto {
  @ApiProperty({ example: 'AI Track' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Choose a track.' })
  @MaxLength(200)
  track: string;
}

export class CountResponse {
  @ApiProperty({ description: 'How many papers were changed or removed.' })
  count: number;
}
