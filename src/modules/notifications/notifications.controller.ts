import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { DatabaseService } from '../../core/database/database.service.js';
import {
  conferences,
  emailLog,
  notifications,
  submissions,
  users,
} from '../../core/database/schema/index.js';
import { paperId } from '../submissions/submission.mapper.js';
import { toNotificationView } from '../../core/notifications/notification.view.js';
import {
  countUnread,
  countUnreadNotifications,
  emailsTo,
} from '../../core/notifications/unread-count.js';
import {
  decodeCursor,
  keyset,
  page,
  PageQuery,
} from '../../core/http/pagination.js';

export class NotificationsQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Only the ones not read yet.' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unread?: boolean;
}

export class MarkReadDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description:
      'The notifications to mark read; leave out to mark all of them.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids?: string[];
}

export class MarkUnreadDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids: string[];
}

export class NotificationResponse {
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "The conference's URL id, when it is about one you can still see.",
  })
  conferenceSlug: string | null;
  @ApiProperty({ nullable: true, type: String })
  conferenceAcronym: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'ICX-3',
    description: 'The paper as people see it, when it is about one.',
  })
  paperLabel: string | null;
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'review_assigned' }) kind: string;
  @ApiProperty() title: string;
  @ApiProperty({ nullable: true, type: String }) body: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Where in the app it leads.',
  })
  link: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  conferenceId: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  submissionId: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  readAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class NotificationPage {
  @ApiProperty({ type: [NotificationResponse] }) data: NotificationResponse[];
  @ApiProperty({ nullable: true, type: String }) nextCursor: string | null;
  @ApiProperty({
    description:
      'How many are not read yet: all notifications plus the emails sent to me (the bell).',
  })
  unread: number;
  @ApiProperty({
    description:
      'Unread notifications only, without emails (the Super Admin console, which lists no emails).',
  })
  unreadNotifications: number;
}

export class MyEmailResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty() subject: string;
  @ApiProperty({ description: 'The message as the template made it (HTML).' })
  body: string;
  @ApiProperty({ nullable: true, type: String }) templateLabel: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'Reviewer' })
  recipientType: string | null;
  @ApiProperty({ nullable: true, type: String }) conferenceSlug: string | null;
  @ApiProperty({ nullable: true, type: String })
  conferenceAcronym: string | null;
  @ApiProperty({ nullable: true, type: String })
  conferenceContact: string | null;
  @ApiProperty({ nullable: true, type: String }) paperLabel: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When I read it here; null = unread (counted on the bell).',
  })
  readAt: string | null;
}

export class MarkEmailsReadDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'The emails to mark read; leave out to mark all of them.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids?: string[];
}

