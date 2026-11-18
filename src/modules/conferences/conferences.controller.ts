import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { ConferenceRef } from '../../core/http/conference-ref.pipe.js';
import { CfpsService } from './cfps.service.js';
import { ConferencesService } from './conferences.service.js';
import { CfpResponse, UpdateCfpDto } from './dto/cfp.dto.js';
import {
  ConferenceResponse,
  CreateConferenceDto,
  MyConferencesResponse,
  ReasonDto,
  SetupProgressDto,
  UpdateConferenceDto,
  UpdateSettingsDto,
} from './dto/conference.dto.js';
import {
  InviteMemberDto,
  MemberQuery,
  MemberResponse,
  UpdateMemberDto,
} from './dto/member.dto.js';
import { MembersService } from './members.service.js';

class InviteResultResponse {
  @ApiProperty({
    description: 'False when they were already invited or on the team.',
  })
  created: boolean;
  @ApiProperty({ type: MemberResponse }) member: MemberResponse;
}

const ConferenceId = () => ConferenceRef();

@ApiTags('conferences')
@ApiBearerAuth()
@Controller('conferences')
export class ConferencesController {
  constructor(
    private readonly conferences: ConferencesService,
    private readonly cfps: CfpsService,
    private readonly members: MembersService,
  ) {}

  // Conferences ------------------------------------------------------------------------------

  @Post()
  @ApiOperation({
    summary: 'Ask for a new conference (waits for a super admin to approve it)',
  })
  @ApiCreatedResponse({ type: ConferenceResponse })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateConferenceDto,
    @Client() client: ClientInfo,
  ): Promise<ConferenceResponse> {
    return this.conferences.create(user, dto, client);
  }

  @Get()
  @ApiOperation({
    summary:
      'My conferences (where I have a role or a paper) and my requests waiting for approval',
  })
  @ApiOkResponse({ type: MyConferencesResponse })
  listMine(@CurrentUser() user: AuthUser): Promise<MyConferencesResponse> {
    return this.conferences.listMine(user);
  }

  @Get(':conferenceId')
  @ApiOperation({
    summary: 'One conference (for its team, creator and authors)',
  })
  @ApiOkResponse({ type: ConferenceResponse })
  get(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
  ): Promise<ConferenceResponse> {
    return this.conferences.get(user, conferenceId);
  }

  @Patch(':conferenceId')
  @ApiOperation({ summary: 'Edit the conference details (chairs)' })
  @ApiOkResponse({ type: ConferenceResponse })
  update(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Body() dto: UpdateConferenceDto,
    @Client() client: ClientInfo,
  ): Promise<ConferenceResponse> {
    return this.conferences.update(user, conferenceId, dto, client);
  }

  @Patch(':conferenceId/settings')
  @ApiOperation({
    summary:
      'Change conference settings: screening, review timeline, … (chairs)',
  })
  @ApiOkResponse({ type: ConferenceResponse })
  updateSettings(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Body() dto: UpdateSettingsDto,
  ): Promise<ConferenceResponse> {
    return this.conferences.updateSettings(user, conferenceId, dto.settings);
  }

  @Put(':conferenceId/setup-progress')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Save my setup-guide progress (chairs)' })
  @ApiNoContentResponse()
  saveSetupProgress(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Body() dto: SetupProgressDto,
  ): Promise<void> {
    return this.conferences.saveSetupProgress(user, conferenceId, dto.progress);
  }

  @Post(':conferenceId/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive an active conference (chairs)' })
  @ApiOkResponse({ type: ConferenceResponse })
  archive(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Client() client: ClientInfo,
  ): Promise<ConferenceResponse> {
    return this.conferences.archive(user, conferenceId, client);
  }

  @Post(':conferenceId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Make an archived conference active again (chairs)',
  })
  @ApiOkResponse({ type: ConferenceResponse })
  restore(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Client() client: ClientInfo,
  ): Promise<ConferenceResponse> {
    return this.conferences.restore(user, conferenceId, client);
  }

  @Post(':conferenceId/deletion-request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask the super admin to delete an archived conference (chairs)',
  })
  @ApiOkResponse({ type: ConferenceResponse })
  requestDeletion(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Body() dto: ReasonDto,
    @Client() client: ClientInfo,
  ): Promise<ConferenceResponse> {
    return this.conferences.requestDeletion(
      user,
      conferenceId,
      dto.reason,
      client,
    );
  }

  @Delete(':conferenceId/deletion-request')
  @ApiOperation({ summary: 'Take back the deletion request (chairs)' })
  @ApiOkResponse({ type: ConferenceResponse })
  cancelDeletion(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Client() client: ClientInfo,
  ): Promise<ConferenceResponse> {
    return this.conferences.cancelDeletion(user, conferenceId, client);
  }

  // Call for Papers --------------------------------------------------------------------------

  @Get(':conferenceId/cfp')
  @ApiOperation({ summary: 'The Call for Papers, in any state (the team)' })
  @ApiOkResponse({ type: CfpResponse })
  getCfp(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
  ): Promise<CfpResponse> {
    return this.cfps.get(user, conferenceId);
  }

  @Patch(':conferenceId/cfp')
  @ApiOperation({ summary: 'Edit the CFP page (chairs, CFP managers)' })
  @ApiOkResponse({ type: CfpResponse })
  updateCfp(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Body() dto: UpdateCfpDto,
  ): Promise<CfpResponse> {
    return this.cfps.update(user, conferenceId, dto);
  }

  @Post(':conferenceId/cfp/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Send the CFP to the Super Admin for approval (chairs, CFP managers). It goes live (the submission link opens) only once approved; a CFP that was approved before and then closed opens again at once.',
  })
  @ApiOkResponse({ type: CfpResponse })
  publishCfp(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Client() client: ClientInfo,
  ): Promise<CfpResponse> {
    return this.cfps.publish(user, conferenceId, client);
  }

  @Post(':conferenceId/cfp/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close the CFP: no new papers (chairs, CFP managers)',
  })
  @ApiOkResponse({ type: CfpResponse })
  closeCfp(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Client() client: ClientInfo,
  ): Promise<CfpResponse> {
    return this.cfps.close(user, conferenceId, client);
  }

  // Team -------------------------------------------------------------------------------------

  @Get(':conferenceId/members')
  @ApiOperation({
    summary: 'The team: chairs, CFP managers, reviewers (chairs)',
  })
  @ApiOkResponse({ type: [MemberResponse] })
  listMembers(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Query() query: MemberQuery,
  ): Promise<MemberResponse[]> {
    return this.members.list(user, conferenceId, query.role);
  }

  @Post(':conferenceId/members')
  @ApiOperation({
    summary:
      'Invite someone by email (201 when invited, 200 when already invited or on the team)',
  })
  @ApiCreatedResponse({ type: InviteResultResponse })
  async invite(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Body() dto: InviteMemberDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InviteResultResponse> {
    const result = await this.members.invite(user, conferenceId, dto, client);
    res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  @Patch(':conferenceId/members/:memberId')
  @ApiOperation({
    summary: "Edit a member's name, expertise or paper limit (chairs)",
  })
  @ApiOkResponse({ type: MemberResponse })
  updateMember(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateMemberDto,
  ): Promise<MemberResponse> {
    return this.members.update(user, conferenceId, memberId, dto);
  }

  @Delete(':conferenceId/members/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove someone from the team; their open review assignments are withdrawn (chairs)',
  })
  @ApiNoContentResponse()
  removeMember(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.members.remove(user, conferenceId, memberId, client);
  }
}
