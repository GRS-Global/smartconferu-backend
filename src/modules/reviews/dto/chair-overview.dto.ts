import { ApiProperty } from '@nestjs/swagger';
import { ScreeningSettingsResponse } from '../../submissions/dto/screening.dto.js';
import { SubmissionResponse } from '../../submissions/dto/submission.dto.js';
import { DecisionTypeResponse } from './review.dto.js';

/** A paper as its chair sees it, with how far its review has got. */
export class ChairOverviewPaperResponse extends SubmissionResponse {
  @ApiProperty({
    description:
      'Reviewers on the paper (not declined or removed), including those who have not joined the committee yet.',
  })
  reviewersAssigned: number;

  @ApiProperty({ description: 'Reviews sent.' })
  reviewsReceived: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: "Average of the sent reviews' scores, or null.",
  })
  averageScore: number | null;
}

/** Everything the chair's conference pages are built from, in one call. */
export class ChairOverviewResponse {
  @ApiProperty({ format: 'uuid' }) conferenceId: string;

  @ApiProperty({
    enum: ['draft', 'published', 'closed'],
    description: "The Call for Papers' state ('draft' when it has none).",
  })
  cfpStatus: string;

  @ApiProperty({ type: [ChairOverviewPaperResponse] })
  papers: ChairOverviewPaperResponse[];

  @ApiProperty({ type: [DecisionTypeResponse] })
  decisionTypes: DecisionTypeResponse[];

  @ApiProperty({
    type: ScreeningSettingsResponse,
    description: 'Screening steps, criteria and AI mode.',
  })
  screening: ScreeningSettingsResponse;
}
