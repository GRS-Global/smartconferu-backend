import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { ConferenceRef } from '../../core/http/conference-ref.pipe.js';
import { ChairOverviewService } from './chair-overview.service.js';
import { ChairOverviewResponse } from './dto/chair-overview.dto.js';

@ApiTags('reviews')
@ApiBearerAuth()
@Controller('conferences/:conferenceId/chair-overview')
export class ChairOverviewController {
  constructor(private readonly overview: ChairOverviewService) {}

  @Get()
  @ApiOperation({
    summary:
      "The chair's conference pages in one call: papers with review progress, decision types, screening settings, CFP state (chairs; the :conferenceId may be the slug)",
  })
  @ApiOkResponse({ type: ChairOverviewResponse })
  get(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
  ): Promise<ChairOverviewResponse> {
    return this.overview.get(user, conferenceId);
  }
}
