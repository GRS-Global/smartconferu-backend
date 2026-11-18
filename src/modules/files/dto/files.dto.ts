import { ApiProperty } from '@nestjs/swagger';

/** What an uploaded file is for. It decides who may upload it, what it may be and where it is kept. */
export const FILE_PURPOSES = [
  'profile_photo',
  'conference_logo',
  'review_instructions_pdf',
  'screening_report',
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export class UploadedFileResponse {
  @ApiProperty({
    description:
      'Storage path. Keep it (e.g. PATCH /me { photoPath }) and read the file back with GET /files?path=.',
    example: '3f0c…/photo-9a1b….png',
  })
  path: string;

  @ApiProperty() fileName: string;
  @ApiProperty() contentType: string;
  @ApiProperty() sizeBytes: number;
}
