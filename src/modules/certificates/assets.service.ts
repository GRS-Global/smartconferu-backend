import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { certificateAssets } from '../../core/database/schema/index.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { AccessService, CHAIR_ROLES } from '../../core/rbac/access.service.js';
import { FileStorage } from '../../core/storage/file-storage.js';
import { storagePaths } from '../../core/storage/storage-paths.js';
import { CertificatesService } from './certificates.service.js';
import type { AssetResponse, UpdateAssetDto } from './dto/certificates.dto.js';
import { IMAGE_KINDS, type UploadedImage } from './image-kinds.js';

export const ASSET_MAX_BYTES = 2 * 1024 * 1024;
/** A conference's library is for its own certificates, not a file store. */
export const ASSET_MAX_COUNT = 200;

type Row = typeof certificateAssets.$inferSelect;
const dto = (r: Row): AssetResponse => ({
  id: r.id,
  name: r.name,
  contentType: r.contentType,
  sizeBytes: r.sizeBytes,
  createdAt: r.createdAt.toISOString(),
});

const cleanName = (n: string) =>
  n
    .replace(/\.[A-Za-z0-9]{2,5}$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

/**
 * The pictures of a conference's certificates (logos, backgrounds, graphics). Chairs of the conference manage them; a design refers to one as
 * `asset:<id>`. The files sit in file storage under an unguessable name and are read back by id without sign-in (they are printed on every certificate
 * that uses them, as signatures are); the list and every change are chairs only.
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly storage: FileStorage,
    private readonly certificates: CertificatesService,
  ) {}

  private image(file: UploadedImage | undefined) {
    if (!file?.buffer?.length)
      throw AppException.validation('Choose a picture to upload.');
    if (file.size > ASSET_MAX_BYTES) {
      throw AppException.validation(
        'That picture is larger than 2 MB. Please use a smaller one.',
      );
    }
    const kind = IMAGE_KINDS.find((k) => k.is(file.buffer));
    if (!kind) {
      throw AppException.validation(
        'Pictures must be PNG (transparent works), JPG or WebP.',
      );
    }
    return kind;
  }

  async list(user: AuthUser, conferenceId: string) {
    await this.access.assertConfRole(user, conferenceId, CHAIR_ROLES);
    const rows = await this.database.db
      .select()
      .from(certificateAssets)
      .where(eq(certificateAssets.conferenceId, conferenceId))
      .orderBy(asc(certificateAssets.createdAt));
    return rows.map(dto);
  }

  async create(
    user: AuthUser,
    conferenceId: string,
    name: string | undefined,
    file: UploadedImage | undefined,
    client: ClientInfo,
  ) {
    await this.access.assertConfRole(user, conferenceId, CHAIR_ROLES);
    const kind = this.image(file);
    const [total] = await this.database.db
      .select({ n: count() })
      .from(certificateAssets)
      .where(eq(certificateAssets.conferenceId, conferenceId));
    if ((total?.n ?? 0) >= ASSET_MAX_COUNT) {
      throw AppException.businessRule(
        `This conference already has ${ASSET_MAX_COUNT} pictures. Delete some you no longer use first.`,
      );
    }
    const id = randomUUID();
    const path = storagePaths.certificatePicture(conferenceId, id, kind.ext);
    await this.storage.put(path, file!.buffer, kind.mime);
    try {
      const [row] = await this.database.db
        .insert(certificateAssets)
        .values({
          id,
          conferenceId,
          name:
            cleanName(name ?? '') || cleanName(file!.originalname) || 'Picture',
          storagePath: path,
          contentType: kind.mime,
          sizeBytes: file!.size,
          createdBy: user.id,
        })
        .returning();
      await this.audit.record({
        action: 'certificate.asset_added',
        actorId: user.id,
        entityType: 'certificate_asset',
        entityId: id,
        client,
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
      .from(certificateAssets)
      .where(eq(certificateAssets.id, id));
    if (!row) throw AppException.notFound('The picture');
    await this.access.assertConfRole(user, row.conferenceId, CHAIR_ROLES);
    return row;
  }

  async rename(user: AuthUser, id: string, patch: UpdateAssetDto) {
    await this.rowOf(user, id);
    const [row] = await this.database.db
      .update(certificateAssets)
      .set({ name: cleanName(patch.name) || 'Picture' })
      .where(eq(certificateAssets.id, id))
      .returning();
    return dto(row);
  }

  /** Replaces the picture, keeping the same asset (so every design that uses it shows the new one). */
  async replaceImage(
    user: AuthUser,
    id: string,
    file: UploadedImage | undefined,
  ) {
    const row = await this.rowOf(user, id);
    const kind = this.image(file);
    const path = storagePaths.certificatePicture(
      row.conferenceId,
      id,
      kind.ext,
    );
    await this.storage.put(path, file!.buffer, kind.mime);
    const [updated] = await this.database.db
      .update(certificateAssets)
      .set({ storagePath: path, contentType: kind.mime, sizeBytes: file!.size })
      .where(eq(certificateAssets.id, id))
      .returning();
    if (row.storagePath !== path)
      await this.storage.delete(row.storagePath).catch(() => undefined);
    return dto(updated);
  }

  async remove(
    user: AuthUser,
    id: string,
    client: ClientInfo,
    removeFromDesigns = false,
  ) {
    const row = await this.rowOf(user, id);
    const using = await this.certificates.designsUsingAsset(
      row.conferenceId,
      id,
    );
    if (using.length > 0 && removeFromDesigns) {
      await this.certificates.stripReference(using, `asset:${id}`, false);
    } else if (using.length > 0) {
      throw AppException.conflict(
        `This picture is used in ${using.length === 1 ? 'the certificate' : 'the certificates'} “${using
          .map((d) => d.name)
          .slice(0, 3)
          .join(
            '”, “',
          )}”${using.length > 3 ? ` and ${using.length - 3} more` : ''}. Remove it from there first.`,
      );
    }
    await this.database.db
      .delete(certificateAssets)
      .where(eq(certificateAssets.id, id));
    await this.storage.delete(row.storagePath).catch(() => undefined);
    await this.audit.record({
      action: 'certificate.asset_deleted',
      actorId: user.id,
      entityType: 'certificate_asset',
      entityId: id,
      client,
    });
  }

  /** The picture, by the asset's (random) id. Read without sign-in: it is printed on the certificates that use it. */
  async read(id: string): Promise<{ data: Buffer; contentType: string }> {
    const [row] = await this.database.db
      .select({
        path: certificateAssets.storagePath,
        type: certificateAssets.contentType,
      })
      .from(certificateAssets)
      .where(eq(certificateAssets.id, id));
    if (!row) throw AppException.notFound('The picture');
    try {
      return { data: await this.storage.get(row.path), contentType: row.type };
    } catch {
      throw AppException.notFound('The picture');
    }
  }
}
