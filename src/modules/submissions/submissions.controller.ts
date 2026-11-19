import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { AppException } from '../../core/errors/app.exception.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { ConferenceRef } from '../../core/http/conference-ref.pipe.js';
import {
  AuthorListDto,
  ChangeTrackDto,
  CountResponse,
  FixRequestDto,
  PaperEmailDto,
  PaperEmailQueuedResponse,
  PaperIdsDto,
  CreateSubmissionDto,
  ConferencePapersQuery,
  DuplicateQuery,
  DuplicateResponse,
  EmailsQueuedResponse,
  RecordDecisionDto,
  ResendOnBehalfDto,
  ScreeningNoticeDto,
  ScreeningRecordDto,
  SubmissionResponse,
  UpdateDetailsDto,
} from './dto/submission.dto.js';
import {
  AutoCheckDto,
  PaperFileUploadResponse,
  ScreeningSettingsResponse,
  UpdateScreeningSettingsDto,
} from './dto/screening.dto.js';
import { ScreeningService } from './screening.service.js';
import type { AutoCheck } from './screening/auto-check.js';
import {
  SubmissionFilesService,
  type UploadedFile as PaperUpload,
} from './submission-files.service.js';
import { SubmissionsService } from './submissions.service.js';

/** Multer's own cap; the configured limit (MAX_UPLOAD_MB) is checked in the service. */
const HARD_UPLOAD_LIMIT = 100 * 1024 * 1024;

/** The conference's screening steps, criteria and AI mode. */
@ApiTags('submissions')
@ApiBearerAuth()
@Controller('conferences/:conferenceId/screening-settings')
export class ScreeningSettingsController {
  constructor(private readonly screening: ScreeningService) {}

  @Get()
  @ApiOperation({
    summary: 'Screening steps, criteria and AI mode (chairs)',
  })
  @ApiOkResponse({ type: ScreeningSettingsResponse })
  get(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
  ): Promise<ScreeningSettingsResponse> {
    return this.screening.getSettings(user, conferenceId);
  }

  @Put()
  @ApiOperation({
    summary:
      'Change screening steps, criteria or AI mode (chairs). Turning AI mode on checks the papers waiting for their initial check.',
  })
  @ApiOkResponse({ type: ScreeningSettingsResponse })
  update(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: UpdateScreeningSettingsDto,
    @Client() client: ClientInfo,
  ): Promise<ScreeningSettingsResponse> {
    return this.screening.updateSettings(user, conferenceId, dto, client);
  }
}

const ConferenceId = () => ConferenceRef();
const SubmissionId = () => Param('submissionId', ParseUUIDPipe);
const Version = () =>
  Param(
    'version',
    new ParseIntPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
  );

/** Submitting to a conference, and a conference's paper list. */
@ApiTags('submissions')
@ApiBearerAuth()
@Controller('conferences/:conferenceId/submissions')
export class ConferenceSubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Submit a paper (the CFP must be published; authors before the deadline). Chairs may submit on behalf of an author.',
  })
  @ApiCreatedResponse({ type: SubmissionResponse })
  create(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Body() dto: CreateSubmissionDto,
    @Client() client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.submissions.create(user, conferenceId, dto, client);
  }

  @Get()
  @ApiOperation({
    summary:
      "The conference's papers: all for chairs; otherwise my own and the ones given to me to review",
  })
  @ApiOkResponse({ type: [SubmissionResponse] })
  list(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Query() query: ConferencePapersQuery,
  ): Promise<SubmissionResponse[]> {
    return this.submissions.listForConference(
      user,
      conferenceId,
      query.paperNo,
    );
  }

  @Patch('track')
  @ApiOperation({ summary: 'Move papers to another track (chairs)' })
  @ApiOkResponse({ type: CountResponse })
  changeTrack(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Body() dto: ChangeTrackDto,
    @Client() client: ClientInfo,
  ): Promise<CountResponse> {
    return this.submissions.changeTrack(
      user,
      conferenceId,
      dto.ids,
      dto.track,
      client,
    );
  }

  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete papers for good, with their authors, files, assignments and reviews (chairs)',
  })
  @ApiOkResponse({ type: CountResponse })
  deleteMany(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Body() dto: PaperIdsDto,
    @Client() client: ClientInfo,
  ): Promise<CountResponse> {
    return this.submissions.deleteMany(user, conferenceId, dto.ids, client);
  }

  @Get('duplicate-check')
  @ApiOperation({
    summary:
      'Is a paper with this title (ignoring case and punctuation) already in the conference? Says only yes/no and whether it is mine.',
  })
  @ApiOkResponse({ type: DuplicateResponse })
  duplicate(
    @CurrentUser() user: AuthUser,
    @ConferenceId() conferenceId: string,
    @Query() query: DuplicateQuery,
  ): Promise<DuplicateResponse> {
    return this.submissions.duplicate(user, conferenceId, query.title);
  }
}

