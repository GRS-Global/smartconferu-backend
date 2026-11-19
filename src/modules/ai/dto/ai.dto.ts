import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PaperMetadataDto {
  @ApiProperty({
    description:
      'The text of the first pages of the paper (read in the browser).',
    maxLength: 60000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(60000)
  text: string;
}

class ScreeningRulesDto {
  @ApiPropertyOptional({ enum: ['single', 'double'] })
  @IsOptional()
  @IsIn(['single', 'double'])
  column?: string;

  @ApiPropertyOptional({ enum: ['high', 'low'] })
  @IsOptional()
  @IsIn(['high', 'low'])
  columnConfidence?: string;
}

export class ScreeningAiDto {
  @ApiProperty({ description: 'Page count of the PDF.' })
  @IsInt()
  @Min(0)
  @Max(10000)
  pages: number;

  @ApiProperty({
    description: 'Per-page layout digest made by the app.',
    maxLength: 20000,
  })
  @IsString()
  @MaxLength(20000)
  layout: string;

  @ApiProperty({
    description: 'Text sample of the first pages.',
    maxLength: 40000,
  })
  @IsString()
  @MaxLength(40000)
  text: string;

  @ApiPropertyOptional({
    type: ScreeningRulesDto,
    description: "The app's rule-based guess.",
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ScreeningRulesDto)
  rules?: ScreeningRulesDto;
}

export class TopicsDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional({ maxLength: 20000 })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  about?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  primaryArea?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secondaryArea?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Topics already chosen.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  existing?: string[];

  @ApiPropertyOptional({ minimum: 1, maximum: 8, default: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  count?: number;
}

class RatingDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  label: string;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsNumber()
  value?: number | null;
}

export class ReviewEnhanceDto {
  @ApiProperty({ description: "The reviewer's draft.", maxLength: 12000 })
  @IsString()
  @MaxLength(12000, {
    message:
      'The review is too long to enhance in one go (the limit is 12,000 characters).',
  })
  review: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The paper, for its digest as context (reviewers and chairs of it).',
  })
  @IsOptional()
  @IsUUID()
  submissionId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional({
    maxLength: 20000,
    description: 'Context when there is no digest.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  abstract?: string;

  @ApiPropertyOptional({ type: [RatingDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RatingDto)
  ratings?: RatingDto[];
}

export class ConferenceWebsiteDto {
  @ApiProperty({ example: 'icai2027.org', maxLength: 2000 })
  @IsString()
  @MinLength(1, { message: 'Enter the conference website first.' })
  @MaxLength(2000)
  url: string;
}

export class IngestDto {
  @ApiPropertyOptional({
    description: 'Prepare it again even if the latest version is done.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class ChatTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @ApiProperty({ maxLength: 20000 })
  @IsString()
  @MaxLength(20000)
  content: string;
}

export class PaperChatDto {
  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MinLength(1, { message: 'Type a question first.' })
  @MaxLength(1000)
  question: string;

  @ApiPropertyOptional({
    type: [ChatTurnDto],
    description: 'Earlier turns (the last 6 are used).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  history?: ChatTurnDto[];
}

export class PaperSummaryResponse {
  @ApiProperty({
    enum: ['ready', 'none'],
    description: "'none' until the summary has been written.",
  })
  status: 'ready' | 'none';
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "A neutral summary of the paper (150-300 words), without the authors' names.",
  })
  summary: string | null;
  @ApiProperty({
    type: [String],
    description: 'Main claims, as the authors state them.',
  })
  claims: string[];
  @ApiProperty({ type: [String] }) methods: string[];
  @ApiProperty({ type: [String] }) datasets: string[];
  @ApiProperty({
    type: [String],
    description: 'Limitations the authors state themselves.',
  })
  limitations: string[];
  @ApiProperty({ nullable: true, type: String }) model: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  updatedAt: string | null;
  @ApiProperty({
    description: "The summary is for the paper's latest uploaded version.",
  })
  upToDate: boolean;
}
