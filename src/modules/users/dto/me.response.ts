import { ApiProperty } from '@nestjs/swagger';

export class MeResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ nullable: true, type: String })
  email: string | null;

  @ApiProperty()
  emailVerified: boolean;

  @ApiProperty({
    description:
      'False for an account created through Google, Microsoft or ORCID that has no password yet (it can set one without a current password).',
  })
  hasPassword: boolean;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty({ nullable: true, type: String })
  designation: string | null;

  @ApiProperty({ nullable: true, type: String })
  affiliation: string | null;

  @ApiProperty({ nullable: true, type: String })
  country: string | null;

  @ApiProperty({ nullable: true, type: String })
  orcidId: string | null;

  @ApiProperty({ nullable: true, type: String })
  photoPath: string | null;

  @ApiProperty()
  isSuperAdmin: boolean;

  @ApiProperty({
    description: 'When the user accepted the Terms of Service.',
    format: 'date-time',
    nullable: true,
    type: String,
  })
  termsAcceptedAt: string | null;

  @ApiProperty({
    description:
      'The Terms version accepted. Null (e.g. a first provider sign-in made without it): ask the user to accept.',
    nullable: true,
    type: String,
  })
  termsVersion: string | null;

  @ApiProperty({
    description: 'Private profile data, visible only to its owner.',
    type: 'object',
    additionalProperties: true,
  })
  details: Record<string, unknown>;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

export class MyConferenceResponse {
  @ApiProperty({ format: 'uuid' })
  conferenceId: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  acronym: string;

  @ApiProperty()
  title: string;

  @ApiProperty({
    enum: ['pending_approval', 'active', 'rejected', 'archived', 'deleted'],
  })
  conferenceStatus: string;

  @ApiProperty({ enum: ['chair', 'track_chair', 'cfp_manager', 'reviewer'] })
  role: string;

  @ApiProperty({ enum: ['invited', 'active', 'declined', 'removed'] })
  memberStatus: string;
}
