import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  ScreeningCriteria,
  ScreeningSettings,
} from '../screening/screening-rules.js';

class ScreeningSettingsDto implements Partial<ScreeningSettings> {
  @ApiPropertyOptional({ description: 'Run the Initial Check step.' })
  @IsOptional()
  @IsBoolean()
  initialCheck?: boolean;

  @ApiPropertyOptional({ description: 'Run the Plagiarism Check step.' })
  @IsOptional()
  @IsBoolean()
  plagiarism?: boolean;

  @ApiPropertyOptional({
    description:
      'AI mode: each new version is read automatically and its initial check decided. Off = the chair checks every paper by hand.',
  })
  @IsOptional()
  @IsBoolean()
  autoInitialCheck?: boolean;

  @ApiPropertyOptional({
    enum: ['send_back', 'leave'],
    description:
      'A paper that fails the automatic check: send_back = Revision + the author is emailed; leave = left for the chair.',
  })
  @IsOptional()
  @IsIn(['send_back', 'leave'])
  autoInitialFail?: 'send_back' | 'leave';
}

const Pages = () => (target: object, key: string) => {
  IsOptional()(target, key);
  IsInt()(target, key);
  Min(1)(target, key);
  Max(500)(target, key);
};
const Percent = () => (target: object, key: string) => {
  IsOptional()(target, key);
  IsInt()(target, key);
  Min(0)(target, key);
  Max(100)(target, key);
};
const Days = () => (target: object, key: string) => {
  IsOptional()(target, key);
  IsInt()(target, key);
  Min(1)(target, key);
  Max(90)(target, key);
};

class ScreeningCriteriaDto implements Partial<ScreeningCriteria> {
  @ApiPropertyOptional({ enum: ['single', 'double', 'either'] })
  @IsOptional()
  @IsIn(['single', 'double', 'either'])
  column?: 'single' | 'double' | 'either';

  @ApiPropertyOptional({ description: 'Single column, at least.' })
  @Pages()
  minPages?: number;
  @ApiPropertyOptional({ description: 'Single column, at most.' })
  @Pages()
  maxPages?: number;
  @ApiPropertyOptional({ description: 'Double column, at least.' })
  @Pages()
  doubleMinPages?: number;
  @ApiPropertyOptional({ description: 'Double column, at most.' })
  @Pages()
  doubleMaxPages?: number;

  @ApiPropertyOptional({ description: 'Similarity limit, %.' })
  @Percent()
  similarityLimit?: number;
  @ApiPropertyOptional({ description: 'AI-writing limit, %.' })
  @Percent()
  aiLimit?: number;

  @ApiPropertyOptional({ description: 'Days to send a corrected version.' })
  @Days()
  correctionDays?: number;
  @ApiPropertyOptional({ description: 'Days to send a revised version.' })
  @Days()
  revisionDays?: number;
}

export class UpdateScreeningSettingsDto {
  @ApiPropertyOptional({ type: ScreeningSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ScreeningSettingsDto)
  settings?: ScreeningSettingsDto;

  @ApiPropertyOptional({ type: ScreeningCriteriaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ScreeningCriteriaDto)
  criteria?: ScreeningCriteriaDto;
}

export class ScreeningSettingsResponse {
  @ApiProperty({ type: ScreeningSettingsDto }) settings: ScreeningSettings;
  @ApiProperty({ type: ScreeningCriteriaDto }) criteria: ScreeningCriteria;
  @ApiProperty({
    description:
      "AI mode is part of the conference's plan (free for every conference for now).",
  })
  aiModeAvailable: boolean;
}

export class PaperFileUploadResponse {
  @ApiProperty() fileId: string;
  @ApiProperty() kind: string;
  @ApiProperty() version: number;
  @ApiProperty() fileName: string;
  @ApiProperty() sizeBytes: number;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      "The app's automatic check as stored; with AI mode on, `decision` says what was done (passed, sent_back, left_for_chair, already_decided).",
  })
  autoCheck: Record<string, unknown> | null;
}

export class AutoCheckDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      "The app's automatic check of the version (src/chair-plagiarism/autoCheck.js): { status: 'done' | 'failed', pages, editable, english, column, confidence: { column, english }, source, missing, aiNote, aiError, error, at, ms }.",
    example: {
      status: 'done',
      pages: 12,
      editable: true,
      english: true,
      column: 'single',
      confidence: { column: 'high', english: 'high' },
      source: { column: 'rules', english: 'rules' },
      missing: [],
      at: '2026-11-13T10:00:00.000Z',
    },
  })
  @IsDefined({ message: 'autoCheck is required.' })
  autoCheck: unknown;
}
