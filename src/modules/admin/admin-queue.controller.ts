import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';
import { AdminQueueService } from './admin-queue.service.js';
import {
  AdminNoteResponse,
  NoteDto,
  QueueItemParams,
  QueueParams,
  QueueStateResponse,
} from './dto/admin-queue.dto.js';

/** Working state of the approval queues: claims and notes. */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin/queues')
export class AdminQueueController {
  constructor(private readonly queues: AdminQueueService) {}

  @Get(':queue')
  @ApiOperation({ summary: "A queue's claims and notes" })
  @ApiOkResponse({ type: QueueStateResponse })
  state(@Param() params: QueueParams): Promise<QueueStateResponse> {
    return this.queues.state(params.queue);
  }

  @Put(':queue/:itemId/claim')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: '"Assign to me" (or take it over from another admin)',
  })
  @ApiNoContentResponse()
  claim(
    @CurrentUser() user: AuthUser,
    @Param() params: QueueItemParams,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.queues.claim(user, params.queue, params.itemId, client);
  }

  @Delete(':queue/:itemId/claim')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '"Release": nobody is on it any more' })
  @ApiNoContentResponse()
  release(
    @CurrentUser() user: AuthUser,
    @Param() params: QueueItemParams,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.queues.release(user, params.queue, params.itemId, client);
  }

  @Post(':queue/:itemId/notes')
  @ApiOperation({ summary: 'Add an internal note (only admins see it)' })
  @ApiCreatedResponse({ type: AdminNoteResponse })
  note(
    @CurrentUser() user: AuthUser,
    @Param() params: QueueItemParams,
    @Body() dto: NoteDto,
  ): Promise<AdminNoteResponse> {
    return this.queues.addNote(user, params.queue, params.itemId, dto.text);
  }
}
