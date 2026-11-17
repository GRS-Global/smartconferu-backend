import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
/** Trims each entry and drops empty ones and repeats (case-insensitive). */
const cleanList = ({ value }: { value: unknown }) => {
  if (!Array.isArray(value)) return value;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      out.push(item);
      continue;
    }
    const v = item.trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
};
const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : trim({ value });

// Societies ------------------------------------------------------------------------------------

export class SocietyResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({
    example: 'ieee-cs',
    description: "Stable short id; the app's logo files are named after it.",
  })
  key: string;
  @ApiProperty({ example: 'IEEE Computer Society' }) name: string;
  @ApiProperty({ example: 'IEEE CS' }) acronym: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'https://www.computer.org',
  })
  url: string | null;
  @ApiProperty({ enum: ['active', 'inactive'] }) status: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class CreateSocietyDto {
  @ApiProperty({ example: 'Indian Society for Technical Education' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 'ISTE' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  acronym: string;

  @ApiPropertyOptional({ nullable: true, example: 'https://www.isteonline.in' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  url?: string | null;
}

export class UpdateSocietyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  acronym?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  url?: string | null;

  @ApiPropertyOptional({
    enum: ['active', 'inactive'],
    description: 'inactive hides it from new memberships; existing ones stay.',
  })
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

// Institutions ---------------------------------------------------------------------------------

class InstitutionRef {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
}

export class InstitutionResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'iitb' }) key: string;
  @ApiProperty({ example: 'Indian Institute of Technology Bombay' })
  name: string;
  @ApiProperty({ type: [String], example: ['IIT Bombay', 'IITB'] })
  aliases: string[];
  @ApiProperty({ nullable: true, type: String, example: 'India' })
  country: string | null;
  @ApiProperty({ type: [String] }) departments: string[];
  @ApiProperty({ enum: ['active', 'retired'] }) status: string;
  @ApiProperty({ nullable: true, type: InstitutionRef })
  mergedInto: InstitutionRef | null;
  @ApiProperty({
    description: 'Profiles whose affiliation is this name (admin lists only).',
  })
  people: number;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class CreateInstitutionDto {
  @ApiProperty({
    example: 'Indian Institute of Technology Bombay',
    description: 'Full official name, no abbreviations.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  name: string;

  @ApiPropertyOptional({ type: [String], example: ['IIT Bombay', 'IITB'] })
  @IsOptional()
  @Transform(cleanList)
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  aliases?: string[];

  @ApiPropertyOptional({ nullable: true, example: 'India' })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  country?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(cleanList)
  @IsArray()
  @ArrayMaxSize(300)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  departments?: string[];
}

export class UpdateInstitutionDto extends CreateInstitutionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  declare name: string;

  @ApiPropertyOptional({
    enum: ['active', 'retired'],
    description: 'retired hides it from the search; active brings it back.',
  })
  @IsOptional()
  @IsIn(['active', 'retired'])
  status?: 'active' | 'retired';
}

export class MergeInstitutionDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'The institution to keep. This one is retired and its name and short forms become short forms of the kept one.',
  })
  @IsUUID()
  intoId: string;
}

export class InstitutionsQuery {
  @ApiPropertyOptional({
    description: 'Matches the name or a short form.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;
}

// Research areas -------------------------------------------------------------------------------

export class SecondaryAreaResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Machine Learning & Deep Learning' }) name: string;
  @ApiProperty({ enum: ['active', 'retired'] }) status: string;
  @ApiProperty({ description: 'Conferences using this pair (admin only).' })
  conferences: number;
}

export class PrimaryAreaResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Computer Science & AI' }) name: string;
  @ApiProperty({ enum: ['active', 'retired'] }) status: string;
  @ApiProperty({ description: 'Conferences in this area (admin only).' })
  conferences: number;
  @ApiProperty({ type: [SecondaryAreaResponse] })
  subareas: SecondaryAreaResponse[];
}

export class ResearchAreaGroupResponse {
  @ApiProperty({ example: 'Computing & Engineering' }) label: string;
  @ApiProperty({ type: [PrimaryAreaResponse] }) areas: PrimaryAreaResponse[];
}

export class CreateResearchAreaDto {
  @ApiProperty({ example: 'Robotics & Autonomous Systems' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The primary area to add a secondary area under.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({
    example: 'Computing & Engineering',
    description:
      'For a new primary area (no parentId): the heading it sits under.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  groupLabel?: string;
}

export class UpdateResearchAreaDto {
  @ApiPropertyOptional({
    description: 'A new name; conferences using it are renamed too.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({
    enum: ['active', 'retired'],
    description:
      'retired hides it from new conferences; existing ones keep it.',
  })
  @IsOptional()
  @IsIn(['active', 'retired'])
  status?: 'active' | 'retired';
}
