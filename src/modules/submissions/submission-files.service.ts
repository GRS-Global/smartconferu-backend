import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { PaperRagService } from '../ai/paper-rag.service.js';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { EmailRecipientsService } from '../../core/email/email-recipients.service.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { NotificationsService } from '../../core/notifications/notifications.service.js';
import * as rules from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import { FileStorage } from '../../core/storage/file-storage.js';
import { storagePaths } from '../../core/storage/storage-paths.js';
import type { PaperFileUploadResponse } from './dto/screening.dto.js';
import { type AutoCheck, parseAutoCheck } from './screening/auto-check.js';
import { AutoInitialCheckService } from './screening/auto-initial-check.service.js';
import { paperId } from './submission.mapper.js';
import { SubmissionsRepository } from './submissions.repository.js';

export interface UploadedFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

/** File types accepted, told apart by their first bytes, not only their name. */
const TYPES = {
  pdf: {
    ext: ['.pdf'],
    mime: 'application/pdf',
    magic: (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  docx: {
    ext: ['.docx'],
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: (b: Buffer) =>
      b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  },
  doc: {
    ext: ['.doc'],
    mime: 'application/msword',
    magic: (b: Buffer) =>
      b
        .subarray(0, 8)
        .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
  },
  zip: {
    ext: ['.zip'],
    mime: 'application/zip',
    magic: (b: Buffer) =>
      b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  },
} as const;
type FileType = keyof typeof TYPES;

/** Paper versions: PDF or Word. Supplementary material may also be a ZIP. */
const PAPER_TYPES: FileType[] = ['pdf', 'docx', 'doc'];
const SUPPLEMENTARY_TYPES: FileType[] = ['pdf', 'docx', 'doc', 'zip'];

export function contentTypeOf(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  const type = Object.values(TYPES).find((t) =>
    (t.ext as readonly string[]).includes(ext),
  );
  return type?.mime ?? 'application/octet-stream';
}

/**
 * Uploading a paper's files and downloading them. Each paper upload is the next version (v1, v2
 * …); the first one moves the paper from "upload pending" to under review, later ones go back to
 * the initial check. With AI mode on, the automatic check of the new version is queued.
 */
@Injectable()
export class SubmissionFilesService {
  private readonly maxBytes: number;

  constructor(
    private readonly database: DatabaseService,
    private readonly submissions: SubmissionsRepository,
    private readonly access: AccessService,
    private readonly storage: FileStorage,
    private readonly autoCheck: AutoInitialCheckService,
    private readonly notifications: NotificationsService,
    private readonly recipients: EmailRecipientsService,
    private readonly audit: AuditService,
    private readonly rag: PaperRagService,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = config.get('MAX_UPLOAD_MB', { infer: true }) * 1024 * 1024;
  }

  async upload(
    user: AuthUser,
    submissionId: string,
    file: UploadedFile | undefined,
    supplementary: boolean,
    /** The app's automatic check of this file (JSON), when it has one. */
    autoCheckInput: unknown,
    client: ClientInfo,
  ): Promise<PaperFileUploadResponse> {
    const auto =
      autoCheckInput === undefined || autoCheckInput === '' || supplementary
        ? null
        : parseAutoCheck(autoCheckInput);
    if (!file || file.size === 0) {
      throw AppException.validation('Choose a file to upload.');
    }
    if (file.size > this.maxBytes) {
      throw AppException.validation(
        `That file is too large: the limit is ${this.maxBytes / 1024 / 1024} MB.`,
      );
    }
    const allowed = supplementary ? SUPPLEMENTARY_TYPES : PAPER_TYPES;
    const ext = extname(file.originalname).toLowerCase();
    const type = allowed.find(
      (t) =>
        (TYPES[t].ext as readonly string[]).includes(ext) &&
        TYPES[t].magic(file.buffer),
    );
    if (!type) {
      throw AppException.validation(
        supplementary
          ? 'Only PDF, Word or ZIP files can be uploaded as supplementary material.'
          : 'Only PDF or Word files can be uploaded.',
      );
    }
    const safeName =
      file.originalname
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^\.+/, '')
        .slice(-120) || `paper${ext}`;

    let storedKey: string | undefined;
    try {
      const result = await this.database.transaction(async (tx) => {
        const submission = await this.submissions.findForUpdate(
          tx,
          submissionId,
        );
        if (!submission) throw AppException.notFound('The paper');
        const access = await this.access.requireSubmission(
          user,
          submissionId,
          tx,
        );
        if (submission.status === 'withdrawn') {
          throw AppException.businessRule(
            'This paper has been withdrawn, so no files can be added.',
          );
        }
        if (!rules.canUploadFile(access)) {
          throw AppException.forbidden(
            'Only the authors of this paper or a chair of the conference can upload its files.',
          );
        }

        const versions = await this.submissions.paperVersionCount(
          tx,
          submissionId,
        );
        const kind = supplementary
          ? 'supplementary'
          : versions === 0
            ? 'paper'
            : submission.outcome === 'accept' ||
                submission.outcome === 'registered'
              ? 'camera_ready'
              : 'revision';
        const version = supplementary ? 1 : versions + 1;
        const tag = Date.now().toString(36);
        storedKey = supplementary
          ? storagePaths.supportingFile(submission.conferenceId, submissionId, {
              tag,
              name: safeName,
            })
          : storagePaths.paperVersion(submission.conferenceId, submissionId, {
              version,
              cameraReady: kind === 'camera_ready',
              tag,
              name: safeName,
            });
        await this.storage.put(storedKey, file.buffer, TYPES[type].mime);
        const row = await this.submissions.insertFile(tx, {
          submissionId,
          kind,
          version,
          storagePath: storedKey,
          fileName: file.originalname.slice(0, 255),
          sizeBytes: file.size,
          uploadedBy: user.id,
        });

        let stored: AutoCheck | null = null;
        if (!supplementary) {
          // The corrected file answers an open "Ask author to fix".
          const { fixRequest: _answered, ...details } =
            submission.details as Record<string, unknown>;
          if (_answered !== undefined) {
            await this.submissions.update(tx, submissionId, { details });
          }
          // The full paper is in: under review (the "no decision" stage).
          if (submission.outcome === 'upload_pending') {
            const stage = await this.submissions.decisionTypeFor(
              tx,
              submission.conferenceId,
              'no_decision',
            );
            await this.submissions.update(tx, submissionId, {
              outcome: 'no_decision',
              decisionTypeId: stage?.id ?? null,
            });
          }
          if (version > 1) {
            const info = (await this.submissions.conferenceInfo(
              tx,
              submission.conferenceId,
            ))!;
            const pid = paperId(info.acronym, submission.paperNo);
            const chairs = (
              await this.recipients.chairs(tx, submission.conferenceId)
            )
              .map((c) => c.userId!)
              .filter((id) => id !== user.id);
            await this.notifications.notify(tx, chairs, {
              kind: 'new_version',
              title: `New version of ${pid} to check`,
              body: submission.title,
              conferenceId: submission.conferenceId,
              submissionId,
              link: `/submissions/${pid}/chair`,
            });
          }
          if (auto) {
            stored = await this.autoCheck.apply(tx, submission, row, auto);
          }
        }

        await this.audit.record(
          {
            action: 'submission.file_uploaded',
            actorId: user.id,
            entityType: 'submission',
            entityId: submissionId,
            client,
            data: { fileId: row.id, kind, version },
          },
          tx,
        );
        return {
          fileId: row.id,
          kind,
          version,
          fileName: row.fileName,
          sizeBytes: file.size,
          autoCheck: stored ? { ...stored } : null,
        };
      });
      // A new PDF version of the paper is prepared for the AI features (in the background).
      if (!supplementary && TYPES[type].mime === 'application/pdf') {
        this.rag.ingestLater(submissionId);
      }
      return result;
    } catch (error) {
      // The upload didn't happen: don't leave its file behind.
      if (storedKey)
        await this.storage.delete(storedKey).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The app's automatic check of a version that arrived after the upload (the check took longer,
   * or ran again). Stored on the version and, with AI mode on, decided — unless the version's
   * initial check was already decided.
   */
  async attachAutoCheck(
    user: AuthUser,
    submissionId: string,
    fileId: string,
    input: unknown,
  ): Promise<AutoCheck> {
    const auto = parseAutoCheck(input);
    return this.database.transaction(async (tx) => {
      const submission = await this.submissions.findForUpdate(tx, submissionId);
      if (!submission) throw AppException.notFound('The paper');
      const access = await this.access.requireSubmission(
        user,
        submissionId,
        tx,
      );
      const file = await this.submissions.fileById(tx, fileId);
      if (
        !file ||
        file.submissionId !== submissionId ||
        file.kind === 'supplementary'
      ) {
        throw AppException.notFound('The paper version');
      }
      if (!rules.canUploadFile(access)) {
        throw AppException.forbidden(
          'Only the authors of this paper or a chair of the conference can do this.',
        );
      }
      const previous = (file.autoCheck as AutoCheck | null)?.decision?.outcome;
      if (previous === 'passed' || previous === 'sent_back') {
        throw AppException.conflict(
          'This version was already decided from its automatic check.',
        );
      }
      return this.autoCheck.apply(tx, submission, file, auto);
    });
  }

  /** A file of the paper, for anyone who may see the paper's files. */
  async download(
    user: AuthUser,
    submissionId: string,
    fileId: string,
  ): Promise<{ data: Buffer; fileName: string; contentType: string }> {
    const db = this.database.db;
    const access = await this.access.requireSubmission(user, submissionId, db);
    const file = await this.submissions.fileById(db, fileId);
    if (
      !file ||
      file.submissionId !== submissionId ||
      !rules.canViewFiles(access)
    ) {
      throw AppException.notFound('The file');
    }
    return {
      data: await this.storage.get(file.storagePath),
      fileName: file.fileName,
      contentType: contentTypeOf(file.fileName),
    };
  }
}
