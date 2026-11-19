import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Get,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { AiToolsService } from './ai-tools.service.js';
import {
  ConferenceWebsiteDto,
  IngestDto,
  PaperChatDto,
  PaperMetadataDto,
  ReviewEnhanceDto,
  ScreeningAiDto,
  TopicsDto,
  PaperSummaryResponse,
} from './dto/ai.dto.js';
import { PaperRagService } from './paper-rag.service.js';
import { ConferenceWebsiteService } from './website/conference-website.service.js';

const anyObject = { schema: { type: 'object', additionalProperties: true } };
/** AI calls cost money: at most this many per minute per client. */
const AI_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/**
 * The AI helpers (signed-in users). Each call is recorded in ai_usage. 503 NOT_READY when the
 * server has no AI keys; 502 AI_FAILED when the provider fails; 422 when the model declines.
 */
@ApiTags('ai')
@ApiBearerAuth()
@Throttle(AI_LIMIT)
@Controller('ai')
export class AiController {
  constructor(
    private readonly tools: AiToolsService,
    private readonly website: ConferenceWebsiteService,
  ) {}

  @Post('paper-metadata')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Smart Fill: the submission form fields from the text of the paper',
  })
  @ApiOkResponse(anyObject)
  paperMetadata(@CurrentUser() user: AuthUser, @Body() dto: PaperMetadataDto) {
    return this.tools.paperMetadata(user, dto);
  }

  @Post('screening')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "The AI part of the automatic initial check, from the app's digest of the PDF (column layout, language, missing parts)",
  })
  @ApiOkResponse(anyObject)
  screening(@CurrentUser() user: AuthUser, @Body() dto: ScreeningAiDto) {
    return this.tools.screening(user, dto);
  }

  @Post('topics')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suggest call-for-papers topics for a conference' })
  @ApiOkResponse(anyObject)
  topics(@CurrentUser() user: AuthUser, @Body() dto: TopicsDto) {
    return this.tools.topics(user, dto);
  }

  @Post('review-enhance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Smart Assist: three better-worded versions of a reviewer's own review (never a new judgment)",
  })
  @ApiOkResponse(anyObject)
  enhanceReview(@CurrentUser() user: AuthUser, @Body() dto: ReviewEnhanceDto) {
    return this.tools.enhanceReview(user, dto);
  }

  @Post('conference-from-website')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Fill the Create Conference form from the conference's website",
  })
  @ApiOkResponse(anyObject)
  conferenceFromWebsite(
    @CurrentUser() user: AuthUser,
    @Body() dto: ConferenceWebsiteDto,
  ) {
    return this.website.fill(user, dto.url);
  }
}

/** A paper's AI material: preparing it, and asking about it. */
@ApiTags('ai')
@ApiBearerAuth()
@Throttle(AI_LIMIT)
@Controller('submissions/:submissionId/ai')
export class PaperAiController {
  constructor(private readonly rag: PaperRagService) {}

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Prepare the latest PDF version for AI (text, embeddings, digest). New versions are prepared automatically.',
  })
  @ApiOkResponse(anyObject)
  ingest(
    @CurrentUser() user: AuthUser,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: IngestDto,
  ) {
    return this.rag.ingestFor(user, submissionId, dto.force === true);
  }

  @Get('summary')
  @ApiOperation({
    summary:
      "The paper's stored summary and key points (its chairs and assigned reviewers). It is written when the paper is given to a reviewer; status 'none' until then.",
  })
  @ApiOkResponse({ type: PaperSummaryResponse })
  summary(
    @CurrentUser() user: AuthUser,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
  ): Promise<PaperSummaryResponse> {
    return this.rag.summaryFor(user, submissionId);
  }

  @Post('summary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Write the paper's summary now (when there is none or it is for an older version), then return it. 409 NOT_READY without a file, 422 for a scanned PDF.",
  })
  @ApiOkResponse({ type: PaperSummaryResponse })
  writeSummary(
    @CurrentUser() user: AuthUser,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
  ): Promise<PaperSummaryResponse> {
    return this.rag.summarizeFor(user, submissionId, false);
  }

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ask about the paper (its chairs and assigned reviewers). 409 NOT_READY while it is being prepared.',
  })
  @ApiOkResponse(anyObject)
  chat(
    @CurrentUser() user: AuthUser,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: PaperChatDto,
  ) {
    return this.rag.chat(user, submissionId, dto.question, dto.history ?? []);
  }
}
