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
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  type ApiBodyOptions,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser, Public } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { ConferenceRef } from '../../core/http/conference-ref.pipe.js';
import { CertificatesService } from './certificates.service.js';
import {
  AssetResponse,
  CertificateEventDto,
  CreateAssetDto,
  UpdateAssetDto,
  CreateDesignDto,
  CreateDistributionDto,
  CreateSignatureDto,
  IssueDto,
  ReissueCertificateDto,
  RevokeCertificateDto,
  SignatureResponse,
  UpdateDesignDto,
  UpdateDistributionDto,
  UpdateSignatureDto,
} from './dto/certificates.dto.js';
import { ASSET_MAX_BYTES, AssetsService } from './assets.service.js';
import type { UploadedImage } from './image-kinds.js';
import {
  SIGNATURE_MAX_BYTES,
  SignaturesService,
} from './signatures.service.js';

const uploadBody: ApiBodyOptions = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary' } },
  },
};

/** Certificate designs, sends and issued certificates (chairs), the public check of a certificate ID, and the certificates a person holds. */
@ApiTags('certificates')
@Controller()
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get('conferences/:conferenceId/certificates')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Every design and send of a conference, each send with the certificates issued through it (chairs)',
  })
  load(@CurrentUser() user: AuthUser, @ConferenceRef() conferenceId: string) {
    return this.certificates.load(user, conferenceId);
  }

  @Post('conferences/:conferenceId/certificates/designs')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a certificate design (chairs)' })
  createDesign(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: CreateDesignDto,
    @Client() client: ClientInfo,
  ) {
    return this.certificates.createDesign(user, conferenceId, dto, client);
  }

  @Patch('certificate-designs/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Save a design's name and / or document (chairs)" })
  @ApiNoContentResponse()
  async saveDesign(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDesignDto,
  ): Promise<void> {
    await this.certificates.saveDesign(user, id, dto);
  }

  @Delete('certificate-designs/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Delete a design and its unsent sends; refused once certificates were issued from it (chairs)',
  })
  @ApiNoContentResponse()
  async deleteDesign(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    await this.certificates.deleteDesign(user, id, client);
  }

  @Post('conferences/:conferenceId/certificates/distributions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a send for a design (chairs)' })
  createDistribution(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() dto: CreateDistributionDto,
  ) {
    return this.certificates.createDistribution(user, conferenceId, dto);
  }

  @Patch('certificate-distributions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Save a draft send: audience rule, email, people added by hand, fixes (chairs; 409 once issued)',
  })
  @ApiNoContentResponse()
  async saveDistribution(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDistributionDto,
  ): Promise<void> {
    await this.certificates.saveDistribution(user, id, dto);
  }

  @Delete('certificate-distributions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a send that has not been issued (chairs)' })
  @ApiNoContentResponse()
  async deleteDistribution(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.certificates.deleteDistribution(user, id);
  }

  @Post('certificate-distributions/:id/issue')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Issue the send: each recipient gets a certificate with its own public ID and an email with the link to check it (chairs; once per send)',
  })
  issue(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueDto,
    @Client() client: ClientInfo,
  ) {
    return this.certificates.issue(user, id, dto.recipients, client);
  }

  @Post('certificates/issued/:serial/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Withdraw an issued certificate: the public check then says it is no longer valid (chairs)',
  })
  @ApiNoContentResponse()
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('serial') serial: string,
    @Body() dto: RevokeCertificateDto,
    @Client() client: ClientInfo,
  ): Promise<void> {
    await this.certificates.revoke(user, serial, dto.reason, client);
  }

  @Post('certificates/issued/:serial/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Send the certificate email again, same ID (chairs); 409 once withdrawn, 422 without an address',
  })
  @ApiNoContentResponse()
  async resend(
    @CurrentUser() user: AuthUser,
    @Param('serial') serial: string,
    @Client() client: ClientInfo,
  ): Promise<void> {
    await this.certificates.resend(user, serial, client);
  }

  @Post('certificates/issued/:serial/reissue')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Replace a certificate (corrected name, address…): the old one is withdrawn and points at the new one, which gets the next ID and is emailed (chairs)',
  })
  reissue(
    @CurrentUser() user: AuthUser,
    @Param('serial') serial: string,
    @Body() dto: ReissueCertificateDto,
    @Client() client: ClientInfo,
  ) {
    return this.certificates.reissue(user, serial, dto, client);
  }

  @Public()
  @Get('certificates/verify/:serial')
  @ApiOperation({
    summary:
      'Public check of a certificate ID: what is printed on it plus the conference details (no sign-in). 404 when there is none.',
  })
  verify(@Param('serial') serial: string) {
    return this.certificates.verify(serial.slice(0, 80));
  }

  @Get('me/certificates')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Certificates issued to the signed-in person (matched by the sign-in or a verified profile address), newest first',
  })
  mine(@CurrentUser() user: AuthUser) {
    return this.certificates.mine(user);
  }

  @Post('certificates/:serial/events')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "The person opened or downloaded their own certificate (for the chair's tracking)",
  })
  @ApiNoContentResponse()
  async event(
    @CurrentUser() user: AuthUser,
    @Param('serial') serial: string,
    @Body() dto: CertificateEventDto,
  ): Promise<void> {
    await this.certificates.recordEvent(user, serial.slice(0, 80), dto.kind);
  }
}

