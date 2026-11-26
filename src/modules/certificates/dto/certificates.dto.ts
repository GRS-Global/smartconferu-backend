import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const CERT_TYPE_KEYS = [
  'presentation',
  'participation',
  'appreciation',
  'publication',
  'author',
] as const;
export type CertTypeKey = (typeof CERT_TYPE_KEYS)[number];

export class CreateDesignDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({ enum: CERT_TYPE_KEYS })
  @IsIn(CERT_TYPE_KEYS)
  typeKey: CertTypeKey;

  @ApiProperty({
    description:
      "The designer's JSON document (artwork, wording and the studio elements). Up to 2 MB; images belong in file storage, not in here.",
  })
  @IsObject()
  design: Record<string, unknown>;
}

export class UpdateDesignDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  design?: Record<string, unknown>;
}

export class CreateDistributionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  designId: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({
    description:
      'Audience rule: { sourceKey, conditions[], excludeAlreadyIssued, timing }.',
  })
  @IsObject()
  audience: Record<string, unknown>;

  @ApiProperty({
    description:
      'Covering email: { subject, body, attachPdf, saveToAccount, bccConference }.',
  })
  @IsObject()
  email: Record<string, unknown>;
}

export class UpdateDistributionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  audience?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  email?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'People added by hand.', type: [Object] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  manual?: Array<Record<string, unknown>>;

  @ApiPropertyOptional({
    description: 'Fixes typed into the recipient table, by recipient key.',
  })
  @IsOptional()
  @IsObject()
  overrides?: Record<string, unknown>;
}

export class RecipientDto {
  @ApiProperty({ maxLength: 300 })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name: string;

  @ApiPropertyOptional({ maxLength: 320 })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  affiliation?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  roleLabel?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  paperId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  paperTitle?: string;
}

export class IssueDto {
  @ApiProperty({ type: [RecipientDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => RecipientDto)
  recipients: RecipientDto[];
}

export class CertificateEventDto {
  @ApiProperty({ enum: ['opened', 'downloaded'] })
  @IsIn(['opened', 'downloaded'])
  kind: 'opened' | 'downloaded';
}

export class UpdateSignatureDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  designation?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  institution?: string;

  @ApiPropertyOptional({
    description:
      "Make this the conference's default signature (the previous default is cleared).",
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** Multipart text fields sent with the image. */
export class CreateSignatureDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  designation?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  institution?: string;
}

export class SignatureResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() designation: string;
  @ApiProperty() institution: string;
  @ApiProperty({ example: 'image/png' }) contentType: string;
  @ApiProperty() sizeBytes: number;
  @ApiProperty() isDefault: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string;
}

export class UpdateAssetDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;
}

/** Multipart text field sent with the picture (the file name is used when it is absent). */
export class CreateAssetDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class AssetResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 'image/png' }) contentType: string;
  @ApiProperty() sizeBytes: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string;
}

export class RevokeCertificateDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Why it is withdrawn (kept for the chairs, not shown publicly).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** The fields to correct; the ones left out keep their value. */
export class ReissueCertificateDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  name?: string;

  @ApiPropertyOptional({ maxLength: 320 })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  affiliation?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  roleLabel?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  paperId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  paperTitle?: string;
}
