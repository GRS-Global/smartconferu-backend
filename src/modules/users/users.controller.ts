import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
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
import { DashboardResponse } from './dto/dashboard.response.js';
import { MeResponse, MyConferenceResponse } from './dto/me.response.js';
import { AcceptTermsDto, UpdateMeDto } from './dto/update-me.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: "The signed-in user's profile" })
  @ApiOkResponse({ type: MeResponse })
  getMe(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.users.getMe(user);
  }

  @Patch()
  @ApiOperation({ summary: "Update the signed-in user's profile" })
  @ApiOkResponse({ type: MeResponse })
  updateMe(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateMeDto,
  ): Promise<MeResponse> {
    return this.users.updateMe(user, dto);
  }

  @Post('terms')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept a version of the Terms of Service (recorded with the time)',
  })
  @ApiOkResponse({ type: MeResponse })
  acceptTerms(
    @CurrentUser() user: AuthUser,
    @Body() dto: AcceptTermsDto,
  ): Promise<MeResponse> {
    return this.users.acceptTerms(user, dto.version);
  }

  @Get('dashboard')
  @ApiOperation({
    summary:
      "Everything the My Conferences dashboard needs in one call: conferences with the user's roles, their papers, assignments and invitations",
  })
  @ApiOkResponse({ type: DashboardResponse })
  getDashboard(@CurrentUser() user: AuthUser): Promise<DashboardResponse> {
    return this.users.getDashboard(user);
  }

  @Get('conferences')
  @ApiOperation({
    summary:
      'Conferences where the signed-in user has a role (chair, reviewer, …)',
  })
  @ApiOkResponse({ type: [MyConferenceResponse] })
  listMyConferences(
    @CurrentUser() user: AuthUser,
  ): Promise<MyConferenceResponse[]> {
    return this.users.listMyConferences(user);
  }
}
