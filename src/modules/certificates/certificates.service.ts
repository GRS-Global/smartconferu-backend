import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, inArray, like, ne, sql } from 'drizzle-orm';
import type { Executor } from '../../core/database/database.types.js';
import type { Env } from '../../config/env.js';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import {
  certificateDesigns,
  certificateDistributions,
  conferences,
  issuedCertificates,
  profileDetails,
  users,
} from '../../core/database/schema/index.js';
import { EmailQueueService } from '../../core/email/email-queue.service.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import { AccessService, CHAIR_ROLES } from '../../core/rbac/access.service.js';
import { readSlot, EMAIL_SLOTS } from '../users/profile-emails.js';
import {
  applyMerge,
  assetIdsIn,
  mergeValues,
  serialIndex,
  serialOf,
  serialPrefix,
  signatoryOf,
  signatureIdsIn,
  textToHtml,
  withoutReference,
} from './certificate-rules.js';
import type {
  CertTypeKey,
  CreateDesignDto,
  CreateDistributionDto,
  RecipientDto,
  UpdateDesignDto,
  UpdateDistributionDto,
} from './dto/certificates.dto.js';

const MAX_DESIGN_BYTES = 2 * 1024 * 1024;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function checkDesignSize(design: unknown): void {
  if (Buffer.byteLength(JSON.stringify(design)) > MAX_DESIGN_BYTES) {
    throw AppException.validation(
      'This design is too large to save (over 2 MB). Large pictures should be uploaded as files instead of being kept inside the design.',
    );
  }
}

