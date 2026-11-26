import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { certificateSignatures } from '../../core/database/schema/index.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { AccessService, CHAIR_ROLES } from '../../core/rbac/access.service.js';
import { FileStorage } from '../../core/storage/file-storage.js';
import { storagePaths } from '../../core/storage/storage-paths.js';
import { CertificatesService } from './certificates.service.js';
import { IMAGE_KINDS, type UploadedImage } from './image-kinds.js';
import type {
  CreateSignatureDto,
  SignatureResponse,
  UpdateSignatureDto,
} from './dto/certificates.dto.js';

export const SIGNATURE_MAX_BYTES = 1024 * 1024;

export type { UploadedImage } from './image-kinds.js';

type Row = typeof certificateSignatures.$inferSelect;
const dto = (r: Row): SignatureResponse => ({
  id: r.id,
  name: r.name,
  designation: r.designation,
  institution: r.institution,
  contentType: r.contentType,
  sizeBytes: r.sizeBytes,
  isDefault: r.isDefault,
  createdAt: r.createdAt.toISOString(),
});

/**
 * The conference's signature library. The people who may manage it are the conference's chairs. The image files are kept in
 * file storage under an unguessable name and are read back by id (see the controller): a signature is printed on every certificate
 * that uses it, so it is as visible as the certificate, but the library itself (who, which designations) is chairs only.
 */
