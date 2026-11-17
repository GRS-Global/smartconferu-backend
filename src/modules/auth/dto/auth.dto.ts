import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../../../core/auth/password.service.js';
import {
  IsJsonObjectOfSize,
  PROFILE_DETAILS_MAX_BYTES,
  TERMS_VERSION_PATTERN,
} from '../../../core/validation/validators.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class EmailDto {
  @ApiProperty({ example: 'ada@example.org' })
  @Transform(trim)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email: string;
}

export class SignInDto extends EmailDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class RegisterDto extends SignInDto {
  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  lastName: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(150)
  designation?: string | null;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  affiliation?: string | null;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  country?: string | null;

  @ApiProperty({
    example: '2026-10-01',
    description:
      'The Terms of Service version the user ticked "I agree" to. The API records it with the time.',
  })
  @IsString()
  @Matches(TERMS_VERSION_PATTERN, {
    message: 'termsVersion must be a short version name, e.g. 2026-10-01',
  })
  termsVersion: string;

  @ApiPropertyOptional({
    description:
      'Private profile details from the form (gender, phone, notification channels, website, affiliations…).',
    type: 'object',
    additionalProperties: true,
    example: {
      gender: 'Female',
      phone: '+44 7700 900123',
      notifyChannels: ['whatsapp'],
      webPage: 'https://example.org',
    },
  })
  @IsOptional()
  @IsJsonObjectOfSize(PROFILE_DETAILS_MAX_BYTES)
  details?: Record<string, unknown>;
}

export class TokenDto {
  @ApiProperty({ description: 'The token from the emailed link.' })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;
}

export class ResetPasswordDto extends TokenDto {
  @ApiProperty()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class SignInWithCodeDto extends EmailDto {
  @ApiProperty({ example: '042917' })
  @Transform(trim)
  @Matches(/^\d{6}$/, { message: 'The code has 6 digits.' })
  code: string;
}

export class ChangePasswordDto {
  @ApiPropertyOptional({
    description:
      'Required unless the account has no password yet (created through Google, Microsoft or ORCID).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword: string;
}

export class AccountSummaryResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ nullable: true, type: String })
  email: string | null;

  @ApiProperty()
  emailVerified: boolean;

  @ApiProperty()
  isSuperAdmin: boolean;
}

export class SessionResponse {
  @ApiProperty({
    description:
      'Send as `Authorization: Bearer <token>`. The refresh token is set as an httpOnly cookie.',
  })
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({ description: 'Seconds until the access token expires.' })
  expiresIn: number;

  @ApiProperty({ type: AccountSummaryResponse })
  user: AccountSummaryResponse;
}

export class MessageResponse {
  @ApiProperty()
  message: string;
}

export class MfaRequiredResponse {
  @ApiProperty({ example: true })
  mfaRequired: true;

  @ApiProperty({
    enum: ['totp', 'email'],
    description:
      'totp: a code from the authenticator app (or a recovery code). email: a code we just emailed (a super admin without an authenticator app).',
  })
  factor: 'totp' | 'email';

  @ApiProperty()
  message: string;
}

export class MfaCodeDto {
  @ApiProperty({
    example: '123456',
    description:
      'A 6-digit code from the authenticator app, or a recovery code (xxxx-xxxx).',
  })
  @Transform(trim)
  @IsString()
  @Matches(/^(\d{6}|[a-zA-Z0-9]{4}-?[a-zA-Z0-9]{4})$/, {
    message: 'Enter the 6-digit code from your app, or a recovery code.',
  })
  code: string;
}

export class ChangeEmailDto {
  @ApiProperty({ example: 'ada@new-university.edu' })
  @Transform(trim)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  newEmail: string;

  @ApiPropertyOptional({
    description: 'Required when the account has a password.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword?: string;
}
