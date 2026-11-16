import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { PageQuery } from '../../../core/http/pagination.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** A conference's own email (Email Templates › Custom emails) has a key like `custom:abc123`. */
export const CUSTOM_PREFIX = 'custom:';
export const CUSTOM_KEY = /^custom:[A-Za-z0-9_-]{1,64}$/;
export const TEMPLATE_KEY = /^[A-Za-z0-9_:-]{1,80}$/;

/** Who Email Communication › Send Email can write to. */
export const AUDIENCES = [
  'all_authors',
  'corresponding_authors',
  'accepted_authors',
  'under_review_authors',
  'reviewers',
] as const;
export type Audience = (typeof AUDIENCES)[number];

export const EMAIL_STATUSES = ['queued', 'sending', 'sent', 'failed'] as const;

// Requests ----------------------------------------------------------------------------------

export class UpdateConferenceTemplateDto {
  @ApiPropertyOptional({
    description: 'false turns this email off for the conference.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    maxLength: 300,
    description: 'Empty uses the platform default.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  subject?: string;

  @ApiPropertyOptional({
    maxLength: 50000,
    description: 'HTML; empty uses the platform default.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  body?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: "A custom email's name (a platform email keeps its own).",
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  label?: string;
}

export class UpdatePlatformTemplateDto {
  @ApiProperty({ maxLength: 300 })
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  @Matches(/\S/, { message: 'subject must not be empty' })
  subject: string;

  @ApiProperty({ maxLength: 50000, description: 'HTML.' })
  @IsString()
  @MaxLength(50000)
  @Matches(/\S/, { message: 'body must not be empty' })
  body: string;
}

export class TestTemplateDto {
  @ApiPropertyOptional({
    maxLength: 300,
    description: 'Test this text instead of the saved one (an unsaved edit).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  subject?: string;

  @ApiPropertyOptional({ maxLength: 50000 })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  body?: string;
}

export class SendCustomEmailDto {
  @ApiProperty({ enum: AUDIENCES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(AUDIENCES, { each: true })
  audiences: Audience[];

  @ApiProperty({
    maxLength: 300,
    description: 'May use {{first_name}}, {{paper_title}}…',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  @Matches(/\S/, { message: 'The email needs a subject.' })
  subject: string;

  @ApiProperty({ maxLength: 50000, description: 'HTML, with placeholders.' })
  @IsString()
  @MaxLength(50000)
  body: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Shown in Email Logs (e.g. the custom email it came from).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  templateLabel?: string;
}

export class EmailLogQuery extends PageQuery {
  @ApiPropertyOptional({ enum: EMAIL_STATUSES })
  @IsOptional()
  @IsIn(EMAIL_STATUSES)
  status?: (typeof EMAIL_STATUSES)[number];

  @ApiPropertyOptional({ format: 'uuid', description: 'One paper only.' })
  @IsOptional()
  @IsUUID()
  submissionId?: string;

  @ApiPropertyOptional({ description: 'One template only.' })
  @IsOptional()
  @Matches(TEMPLATE_KEY)
  templateKey?: string;
}

export class AdminEmailLogQuery extends EmailLogQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'One conference only.' })
  @IsOptional()
  @IsUUID()
  conferenceId?: string;
}

// Responses ---------------------------------------------------------------------------------

export class PlatformTemplateResponse {
  @ApiProperty() key: string;
  @ApiProperty({ nullable: true, type: String }) module: string | null;
  @ApiProperty({ nullable: true, type: String }) role: string | null;
  @ApiProperty() label: string;
  @ApiProperty({ nullable: true, type: String }) sendType: string | null;
  @ApiProperty({ nullable: true, type: String }) triggerText: string | null;
  @ApiProperty({ nullable: true, type: String }) recipients: string | null;
  @ApiProperty() subject: string;
  @ApiProperty() body: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  updatedAt: string | null;
}

export class ConferenceTemplateResponse extends PlatformTemplateResponse {
  @ApiProperty({ description: 'false: the conference turned this email off.' })
  enabled: boolean;
  @ApiProperty({
    description: 'The conference changed the subject or body.',
  })
  customized: boolean;
  @ApiProperty({ description: 'The platform default subject.' })
  defaultSubject: string;
  @ApiProperty({ description: 'The platform default body.' })
  defaultBody: string;
}

export class CustomEmailResponse {
  @ApiProperty({ example: 'custom:abc123' }) key: string;
  @ApiProperty({ example: 'abc123' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty() subject: string;
  @ApiProperty() body: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class ConferenceTemplatesResponse {
  @ApiProperty({ type: [ConferenceTemplateResponse] })
  templates: ConferenceTemplateResponse[];
  @ApiProperty({ type: [CustomEmailResponse] })
  customEmails: CustomEmailResponse[];
}

export class EmailLogEntry {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  conferenceId: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  submissionId: string | null;
  @ApiProperty({ example: 'decision_notified' }) event: string;
  @ApiProperty() templateKey: string;
  @ApiProperty({ nullable: true, type: String }) templateLabel: string | null;
  @ApiProperty() toEmail: string;
  @ApiProperty({ nullable: true, type: String }) toName: string | null;
  @ApiProperty({ nullable: true, type: String }) recipientType: string | null;
  @ApiProperty() subject: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The HTML message.',
  })
  body: string | null;
  @ApiProperty({ enum: EMAIL_STATUSES }) status: string;
  @ApiProperty() attempts: number;
  @ApiProperty({ nullable: true, type: String }) error: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  sentAt: string | null;
  @ApiProperty({ nullable: true, type: String }) sentByName: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class EmailLogPage {
  @ApiProperty({ type: [EmailLogEntry] }) data: EmailLogEntry[];
  @ApiProperty({ nullable: true, type: String }) nextCursor: string | null;
}

export class CustomEmailQueuedResponse {
  @ApiProperty() queued: number;
  @ApiProperty() skipped: number;
}
