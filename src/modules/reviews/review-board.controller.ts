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
import { ReviewBoardResponse } from './dto/review.dto.js';
import { ReviewsService } from './reviews.service.js';

@ApiTags('reviews')
@ApiBearerAuth()
@Controller('conferences/:conferenceId/review-board')
export class ReviewBoardController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({
    summary:
      "Every submitted paper's reviewers and reviews in one call (chairs; the :conferenceId may be the slug)",
  })
  @ApiOkResponse({ type: ReviewBoardResponse })
  get(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
  ): Promise<ReviewBoardResponse> {
    return this.reviews.reviewBoard(user, conferenceId);
  }
}
