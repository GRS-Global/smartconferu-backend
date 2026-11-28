import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';
import { PageQuery } from '../../../core/http/pagination.js';

export class UsersQuery extends PageQuery {
  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Part of a name, email or institution.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export class ActivityQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'The `nextBefore` of the previous page.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;

  @ApiPropertyOptional({
    example: 'submission.',
    description: 'Actions starting with this, e.g. "auth." or "review.".',
  })
  @IsOptional()
  @Matches(/^[a-z_.]{1,60}$/)
  action?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only what this user did.',
  })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only entries about this thing (e.g. a conference id).',
  })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-11-01',
    description: 'From this day (inclusive, UTC).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-11-30',
    description: 'Up to this day (inclusive, UTC).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Words in the action, its details, or who did it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

class ConferenceCounts {
  @ApiProperty() pendingApproval: number;
  @ApiProperty() active: number;
  @ApiProperty() archived: number;
  @ApiProperty() rejected: number;
  @ApiProperty() deleted: number;
  @ApiProperty() pendingDeletion: number;
}
class PaperCounts {
  @ApiProperty() submitted: number;
  @ApiProperty() withdrawn: number;
  @ApiProperty() drafts: number;
}
class UserCounts {
  @ApiProperty() total: number;
  @ApiProperty() disabled: number;
  @ApiProperty() superAdmins: number;
  @ApiProperty() newThisWeek: number;
}
class EmailCounts {
  @ApiProperty() sent: number;
  @ApiProperty() queued: number;
  @ApiProperty() failed: number;
}

export class AdminStatsResponse {
  @ApiProperty({ type: ConferenceCounts }) conferences: ConferenceCounts;
  @ApiProperty({ type: PaperCounts }) papers: PaperCounts;
  @ApiProperty({ type: UserCounts }) users: UserCounts;
  @ApiProperty() reviewsSubmitted: number;
  @ApiProperty({ type: EmailCounts, description: 'Emails of the last 7 days.' })
  emailsLastWeek: EmailCounts;
}

export class AdminUserResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) email: string | null;
  @ApiProperty({ nullable: true, type: String }) affiliation: string | null;
  @ApiProperty({ nullable: true, type: String }) country: string | null;
  @ApiProperty({
    type: [String],
    example: ['chair', 'author'],
    description: 'super_admin, chair, cfp_manager, reviewer, author.',
  })
  roles: string[];
  @ApiProperty({ enum: ['active', 'disabled'] }) status: string;
  @ApiProperty() emailVerified: boolean;
  @ApiProperty() twoStepOn: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastSignInAt: string | null;
}

class AdminUserConference {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() slug: string;
  @ApiProperty() acronym: string;
  @ApiProperty() title: string;
  @ApiProperty({ example: 'active' }) status: string;
  @ApiProperty({
    type: [String],
    example: ['chair'],
    description: 'chair, cfp_manager, reviewer, author.',
  })
  roles: string[];
  @ApiProperty({ description: 'Papers they submitted or are an author of.' })
  papers: number;
}

export class AdminUserDetailResponse extends AdminUserResponse {
  @ApiProperty({ type: [AdminUserConference] })
  conferences: AdminUserConference[];
  @ApiProperty({
    type: () => [ActivityEntry],
    description: 'The last 20 things they did.',
  })
  recentActivity: ActivityEntry[];
}

export class SetUserStatusDto {
  @ApiPropertyOptional({
    example: 'Spam submissions',
    description: 'Why (kept in the activity log).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AdminUserPage {
  @ApiProperty({ type: [AdminUserResponse] }) data: AdminUserResponse[];
  @ApiProperty({ nullable: true, type: String }) nextCursor: string | null;
}

class ActivityActor {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) email: string | null;
}

export class ActivityEntry {
  @ApiProperty() id: number;
  @ApiProperty({ format: 'date-time' }) occurredAt: string;
  @ApiProperty({ example: 'submission.created' }) action: string;
  @ApiProperty({ nullable: true, type: String }) entityType: string | null;
  @ApiProperty({ nullable: true, type: String }) entityId: string | null;
  @ApiProperty({ nullable: true, type: ActivityActor })
  actor: ActivityActor | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  data: Record<string, unknown>;
}

export class ActivityPage {
  @ApiProperty({ type: [ActivityEntry] }) data: ActivityEntry[];
  @ApiProperty({ nullable: true, type: Number }) nextBefore: number | null;
}

class AdminPaperAuthor {
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) email: string | null;
  @ApiProperty({ nullable: true, type: String }) affiliation: string | null;
  @ApiProperty() corresponding: boolean;
}

