import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { ConferenceRef } from '../../core/http/conference-ref.pipe.js';
import { TourStateResponse } from './dto/tour.dto.js';
import { TourService } from './tour.service.js';

/** Whether the "Take a tour" guide has already been shown to the signed-in person for this conference. */
@ApiTags('conferences')
@ApiBearerAuth()
@Controller('conferences/:conferenceId/tour')
export class ConferenceTourController {
  constructor(private readonly tour: TourService) {}

  @Get()
  @ApiOperation({
    summary: 'Has this person been shown the tour of this conference yet?',
  })
  @ApiOkResponse({ type: TourStateResponse })
  state(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
  ): Promise<TourStateResponse> {
    return this.tour.state(user, conferenceId);
  }

  @Post('seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remember that the tour has been shown (on every device); safe to repeat',
  })
  @ApiNoContentResponse()
  async seen(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
  ): Promise<void> {
    await this.tour.markSeen(user, conferenceId);
  }
}
