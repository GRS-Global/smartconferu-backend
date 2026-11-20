import { ApiProperty } from '@nestjs/swagger';

export class TourStateResponse {
  @ApiProperty({
    description:
      'true once this person has been shown the tour of this conference (on any device).',
  })
  seen: boolean;
}
