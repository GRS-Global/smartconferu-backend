import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { AppException } from '../../core/errors/app.exception.js';
import type { ClientInfo } from '../../core/http/client-info.js';
import * as rules from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import type {
  SaveRegistrationDto,
  SubmissionResponse,
} from './dto/submission.dto.js';
import { ACCEPTED_OUTCOMES } from './submission.mapper.js';
import { SubmissionsRepository } from './submissions.repository.js';
import { SubmissionsService } from './submissions.service.js';

/**
 * An accepted paper's payment and attendance, recorded by hand by a chair (until the conference
 * has a registration module). No email goes out; the change is in the Activity Logs.
 */
@Injectable()
export class RegistrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly submissions: SubmissionsRepository,
    private readonly papers: SubmissionsService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async save(
    user: AuthUser,
    submissionId: string,
    dto: SaveRegistrationDto,
    client: ClientInfo,
  ): Promise<SubmissionResponse> {
    return this.database.transaction(async (tx) => {
      // Locks the paper, so a decision recorded at the same moment can't slip in between.
      const submission = await this.submissions.findForUpdate(tx, submissionId);
      if (!submission) throw AppException.notFound('The paper');
      const access = await this.access.requireSubmission(
        user,
        submissionId,
        tx,
      );
      if (!rules.canDecide(access)) {
        throw AppException.forbidden(
          'Only a chair of this conference can record payment and attendance.',
        );
      }
      if (submission.status === 'withdrawn') {
        throw AppException.businessRule(
          'This paper has been withdrawn, so it takes no payment or attendance.',
        );
      }
      if (!ACCEPTED_OUTCOMES.includes(submission.outcome)) {
        throw AppException.businessRule(
          'Payment and attendance can be recorded once the paper is accepted.',
        );
      }

      let presenterEmail: string | null = null;
      if (dto.presenterEmail) {
        const wanted = dto.presenterEmail.toLowerCase();
        const author = (await this.submissions.authors(tx, submissionId)).find(
          (a) => a.email?.toLowerCase() === wanted,
        );
        if (!author) {
          throw AppException.validation(
            'The presenter must be one of the paper’s authors.',
            [
              {
                field: 'presenterEmail',
                errors: ['must be an author of this paper'],
              },
            ],
          );
        }
        presenterEmail = author.email;
      }

      const before = await this.submissions.registration(tx, submissionId);
      const after = {
        payment: dto.payment,
        attendance: dto.attendance ?? null,
        presenterEmail,
        note: dto.note ?? null,
      };
      await this.submissions.saveRegistration(tx, submissionId, after, user.id);
      await this.audit.record(
        {
          action: 'submission.registration_updated',
          actorId: user.id,
          entityType: 'submission',
          entityId: submissionId,
          client,
          data: {
            before: {
              payment: before?.payment ?? 'not_paid',
              attendance: before?.attendance ?? null,
              presenterEmail: before?.presenterEmail ?? null,
            },
            after: {
              payment: after.payment,
              attendance: after.attendance,
              presenterEmail: after.presenterEmail,
            },
          },
        },
        tx,
      );
      return this.papers.view(tx, user, submissionId);
    });
  }
}