/** Designs, sends, issued certificates, the public check of a certificate ID, and the certificates a person holds. */
@Injectable()
export class CertificatesService {
  private readonly appUrl: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly emails: EmailQueueService,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true }).replace(/\/$/, '');
  }

  /* ---------------- chairs ---------------- */

  async load(user: AuthUser, conferenceId: string) {
    await this.access.assertConfRole(user, conferenceId, CHAIR_ROLES);
    const db = this.database.db;
    const [designs, dists, issued] = await Promise.all([
      db
        .select()
        .from(certificateDesigns)
        .where(eq(certificateDesigns.conferenceId, conferenceId))
        .orderBy(asc(certificateDesigns.createdAt)),
      db
        .select()
        .from(certificateDistributions)
        .where(eq(certificateDistributions.conferenceId, conferenceId))
        .orderBy(asc(certificateDistributions.createdAt)),
      db
        .select()
        .from(issuedCertificates)
        .where(eq(issuedCertificates.conferenceId, conferenceId))
        .orderBy(asc(issuedCertificates.serial)),
    ]);
    return {
      designs: designs.map(designDto),
      distributions: dists.map((d) =>
        distributionDto(
          d,
          issued.filter((i) => i.distributionId === d.id),
        ),
      ),
    };
  }

  async createDesign(
    user: AuthUser,
    conferenceId: string,
    dto: CreateDesignDto,
    client: ClientInfo,
  ) {
    await this.access.assertConfRole(user, conferenceId, CHAIR_ROLES);
    checkDesignSize(dto.design);
    const [row] = await this.database.db
      .insert(certificateDesigns)
      .values({
        conferenceId,
        name: dto.name.trim(),
        typeKey: dto.typeKey,
        design: dto.design,
        createdBy: user.id,
      })
      .returning();
    await this.audit.record({
      action: 'certificate.design_created',
      actorId: user.id,
      entityType: 'certificate_design',
      entityId: row.id,
      client,
    });
    return designDto(row);
  }

  private async designOf(user: AuthUser, id: string) {
    const [row] = await this.database.db
      .select()
      .from(certificateDesigns)
      .where(eq(certificateDesigns.id, id));
    if (!row) throw AppException.notFound('The certificate');
    await this.access.assertConfRole(user, row.conferenceId, CHAIR_ROLES);
    return row;
  }

  async saveDesign(user: AuthUser, id: string, dto: UpdateDesignDto) {
    await this.designOf(user, id);
    if (dto.design) checkDesignSize(dto.design);
    await this.database.db
      .update(certificateDesigns)
      .set({
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.design ? { design: dto.design } : {}),
      })
      .where(eq(certificateDesigns.id, id));
  }

  async deleteDesign(user: AuthUser, id: string, client: ClientInfo) {
    const row = await this.designOf(user, id);
    const [issued] = await this.database.db
      .select({ n: sql<number>`count(*)::int` })
      .from(issuedCertificates)
      .innerJoin(
        certificateDistributions,
        eq(certificateDistributions.id, issuedCertificates.distributionId),
      )
      .where(eq(certificateDistributions.designId, id));
    if ((issued?.n ?? 0) > 0) {
      throw AppException.conflict(
        `${issued.n} certificate${issued.n === 1 ? ' was' : 's were'} already issued from this design, so it cannot be deleted. People still need it to view their certificate.`,
      );
    }
    await this.database.db
      .delete(certificateDesigns)
      .where(eq(certificateDesigns.id, id));
    await this.audit.record({
      action: 'certificate.design_deleted',
      actorId: user.id,
      entityType: 'certificate_design',
      entityId: id,
      client,
      data: { name: row.name },
    });
  }

  async createDistribution(
    user: AuthUser,
    conferenceId: string,
    dto: CreateDistributionDto,
  ) {
    await this.access.assertConfRole(user, conferenceId, CHAIR_ROLES);
    const [design] = await this.database.db
      .select({ id: certificateDesigns.id })
      .from(certificateDesigns)
      .where(
        and(
          eq(certificateDesigns.id, dto.designId),
          eq(certificateDesigns.conferenceId, conferenceId),
        ),
      );
    if (!design) throw AppException.notFound('The certificate design');
    const [row] = await this.database.db
      .insert(certificateDistributions)
      .values({
        conferenceId,
        designId: dto.designId,
        name: dto.name.trim(),
        audience: dto.audience,
        email: dto.email,
        createdBy: user.id,
      })
      .returning();
    return distributionDto(row, []);
  }

  private async distributionOf(user: AuthUser, id: string) {
    const [row] = await this.database.db
      .select()
      .from(certificateDistributions)
      .where(eq(certificateDistributions.id, id));
    if (!row) throw AppException.notFound('The send');
    await this.access.assertConfRole(user, row.conferenceId, CHAIR_ROLES);
    return row;
  }

  async saveDistribution(
    user: AuthUser,
    id: string,
    dto: UpdateDistributionDto,
  ) {
    const row = await this.distributionOf(user, id);
    if (row.status === 'sent') {
      throw AppException.conflict(
        'This send has already been issued and can no longer be changed.',
      );
    }
    await this.database.db
      .update(certificateDistributions)
      .set({
        ...(dto.audience ? { audience: dto.audience } : {}),
        ...(dto.email ? { email: dto.email } : {}),
        ...(dto.manual ? { manual: dto.manual } : {}),
        ...(dto.overrides ? { overrides: dto.overrides } : {}),
      })
      .where(eq(certificateDistributions.id, id));
  }

  async deleteDistribution(user: AuthUser, id: string) {
    const row = await this.distributionOf(user, id);
    if (row.status === 'sent') {
      throw AppException.conflict(
        'Certificates were already issued from this send, so it cannot be deleted.',
      );
    }
    await this.database.db
      .delete(certificateDistributions)
      .where(eq(certificateDistributions.id, id));
  }

  /**
   * Issues a send: every recipient gets a certificate with its own public ID (continuing the numbering of that
   * conference and type), the send becomes "sent", and each person with an address is emailed the chair's message
   * with a link to the public check page. All in one transaction, so a failure leaves nothing half-issued.
   */
  async issue(
    user: AuthUser,
    id: string,
    recipients: RecipientDto[],
    client: ClientInfo,
  ): Promise<{ count: number }> {
    const dist = await this.distributionOf(user, id);
    const count = await this.database.transaction(async (tx) => {
      // One send at a time per conference, so two chairs issuing together cannot draw the same ID.
      const [conf] = await tx
        .select()
        .from(conferences)
        .where(eq(conferences.id, dist.conferenceId))
        .for('update');
      const [fresh] = await tx
        .select()
        .from(certificateDistributions)
        .where(eq(certificateDistributions.id, id))
        .for('update');
      if (!conf || !fresh) throw AppException.notFound('The send');
      if (fresh.status === 'sent') {
        throw AppException.conflict('This send has already been issued.');
      }
      const [design] = await tx
        .select({ typeKey: certificateDesigns.typeKey })
        .from(certificateDesigns)
        .where(eq(certificateDesigns.id, fresh.designId));
      const typeKey = (design?.typeKey ?? 'participation') as CertTypeKey;
      const prefix = serialPrefix(conf.acronym, typeKey);

      const existing = await tx
        .select({ serial: issuedCertificates.serial })
        .from(issuedCertificates)
        .where(like(issuedCertificates.serial, `${prefix}%`));
      let next =
        existing.reduce(
          (m, r) => Math.max(m, serialIndex(r.serial, prefix)),
          -1,
        ) + 1;

      const rows = recipients.map((r) => ({
        conferenceId: conf.id,
        distributionId: id,
        serial: serialOf(prefix, next++),
        name: r.name.trim(),
        email: (r.email ?? '').trim(),
        affiliation: r.affiliation ?? '',
        roleLabel: r.roleLabel ?? '',
        paperLabel: r.paperId ?? '',
        paperTitle: r.paperTitle ?? '',
      }));
      await tx.insert(issuedCertificates).values(rows);
      await tx
        .update(certificateDistributions)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(certificateDistributions.id, id));

      for (const row of rows) {
        await this.mailCertificate(
          tx,
          conf,
          typeKey,
          row,
          fresh.email as MailTemplate,
          user.id,
        );
      }
      await this.audit.record(
        {
          action: 'certificate.issued',
          actorId: user.id,
          entityType: 'certificate_distribution',
          entityId: id,
          client,
          data: { count: rows.length },
        },
        tx,
      );
      return rows.length;
    });
    return { count };
  }

  /** Queues the email that carries the certificate's public link (nothing when the person has no address). */
  private async mailCertificate(
    tx: Executor,
    conf: typeof conferences.$inferSelect,
    typeKey: CertTypeKey,
    row: {
      serial: string;
      name: string;
      email: string;
      affiliation: string;
      roleLabel: string;
      paperTitle: string;
      paperLabel: string;
    },
    mail: MailTemplate,
    sentBy: string,
  ) {
    if (!row.email) return;
    const url = `${this.appUrl}/verify/${encodeURIComponent(row.serial)}`;
    const values = mergeValues(
      {
        name: row.name,
        affiliation: row.affiliation,
        roleLabel: row.roleLabel,
        serial: row.serial,
        paperTitle: row.paperTitle,
        paperId: row.paperLabel,
      },
      conf,
      { typeKey, issuedAt: new Date(), verificationUrl: url },
    );
    await this.emails.enqueue(
      tx,
      'certificate.issued',
      {
        key: 'certificate_issued',
        label: 'Certificate issued',
        to: { email: row.email, name: row.name },
        recipientType: 'Recipient',
        conference: {
          id: conf.id,
          title: conf.title,
          acronym: conf.acronym,
          contactEmail: conf.contactEmail,
        },
        subject: applyMerge(mail.subject ?? 'Your certificate', values),
        body: `${textToHtml(applyMerge(mail.body ?? '', values))}<p><a href="${url}">View and verify your certificate (${row.serial})</a></p>`,
      },
      { sentBy },
    );
  }

  /** An issued certificate with its send and design type, for a chair of its conference. */
  private async issuedOf(user: AuthUser, serial: string) {
    const [row] = await this.database.db
      .select({
        c: issuedCertificates,
        dist: certificateDistributions,
        typeKey: certificateDesigns.typeKey,
      })
      .from(issuedCertificates)
      .innerJoin(
        certificateDistributions,
        eq(certificateDistributions.id, issuedCertificates.distributionId),
      )
      .innerJoin(
        certificateDesigns,
        eq(certificateDesigns.id, certificateDistributions.designId),
      )
      .where(eq(issuedCertificates.serial, serial.slice(0, 80)));
    if (!row) throw AppException.notFound('That certificate');
    await this.access.assertConfRole(user, row.c.conferenceId, CHAIR_ROLES);
    return row;
  }

  /** Withdraws a certificate: the public check then says it is no longer valid. It stays in the list and can be replaced (reissue). */
  async revoke(
    user: AuthUser,
    serial: string,
    reason: string | undefined,
    client: ClientInfo,
  ): Promise<void> {
    const { c } = await this.issuedOf(user, serial);
    if (c.revokedAt)
      throw AppException.conflict(
        'This certificate has already been withdrawn.',
      );
    await this.database.db
      .update(issuedCertificates)
      .set({
        revokedAt: new Date(),
        revokeReason: reason?.trim() || null,
        revokedBy: user.id,
      })
      .where(eq(issuedCertificates.id, c.id));
    await this.audit.record({
      action: 'certificate.revoked',
      actorId: user.id,
      entityType: 'issued_certificate',
      entityId: c.id,
      client,
      data: { serial: c.serial, reason: reason?.trim() || null },
    });
  }

  /** Sends the certificate email again (same ID). Not for a withdrawn certificate or one with no address. */
  async resend(
    user: AuthUser,
    serial: string,
    client: ClientInfo,
  ): Promise<void> {
    const { c, dist, typeKey } = await this.issuedOf(user, serial);
    if (c.revokedAt)
      throw AppException.conflict(
        'This certificate has been withdrawn, so it cannot be sent again. Reissue it instead.',
      );
    if (!c.email)
      throw AppException.businessRule(
        'This person has no email address. Reissue the certificate with one.',
      );
    await this.database.transaction(async (tx) => {
      const [conf] = await tx
        .select()
        .from(conferences)
        .where(eq(conferences.id, c.conferenceId));
      if (!conf) throw AppException.notFound('The conference');
      await this.mailCertificate(
        tx,
        conf,
        typeKey as CertTypeKey,
        c,
        dist.email as MailTemplate,
        user.id,
      );
      await tx
        .update(issuedCertificates)
        .set({ resentAt: new Date(), status: 'sent', bounceReason: null })
        .where(eq(issuedCertificates.id, c.id));
      await this.audit.record(
        {
          action: 'certificate.resent',
          actorId: user.id,
          entityType: 'issued_certificate',
          entityId: c.id,
          client,
          data: { serial: c.serial },
        },
        tx,
      );
    });
  }

  /**
   * Replaces a certificate (a wrong name, a wrong address): the old one is withdrawn and points at the new one, which gets the next ID of the
   * same series and is emailed. Fields left out keep their value.
   */
  async reissue(
    user: AuthUser,
    serial: string,
    changes: Partial<RecipientDto>,
    client: ClientInfo,
  ) {
    const { c, dist, typeKey } = await this.issuedOf(user, serial);
    if (c.revokedAt)
      throw AppException.conflict(
        'This certificate has already been withdrawn or replaced.',
      );
    if (changes.name !== undefined && !changes.name.trim())
      throw AppException.validation('The name cannot be empty.');
    return this.database.transaction(async (tx) => {
      const [conf] = await tx
        .select()
        .from(conferences)
        .where(eq(conferences.id, c.conferenceId))
        .for('update');
      if (!conf) throw AppException.notFound('The conference');
      const prefix = serialPrefix(conf.acronym, typeKey as CertTypeKey);
      const existing = await tx
        .select({ serial: issuedCertificates.serial })
        .from(issuedCertificates)
        .where(like(issuedCertificates.serial, `${prefix}%`));
      const next =
        existing.reduce(
          (m, r) => Math.max(m, serialIndex(r.serial, prefix)),
          -1,
        ) + 1;
      const [fresh] = await tx
        .insert(issuedCertificates)
        .values({
          conferenceId: c.conferenceId,
          distributionId: c.distributionId,
          serial: serialOf(prefix, next),
          name: (changes.name ?? c.name).trim(),
          email: (changes.email ?? c.email).trim(),
          affiliation: changes.affiliation ?? c.affiliation,
          roleLabel: changes.roleLabel ?? c.roleLabel,
          paperLabel: changes.paperId ?? c.paperLabel,
          paperTitle: changes.paperTitle ?? c.paperTitle,
        })
        .returning();
      await tx
        .update(issuedCertificates)
        .set({
          revokedAt: new Date(),
          revokeReason: 'Replaced by a corrected certificate',
          revokedBy: user.id,
          replacedBy: fresh.serial,
        })
        .where(eq(issuedCertificates.id, c.id));
      await this.mailCertificate(
        tx,
        conf,
        typeKey as CertTypeKey,
        fresh,
        dist.email as MailTemplate,
        user.id,
      );
      await this.audit.record(
        {
          action: 'certificate.reissued',
          actorId: user.id,
          entityType: 'issued_certificate',
          entityId: c.id,
          client,
          data: { serial: c.serial, newSerial: fresh.serial },
        },
        tx,
      );
      return issuedDto(fresh);
    });
  }

  /* ---------------- public and personal ---------------- */

  /** The public check of a certificate ID: only what is printed on the certificate plus the conference's own details. Counts the check. */
  async verify(serial: string) {
    const [row] = await this.database.db
      .select({
        c: issuedCertificates,
        design: certificateDesigns.design,
        typeKey: certificateDesigns.typeKey,
        conf: conferences,
      })
      .from(issuedCertificates)
      .innerJoin(
        certificateDistributions,
        eq(certificateDistributions.id, issuedCertificates.distributionId),
      )
      .innerJoin(
        certificateDesigns,
        eq(certificateDesigns.id, certificateDistributions.designId),
      )
      .innerJoin(
        conferences,
        eq(conferences.id, issuedCertificates.conferenceId),
      )
      .where(
        and(
          eq(issuedCertificates.serial, serial),
          ne(conferences.status, 'deleted'),
        ),
      );
    if (!row) throw AppException.notFound('That certificate');
    await this.database.db
      .update(issuedCertificates)
      .set({ verifiedCount: sql`${issuedCertificates.verifiedCount} + 1` })
      .where(eq(issuedCertificates.id, row.c.id));
    if (row.c.revokedAt) {
      // Withdrawn: say so, and nothing about the person.
      return {
        revoked: true as const,
        serial: row.c.serial,
        revokedAt: row.c.revokedAt.toISOString(),
        replacedBy: row.c.replacedBy,
        conference: {
          name: row.conf.title,
          acronym: row.conf.acronym,
          contactEmail: row.conf.contactEmail,
        },
      };
    }
    return {
      revoked: false as const,
      serial: row.c.serial,
      name: row.c.name,
      affiliation: row.c.affiliation,
      roleLabel: row.c.roleLabel,
      paperId: row.c.paperLabel,
      paperTitle: row.c.paperTitle,
      issuedAt: row.c.issuedAt.toISOString(),
      typeKey: row.typeKey,
      signatory: signatoryOf(row.design),
      conference: {
        name: row.conf.title,
        acronym: row.conf.acronym,
        startDate: row.conf.startDate,
        endDate: row.conf.endDate,
        city: row.conf.city,
        country: row.conf.country,
        contactEmail: row.conf.contactEmail,
      },
    };
  }

  /** The addresses a person can be reached on: the sign-in address and the verified personal / professional ones on the profile. */
  private async addressesOf(userId: string): Promise<string[]> {
    const [u] = await this.database.db
      .select({ email: users.email, data: profileDetails.data })
      .from(users)
      .leftJoin(profileDetails, eq(profileDetails.userId, users.id))
      .where(eq(users.id, userId));
    const out = new Set<string>();
    if (u?.email) out.add(u.email.trim().toLowerCase());
    const emails = (u?.data as { emails?: unknown } | null)?.emails;
    for (const slot of EMAIL_SLOTS) {
      const s = readSlot(emails, slot);
      if (s.value && s.status === 'verified') out.add(s.value.toLowerCase());
    }
    return [...out];
  }

  async mine(user: AuthUser) {
    const addresses = await this.addressesOf(user.id);
    if (addresses.length === 0) return [];
    const rows = await this.database.db
      .select({
        c: issuedCertificates,
        design: certificateDesigns.design,
        typeKey: certificateDesigns.typeKey,
        conf: conferences,
      })
      .from(issuedCertificates)
      .innerJoin(
        certificateDistributions,
        eq(certificateDistributions.id, issuedCertificates.distributionId),
      )
      .innerJoin(
        certificateDesigns,
        eq(certificateDesigns.id, certificateDistributions.designId),
      )
      .innerJoin(
        conferences,
        eq(conferences.id, issuedCertificates.conferenceId),
      )
      .where(
        and(
          inArray(sql`lower(${issuedCertificates.email})`, addresses),
          ne(conferences.status, 'deleted'),
        ),
      )
      .orderBy(desc(issuedCertificates.issuedAt));
    return rows.map((r) => ({
      serial: r.c.serial,
      name: r.c.name,
      affiliation: r.c.affiliation,
      roleLabel: r.c.roleLabel,
      paperId: r.c.paperLabel,
      paperTitle: r.c.paperTitle,
      issuedAt: r.c.issuedAt.toISOString(),
      revokedAt: iso(r.c.revokedAt),
      replacedBy: r.c.replacedBy,
      typeKey: r.typeKey,
      design: r.design,
      conference: {
        id: r.conf.slug,
        acronym: r.conf.acronym,
        name: r.conf.title,
        startDate: r.conf.startDate,
        endDate: r.conf.endDate,
        city: r.conf.city,
        country: r.conf.country,
        contactEmail: r.conf.contactEmail,
        status: r.conf.status,
      },
    }));
  }

  /** The person opened or downloaded their own certificate (the chair's tracking reads it). Only for the person it was issued to. */
  async recordEvent(
    user: AuthUser,
    serial: string,
    kind: 'opened' | 'downloaded',
  ): Promise<void> {
    const addresses = await this.addressesOf(user.id);
    if (addresses.length === 0) return;
    await this.database.db
      .update(issuedCertificates)
      .set(kind === 'opened' ? { opened: true } : { downloaded: true })
      .where(
        and(
          eq(issuedCertificates.serial, serial),
          inArray(sql`lower(${issuedCertificates.email})`, addresses),
        ),
      );
  }

  /** Designs that use a library picture (so one that is in use cannot be deleted from under them). */
  async designsUsingAsset(conferenceId: string, assetId: string) {
    const rows = await this.database.db
      .select({
        id: certificateDesigns.id,
        name: certificateDesigns.name,
        design: certificateDesigns.design,
      })
      .from(certificateDesigns)
      .where(eq(certificateDesigns.conferenceId, conferenceId));
    return rows.filter((r) =>
      assetIdsIn(r.design).includes(assetId.toLowerCase()),
    );
  }

  /** Takes a library picture / signature (`ref`) out of the given designs (the ones that use it). */
  async stripReference(
    designs: Array<{ id: string; design: unknown }>,
    ref: string,
    wholeGroup: boolean,
  ) {
    for (const d of designs) {
      await this.database.db
        .update(certificateDesigns)
        .set({
          design: withoutReference(
            d.design as Record<string, unknown>,
            ref,
            wholeGroup,
          ),
        })
        .where(eq(certificateDesigns.id, d.id));
    }
  }

  /** Library signatures a design uses (so a signature that is in use cannot be deleted from under it). */
  async designsUsingSignature(conferenceId: string, signatureId: string) {
    const rows = await this.database.db
      .select({
        id: certificateDesigns.id,
        name: certificateDesigns.name,
        design: certificateDesigns.design,
      })
      .from(certificateDesigns)
      .where(eq(certificateDesigns.conferenceId, conferenceId));
    return rows.filter((r) =>
      signatureIdsIn(r.design).includes(signatureId.toLowerCase()),
    );
  }
}

