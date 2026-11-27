import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import {
  cfps,
  conferences,
  submissions,
} from '../../core/database/schema/index.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import * as rules from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import { FileStorage } from '../../core/storage/file-storage.js';
import { storagePaths } from '../../core/storage/storage-paths.js';
import { CFP_LOCKED_MESSAGE } from '../conferences/cfp-lock.js';
import { reportSharedWithAuthors } from '../submissions/submission-emails.service.js';
import type { FilePurpose, UploadedFileResponse } from './dto/files.dto.js';

export interface UploadedFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** The kinds of file accepted, told apart by their first bytes (not only their name). */
const KINDS = {
  png: {
    ext: 'png',
    mime: 'image/png',
    is: (b: Buffer) =>
      b
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  jpg: {
    ext: 'jpg',
    mime: 'image/jpeg',
    is: (b: Buffer) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  },
  webp: {
    ext: 'webp',
    mime: 'image/webp',
    is: (b: Buffer) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  pdf: {
    ext: 'pdf',
    mime: 'application/pdf',
    is: (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
} as const;
type Kind = keyof typeof KINDS;

const IMAGES: Kind[] = ['png', 'jpg', 'webp'];
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.values(KINDS).map((k) => [k.ext, k.mime]),
);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Every storage path this module hands out; anything else is refused. */
const PATH = new RegExp(
  `^(?:users/(?<user>${UUID})/photo-${UUID}\\.(?:png|jpg|webp)|conferences/(?<conference>${UUID})/(?:branding/(?<logo>logo-${UUID}\\.(?:png|jpg|webp))|documents/(?<instructions>review-instructions-${UUID}\\.pdf)|papers/(?<paper>${UUID})/plagiarism/(?<screening>report-${UUID}\\.pdf)))$`,
);

export type PathKind = 'photo' | 'logo' | 'instructions' | 'screening';

/** Uploads that are not tied to a paper: profile photo, conference logo, review instructions PDF, screening report. */
@Injectable()
export class FilesService {
  private readonly maxBytes: number;

  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly storage: FileStorage,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = config.get('MAX_UPLOAD_MB', { infer: true }) * 1024 * 1024;
  }

  async upload(
    user: AuthUser,
    purpose: FilePurpose,
    conferenceId: string | undefined,
    file: UploadedFile | undefined,
    client?: ClientInfo,
    submissionId?: string,
  ): Promise<UploadedFileResponse> {
    if (!file?.buffer?.length) {
      throw AppException.validation('Choose a file to upload.', [
        { field: 'file', errors: ['file is required'] },
      ]);
    }

    let allowed: Kind[];
    let limit: number;
    let key: string;
    switch (purpose) {
      case 'profile_photo':
        allowed = IMAGES;
        limit = IMAGE_MAX_BYTES;
        break;
      case 'conference_logo':
        allowed = IMAGES;
        limit = IMAGE_MAX_BYTES;
        break;
      case 'review_instructions_pdf':
      case 'screening_report':
        allowed = ['pdf'];
        limit = this.maxBytes;
        break;
    }

    if (purpose !== 'profile_photo') {
      if (!conferenceId) {
        throw AppException.validation('This upload needs a conference.', [
          { field: 'conferenceId', errors: ['conferenceId is required'] },
        ]);
      }
      const access = await this.access.requireConference(user, conferenceId);
      if (!rules.canManageConference(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can upload this.',
        );
      }
      // The logo is on the Call for Papers: it stays as sent while the Super Admin reviews it.
      if (purpose === 'conference_logo') {
        const [cfp] = await this.database.db
          .select({ status: cfps.status })
          .from(cfps)
          .where(eq(cfps.conferenceId, conferenceId));
        if (cfp?.status === 'in_review') {
          throw AppException.businessRule(CFP_LOCKED_MESSAGE);
        }
      }
    }
    // A plagiarism report is kept with its paper.
    if (purpose === 'screening_report') {
      const [paper] = submissionId
        ? await this.database.db
            .select({ id: submissions.id })
            .from(submissions)
            .where(
              and(
                eq(submissions.id, submissionId),
                eq(submissions.conferenceId, conferenceId!),
              ),
            )
        : [];
      if (!paper) {
        throw AppException.validation('This report needs its paper.', [
          {
            field: 'submissionId',
            errors: ['must be a paper of this conference'],
          },
        ]);
      }
    }

    if (file.size > limit) {
      throw AppException.validation(
        `That file is too large (limit ${Math.round(limit / 1024 / 1024)} MB).`,
        [{ field: 'file', errors: ['file too large'] }],
      );
    }
    const kind = allowed.find((k) => KINDS[k].is(file.buffer));
    if (!kind) {
      throw AppException.validation(
        allowed.includes('pdf')
          ? 'Upload a PDF file.'
          : 'Upload a PNG, JPEG or WebP image.',
        [{ field: 'file', errors: ['unsupported file type'] }],
      );
    }

    const id = randomUUID();
    const ext = KINDS[kind].ext;
    switch (purpose) {
      case 'profile_photo':
        key = storagePaths.profilePhoto(user.id, id, ext);
        break;
      case 'conference_logo':
        key = storagePaths.conferenceLogo(conferenceId!, id, ext);
        break;
      case 'review_instructions_pdf':
        key = storagePaths.reviewInstructions(conferenceId!, id);
        break;
      case 'screening_report':
        key = storagePaths.plagiarismReport(conferenceId!, submissionId!, id);
        break;
    }
    await this.storage.put(key, file.buffer, KINDS[kind].mime);

    // A logo belongs to the conference as soon as it is uploaded; the old file goes away.
    if (purpose === 'conference_logo') {
      const db = this.database.db;
      const [before] = await db
        .select({ logoPath: conferences.logoPath })
        .from(conferences)
        .where(eq(conferences.id, conferenceId!));
      await db
        .update(conferences)
        .set({ logoPath: key })
        .where(eq(conferences.id, conferenceId!));
      if (before?.logoPath && PATH.test(before.logoPath)) {
        await this.storage.delete(before.logoPath);
      }
    }

    await this.audit.record({
      action: 'file.uploaded',
      actorId: user.id,
      entityType: purpose === 'profile_photo' ? 'user' : 'conference',
      entityId: purpose === 'profile_photo' ? user.id : conferenceId,
      client,
      data: {
        purpose,
        path: key,
        contentType: KINDS[kind].mime,
        sizeBytes: file.size,
      },
    });

    return {
      path: key,
      fileName: file.originalname,
      contentType: KINDS[kind].mime,
      sizeBytes: file.size,
    };
  }

  /**
   * Removes a conference's logo (chairs): the conference shows its initials again and the file is
   * deleted. Like an upload, it waits while the Call for Papers is with the Super Admin.
   */
  async removeConferenceLogo(
    user: AuthUser,
    conferenceId: string,
    client: ClientInfo,
  ): Promise<void> {
    const access = await this.access.requireConference(user, conferenceId);
    if (!rules.canManageConference(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can remove its logo.',
      );
    }
    const db = this.database.db;
    const [cfp] = await db
      .select({ status: cfps.status })
      .from(cfps)
      .where(eq(cfps.conferenceId, conferenceId));
    if (cfp?.status === 'in_review') {
      throw AppException.businessRule(CFP_LOCKED_MESSAGE);
    }
    const [before] = await db
      .select({ logoPath: conferences.logoPath })
      .from(conferences)
      .where(eq(conferences.id, conferenceId));
    if (!before?.logoPath) {
      return;
    }
    await db
      .update(conferences)
      .set({ logoPath: null })
      .where(eq(conferences.id, conferenceId));
    if (PATH.test(before.logoPath)) {
      await this.storage.delete(before.logoPath);
    }
    await this.audit.record({
      action: 'file.deleted',
      actorId: user.id,
      entityType: 'conference',
      entityId: conferenceId,
      client,
      data: { purpose: 'conference_logo', path: before.logoPath },
    });
  }

  /** Reads a file by its storage path. `viewer` is absent for the public route (photos, logos and review-instructions PDFs only). */
  async read(
    path: string,
    viewer?: AuthUser,
  ): Promise<{ data: Buffer; contentType: string; kind: PathKind }> {
    const match = PATH.exec(path);
    if (!match?.groups) throw AppException.notFound('The file');
    const g = match.groups;
    const kind: PathKind = g.user
      ? 'photo'
      : g.logo
        ? 'logo'
        : g.instructions
          ? 'instructions'
          : 'screening';

    // Photos and logos are shown on pages and in <img> tags (public profiles, CFP pages) and the reviewers' instructions PDF is linked from the
    // review page; their names are unguessable.
    if (
      !viewer &&
      kind !== 'logo' &&
      kind !== 'photo' &&
      kind !== 'instructions'
    ) {
      throw AppException.notFound('The file');
    }
    if (viewer && kind === 'instructions') {
      await this.access.requireConference(viewer, g.conference);
    }
    // A plagiarism report: the conference's chairs, and the paper's own authors once they were told
    // the decision (cleared, or an emailed revision / rejection).
    if (viewer && kind === 'screening') {
      const access = await this.access.requireConference(viewer, g.conference);
      if (!rules.isChair(access)) {
        const paper = await this.access.submissionAccess(viewer, g.paper);
        if (!paper || !rules.isAuthorOf(paper)) {
          throw AppException.notFound('The file');
        }
        const [row] = await this.database.db
          .select({ screening: submissions.screening })
          .from(submissions)
          .where(
            and(
              eq(submissions.id, g.paper),
              eq(submissions.conferenceId, g.conference),
            ),
          );
        if (!row || !reportSharedWithAuthors(row.screening, path)) {
          throw AppException.notFound('The file');
        }
      }
    }

    let data: Buffer;
    try {
      data = await this.storage.get(path);
    } catch {
      throw AppException.notFound('The file');
    }
    const ext = path.slice(path.lastIndexOf('.') + 1);
    return {
      data,
      contentType: MIME_BY_EXT[ext] ?? 'application/octet-stream',
      kind,
    };
  }
}