export class EmailsQuery {
  @ApiPropertyOptional({ default: 100, maximum: 200 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  limit?: number;
}

export class MarkReadResponse {
  @ApiProperty() updated: number;
  @ApiProperty() unread: number;
}

/** The bell: a user's own notifications (notifications: own, mark read). */
@Injectable()
export class BellService {
  constructor(private readonly database: DatabaseService) {}

  async list(
    user: AuthUser,
    query: NotificationsQuery,
  ): Promise<NotificationPage> {
    const limit = query.limit ?? 50;
    const order = keyset(
      notifications.createdAt,
      notifications.id,
      decodeCursor(query.cursor),
      'newest-first',
    );
    const rows = await this.database.db
      .select({
        n: notifications,
        slug: conferences.slug,
        acronym: conferences.acronym,
        paperNo: submissions.paperNo,
      })
      .from(notifications)
      .leftJoin(conferences, eq(conferences.id, notifications.conferenceId))
      .leftJoin(submissions, eq(submissions.id, notifications.submissionId))
      .where(
        and(
          eq(notifications.userId, user.id),
          query.unread ? isNull(notifications.readAt) : undefined,
          order.where,
        ),
      )
      .orderBy(...order.orderBy)
      .limit(limit + 1);
    const result = page(rows, limit, (r) => ({
      at: r.n.createdAt,
      id: r.n.id,
    }));
    return {
      data: result.data.map((r) => ({
        ...toNotificationView(r.n),
        conferenceSlug: r.slug,
        conferenceAcronym: r.acronym,
        paperLabel:
          r.acronym && r.paperNo ? paperId(r.acronym, r.paperNo) : null,
      })),
      nextCursor: result.nextCursor,
      unread: await this.unread(user),
      unreadNotifications: await countUnreadNotifications(
        this.database.db,
        user.id,
      ),
    };
  }

  async markRead(
    user: AuthUser,
    ids: string[] | undefined,
  ): Promise<MarkReadResponse> {
    if (ids?.length === 0) {
      return { updated: 0, unread: await this.unread(user) };
    }
    const updated = await this.database.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, user.id),
          isNull(notifications.readAt),
          ids ? inArray(notifications.id, ids) : undefined,
        ),
      )
      .returning({ id: notifications.id });
    // "Mark all as read" covers the Emails tab too.
    const emails = ids ? 0 : await this.setEmailsRead(user, undefined, true);
    return {
      updated: updated.length + emails,
      unread: await this.unread(user),
    };
  }

  /** Marks emails sent to me read (these, or all of them) or, with `read` false, unread again. */
  async markEmails(
    user: AuthUser,
    ids: string[] | undefined,
    read: boolean,
  ): Promise<MarkReadResponse> {
    const updated =
      ids?.length === 0 ? 0 : await this.setEmailsRead(user, ids, read);
    return { updated, unread: await this.unread(user) };
  }

  private async setEmailsRead(
    user: AuthUser,
    ids: string[] | undefined,
    read: boolean,
  ): Promise<number> {
    const email = await this.myEmail(user);
    if (!email) {
      return 0;
    }
    const rows = await this.database.db
      .update(emailLog)
      .set({ recipientReadAt: read ? new Date() : null })
      .where(
        and(
          emailsTo(email),
          read
            ? isNull(emailLog.recipientReadAt)
            : isNotNull(emailLog.recipientReadAt),
          ids ? inArray(emailLog.id, ids) : undefined,
        ),
      )
      .returning({ id: emailLog.id });
    return rows.length;
  }

  private async myEmail(user: AuthUser): Promise<string | null> {
    const [me] = await this.database.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, user.id));
    return me?.email ?? null;
  }

  /** Puts read notifications back to unread (the Notifications page's read / unread toggle). */
  async markUnread(user: AuthUser, ids: string[]): Promise<MarkReadResponse> {
    const updated =
      ids.length === 0
        ? []
        : await this.database.db
            .update(notifications)
            .set({ readAt: null })
            .where(
              and(
                eq(notifications.userId, user.id),
                isNotNull(notifications.readAt),
                inArray(notifications.id, ids),
              ),
            )
            .returning({ id: notifications.id });
    return { updated: updated.length, unread: await this.unread(user) };
  }

  /** The emails sent to my own address (the Emails tab), newest first. Only what was sent. */
  async emails(user: AuthUser, limit: number): Promise<MyEmailResponse[]> {
    const email = await this.myEmail(user);
    if (!email) {
      return [];
    }
    const rows = await this.database.db
      .select({
        id: emailLog.id,
        createdAt: emailLog.createdAt,
        subject: emailLog.subject,
        body: emailLog.body,
        templateLabel: emailLog.templateLabel,
        recipientType: emailLog.recipientType,
        slug: conferences.slug,
        acronym: conferences.acronym,
        contact: conferences.contactEmail,
        paperNo: submissions.paperNo,
        readAt: emailLog.recipientReadAt,
      })
      .from(emailLog)
      .leftJoin(conferences, eq(conferences.id, emailLog.conferenceId))
      .leftJoin(submissions, eq(submissions.id, emailLog.submissionId))
      .where(emailsTo(email))
      .orderBy(desc(emailLog.createdAt), desc(emailLog.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      subject: r.subject,
      body: r.body ?? '',
      templateLabel: r.templateLabel,
      recipientType: r.recipientType,
      conferenceSlug: r.slug,
      conferenceAcronym: r.acronym,
      conferenceContact: r.contact,
      paperLabel: r.acronym && r.paperNo ? paperId(r.acronym, r.paperNo) : null,
      readAt: r.readAt?.toISOString() ?? null,
    }));
  }

  /** Unread notifications plus unread emails (the bell's number). */
  private unread(user: AuthUser): Promise<number> {
    return countUnread(this.database.db, user.id);
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly bell: BellService) {}

  @Get()
  @ApiOperation({ summary: 'My notifications, newest first' })
  @ApiOkResponse({ type: NotificationPage })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: NotificationsQuery,
  ): Promise<NotificationPage> {
    return this.bell.list(user, query);
  }

  @Post('unread')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark some of my notifications unread again' })
  @ApiOkResponse({ type: MarkReadResponse })
  markUnread(
    @CurrentUser() user: AuthUser,
    @Body() dto: MarkUnreadDto,
  ): Promise<MarkReadResponse> {
    return this.bell.markUnread(user, dto.ids);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark my notifications read (these, or all; "all" also marks my emails read)',
  })
  @ApiOkResponse({ type: MarkReadResponse })
  markRead(
    @CurrentUser() user: AuthUser,
    @Body() dto: MarkReadDto,
  ): Promise<MarkReadResponse> {
    return this.bell.markRead(user, dto.ids);
  }
}

/** The emails sent to me (Notifications › Emails). */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('me/emails')
export class MyEmailsController {
  constructor(private readonly bell: BellService) {}

  @Get()
  @ApiOperation({
    summary:
      'Emails sent to my address, newest first (what was sent, not drafts)',
  })
  @ApiOkResponse({ type: [MyEmailResponse] })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: EmailsQuery,
  ): Promise<MyEmailResponse[]> {
    const limit = Number.isInteger(query.limit) ? query.limit! : 100;
    return this.bell.emails(user, Math.min(Math.max(limit, 1), 200));
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark emails sent to me read (these, or all)' })
  @ApiOkResponse({ type: MarkReadResponse })
  markRead(
    @CurrentUser() user: AuthUser,
    @Body() dto: MarkEmailsReadDto,
  ): Promise<MarkReadResponse> {
    return this.bell.markEmails(user, dto.ids, true);
  }

  @Post('unread')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark emails sent to me unread again' })
  @ApiOkResponse({ type: MarkReadResponse })
  markUnread(
    @CurrentUser() user: AuthUser,
    @Body() dto: MarkUnreadDto,
  ): Promise<MarkReadResponse> {
    return this.bell.markEmails(user, dto.ids, false);
  }
}