/** One paper: the paper page and its changes. */
@ApiTags('submissions')
@ApiBearerAuth()
@Controller('submissions')
export class SubmissionsController {
  constructor(
    private readonly submissions: SubmissionsService,
    private readonly screening: ScreeningService,
    private readonly files: SubmissionFilesService,
  ) {}

  @Post(':submissionId/files')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: HARD_UPLOAD_LIMIT, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        supplementary: {
          type: 'boolean',
          description:
            'Supplementary material (PDF, Word or ZIP). Otherwise the next paper version (PDF or Word).',
        },
        autoCheck: {
          type: 'string',
          description:
            "The app's automatic check of this file, as JSON (see PUT …/files/{fileId}/auto-check). Stored on the version; with AI mode on, the initial check is decided from it.",
        },
      },
    },
  })
  @ApiOperation({
    summary:
      'Upload the next version of the paper (authors, chairs), or supplementary material',
  })
  @ApiCreatedResponse({ type: PaperFileUploadResponse })
  upload(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @UploadedFile() file: PaperUpload | undefined,
    @Body('supplementary') supplementary: string | undefined,
    @Body('autoCheck') autoCheck: string | undefined,
    @Client() client: ClientInfo,
  ): Promise<PaperFileUploadResponse> {
    return this.files.upload(
      user,
      submissionId,
      file,
      supplementary === 'true',
      autoCheck,
      client,
    );
  }

  @Put(':submissionId/files/:fileId/auto-check')
  @ApiOperation({
    summary:
      "Attach the app's automatic check of a version that finished after the upload (authors, chairs)",
  })
  @ApiOkResponse({
    schema: { type: 'object', additionalProperties: true },
  })
  attachAutoCheck(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Body() dto: AutoCheckDto,
  ): Promise<AutoCheck> {
    return this.files.attachAutoCheck(
      user,
      submissionId,
      fileId,
      dto.autoCheck,
    );
  }

  @Get(':submissionId/files/:fileId')
  @ApiProduces('application/pdf', 'application/octet-stream')
  @ApiOperation({ summary: 'Download a file of the paper' })
  async download(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<StreamableFile> {
    const file = await this.files.download(user, submissionId, fileId);
    return new StreamableFile(file.data, {
      type: file.contentType,
      disposition: `attachment; filename="${file.fileName.replace(/[^\w.-]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      length: file.data.length,
    });
  }

  @Get()
  @ApiOperation({
    summary: 'My papers in every conference (submitted or co-authored)',
  })
  @ApiOkResponse({ type: [SubmissionResponse] })
  listMine(@CurrentUser() user: AuthUser): Promise<SubmissionResponse[]> {
    return this.submissions.listMine(user);
  }

  @Get('by-label/:label')
  @ApiOperation({
    summary:
      'The paper page found by its paper id as people see it ("ICX-12"). 404 if there is none I may see.',
  })
  @ApiOkResponse({ type: SubmissionResponse })
  getByLabel(
    @CurrentUser() user: AuthUser,
    @Param('label') label: string,
  ): Promise<SubmissionResponse> {
    return this.submissions.getByLabel(user, label);
  }

  @Get(':submissionId')
  @ApiOperation({
    summary:
      'The paper page, as I may see it (chair, author or reviewer). 404 if I may not see it.',
  })
  @ApiOkResponse({ type: SubmissionResponse })
  get(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
  ): Promise<SubmissionResponse> {
    return this.submissions.get(user, submissionId);
  }

  @Patch(':submissionId')
  @ApiOperation({
    summary:
      'Change title, abstract and keywords (authors until a decision; a chair until an author claims the paper)',
  })
  @ApiOkResponse({ type: SubmissionResponse })
  updateDetails(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Body() dto: UpdateDetailsDto,
    @Client() client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.submissions.updateDetails(user, submissionId, dto, client);
  }

  @Put(':submissionId/authors')
  @ApiOperation({
    summary:
      'Replace the author list (the submitter; a chair until an author claims the paper). New authors are emailed.',
  })
  @ApiOkResponse({ type: SubmissionResponse })
  replaceAuthors(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Body() dto: AuthorListDto,
    @Client() client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.submissions.replaceAuthors(
      user,
      submissionId,
      dto.authors,
      client,
    );
  }

  @Post(':submissionId/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Withdraw the paper (an author or a chair; final, and not after a rejection)',
  })
  @ApiOkResponse({ type: SubmissionResponse })
  withdraw(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Client() client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.submissions.withdraw(user, submissionId, client);
  }

  @Post(':submissionId/email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Email some of this paper's authors (chairs); {{first_name}}, {{paper_title}}... are filled in for each person. Listed in Email Logs.",
  })
  @ApiOkResponse({ type: PaperEmailQueuedResponse })
  emailAuthors(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Body() dto: PaperEmailDto,
    @Client() client: ClientInfo,
  ): Promise<PaperEmailQueuedResponse> {
    return this.submissions.emailAuthors(user, submissionId, dto, client);
  }

  @Post(':submissionId/fix-request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ask the authors to fix something by a date (chairs). They are told; it stays on the paper until a new version is uploaded.',
  })
  @ApiOkResponse({ type: SubmissionResponse })
  requestFix(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Body() dto: FixRequestDto,
    @Client() client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.submissions.requestFix(user, submissionId, dto, client);
  }

  @Post(':submissionId/on-behalf-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Send "Submitted on your behalf" again (the chair who submitted the paper), to all corresponding authors or the ones given',
  })
  @ApiOkResponse({ type: EmailsQueuedResponse })
  resendOnBehalf(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Body() dto: ResendOnBehalfDto,
  ): Promise<EmailsQueuedResponse> {
    return this.submissions.resendOnBehalf(user, submissionId, dto.emails);
  }

  // Screening and decisions (chairs) -------------------------------------------------------------

  @Put(':submissionId/screening/:version')
  @ApiOperation({
    summary:
      "Save the chair's screening record of a paper version (Initial Check / Plagiarism Check)",
  })
  @ApiOkResponse({ type: SubmissionResponse })
  saveScreening(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Version() version: number,
    @Body() dto: ScreeningRecordDto,
  ): Promise<SubmissionResponse> {
    if (version < 1) {
      throw AppException.validation('Unknown paper version.');
    }
    return this.screening.saveRecord(user, submissionId, version, dto.record);
  }

  @Post(':submissionId/screening/:version/notify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Email the authors the screening decision saved on this version (correction, revision or rejection)',
  })
  @ApiOkResponse({ type: EmailsQueuedResponse })
  notifyScreening(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Version() version: number,
    @Body() dto: ScreeningNoticeDto,
    @Client() client: ClientInfo,
  ): Promise<EmailsQueuedResponse> {
    return this.screening.notify(user, submissionId, version, dto, client);
  }

  @Post(':submissionId/decision')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Record a decision or stage (chairs). Authors are told only when the decision is sent.',
  })
  @ApiOkResponse({ type: SubmissionResponse })
  recordDecision(
    @CurrentUser() user: AuthUser,
    @SubmissionId() submissionId: string,
    @Body() dto: RecordDecisionDto,
    @Client() client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.screening.recordDecision(user, submissionId, dto, client);
  }
}
