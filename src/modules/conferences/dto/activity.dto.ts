import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ActivityQuery {
  @ApiPropertyOptional({ default: 500, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

export class MyActivityQuery extends ActivityQuery {
  @ApiPropertyOptional({
    enum: ['author', 'reviewer'],
    default: 'author',
    description:
      'Whose log: the author log (Submissions) or the reviewer log (Peer Review).',
  })
  @IsOptional()
  @IsIn(['author', 'reviewer'])
  role?: 'author' | 'reviewer';
}

export class ActivityEntryResponse {
  @ApiProperty() id: string;
  @ApiProperty({ format: 'date-time' }) at: string;
  @ApiProperty() actorName: string;
  @ApiProperty({ enum: ['chair', 'author', 'reviewer', 'system'] })
  actorRole: 'chair' | 'author' | 'reviewer' | 'system';
  @ApiProperty({ example: 'Assigned' }) action: string;
  @ApiProperty({ example: 'Peer Review' }) module: string;
  @ApiProperty() description: string;
  @ApiProperty({ enum: ['success', 'failed'] }) status: 'success' | 'failed';
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Who the reviewer was (chairs only; kept out of the description).',
  })
  reviewerName: string | null;
  @ApiProperty({ nullable: true, type: String }) previousValue: string | null;
  @ApiProperty({ nullable: true, type: String }) newValue: string | null;
}
