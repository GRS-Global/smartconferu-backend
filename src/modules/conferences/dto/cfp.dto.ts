import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { cfpStatus } from '../../../core/database/schema/index.js';
import { IsJsonObjectOfSize } from '../../../core/validation/validators.js';

export type CfpStatus = (typeof cfpStatus.enumValues)[number];

/** The CFP page content and look are designed in the web app; the API stores them as given. */
export const CFP_JSON_MAX_BYTES = 200_000;

export class UpdateCfpDto {
  @ApiPropertyOptional({
    description:
      'The page content (sections, topics, dates…). Replaces the stored content.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsJsonObjectOfSize(CFP_JSON_MAX_BYTES)
  content?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'The page design (colours, layout…). Replaces the stored theme.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsJsonObjectOfSize(CFP_JSON_MAX_BYTES)
  theme?: Record<string, unknown>;
}

export class CfpResponse {
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty({ enum: cfpStatus.enumValues }) status: CfpStatus;
  @ApiProperty({ type: 'object', additionalProperties: true })
  content: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true })
  theme: Record<string, unknown>;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When it was published or closed.',
  })
  decidedAt: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

/** One entry of the public Smart CFP directory. */
export class DirectoryEntryResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() slug: string;
  @ApiProperty() acronym: string;
  @ApiProperty() title: string;
  @ApiProperty({ nullable: true, type: String }) about: string | null;
  @ApiProperty({ nullable: true, type: String }) mode: string | null;
  @ApiProperty({ nullable: true, type: String }) city: string | null;
  @ApiProperty({ nullable: true, type: String }) country: string | null;
  @ApiProperty({ nullable: true, type: String }) primaryArea: string | null;
  @ApiProperty({ nullable: true, type: String }) secondaryArea: string | null;
  @ApiProperty({ nullable: true, type: String }) startDate: string | null;
  @ApiProperty({ nullable: true, type: String }) endDate: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  submissionDeadline: string | null;
  @ApiProperty({ nullable: true, type: String }) webPage: string | null;
  @ApiProperty({ nullable: true, type: String }) contactEmail: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  details: Record<string, unknown>;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When the CFP was published.',
  })
  publishedAt: string | null;
}
