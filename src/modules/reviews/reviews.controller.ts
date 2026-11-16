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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { DecisionsService } from './decisions.service.js';
import {
  AssignmentResponse,
  AssignReviewersDto,
  DecisionSentResponse,
  DecisionTypeResponse,
  DecisionTypesDto,
  MyAssignmentResponse,
  NotifyDecisionDto,
  PaperReviewsResponse,
  RespondToAssignmentDto,
  ReviewFieldsDto,
  ReviewResponse,
  SaveReviewDto,
  SaveReviewResponse,
  ShareReviewDto,
} from './dto/review.dto.js';
import { ReviewsService } from './reviews.service.js';

const Id = (name: string) => Param(name, ParseUUIDPipe);

/** A paper's reviews and decision (chairs; reviewers and authors see their part). */
@ApiTags('reviews')
@ApiBearerAuth()
@Controller('submissions/:submissionId')
export class PaperReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly decisions: DecisionsService,
  ) {}

  @Get('reviews')
  @ApiOperation({
    summary:
      "The paper's reviews: chairs see every assignment, a reviewer their own, authors the reviews shared with them (anonymised)",
  })
  @ApiOkResponse({ type: PaperReviewsResponse })
  list(
    @CurrentUser() user: AuthUser,
    @Id('submissionId') submissionId: string,
  ): Promise<PaperReviewsResponse> {
    return this.reviews.paperReviews(user, submissionId);
  }

  @Post('assignments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Give the paper to reviewers (chairs). Active reviewers get it now and are emailed; invited ones when they accept the committee invitation.',
  })
  @ApiOkResponse({ type: PaperReviewsResponse })
  assign(
    @CurrentUser() user: AuthUser,
    @Id('submissionId') submissionId: string,
    @Body() dto: AssignReviewersDto,
    @Client() client: ClientInfo,
  ): Promise<PaperReviewsResponse> {
    return this.reviews.assign(user, submissionId, dto, client);
  }

  @Put('chair-review')
  @ApiOperation({
    summary:
      "Review the paper as the chair (the first save creates the chair's review)",
  })
  @ApiOkResponse({ type: AssignmentResponse })
  chairReview(
    @CurrentUser() user: AuthUser,
    @Id('submissionId') submissionId: string,
    @Body() dto: ReviewFieldsDto,
    @Client() client: ClientInfo,
  ): Promise<AssignmentResponse> {
    return this.reviews.chairReview(user, submissionId, dto, client);
  }

  @Post('decision/notify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Send the recorded decision to the authors (chairs): their bell and email, with the reviews shared; the final decision to the reviewers',
  })
  @ApiOkResponse({ type: DecisionSentResponse })
  notify(
    @CurrentUser() user: AuthUser,
    @Id('submissionId') submissionId: string,
    @Body() dto: NotifyDecisionDto,
    @Client() client: ClientInfo,
  ): Promise<DecisionSentResponse> {
    return this.decisions.notify(user, submissionId, dto, client);
  }
}

/** One review assignment: the reviewer's answer and form, or a chair taking it back. */
@ApiTags('reviews')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get(':assignmentId')
  @ApiOperation({
    summary: 'One assignment with its review (its reviewer, or a chair)',
  })
  @ApiOkResponse({ type: AssignmentResponse })
  get(
    @CurrentUser() user: AuthUser,
    @Id('assignmentId') assignmentId: string,
  ): Promise<AssignmentResponse> {
    return this.reviews.assignment(user, assignmentId);
  }

  @Post(':assignmentId/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept or decline a paper given to me (chairs hear about a decline)',
  })
  @ApiOkResponse({ type: AssignmentResponse })
  respond(
    @CurrentUser() user: AuthUser,
    @Id('assignmentId') assignmentId: string,
    @Body() dto: RespondToAssignmentDto,
    @Client() client: ClientInfo,
  ): Promise<AssignmentResponse> {
    return this.reviews.respond(user, assignmentId, dto, client);
  }

  @Put(':assignmentId/review')
  @ApiOperation({
    summary:
      'Save my review as a draft, or send it. A sent review can be corrected until the paper has a decision.',
  })
  @ApiOkResponse({ type: SaveReviewResponse })
  saveReview(
    @CurrentUser() user: AuthUser,
    @Id('assignmentId') assignmentId: string,
    @Body() dto: SaveReviewDto,
    @Client() client: ClientInfo,
  ): Promise<SaveReviewResponse> {
    return this.reviews.saveReview(user, assignmentId, dto, client);
  }

  @Delete(':assignmentId')
  @ApiOperation({
    summary:
      'Take the paper away from this reviewer (chairs). A sent review stays on record but no longer counts.',
  })
  @ApiOkResponse({ type: PaperReviewsResponse })
  unassign(
    @CurrentUser() user: AuthUser,
    @Id('assignmentId') assignmentId: string,
    @Client() client: ClientInfo,
  ): Promise<PaperReviewsResponse> {
    return this.reviews.unassign(user, assignmentId, client);
  }
}

