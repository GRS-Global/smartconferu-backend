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
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { notifications } from '../../core/database/schema/index.js';
import { toNotificationView } from '../../core/notifications/notification.view.js';
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

export class NotificationResponse {
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
  @ApiProperty({ description: 'How many are not read yet (all of them).' })
  unread: number;
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
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, user.id),
          query.unread ? isNull(notifications.readAt) : undefined,
          order.where,
        ),
      )
      .orderBy(...order.orderBy)
      .limit(limit + 1);
    const result = page(rows, limit, (n) => ({ at: n.createdAt, id: n.id }));
    return {
      data: result.data.map(toNotificationView),
      nextCursor: result.nextCursor,
      unread: await this.unread(user),
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
    return { updated: updated.length, unread: await this.unread(user) };
  }

  private async unread(user: AuthUser): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(eq(notifications.userId, user.id), isNull(notifications.readAt)),
      );
    return row?.count ?? 0;
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

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark my notifications read (these, or all)' })
  @ApiOkResponse({ type: MarkReadResponse })
  markRead(
    @CurrentUser() user: AuthUser,
    @Body() dto: MarkReadDto,
  ): Promise<MarkReadResponse> {
    return this.bell.markRead(user, dto.ids);
  }
}
