import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { DeclineDto, InvitationResponse } from './dto/member.dto.js';
import { MembersService } from './members.service.js';

/** The signed-in user's committee invitations. */
@ApiTags('invitations')
@ApiBearerAuth()
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @ApiOperation({ summary: 'My invitations and committee roles' })
  @ApiOkResponse({ type: [InvitationResponse] })
  list(@CurrentUser() user: AuthUser): Promise<InvitationResponse[]> {
    return this.members.myInvitations(user);
  }

  @Post(':memberId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an invitation' })
  @ApiOkResponse({ type: InvitationResponse })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Client() client: ClientInfo,
  ): Promise<InvitationResponse> {
    return this.members.respond(user, memberId, true, null, client);
  }

  @Post(':memberId/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decline an invitation (papers already given are handed back)',
  })
  @ApiOkResponse({ type: InvitationResponse })
  decline(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: DeclineDto,
    @Client() client: ClientInfo,
  ): Promise<InvitationResponse> {
    return this.members.respond(user, memberId, false, dto.reason, client);
  }
}