/** Papers waiting for an invited reviewer. */
@ApiTags('reviews')
@ApiBearerAuth()
@Controller('pending-assignments')
export class PendingAssignmentsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Delete(':pendingId')
  @ApiOperation({
    summary: 'Drop a paper waiting for an invited reviewer (chairs)',
  })
  @ApiOkResponse({ type: PaperReviewsResponse })
  remove(
    @CurrentUser() user: AuthUser,
    @Id('pendingId') pendingId: string,
    @Client() client: ClientInfo,
  ): Promise<PaperReviewsResponse> {
    return this.reviews.removePending(user, pendingId, client);
  }
}

/** A sent review, as a chair handles it. */
@ApiTags('reviews')
@ApiBearerAuth()
@Controller('reviews')
export class ChairReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Put(':reviewId')
  @ApiOperation({
    summary: "Correct a reviewer's sent review (chairs). The reviewer is told.",
  })
  @ApiOkResponse({ type: AssignmentResponse })
  edit(
    @CurrentUser() user: AuthUser,
    @Id('reviewId') reviewId: string,
    @Body() dto: ReviewFieldsDto,
    @Client() client: ClientInfo,
  ): Promise<AssignmentResponse> {
    return this.reviews.chairEdit(user, reviewId, dto, client);
  }

  @Patch(':reviewId/shared')
  @ApiOperation({
    summary:
      'Show this review to the authors (anonymised), or hide it (chairs)',
  })
  @ApiOkResponse({ type: ReviewResponse })
  share(
    @CurrentUser() user: AuthUser,
    @Id('reviewId') reviewId: string,
    @Body() dto: ShareReviewDto,
    @Client() client: ClientInfo,
  ): Promise<ReviewResponse> {
    return this.reviews.share(user, reviewId, dto.shared, client);
  }
}

/** The reviewer's own queue. */
@ApiTags('reviews')
@ApiBearerAuth()
@Controller('me/review-assignments')
export class MyReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ApiQuery({ name: 'conferenceId', required: false, type: String })
  @ApiOperation({
    summary: 'Papers given to me to review (in one conference, or all)',
  })
  @ApiOkResponse({ type: [MyAssignmentResponse] })
  list(
    @CurrentUser() user: AuthUser,
    @Query('conferenceId', new ParseUUIDPipe({ optional: true }))
    conferenceId?: string,
  ): Promise<MyAssignmentResponse[]> {
    return this.reviews.myAssignments(user, conferenceId);
  }
}

/** What a decision is called in a conference. */
@ApiTags('reviews')
@ApiBearerAuth()
@Controller('conferences/:conferenceId/decision-types')
export class DecisionTypesController {
  constructor(private readonly decisions: DecisionsService) {}

  @Get()
  @ApiOperation({ summary: "The conference's decision types, in order" })
  @ApiOkResponse({ type: [DecisionTypeResponse] })
  list(
    @CurrentUser() user: AuthUser,
    @Id('conferenceId') conferenceId: string,
  ): Promise<DecisionTypeResponse[]> {
    return this.decisions.decisionTypes(user, conferenceId);
  }

  @Put()
  @ApiOperation({
    summary: 'Replace the list (chairs). Types a paper uses cannot be removed.',
  })
  @ApiOkResponse({ type: [DecisionTypeResponse] })
  replace(
    @CurrentUser() user: AuthUser,
    @Id('conferenceId') conferenceId: string,
    @Body() dto: DecisionTypesDto,
    @Client() client: ClientInfo,
  ): Promise<DecisionTypeResponse[]> {
    return this.decisions.replaceDecisionTypes(user, conferenceId, dto, client);
  }
}
