import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Public } from '../../core/auth/auth.decorators.js';
import { ConferencesService } from './conferences.service.js';
import { DirectoryEntryResponse } from './dto/cfp.dto.js';
import {
  ArchivedConferenceNotice,
  PublicConferenceResponse,
  SubmissionFormResponse,
} from './dto/conference.dto.js';

/** Readable without an account: the Smart CFP directory and the submission link. */
@ApiTags('public')
@Public()
@Controller('public')
export class PublicConferencesController {
  constructor(private readonly conferences: ConferencesService) {}

  @Get('cfps')
  @ApiOperation({
    summary:
      'Open Calls for Papers of approved conferences (Smart CFP directory)',
  })
  @ApiOkResponse({ type: [DirectoryEntryResponse] })
  directory(): Promise<DirectoryEntryResponse[]> {
    return this.conferences.directory();
  }

  @Get('conferences/:slug')
  @ApiOperation({
    summary:
      'An active conference by its URL id (the submission link); archived ones answer with a short notice',
  })
  @ApiExtraModels(PublicConferenceResponse, ArchivedConferenceNotice)
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(PublicConferenceResponse) },
        { $ref: getSchemaPath(ArchivedConferenceNotice) },
      ],
    },
  })
  find(
    @Param('slug') slug: string,
  ): Promise<PublicConferenceResponse | ArchivedConferenceNotice> {
    return this.conferences.findPublic(slug.toLowerCase());
  }

  @Get('conferences/:slug/submission-form')
  @ApiOperation({
    summary:
      "The tracks, submission types, extra questions and guidelines of an active conference's submission form",
  })
  @ApiOkResponse({ type: SubmissionFormResponse })
  submissionForm(@Param('slug') slug: string): Promise<SubmissionFormResponse> {
    return this.conferences.submissionForm(slug.toLowerCase());
  }
}
