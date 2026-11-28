import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  assignmentStatus,
  decisionOutcome,
  extensionStatus,
  reviewStatus,
} from '../../../core/database/schema/index.js';
import { IsJsonObjectOfSize } from '../../../core/validation/validators.js';
import type {
  AssignmentStatus,
  DecisionOutcome,
  ReviewStatus,
} from '../../../core/rbac/access-rules.js';
import { SubmissionResponse } from '../../submissions/dto/submission.dto.js';

type ExtensionStatus = (typeof extensionStatus.enumValues)[number];

const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** The review form's own answers are designed in the app; the API stores them as given. */
export const REVIEW_ANSWERS_MAX_BYTES = 100_000;
export const CONFIDENCES = ['low', 'medium', 'high'] as const;
export const RECOMMENDATIONS = ['accept', 'revise', 'reject'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Requests ----------------------------------------------------------------------------------

export class AssignReviewersDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Committee members (conference_members ids) with the reviewer role. Active reviewers get the paper now; invited ones get it when they accept the committee invitation.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  memberIds: string[];

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '2027-03-31',
    description:
      'The review deadline for these reviewers (end of that day, UTC).',
  })
  @IsOptional()
  @Matches(DATE, { message: 'dueDate must be a date (YYYY-MM-DD)' })
  dueDate?: string | null;
}

export class RespondToAssignmentDto {
  @ApiProperty({
    description: 'true to accept the paper, false to decline it.',
  })
  @IsBoolean()
  accept: boolean;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 2000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  reason?: string | null;
}

/** The review form. Every field is optional, as in the app (the conference designs the form). */
export class ReviewFieldsDto {
  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  score?: number | null;

  @ApiPropertyOptional({ nullable: true, enum: CONFIDENCES })
  @IsOptional()
  @IsIn(CONFIDENCES)
  confidence?: (typeof CONFIDENCES)[number] | null;

  @ApiPropertyOptional({ nullable: true, enum: RECOMMENDATIONS })
  @IsOptional()
  @IsIn(RECOMMENDATIONS)
  recommendation?: (typeof RECOMMENDATIONS)[number] | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 20000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(20000)
  commentsToAuthor?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 20000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(20000)
  commentsToChair?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: "Answers to the conference's own review form questions.",
  })
  @IsOptional()
  @IsJsonObjectOfSize(REVIEW_ANSWERS_MAX_BYTES)
  answers?: Record<string, unknown>;
}

export class SaveReviewDto extends ReviewFieldsDto {
  @ApiProperty({
    description:
      'true sends the review to the chairs (and keeps it editable until the decision); false saves a draft. A draft never takes back a sent review.',
  })
  @IsBoolean()
  submit: boolean;
}

export class ShareReviewDto {
  @ApiProperty({ description: 'Show this review (anonymised) to the authors.' })
  @IsBoolean()
  shared: boolean;
}

export class NotifyDecisionDto {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    maxLength: 5000,
    description:
      'A note from the chair; replaces the note saved with the decision.',
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(5000)
  note?: string | null;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description:
      'Reviews to share with the authors in this email (the others keep their setting).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  shareReviewIds?: string[];
}

export class DecisionTypeDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'An existing type to keep; leave out for a new one.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  @Matches(/\S/, { message: 'label must not be empty' })
  label: string;

  @ApiPropertyOptional({ example: '#16A34A' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a hex colour like #16A34A',
  })
  color?: string;

  @ApiProperty({ enum: decisionOutcome.enumValues })
  @IsIn(decisionOutcome.enumValues)
  outcome: DecisionOutcome;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 1000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    maxLength: 120,
    description:
      'The status text the author sees on their paper; leave empty for the standard wording.',
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(120)
  authorLabel?: string | null;
}

export class DecisionTypesDto {
  @ApiProperty({
    type: [DecisionTypeDto],
    description: 'The whole list, in order. Types left out are removed.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DecisionTypeDto)
  types: DecisionTypeDto[];
}

// Responses ---------------------------------------------------------------------------------

export class ReviewResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: reviewStatus.enumValues }) status: ReviewStatus;
  @ApiProperty({ nullable: true, type: Number }) score: number | null;
  @ApiProperty({ nullable: true, type: String }) confidence: string | null;
  @ApiProperty({ nullable: true, type: String }) recommendation: string | null;
  @ApiProperty({ nullable: true, type: String }) commentsToAuthor:
    string | null;
  @ApiProperty({ nullable: true, type: String }) commentsToChair: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  answers: Record<string, unknown>;
  @ApiProperty() sharedWithAuthor: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  submittedAt: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  editedByChairAt: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class ReviewerResponse {
  @ApiProperty({ format: 'uuid' }) userId: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) email: string | null;
}

