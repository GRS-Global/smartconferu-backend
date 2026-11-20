import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export const QUEUE_KEYS = [
  'requests',
  'deletions',
  'licenses',
  'cfps',
] as const;
export type QueueKey = (typeof QUEUE_KEYS)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class QueueParams {
  @ApiProperty({ enum: QUEUE_KEYS })
  @IsIn(QUEUE_KEYS)
  queue: QueueKey;
}

export class QueueItemParams extends QueueParams {
  @ApiProperty({
    description: 'The item id in that queue (a conference or request id).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  itemId: string;
}

export class NoteDto {
  @ApiProperty({ maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;
}

class Who {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
}

export class AdminNoteResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() itemId: string;
  @ApiProperty({
    enum: ['note', 'message'],
    description:
      'note: only admins see it. message: sent to the person who asked.',
  })
  kind: 'note' | 'message';
  @ApiProperty() text: string;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ type: Who, nullable: true }) author: Who | null;
}

export class AdminClaimResponse {
  @ApiProperty() itemId: string;
  @ApiProperty({ type: Who }) admin: Who;
  @ApiProperty({ format: 'date-time' }) claimedAt: string;
}

export class QueueStateResponse {
  @ApiProperty({ type: [AdminClaimResponse] }) claims: AdminClaimResponse[];
  @ApiProperty({ type: [AdminNoteResponse] }) notes: AdminNoteResponse[];
}
