import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  conferenceStatus,
  reviewMode,
} from '../../../core/database/schema/index.js';
import { IsJsonObjectOfSize } from '../../../core/validation/validators.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
/** Blank optional text is stored as null. */
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export const CONFERENCE_MODES = ['in_person', 'virtual', 'hybrid'] as const;
export type ConferenceMode = (typeof CONFERENCE_MODES)[number];
export type ConferenceStatus = (typeof conferenceStatus.enumValues)[number];
export type ReviewMode = (typeof reviewMode.enumValues)[number];

/** Free-form extra details (topics, organizer, timezone…), shown on the conference pages. */
export const CONFERENCE_DETAILS_MAX_BYTES = 20_000;
/** Chair-only settings (email template edits, screening, review timeline, setup progress). */
export const CONFERENCE_SETTINGS_MAX_BYTES = 200_000;

/** Fields shared by "request a conference" and "edit conference details". */
class ConferenceFieldsDto {
  @ApiPropertyOptional({ maxLength: 5000, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(5000)
  about?: string | null;

  @ApiPropertyOptional({ enum: CONFERENCE_MODES, nullable: true })
  @IsOptional()
  @IsIn(CONFERENCE_MODES)
  mode?: ConferenceMode | null;

  @ApiPropertyOptional({ maxLength: 200, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  venue?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  state?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  country?: string | null;

  @ApiPropertyOptional({ maxLength: 300, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'Enter a web address that starts with http:// or https://.' },
  )
  @MaxLength(300)
  webPage?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsEmail({}, { message: 'Enter a valid contact email address.' })
  @MaxLength(254)
  contactEmail?: string | null;

  @ApiPropertyOptional({ maxLength: 200, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  primaryArea?: string | null;

  @ApiPropertyOptional({ maxLength: 200, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  secondaryArea?: string | null;

  @ApiPropertyOptional({ example: '2027-03-15', nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true }, { message: 'startDate must be a date' })
  startDate?: string | null;

  @ApiPropertyOptional({ example: '2027-03-17', nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true }, { message: 'endDate must be a date' })
  endDate?: string | null;

  @ApiPropertyOptional({
    description:
      'Extra details (topics, organizer, timezone, …). Keys sent are merged into the stored ones.',
    type: 'object',
    additionalProperties: true,
    example: { topics: ['information systems'], organizer: 'GR Conferences' },
  })
  @IsOptional()
  @IsJsonObjectOfSize(CONFERENCE_DETAILS_MAX_BYTES)
  details?: Record<string, unknown>;
}

/** A chair asks for a new conference; it waits for a super admin's approval. */
export class CreateConferenceDto extends ConferenceFieldsDto {
  @ApiProperty({
    example: 'ISBM 2027',
    description: 'Also the URL id (e.g. isbm2027) and the paper-id prefix.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  acronym: string;

  @ApiProperty({
    example:
      'World Conference on Information Systems for Business Management 2027',
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  title: string;
}

/** Conference details a chair edits. Omitted fields are left as they are. */
export class UpdateConferenceDto extends ConferenceFieldsDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional({
    example: '2027-01-31T23:59:59Z',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true })
  submissionDeadline?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true })
  reviewDeadline?: string | null;

  @ApiPropertyOptional({ example: '2027-02-20', nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true })
  notificationDate?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true })
  cameraReadyDeadline?: string | null;

  @ApiPropertyOptional({ enum: reviewMode.enumValues })
  @IsOptional()
  @IsIn(reviewMode.enumValues)
  reviewMode?: ReviewMode;
}

export class UpdateSettingsDto {
  @ApiProperty({
    description:
      'Top-level keys to replace (e.g. screening, reviewTimeline); other keys are kept. A key set to null is removed.',
    type: 'object',
    additionalProperties: true,
    example: { reviewTimeline: { days: 21, reminders: [7, 2] } },
  })
  @IsJsonObjectOfSize(CONFERENCE_SETTINGS_MAX_BYTES)
  settings: Record<string, unknown>;
}

export class SetupProgressDto {
  @ApiProperty({
    description: "The signed-in chair's own setup-guide progress.",
    type: 'object',
    additionalProperties: true,
    example: { welcomeSeen: true, step: 3, skipped: ['tracks'] },
  })
  @IsJsonObjectOfSize(10_000)
  progress: Record<string, unknown>;
}

export class ReasonDto {
  @ApiProperty({ maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Please give a reason.' })
  @MaxLength(2000)
  reason: string;
}

export class CancelRequestDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class DecisionDto {
  @ApiProperty({ description: 'true approves, false declines.' })
  @IsBoolean()
  approve: boolean;

  @ApiPropertyOptional({
    maxLength: 300,
    description:
      'The email subject as edited in the popup (placeholders allowed).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  emailSubject?: string;

  @ApiPropertyOptional({
    maxLength: 10000,
    description:
      'The email body as plain text (a blank line starts a paragraph; {{placeholders}} allowed).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  emailBody?: string;

  @ApiPropertyOptional({
    description: 'Keep the edited text as the default for the next decisions.',
  })
  @IsOptional()
  @IsBoolean()
  saveEmailAsDefault?: boolean;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Shown to the chair, e.g. why a request was declined.',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

export class ConferenceStatusQuery {
  @ApiPropertyOptional({ enum: conferenceStatus.enumValues })
  @IsOptional()
  @IsIn(conferenceStatus.enumValues)
  status?: ConferenceStatus;
}

// Responses -----------------------------------------------------------------------------------

/** What anyone may see about an active conference (the CFP directory, the submission link). */
export class PublicConferenceResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() slug: string;
  @ApiProperty() acronym: string;
  @ApiProperty() title: string;
  @ApiProperty({ nullable: true, type: String }) about: string | null;
  @ApiProperty({ enum: CONFERENCE_MODES, nullable: true })
  mode: ConferenceMode | null;
  @ApiProperty({ nullable: true, type: String }) venue: string | null;
  @ApiProperty({ nullable: true, type: String }) city: string | null;
  @ApiProperty({ nullable: true, type: String }) state: string | null;
  @ApiProperty({ nullable: true, type: String }) country: string | null;
  @ApiProperty({ nullable: true, type: String }) webPage: string | null;
  @ApiProperty({ nullable: true, type: String }) contactEmail: string | null;
  @ApiProperty({ nullable: true, type: String }) primaryArea: string | null;
  @ApiProperty({ nullable: true, type: String }) secondaryArea: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2027-03-15' })
  startDate: string | null;
  @ApiProperty({ nullable: true, type: String }) endDate: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  submissionDeadline: string | null;
  @ApiProperty({ enum: reviewMode.enumValues }) reviewMode: ReviewMode;
  @ApiProperty({ type: 'object', additionalProperties: true })
  details: Record<string, unknown>;
  @ApiProperty({
    enum: ['draft', 'in_review', 'published', 'rejected', 'closed'],
    description: 'Submissions are open only while the CFP is published.',
  })
  cfpStatus: string;
}

/** What the New Submission page shows: the chair's choices for the form (empty lists = the app's defaults). */
export class SubmissionFormResponse {
  @ApiProperty({ type: [String] }) tracks: string[];
  @ApiProperty({ type: [String] }) presentationTypes: string[];
  @ApiProperty({
    description:
      "The chair's extra questions (stored as the chair saved them).",
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  extras: Record<string, unknown>[];
  @ApiProperty() guidelines: string;
}

/** The full record, for the conference's team, its creator and super admins. */
export class ConferenceResponse extends PublicConferenceResponse {
  @ApiProperty({ enum: conferenceStatus.enumValues }) status: ConferenceStatus;
  @ApiProperty({ nullable: true, type: String }) adminNote: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  reviewDeadline: string | null;
  @ApiProperty({ nullable: true, type: String }) notificationDate:
    string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  cameraReadyDeadline: string | null;
  @ApiProperty({ nullable: true, type: String }) logoPath: string | null;
  @ApiProperty({
    description: "The signed-in user's roles: chair, reviewer, author, …",
    type: [String],
  })
  myRoles: string[];
  @ApiProperty({
    description: 'Chair-only settings; null for everyone else.',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  settings: Record<string, unknown> | null;
  @ApiProperty({
    description:
      'The latest deletion request (pending or rejected) seen by chairs; null otherwise.',
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  deletionRequest: DeletionRequestSummary | null;
  @ApiProperty({ format: 'uuid' }) createdBy: string;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export interface DeletionRequestSummary {
  id: string;
  status: string;
  reason: string;
  adminNote: string | null;
  createdAt: string;
}

export class MyConferencesResponse {
  @ApiProperty({
    type: [ConferenceResponse],
    description:
      'Live and archived conferences where the user has a role or a paper.',
  })
  conferences: ConferenceResponse[];

  @ApiProperty({
    type: [ConferenceResponse],
    description:
      'Every conference the user asked for, whatever its status: waiting, approved, declined or cancelled.',
  })
  requests: ConferenceResponse[];
}

/** An archived conference's submission link says so instead of "not found". */
export class ArchivedConferenceNotice {
  @ApiProperty({ example: 'archived' }) status: 'archived';
  @ApiProperty() acronym: string;
  @ApiProperty() title: string;
}

export class AdminConferenceResponse extends ConferenceResponse {
  @ApiProperty({
    description: 'Who asked for the conference.',
    type: 'object',
    additionalProperties: true,
  })
  requester: {
    id: string;
    name: string;
    email: string | null;
    affiliation: string | null;
  };

  @ApiProperty({ description: 'Submitted papers (drafts not counted).' })
  papers: number;

  @ApiProperty({
    format: 'date',
    description:
      'When the license ends: the date a Super Admin set, else 30 days after the conference was created.',
  })
  licenseExpiry: string;

  @ApiProperty({
    description:
      'No license date set yet: the conference is on its 30-day trial.',
  })
  onTrial: boolean;

  @ApiProperty({
    description:
      'Suspended by a Super Admin: read-only for everyone else until reactivated.',
  })
  suspended: boolean;
}

/** A conference in CFP Page Review: also the CFP's own page address and when it was sent for approval. */
export class AdminCfpResponse extends AdminConferenceResponse {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The page the chair chose: smartconferu.com/cfp/<cfpPage>.',
  })
  cfpPage: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When the CFP was (last) sent for approval.',
  })
  cfpSubmittedAt: string | null;
}

export class SuspendDto {
  @ApiPropertyOptional({
    maxLength: 2000,
    nullable: true,
    type: String,
    description: 'Why (shown to the chairs).',
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  reason?: string | null;
}

export class AskInfoDto {
  @ApiProperty({
    maxLength: 2000,
    description: 'The message to the chair who asked.',
  })
  @Transform(trimToNull)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;
}

export class LicenseExpiryDto {
  @ApiProperty({ format: 'date', example: '2027-06-30' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a date like 2027-06-30.' })
  expiry: string;
}

export class DeletionRequestResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty() acronym: string;
  @ApiProperty() title: string;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'cancelled'] })
  status: string;
  @ApiProperty() reason: string;
  @ApiProperty({ nullable: true, type: String }) adminNote: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  requestedBy: { id: string; name: string; email: string | null };
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  decidedAt: string | null;
}