export class ExtensionResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: '2027-02-10' }) date: string;
  @ApiProperty({ nullable: true, type: String }) reason: string | null;
  @ApiProperty({ enum: extensionStatus.enumValues }) status: ExtensionStatus;
  @ApiProperty({ nullable: true, type: String }) note: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  decidedAt: string | null;
}

export class AssignmentCan {
  @ApiProperty({ description: 'Accept or decline the paper.' })
  respond: boolean;
  @ApiProperty({ description: 'Save or send the review.' }) review: boolean;
}

export class AssignmentResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) submissionId: string;
  @ApiProperty({ type: ReviewerResponse }) reviewer: ReviewerResponse;
  @ApiProperty({ enum: assignmentStatus.enumValues }) status: AssignmentStatus;
  @ApiProperty({
    description: "A chair's own review of the paper (Review as chair).",
  })
  byChair: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  dueAt: string | null;
  @ApiProperty({ format: 'date-time' }) assignedAt: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  respondedAt: string | null;
  @ApiProperty({ nullable: true, type: String }) declineReason: string | null;
  @ApiProperty({ nullable: true, type: ReviewResponse })
  review: ReviewResponse | null;
  @ApiProperty({
    nullable: true,
    type: ExtensionResponse,
    description: 'The latest "Ask for more time" on this paper, in any state.',
  })
  extension: ExtensionResponse | null;
  @ApiProperty({ type: AssignmentCan }) can: AssignmentCan;
}

export class PendingAssignmentResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) memberId: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) email: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  dueAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

/** A review as the authors see it: anonymised, no comments to the chair. */
export class AuthorReviewResponse {
  @ApiProperty({
    description: '"Reviewer 1", "Reviewer 2"… in the order sent.',
  })
  reviewerNo: number;
  @ApiProperty({ nullable: true, type: Number }) score: number | null;
  @ApiProperty({ nullable: true, type: String }) recommendation: string | null;
  @ApiProperty({ nullable: true, type: String }) commentsToAuthor:
    string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  submittedAt: string | null;
}

export class ReviewSummary {
  @ApiProperty({
    description: 'Assignments still open or sent (not declined or removed).',
  })
  assigned: number;
  @ApiProperty() submitted: number;
  @ApiProperty({ nullable: true, type: Number }) averageScore: number | null;
  @ApiProperty({ description: 'Every assigned review is in.' })
  complete: boolean;
}

export class PaperReviewsResponse {
  @ApiProperty({ format: 'uuid' }) submissionId: string;
  @ApiProperty({ enum: ['chair', 'reviewer', 'author'] })
  view: 'chair' | 'reviewer' | 'author';
  @ApiProperty({
    type: [AssignmentResponse],
    description: 'Chairs: every assignment. Reviewers: their own.',
  })
  assignments: AssignmentResponse[];
  @ApiProperty({
    type: [PendingAssignmentResponse],
    description: 'Chairs: papers waiting for invited reviewers.',
  })
  pending: PendingAssignmentResponse[];
  @ApiProperty({
    type: [AuthorReviewResponse],
    description:
      'Authors: the reviews the chair shared, once the decision is sent.',
  })
  authorReviews: AuthorReviewResponse[];
  @ApiProperty({ nullable: true, type: ReviewSummary })
  summary: ReviewSummary | null;
}

export class ReviewPaperSummary {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'ICX-12' }) paperId: string;
  @ApiProperty() title: string;
  @ApiProperty() abstract: string;
  @ApiProperty({ type: [String] }) keywords: string[];
  @ApiProperty({ nullable: true, type: String }) track: string | null;
  @ApiProperty({ nullable: true, type: String }) presentationType:
    string | null;
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty() conferenceSlug: string;
  @ApiProperty() conferenceAcronym: string;
  @ApiProperty({ enum: decisionOutcome.enumValues }) outcome: DecisionOutcome;
  @ApiProperty() withdrawn: boolean;
}

