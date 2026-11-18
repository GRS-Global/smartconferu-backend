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
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { AppException } from '../../core/errors/app.exception.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { ConferenceRef } from '../../core/http/conference-ref.pipe.js';
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';
import { CommunicationsService } from './communications.service.js';
import {
  AdminEmailLogQuery,
  ConferenceTemplatesResponse,
  CustomEmailQueuedResponse,
  EmailLogPage,
  EmailLogQuery,
  PlatformTemplateResponse,
  SendCustomEmailDto,
  TEMPLATE_KEY,
  TestTemplateDto,
  UpdateConferenceTemplateDto,
  UpdatePlatformTemplateDto,
} from './dto/communications.dto.js';

const ConferenceId = () => ConferenceRef();

function templateKey(key: string): string {
  if (!TEMPLATE_KEY.test(key)) {
    throw AppException.notFound('The email template');
  }
  return key;
}

/** A conference's emails: its templates, its Email Logs, and the chair's own messages. */
@ApiTags('communications')
@ApiBearerAuth()
@Controller('conferences/:conferenceId')
export class ConferenceEmailsController {
  constructor(private readonly comms: CommunicationsService) {}

  @Get('email-templates')
  @ApiOperation({
    summary:
      "The conference's emails (its copy of each platform email) and custom emails (chairs)",
  })
  @ApiOkResponse({ type: ConferenceTemplatesResponse })
  templates(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
  ): Promise<ConferenceTemplatesResponse> {
    return this.comms.conferenceTemplates(user, conferenceId);
  }

  @Put('email-templates/:key')
  @ApiOperation({
    summary:
      'Change an email (on/off, subject, body), or create or change a custom email (key custom:<id>) (chairs)',
  })
  @ApiOkResponse({ type: ConferenceTemplatesResponse })
  updateTemplate(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Param('key') key: string,
    @Body() dto: UpdateConferenceTemplateDto,
    @Client() client: ClientInfo,
  ): Promise<ConferenceTemplatesResponse> {
    return this.comms.updateConferenceTemplate(
      user,
      conferenceId,
      templateKey(key),
      dto,
      client,
    );
  }

  @Delete('email-templates/:key')
  @ApiOperation({
    summary:
      'Delete a custom email, or put an email back to the platform default (chairs)',
  })
  @ApiOkResponse({ type: ConferenceTemplatesResponse })
  resetTemplate(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Param('key') key: string,
    @Client() client: ClientInfo,
  ): Promise<ConferenceTemplatesResponse> {
    return this.comms.resetConferenceTemplate(
      user,
      conferenceId,
      templateKey(key),
      client,
    );
  }

  @Get('email-log')
  @ApiOperation({
    summary: "The conference's Email Logs, newest first (chairs)",
  })
  @ApiOkResponse({ type: EmailLogPage })
  log(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Query() query: EmailLogQuery,
  ): Promise<EmailLogPage> {
    return this.comms.conferenceLog(user, conferenceId, query);
  }

  @Post('emails')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Send the chair’s own email to authors and/or reviewers (each person once, placeholders filled in)',
  })
  @ApiOkResponse({ type: CustomEmailQueuedResponse })
  send(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Body() dto: SendCustomEmailDto,
    @Client() client: ClientInfo,
  ): Promise<CustomEmailQueuedResponse> {
    return this.comms.sendCustom(user, conferenceId, dto, client);
  }
}

/** Super Admin › Email Templates and the platform's email log. */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin')
export class AdminEmailsController {
  constructor(private readonly comms: CommunicationsService) {}

  @Get('email-templates')
  @ApiOperation({ summary: 'Every platform email template' })
  @ApiOkResponse({ type: [PlatformTemplateResponse] })
  templates(): Promise<PlatformTemplateResponse[]> {
    return this.comms.platformTemplates();
  }

  @Put('email-templates/:key')
  @ApiOperation({
    summary:
      'Change a platform default (conference copies nobody changed follow it)',
  })
  @ApiOkResponse({ type: PlatformTemplateResponse })
  update(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
    @Body() dto: UpdatePlatformTemplateDto,
    @Client() client: ClientInfo,
  ): Promise<PlatformTemplateResponse> {
    return this.comms.updatePlatformTemplate(
      user,
      templateKey(key),
      dto,
      client,
    );
  }

  @Post('email-templates/:key/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send me this template with example values (or an unsaved edit)',
  })
  @ApiOkResponse({ type: CustomEmailQueuedResponse })
  test(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
    @Body() dto: TestTemplateDto,
  ): Promise<CustomEmailQueuedResponse> {
    return this.comms.testTemplate(user, templateKey(key), dto);
  }

  @Get('email-log')
  @ApiOperation({ summary: 'Every email the platform sent, newest first' })
  @ApiOkResponse({ type: EmailLogPage })
  log(@Query() query: AdminEmailLogQuery): Promise<EmailLogPage> {
    return this.comms.platformLog(query);
  }
}
