import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ProfileRequestPerson {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
}

export class ProfileRequestResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['institution', 'society', 'research_area'] }) kind!:
    'institution' | 'society' | 'research_area';
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Secondary research areas: the primary area it was typed under',
  })
  parentName!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] }) status!:
    'pending' | 'approved' | 'rejected';
  @ApiProperty({ type: String, nullable: true }) resolvedName!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) resolvedAt!: string | null;
  @ApiProperty({ type: [ProfileRequestPerson] })
  requesters!: ProfileRequestPerson[];
}

export class ProfileRequestsQuery {
  @IsOptional()
  @IsIn(['institution', 'society', 'research_area'])
  kind?: 'institution' | 'society' | 'research_area';

  @IsOptional()
  @IsIn(['pending', 'resolved'])
  status?: 'pending' | 'resolved';
}

export class ApproveProfileRequestDto {
  @ApiPropertyOptional({
    description: 'The official name to list (defaults to what was typed)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    description: 'Societies: the official acronym (required)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  acronym?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  url?: string;

  @ApiPropertyOptional({
    description: 'New primary research area: the heading it sits under',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  group?: string;

  @ApiPropertyOptional({
    description:
      'New secondary research area: the primary area (defaults to the one it was typed under)',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ description: 'Institutions: the country' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiPropertyOptional({
    description: 'Link to an entry already on the list instead of adding one',
  })
  @IsOptional()
  @IsUUID()
  intoId?: string;
}

export class RejectProfileRequestDto {
  @ApiProperty({ description: 'Shown to the member' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
