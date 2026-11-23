import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RequestVerificationDto {
  @ApiPropertyOptional({
    description: 'Why the Super Admin should verify this profile (optional)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class RejectVerificationDto {
  @ApiProperty({ description: 'Shown to the member and emailed to them' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class VerificationsQuery {
  @IsOptional()
  @IsIn(['pending', 'resolved'])
  status?: 'pending' | 'resolved';
}

export class MyVerificationResponse {
  @ApiProperty({ enum: ['none', 'pending', 'verified', 'rejected'] })
  status!: 'none' | 'pending' | 'verified' | 'rejected';
  @ApiProperty({ type: String, nullable: true }) requestedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) resolvedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it was rejected',
  })
  reason!: string | null;
}

export class VerificationPerson {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty({ type: String, nullable: true }) designation!: string | null;
  @ApiProperty({ type: String, nullable: true }) affiliation!: string | null;
  @ApiProperty({ type: String, nullable: true }) country!: string | null;
  @ApiProperty({ type: String, nullable: true }) orcidId!: string | null;
  @ApiProperty({ type: String, nullable: true }) institutionalEmail!:
    string | null;
  @ApiProperty() institutionalEmailVerified!: boolean;
  @ApiProperty({ type: String, nullable: true }) webPage!: string | null;
}

export class VerificationResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'withdrawn'] })
  status!: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) resolvedAt!: string | null;
  @ApiProperty({ type: VerificationPerson }) person!: VerificationPerson;
}
