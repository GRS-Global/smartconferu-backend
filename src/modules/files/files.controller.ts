import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ParseEnumPipe,
  Post,
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
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser, Public } from '../../core/auth/auth.decorators.js';
import { AppException } from '../../core/errors/app.exception.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { ConferenceRefPipe } from '../../core/http/conference-ref.pipe.js';
import {
  FILE_PURPOSES,
  type FilePurpose,
  UploadedFileResponse,
} from './dto/files.dto.js';
import { FilesService, type UploadedFile as Upload } from './files.service.js';

/** Multer's own cap; each purpose has its own, smaller limit checked in the service. */
const HARD_UPLOAD_LIMIT = 100 * 1024 * 1024;

@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @ApiBearerAuth()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: HARD_UPLOAD_LIMIT, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiQuery({ name: 'purpose', enum: FILE_PURPOSES })
  @ApiQuery({
    name: 'conferenceId',
    required: false,
    type: String,
    description:
      'UUID or slug. Required for conference_logo, review_instructions_pdf and screening_report (chairs).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary:
      'Upload a profile photo (PNG/JPEG/WebP ≤ 5 MB), a conference logo (same; saved on the conference), a review-instructions PDF or a screening report (PDF). Returns the storage path to keep.',
  })
  @ApiCreatedResponse({ type: UploadedFileResponse })
  upload(
    @CurrentUser() user: AuthUser,
    @Query('purpose', new ParseEnumPipe(FILE_PURPOSES)) purpose: FilePurpose,
    @Query('conferenceId', ConferenceRefPipe) conferenceId: string | undefined,
    @UploadedFile() file: Upload | undefined,
    @Client() client: ClientInfo,
  ): Promise<UploadedFileResponse> {
    return this.files.upload(user, purpose, conferenceId, file, client);
  }

  /** Profile photos and conference logos are shown in <img> tags and on public pages, so they can be read without a token. */
  @Public()
  @Get('public')
  @HttpCode(HttpStatus.OK)
  @ApiProduces('image/png', 'image/jpeg', 'image/webp')
  @ApiOperation({
    summary:
      'Read a profile photo or conference logo by its storage path (no sign-in)',
  })
  @ApiQuery({ name: 'path', type: String })
  async readPublic(@Query('path') path: string): Promise<StreamableFile> {
    const file = await this.files.read(requirePath(path));
    return new StreamableFile(file.data, {
      type: file.contentType,
      length: file.data.length,
    });
  }

  @Get()
  @ApiBearerAuth()
  @ApiProduces('image/png', 'image/jpeg', 'image/webp', 'application/pdf')
  @ApiOperation({
    summary:
      'Read a photo, logo, review-instructions PDF (anyone who can see the conference) or screening report (chairs) by its storage path',
  })
  @ApiQuery({ name: 'path', type: String })
  async read(
    @CurrentUser() user: AuthUser,
    @Query('path') path: string,
  ): Promise<StreamableFile> {
    const file = await this.files.read(requirePath(path), user);
    return new StreamableFile(file.data, {
      type: file.contentType,
      length: file.data.length,
    });
  }
}

function requirePath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 300) {
    throw AppException.notFound('The file');
  }
  return path;
}