type MailTemplate = { subject?: string; body?: string };
type DesignRow = typeof certificateDesigns.$inferSelect;
type DistRow = typeof certificateDistributions.$inferSelect;
type IssuedRow = typeof issuedCertificates.$inferSelect;

const designDto = (r: DesignRow) => ({
  id: r.id,
  conferenceId: r.conferenceId,
  name: r.name,
  typeKey: r.typeKey,
  design: r.design,
  createdAt: r.createdAt.toISOString(),
});

const distributionDto = (r: DistRow, issued: IssuedRow[]) => ({
  id: r.id,
  conferenceId: r.conferenceId,
  designId: r.designId,
  name: r.name,
  audience: r.audience,
  email: r.email,
  manual: r.manual,
  overrides: r.overrides,
  status: r.status,
  sentAt: iso(r.sentAt),
  createdAt: r.createdAt.toISOString(),
  issued: issued.map(issuedDto),
});

const issuedDto = (i: IssuedRow) => ({
  serial: i.serial,
  name: i.name,
  email: i.email,
  affiliation: i.affiliation,
  roleLabel: i.roleLabel,
  paperId: i.paperLabel,
  paperTitle: i.paperTitle,
  issuedAt: i.issuedAt.toISOString(),
  status: i.status,
  bounceReason: i.bounceReason,
  opened: i.opened,
  downloaded: i.downloaded,
  verifiedCount: i.verifiedCount,
  revokedAt: iso(i.revokedAt),
  revokeReason: i.revokeReason,
  replacedBy: i.replacedBy,
  resentAt: iso(i.resentAt),
});
