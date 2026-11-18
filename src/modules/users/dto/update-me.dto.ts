import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  IsJsonObjectOfSize,
  PROFILE_DETAILS_MAX_BYTES,
  TERMS_VERSION_PATTERN,
} from '../../../core/validation/validators.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
/** Blank optional text is stored as null, as the app does today. */
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

/** Fields the signed-in user may change on their own profile. Omitted fields are left as they are. */
export class UpdateMeDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ maxLength: 150, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(150)
  designation?: string | null;

  @ApiPropertyOptional({ maxLength: 200, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  affiliation?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  country?: string | null;

  @ApiPropertyOptional({
    example: '0000-0002-1825-0097',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @Transform(trimToNull)
  @Matches(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/, {
    message: 'Enter your ORCID iD like 0000-0002-1825-0097.',
  })
  orcidId?: string | null;

  @ApiPropertyOptional({
    description:
      "Path of an uploaded photo in the `public` bucket; must be inside the user's own folder (`<userId>/…`). Null removes the photo.",
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  photoPath?: string | null;

  @ApiPropertyOptional({
    description:
      'Private profile data (owner-only). Replaces the stored object as a whole.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsJsonObjectOfSize(PROFILE_DETAILS_MAX_BYTES)
  details?: Record<string, unknown>;
}

export class AcceptTermsDto {
  @ApiProperty({ example: '2026-10-01' })
  @IsString()
  @Matches(TERMS_VERSION_PATTERN, {
    message: 'version must be a short version name, e.g. 2026-10-01',
  })
  version: string;
}