class AdminPaperReviewer {
  @ApiProperty({ format: 'uuid' }) userId: string;
  @ApiProperty() name: string;
  @ApiProperty() status: string;
  @ApiProperty() byChair: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  dueAt: string | null;
  @ApiProperty({ format: 'date-time' }) assignedAt: string;
  @ApiProperty({ nullable: true, type: String }) declineReason: string | null;
  @ApiProperty({ nullable: true, type: String }) reviewStatus: string | null;
  @ApiProperty({ nullable: true, type: Number }) score: number | null;
  @ApiProperty({ nullable: true, type: String }) recommendation: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  submittedAt: string | null;
}

export class AdminPaperResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() paperId: string;
  @ApiProperty() title: string;
  @ApiProperty() status: string;
  @ApiProperty() outcome: string;
  @ApiProperty({ nullable: true, type: String }) notifiedOutcome: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The decision label.',
  })
  decision: string | null;
  @ApiProperty({ nullable: true, type: String }) track: string | null;
  @ApiProperty({
    nullable: true,
    enum: [
      'upload',
      'screening',
      'needs_reviewers',
      'awaiting_response',
      'in_review',
      'overdue',
      'ready',
      'decided',
    ],
    description: 'Where it stands in review (null when withdrawn or a draft).',
  })
  stage: string | null;
  @ApiProperty() reviewersWanted: number;
  @ApiProperty() reviewsIn: number;
  @ApiProperty({ nullable: true, type: Number }) averageScore: number | null;
  @ApiProperty({ description: 'Scores 2 or more apart.' }) split: boolean;
  @ApiProperty({ type: [AdminPaperAuthor] }) authors: AdminPaperAuthor[];
  @ApiProperty({ type: [AdminPaperReviewer] }) reviewers: AdminPaperReviewer[];
  @ApiProperty({ format: 'date-time' }) submittedAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class AdminSessionResponse {
  @ApiProperty({ format: 'uuid', description: 'The sign-in (session family).' })
  id: string;
  @ApiProperty({ format: 'date-time' }) signedInAt: string;
  @ApiProperty({ format: 'date-time' }) lastActiveAt: string;
  @ApiProperty({ nullable: true, type: String }) userAgent: string | null;
  @ApiProperty({ nullable: true, type: String }) ipAddress: string | null;
}

export class MergeUsersDto {
  @ApiProperty({
    format: 'uuid',
    description: 'The account to merge into this one (it is closed).',
  })
  @IsUUID()
  otherUserId: string;
}

export class ViewAsDto {
  @ApiProperty({
    maxLength: 500,
    description: 'Why (kept in the activity log), e.g. a ticket number.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

class ViewAsUser {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) email: string | null;
}

export class ViewAsResponse {
  @ApiProperty({
    description:
      'A read-only access token for the user app as this person; it cannot be refreshed.',
  })
  accessToken: string;
  @ApiProperty({ format: 'date-time' }) expiresAt: string;
  @ApiProperty({ type: ViewAsUser }) user: ViewAsUser;
}

export class YearQuery {
  @ApiPropertyOptional({ example: 2026, description: 'Default: this year.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

class MonthActivity {
  @ApiProperty({ example: 'Jan' }) month: string;
  @ApiProperty() submissions: number;
  @ApiProperty() reviews: number;
}

export class MonthlyActivityResponse {
  @ApiProperty() year: number;
  @ApiProperty({
    type: [Number],
    description: 'Years with data, newest first.',
  })
  years: number[];
  @ApiProperty({ type: [MonthActivity] }) months: MonthActivity[];
}
