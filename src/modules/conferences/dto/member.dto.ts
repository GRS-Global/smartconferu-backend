import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  memberRole,
  memberStatus,
} from '../../../core/database/schema/index.js';
import type { MemberRole } from '../../../core/rbac/conf-roles.decorator.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;
const trimEach = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v.trim() : v))
    : value;

export type MemberStatus = (typeof memberStatus.enumValues)[number];

class MemberFieldsDto {
  @ApiPropertyOptional({
    maxLength: 200,
    nullable: true,
    type: String,
    description: 'Shown until the person has an account with a name.',
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  displayName?: string | null;

  @ApiPropertyOptional({ type: [String], example: ['machine learning'] })
  @IsOptional()
  @Transform(trimEach)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  expertise?: string[];

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Most papers to give this reviewer; null for no limit.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxPapers?: number | null;
}

export class InviteMemberDto extends MemberFieldsDto {
  @ApiProperty({ example: 'reviewer@university.edu' })
  @Transform(trim)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email: string;

  @ApiPropertyOptional({
    enum: memberRole.enumValues,
    default: 'reviewer',
  })
  @IsOptional()
  @IsIn(memberRole.enumValues)
  role?: MemberRole;
}

export class UpdateMemberDto extends MemberFieldsDto {}

export class MemberQuery {
  @ApiPropertyOptional({ enum: memberRole.enumValues })
  @IsOptional()
  @IsIn(memberRole.enumValues)
  role?: MemberRole;
}

export class DeclineDto {
  @ApiPropertyOptional({ maxLength: 2000, nullable: true, type: String })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  reason?: string | null;
}

export class MemberResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty({ enum: memberRole.enumValues }) role: MemberRole;
  @ApiProperty({ enum: memberStatus.enumValues }) status: MemberStatus;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'Null until the invited person has an account.',
  })
  userId: string | null;
  @ApiProperty({ description: 'Their name, or the invited name / email.' })
  name: string;
  @ApiProperty({ nullable: true, type: String }) email: string | null;
  @ApiProperty({ nullable: true, type: String }) affiliation: string | null;
  @ApiProperty({ nullable: true, type: String }) photoPath: string | null;
  @ApiProperty({ type: [String] }) expertise: string[];
  @ApiProperty({ nullable: true, type: Number }) maxPapers: number | null;
  @ApiProperty({ format: 'date-time' }) invitedAt: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  respondedAt: string | null;
  @ApiProperty({ nullable: true, type: String }) declineReason: string | null;
}

/** A committee invitation, as the invited person sees it. */
export class InvitationResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: memberRole.enumValues }) role: MemberRole;
  @ApiProperty({ enum: memberStatus.enumValues }) status: MemberStatus;
  @ApiProperty({ type: 'object', additionalProperties: true })
  conference: {
    id: string;
    slug: string;
    acronym: string;
    title: string;
    country: string | null;
    startDate: string | null;
    endDate: string | null;
  };
  @ApiProperty({ nullable: true, type: Number }) maxPapers: number | null;
  @ApiProperty({ format: 'date-time' }) invitedAt: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  respondedAt: string | null;
  @ApiProperty({ nullable: true, type: String }) declineReason: string | null;
}
