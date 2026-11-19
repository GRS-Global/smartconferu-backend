import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export const LICENSE_STATUSES = [
  'pending',
  'approved',
  'declined',
  'withdrawn',
] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export class RequestLicenseDto {
  @ApiProperty({
    example: '2027-12-31',
    description: 'The date the chair needs the license until (YYYY-MM-DD).',
  })
  @IsDateString({ strict: true }, { message: 'Pick the date you need.' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Pick the date you need.' })
  requestedDate: string;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  reason?: string | null;
}

export class DecideLicenseDto {
  @ApiProperty({ description: 'true approves, false declines.' })
  @IsBoolean()
  approve: boolean;

  @ApiPropertyOptional({
    example: '2027-12-31',
    description:
      'When approving: the date the license now runs until (default: the date asked for).',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  newExpiry?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    nullable: true,
    type: String,
    description: 'Shown to the chair (e.g. why it was declined).',
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  reason?: string | null;
}

export class LicenseStatusQuery {
  @ApiPropertyOptional({ enum: LICENSE_STATUSES, default: 'pending' })
  @IsOptional()
  @IsIn(LICENSE_STATUSES)
  status?: LicenseStatus;
}

export class LicenseRequestResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: '2027-12-31' }) requestedDate: string;
  @ApiProperty({ nullable: true, type: String }) reason: string | null;
  @ApiProperty({ enum: LICENSE_STATUSES }) status: LicenseStatus;
  @ApiProperty({ nullable: true, type: String }) decisionReason: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2027-12-31' })
  newExpiry: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AdminLicenseRequestResponse extends LicenseRequestResponse {
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty() conferenceSlug: string;
  @ApiProperty() conferenceAcronym: string;
  @ApiProperty() conferenceTitle: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '2027-01-15',
    description: 'The license date now (set by a Super Admin, else null).',
  })
  currentExpiry: string | null;
  @ApiProperty() requestedByName: string;
  @ApiProperty({ nullable: true, type: String }) requestedByEmail:
    string | null;
}
