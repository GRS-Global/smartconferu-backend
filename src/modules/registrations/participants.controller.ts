import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { ConferenceRef } from '../../core/http/conference-ref.pipe.js';
import {
  MAX_RECEIPT_BYTES,
  type ReceiptUpload,
} from '../submissions/payment-receipts.service.js';
import { fileResponse } from '../submissions/submissions.controller.js';
import {
  ParticipantResponse,
  RegistrationImportDto,
  RegistrationImportResponse,
  SaveParticipantDto,
} from './dto/participant.dto.js';
import { ParticipantsService } from './participants.service.js';
import { RegistrationImportService } from './registration-import.service.js';

/** Participants without a paper (and co-authors who register), their payments and imports (chairs). */
@ApiTags('registrations')
@ApiBearerAuth()
@Controller('conferences/:conferenceId')
export class ParticipantsController {
  constructor(
    private readonly participants: ParticipantsService,
    private readonly imports: RegistrationImportService,
  ) {}

  @Get('participants')
  @ApiOperation({ summary: "The conference's participants (chairs)" })
  @ApiOkResponse({ type: [ParticipantResponse] })
  list(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
  ): Promise<ParticipantResponse[]> {
    return this.participants.list(user, conferenceId);
  }

  @Post('participants')
  @ApiOperation({ summary: 'Add a participant (chairs). No email is sent.' })
  @ApiOkResponse({ type: ParticipantResponse })
  create(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: SaveParticipantDto,
    @Client() client: ClientInfo,
  ): Promise<ParticipantResponse> {
    return this.participants.create(user, conferenceId, dto, client);
  }

  @Put('participants/:participantId')
  @ApiOperation({ summary: 'Change a participant (chairs)' })
  @ApiOkResponse({ type: ParticipantResponse })
  update(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
    @Body() dto: SaveParticipantDto,
    @Client() client: ClientInfo,
  ): Promise<ParticipantResponse> {
    return this.participants.update(
      user,
      conferenceId,
      participantId,
      dto,
      client,
    );
  }

  @Delete('participants/:participantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a participant (chairs)' })
  remove(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    return this.participants.remove(user, conferenceId, participantId, client);
  }

  @Post('participants/:participantId/receipt')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_RECEIPT_BYTES + 1, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary:
      "Attach a participant's payment receipt (chairs; PDF, JPG, PNG or WebP, 10 MB; the fee must be Paid)",
  })
  @ApiOkResponse({ type: ParticipantResponse })
  uploadReceipt(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
    @UploadedFile() file: ReceiptUpload | undefined,
    @Client() client: ClientInfo,
  ): Promise<ParticipantResponse> {
    return this.participants.uploadReceipt(
      user,
      conferenceId,
      participantId,
      file,
      client,
    );
  }

  @Delete('participants/:participantId/receipt')
  @ApiOperation({ summary: "Remove a participant's receipt (chairs)" })
  @ApiOkResponse({ type: ParticipantResponse })
  removeReceipt(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
    @Client() client: ClientInfo,
  ): Promise<ParticipantResponse> {
    return this.participants.removeReceipt(
      user,
      conferenceId,
      participantId,
      client,
    );
  }

  @Get('participants/:participantId/receipt')
  @ApiProduces('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
  @ApiOperation({ summary: "Download a participant's receipt (chairs)" })
  async downloadReceipt(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
  ): Promise<StreamableFile> {
    return fileResponse(
      await this.participants.downloadReceipt(
        user,
        conferenceId,
        participantId,
      ),
    );
  }

  @Post('registrations/import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Check (apply: false) or save (apply: true) paper payments or participants from a sheet (chairs). All rows or none.',
  })
  @ApiOkResponse({ type: RegistrationImportResponse })
  import(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: RegistrationImportDto,
    @Client() client: ClientInfo,
  ): Promise<RegistrationImportResponse> {
    return this.imports.run(user, conferenceId, dto, client);
  }
}