/** The conference's signature library (chairs) and the read of a signature picture. */
@ApiTags('certificates')
@Controller()
export class SignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

  @Get('conferences/:conferenceId/certificate-signatures')
  @ApiBearerAuth()
  @ApiOperation({ summary: "The conference's signature library (chairs)" })
  @ApiOkResponse({ type: [SignatureResponse] })
  list(@CurrentUser() user: AuthUser, @ConferenceRef() conferenceId: string) {
    return this.signatures.list(user, conferenceId);
  }

  @Post('conferences/:conferenceId/certificate-signatures')
  @ApiBearerAuth()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: SIGNATURE_MAX_BYTES + 1, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'name'],
      properties: {
        file: { type: 'string', format: 'binary' },
        name: { type: 'string' },
        designation: { type: 'string' },
        institution: { type: 'string' },
      },
    },
  })
  @ApiOperation({
    summary:
      "Add a signature: PNG (transparent works), JPG or WebP up to 1 MB, with the signatory's name, designation and institution (chairs). The first one becomes the default.",
  })
  @ApiCreatedResponse({ type: SignatureResponse })
  create(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() fields: CreateSignatureDto,
    @UploadedFile() file: UploadedImage | undefined,
    @Client() client: ClientInfo,
  ) {
    return this.signatures.create(user, conferenceId, fields, file, client);
  }

  @Patch('certificate-signatures/:id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Edit the signatory's details or make it the default (chairs)",
  })
  @ApiOkResponse({ type: SignatureResponse })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSignatureDto,
  ) {
    return this.signatures.update(user, id, dto);
  }

  @Put('certificate-signatures/:id/image')
  @ApiBearerAuth()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: SIGNATURE_MAX_BYTES + 1, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody)
  @ApiOperation({
    summary:
      'Replace the picture of a signature, keeping every design that uses it (chairs)',
  })
  @ApiOkResponse({ type: SignatureResponse })
  replaceImage(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedImage | undefined,
  ) {
    return this.signatures.replaceImage(user, id, file);
  }

  @Delete('certificate-signatures/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Delete a signature; refused (409) while a design still uses it, unless ?removeFromDesigns=true (then its blocks are taken off those designs) (chairs)',
  })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
    @Query('removeFromDesigns') removeFromDesigns?: string,
  ): Promise<void> {
    await this.signatures.remove(
      user,
      id,
      client,
      removeFromDesigns === 'true',
    );
  }

  @Public()
  @Get('certificates/signature-image/:id')
  @ApiProduces('image/png', 'image/jpeg', 'image/webp')
  @ApiOperation({
    summary:
      'The picture of a signature by its (random) id, for drawing certificates (no sign-in; it is printed on every certificate that uses it)',
  })
  async image(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const file = await this.signatures.read(id);
    return new StreamableFile(file.data, {
      type: file.contentType,
      length: file.data.length,
    });
  }
}

/** The conference's picture library for its certificates (chairs) and the read of a picture. */
@ApiTags('certificates')
@Controller()
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get('conferences/:conferenceId/certificate-assets')
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The conference's picture library for certificates (chairs)",
  })
  @ApiOkResponse({ type: [AssetResponse] })
  list(@CurrentUser() user: AuthUser, @ConferenceRef() conferenceId: string) {
    return this.assets.list(user, conferenceId);
  }

  @Post('conferences/:conferenceId/certificate-assets')
  @ApiBearerAuth()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: ASSET_MAX_BYTES + 1, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        name: { type: 'string' },
      },
    },
  })
  @ApiOperation({
    summary:
      'Add a picture: PNG (transparent works), JPG or WebP up to 2 MB, at most 200 per conference (chairs)',
  })
  @ApiCreatedResponse({ type: AssetResponse })
  create(
    @CurrentUser() user: AuthUser,
    @ConferenceRef() conferenceId: string,
    @Body() fields: CreateAssetDto,
    @UploadedFile() file: UploadedImage | undefined,
    @Client() client: ClientInfo,
  ) {
    return this.assets.create(user, conferenceId, fields.name, file, client);
  }

  @Patch('certificate-assets/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rename a picture (chairs)' })
  @ApiOkResponse({ type: AssetResponse })
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssetDto,
  ) {
    return this.assets.rename(user, id, dto);
  }

  @Put('certificate-assets/:id/image')
  @ApiBearerAuth()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: ASSET_MAX_BYTES + 1, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody)
  @ApiOperation({
    summary: 'Replace a picture, keeping every design that uses it (chairs)',
  })
  @ApiOkResponse({ type: AssetResponse })
  replaceImage(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedImage | undefined,
  ) {
    return this.assets.replaceImage(user, id, file);
  }

  @Delete('certificate-assets/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Delete a picture; refused (409) while a design still uses it, unless ?removeFromDesigns=true (then it is taken off those designs) (chairs)',
  })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
    @Query('removeFromDesigns') removeFromDesigns?: string,
  ): Promise<void> {
    await this.assets.remove(user, id, client, removeFromDesigns === 'true');
  }

  @Public()
  @Get('certificates/asset-image/:id')
  @ApiProduces('image/png', 'image/jpeg', 'image/webp')
  @ApiOperation({
    summary:
      'The picture of an asset by its (random) id, for drawing certificates (no sign-in; it is printed on every certificate that uses it)',
  })
  async image(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const file = await this.assets.read(id);
    return new StreamableFile(file.data, {
      type: file.contentType,
      length: file.data.length,
    });
  }
}
