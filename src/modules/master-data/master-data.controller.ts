import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser, Public } from '../../core/auth/auth.decorators.js';
import { Client, type ClientInfo } from '../../core/http/client-info.js';
import { SuperAdminOnly } from '../../core/rbac/super-admin.guard.js';
import {
  CreateInstitutionDto,
  CreateResearchAreaDto,
  CreateSocietyDto,
  InstitutionResponse,
  InstitutionsQuery,
  MergeInstitutionDto,
  ResearchAreaGroupResponse,
  SocietyResponse,
  UpdateInstitutionDto,
  UpdateResearchAreaDto,
  UpdateSocietyDto,
} from './dto/master-data.dto.js';
import { MasterDataService } from './master-data.service.js';

class ResearchAreaSaved {
  @ApiProperty({ format: 'uuid' }) id: string;
}

class ResearchAreaUpdated extends ResearchAreaSaved {
  @ApiProperty({ description: 'Conferences whose area was renamed with it.' })
  conferencesRenamed: number;
}

/** The active entries of the master-data lists, for the app's pickers. Open to everyone. */
@ApiTags('master data')
@Public()
@Controller('master-data')
export class MasterDataController {
  constructor(private readonly masterData: MasterDataService) {}

  @Get('societies')
  @ApiOperation({ summary: 'Societies a member can pick (active ones)' })
  @ApiOkResponse({ type: [SocietyResponse] })
  societies(): Promise<SocietyResponse[]> {
    return this.masterData.societies(true);
  }

  @Get('institutions')
  @ApiOperation({
    summary:
      'Institutions the search offers (active ones), by name or short form',
  })
  @ApiOkResponse({ type: [InstitutionResponse] })
  institutions(
    @Query() query: InstitutionsQuery,
  ): Promise<InstitutionResponse[]> {
    return this.masterData.institutions(true, query.search);
  }

  @Get('research-areas')
  @ApiOperation({
    summary:
      'The research-area taxonomy (active areas), grouped under headings',
  })
  @ApiOkResponse({ type: [ResearchAreaGroupResponse] })
  researchAreas(): Promise<ResearchAreaGroupResponse[]> {
    return this.masterData.researchAreas(false);
  }
}

/** Super Admin › Master data: every entry, including deactivated / retired ones, and changes. */
@ApiTags('admin')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin/master-data')
export class AdminMasterDataController {
  constructor(private readonly masterData: MasterDataService) {}

  @Get('societies')
  @ApiOperation({ summary: 'Every society, deactivated ones included' })
  @ApiOkResponse({ type: [SocietyResponse] })
  societies(): Promise<SocietyResponse[]> {
    return this.masterData.societies(false);
  }

  @Post('societies')
  @ApiOperation({ summary: 'Add a society' })
  @ApiCreatedResponse({ type: SocietyResponse })
  createSociety(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSocietyDto,
    @Client() client: ClientInfo,
  ): Promise<SocietyResponse> {
    return this.masterData.createSociety(user, dto, client);
  }

  @Patch('societies/:id')
  @ApiOperation({ summary: 'Edit, deactivate or reactivate a society' })
  @ApiOkResponse({ type: SocietyResponse })
  updateSociety(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSocietyDto,
    @Client() client: ClientInfo,
  ): Promise<SocietyResponse> {
    return this.masterData.updateSociety(user, id, dto, client);
  }

  @Get('institutions')
  @ApiOperation({
    summary:
      'Every institution with how many profiles name it, retired ones included',
  })
  @ApiOkResponse({ type: [InstitutionResponse] })
  institutions(
    @Query() query: InstitutionsQuery,
  ): Promise<InstitutionResponse[]> {
    return this.masterData.institutions(false, query.search);
  }

  @Post('institutions')
  @ApiOperation({ summary: 'Add an institution' })
  @ApiCreatedResponse({ type: InstitutionResponse })
  createInstitution(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateInstitutionDto,
    @Client() client: ClientInfo,
  ): Promise<InstitutionResponse> {
    return this.masterData.createInstitution(user, dto, client);
  }

  @Patch('institutions/:id')
  @ApiOperation({ summary: 'Edit, retire or restore an institution' })
  @ApiOkResponse({ type: InstitutionResponse })
  updateInstitution(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInstitutionDto,
    @Client() client: ClientInfo,
  ): Promise<InstitutionResponse> {
    return this.masterData.updateInstitution(user, id, dto, client);
  }

  @Post('institutions/:id/merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Merge a duplicate institution into another (returns the kept one)',
  })
  @ApiOkResponse({ type: InstitutionResponse })
  mergeInstitution(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeInstitutionDto,
    @Client() client: ClientInfo,
  ): Promise<InstitutionResponse> {
    return this.masterData.mergeInstitution(user, id, dto.intoId, client);
  }

  @Get('research-areas')
  @ApiOperation({
    summary:
      'The whole taxonomy with conference counts, retired areas included',
  })
  @ApiOkResponse({ type: [ResearchAreaGroupResponse] })
  researchAreas(): Promise<ResearchAreaGroupResponse[]> {
    return this.masterData.researchAreas(true);
  }

  @Post('research-areas')
  @ApiOperation({
    summary: 'Add a primary area (groupLabel) or a secondary area (parentId)',
  })
  @ApiCreatedResponse({ type: ResearchAreaSaved })
  createResearchArea(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateResearchAreaDto,
    @Client() client: ClientInfo,
  ): Promise<ResearchAreaSaved> {
    return this.masterData.createResearchArea(user, dto, client);
  }

  @Patch('research-areas/:id')
  @ApiOperation({
    summary: 'Rename (conferences follow), retire or restore a research area',
  })
  @ApiOkResponse({ type: ResearchAreaUpdated })
  updateResearchArea(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateResearchAreaDto,
    @Client() client: ClientInfo,
  ): Promise<ResearchAreaUpdated> {
    return this.masterData.updateResearchArea(user, id, dto, client);
  }
}