@Injectable()
export class SignaturesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly storage: FileStorage,
    private readonly certificates: CertificatesService,
  ) {}

  private image(file: UploadedImage | undefined) {
    if (!file?.buffer?.length) {
      throw AppException.validation('Choose a signature image to upload.');
    }
    if (file.size > SIGNATURE_MAX_BYTES) {
      throw AppException.validation(
        'That image is larger than 1 MB. Please use a smaller one.',
      );
    }
    const kind = IMAGE_KINDS.find((k) => k.is(file.buffer));
    if (!kind) {
      throw AppException.validation(
        'Signatures must be a PNG (transparent works best), JPG or WebP image.',
      );
    }
    return kind;
  }

  async list(user: AuthUser, conferenceId: string) {
    await this.access.assertConfRole(user, conferenceId, CHAIR_ROLES);
    const rows = await this.database.db
      .select()
      .from(certificateSignatures)
      .where(eq(certificateSignatures.conferenceId, conferenceId))
      .orderBy(asc(certificateSignatures.createdAt));
    return rows.map(dto);
  }

  async create(
    user: AuthUser,
    conferenceId: string,
    fields: CreateSignatureDto,
    file: UploadedImage | undefined,
    client: ClientInfo,
  ) {
    await this.access.assertConfRole(user, conferenceId, CHAIR_ROLES);
    const kind = this.image(file);
    const id = randomUUID();
    const path = storagePaths.certificateSignature(conferenceId, id, kind.ext);
    await this.storage.put(path, file!.buffer, kind.mime);
    try {
      const row = await this.database.transaction(async (tx) => {
        const [first] = await tx
          .select({ id: certificateSignatures.id })
          .from(certificateSignatures)
          .where(eq(certificateSignatures.conferenceId, conferenceId))
          .limit(1);
        const [created] = await tx
          .insert(certificateSignatures)
          .values({
            id,
            conferenceId,
            name: fields.name.trim(),
            designation: (fields.designation ?? '').trim(),
            institution: (fields.institution ?? '').trim(),
            storagePath: path,
            contentType: kind.mime,
            sizeBytes: file!.size,
            // The first signature of a conference is its default.
            isDefault: !first,
            createdBy: user.id,
          })
          .returning();
        await this.audit.record(
          {
            action: 'certificate.signature_added',
            actorId: user.id,
            entityType: 'certificate_signature',
            entityId: id,
            client,
          },
          tx,
        );
        return created;
      });
      return dto(row);
    } catch (error) {
      await this.storage.delete(path).catch(() => undefined);
      throw error;
    }
  }

  private async rowOf(user: AuthUser, id: string): Promise<Row> {
    const [row] = await this.database.db
      .select()
      .from(certificateSignatures)
      .where(eq(certificateSignatures.id, id));
    if (!row) throw AppException.notFound('The signature');
    await this.access.assertConfRole(user, row.conferenceId, CHAIR_ROLES);
    return row;
  }

  async update(user: AuthUser, id: string, patch: UpdateSignatureDto) {
    const row = await this.rowOf(user, id);
    const updated = await this.database.transaction(async (tx) => {
      if (patch.isDefault === true) {
        await tx
          .update(certificateSignatures)
          .set({ isDefault: false })
          .where(
            and(
              eq(certificateSignatures.conferenceId, row.conferenceId),
              ne(certificateSignatures.id, id),
            ),
          );
      }
      const [r] = await tx
        .update(certificateSignatures)
        .set({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.designation !== undefined
            ? { designation: patch.designation.trim() }
            : {}),
          ...(patch.institution !== undefined
            ? { institution: patch.institution.trim() }
            : {}),
          ...(patch.isDefault !== undefined
            ? { isDefault: patch.isDefault }
            : {}),
        })
        .where(eq(certificateSignatures.id, id))
        .returning();
      return r;
    });
    return dto(updated);
  }

  /** Replaces the picture, keeping the same signature (and so every certificate design that uses it). */
  async replaceImage(
    user: AuthUser,
    id: string,
    file: UploadedImage | undefined,
  ) {
    const row = await this.rowOf(user, id);
    const kind = this.image(file);
    const path = storagePaths.certificateSignature(
      row.conferenceId,
      id,
      kind.ext,
    );
    await this.storage.put(path, file!.buffer, kind.mime);
    const [updated] = await this.database.db
      .update(certificateSignatures)
      .set({ storagePath: path, contentType: kind.mime, sizeBytes: file!.size })
      .where(eq(certificateSignatures.id, id))
      .returning();
    if (row.storagePath !== path) {
      await this.storage.delete(row.storagePath).catch(() => undefined);
    }
    return dto(updated);
  }

  async remove(
    user: AuthUser,
    id: string,
    client: ClientInfo,
    removeFromDesigns = false,
  ) {
    const row = await this.rowOf(user, id);
    const using = await this.certificates.designsUsingSignature(
      row.conferenceId,
      id,
    );
    if (using.length > 0 && removeFromDesigns) {
      await this.certificates.stripReference(using, `sig:${id}`, true);
    } else if (using.length > 0) {
      throw AppException.conflict(
        `This signature is used in ${using.length === 1 ? 'the certificate' : 'the certificates'} “${using
          .map((d) => d.name)
          .slice(0, 3)
          .join(
            '”, “',
          )}”${using.length > 3 ? ` and ${using.length - 3} more` : ''}. Remove it from there first.`,
      );
    }
    await this.database.db
      .delete(certificateSignatures)
      .where(eq(certificateSignatures.id, id));
    await this.storage.delete(row.storagePath).catch(() => undefined);
    await this.audit.record({
      action: 'certificate.signature_deleted',
      actorId: user.id,
      entityType: 'certificate_signature',
      entityId: id,
      client,
    });
  }

  /** The picture, by the signature's (random) id. Read without sign-in: it is printed on the certificates that use it. */
  async read(id: string): Promise<{ data: Buffer; contentType: string }> {
    const [row] = await this.database.db
      .select({
        path: certificateSignatures.storagePath,
        type: certificateSignatures.contentType,
      })
      .from(certificateSignatures)
      .where(eq(certificateSignatures.id, id));
    if (!row) throw AppException.notFound('The signature');
    try {
      return { data: await this.storage.get(row.path), contentType: row.type };
    } catch {
      throw AppException.notFound('The signature');
    }
  }
}