/** One paper in a reviewer's queue. */
/** One paper's reviewers on the chair's review board. */
export class ReviewBoardPaperResponse {
  @ApiProperty({ format: 'uuid' }) submissionId: string;
  @ApiProperty({
    type: [AssignmentResponse],
    description:
      'Every assignment, whatever its state (open, sent, declined, removed).',
  })
  assignments: AssignmentResponse[];
  @ApiProperty({
    type: [PendingAssignmentResponse],
    description: 'Waiting for an invited reviewer who has not joined yet.',
  })
  pending: PendingAssignmentResponse[];
}

/** Every paper's reviewers and reviews in one read (chairs). */
export class ReviewBoardResponse {
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty({
    type: [ReviewBoardPaperResponse],
    description: 'One entry per submitted paper (drafts left out).',
  })
  papers: ReviewBoardPaperResponse[];
}

export class MyAssignmentResponse extends AssignmentResponse {
  @ApiProperty({ type: ReviewPaperSummary }) paper: ReviewPaperSummary;
}

export class SaveReviewResponse extends AssignmentResponse {
  @ApiProperty({
    description:
      'True the first time the review is sent (the thank-you and chair emails go out then).',
  })
  firstSubmit: boolean;
}

export class DecisionTypeResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() label: string;
  @ApiProperty() color: string;
  @ApiProperty({ enum: decisionOutcome.enumValues }) outcome: DecisionOutcome;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ nullable: true, type: String }) authorLabel: string | null;
  @ApiProperty() position: number;
}

export class DecisionSentResponse {
  @ApiProperty({ type: SubmissionResponse }) submission: SubmissionResponse;
  @ApiProperty({ description: 'Emails queued (authors and reviewers).' })
  queued: number;
  @ApiProperty({ description: 'Turned off by the conference, or duplicates.' })
  skipped: number;
  @ApiProperty({
    description:
      'The authors had been told a different decision before ("Decision changed").',
  })
  changed: boolean;
}

export class ReviewInstructionsResponse {
  @ApiProperty({
    description:
      "The chair's instructions as text/HTML ('' = the standard text).",
  })
  text: string;
  @ApiProperty({ enum: ['html', 'pdf'] }) mode: 'html' | 'pdf';
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'The attached PDF: { path, name }. Read it with GET /files/public?path=.',
  })
  pdf: { path: string; name: string } | null;
}

export class SentDecisionResponse {
  @ApiProperty({ enum: decisionOutcome.enumValues }) outcome: DecisionOutcome;
  @ApiProperty({ nullable: true, type: String }) label: string | null;
  @ApiProperty({ nullable: true, type: String }) color: string | null;
}

/** What the review form of one assignment is built from: the chair's own form and instructions, and the decision once the authors were told. */
export class ReviewFormResponse {
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      "The conference's own review form as the chair saved it ({ sections }); null = the standard form.",
  })
  form: Record<string, unknown> | null;
  @ApiProperty({ type: ReviewInstructionsResponse })
  instructions: ReviewInstructionsResponse;
  @ApiProperty({
    nullable: true,
    type: SentDecisionResponse,
    description:
      'The decision the chair has sent to the authors (reviewers hear it when the authors do); null before.',
  })
  decision: SentDecisionResponse | null;
}

export class RequestExtensionDto {
  @ApiProperty({
    example: '2027-02-10',
    description:
      'The new deadline asked for (YYYY-MM-DD): after the current one and not in the past.',
  })
  @IsDateString({ strict: true }, { message: 'Choose a date.' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Choose a date (YYYY-MM-DD).' })
  date: string;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 1000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(1000)
  reason?: string | null;
}

export class SetDueDateDto {
  @ApiProperty({
    example: '2027-02-10',
    description:
      "The reviewer's new deadline on this paper (YYYY-MM-DD, not in the past).",
  })
  @IsDateString({ strict: true }, { message: 'Choose a date.' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Choose a date (YYYY-MM-DD).' })
  date: string;
}

export class RemindReviewerDto {
  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'A line added to the reminder.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class MessageReviewerDto {
  @ApiProperty({ maxLength: 5000 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Write a message.' })
  @MaxLength(5000)
  message: string;
}

export class DecideExtensionDto {
  @ApiProperty({
    description:
      "true moves the reviewer's deadline to the date asked for; false declines.",
  })
  @IsBoolean()
  approve: boolean;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 1000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}
