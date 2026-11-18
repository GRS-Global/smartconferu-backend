import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One conference on the signed-in user's dashboard, with every role they hold in it. */
export class DashboardConferenceResponse {
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty({ description: 'URL id, e.g. "isbm2026".' }) slug: string;
  @ApiProperty() acronym: string;
  @ApiProperty() title: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status: string;
  @ApiProperty({ nullable: true, type: String })
  logoPath: string | null;
  @ApiProperty({ nullable: true, type: String }) city: string | null;
  @ApiProperty({ nullable: true, type: String }) country: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2026-10-01' })
  startDate: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2026-10-03' })
  endDate: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  reviewDeadline: string | null;
  @ApiProperty({
    isArray: true,
    enum: ['author', 'chair', 'track_chair', 'cfp_manager', 'reviewer'],
    description:
      'Roles held here. Member roles only count while the membership is active; "author" comes from submissions.',
  })
  roles: string[];
}

/** A paper the user wrote or submitted, as its author is allowed to see it. */
export class DashboardAuthorPaperResponse {
  @ApiProperty({ format: 'uuid' }) submissionId: string;
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty() paperNo: number;
  @ApiProperty({ enum: ['draft', 'submitted', 'withdrawn'] }) status: string;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'The decision the author has been told. Null until the chair notifies; never the unsent decision.',
  })
  notifiedOutcome: string | null;
}

/** A paper of a conference the user chairs (the chair's own, un-notified decision included). */
export class DashboardChairPaperResponse {
  @ApiProperty({ format: 'uuid' }) submissionId: string;
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty({ enum: ['draft', 'submitted', 'withdrawn'] }) status: string;
  @ApiProperty({
    description:
      'upload_pending | no_decision | plagiarism_clear | revise | waitlist | accept | registered | reject',
  })
  outcome: string;
}

/** A paper assigned to the user as reviewer. */
export class DashboardReviewAssignmentResponse {
  @ApiProperty({ format: 'uuid' }) assignmentId: string;
  @ApiProperty({ format: 'uuid' }) submissionId: string;
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty() paperNo: number;
  @ApiProperty({ enum: ['assigned', 'accepted', 'declined', 'submitted'] })
  status: string;
  @ApiProperty({ description: 'True once the review itself is submitted.' })
  reviewed: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  dueAt: string | null;
}

/** A committee invitation waiting for (or already answered by) the user. */
export class DashboardInvitationResponse {
  @ApiProperty({ format: 'uuid', description: 'conference_members.id' })
  memberId: string;
  @ApiProperty({ format: 'uuid' }) conferenceId: string;
  @ApiProperty() slug: string;
  @ApiProperty() acronym: string;
  @ApiProperty() title: string;
  @ApiProperty({ nullable: true, type: String }) country: string | null;
  @ApiProperty({ enum: ['chair', 'track_chair', 'cfp_manager', 'reviewer'] })
  role: string;
  @ApiProperty({ enum: ['invited', 'active', 'declined'] }) status: string;
  @ApiProperty({ nullable: true, type: Number }) maxPapers: number | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  invitedAt: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  respondedAt: string | null;
  @ApiProperty({ nullable: true, type: String }) declineReason: string | null;
}

/** Everything the "My Conferences" dashboard is built from, in one call. */
export class DashboardResponse {
  @ApiProperty({ type: [DashboardConferenceResponse] })
  conferences: DashboardConferenceResponse[];
  @ApiProperty({ type: [DashboardAuthorPaperResponse] })
  authorPapers: DashboardAuthorPaperResponse[];
  @ApiProperty({ type: [DashboardChairPaperResponse] })
  chairPapers: DashboardChairPaperResponse[];
  @ApiProperty({ type: [DashboardReviewAssignmentResponse] })
  reviewerAssignments: DashboardReviewAssignmentResponse[];
  @ApiProperty({ type: [DashboardInvitationResponse] })
  invitations: DashboardInvitationResponse[];
}
