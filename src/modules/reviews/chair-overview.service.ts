import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { AppException } from '../../core/errors/app.exception.js';
import * as rules from '../../core/rbac/access-rules.js';
import { AccessService } from '../../core/rbac/access.service.js';
import { ScreeningService } from '../submissions/screening.service.js';
import { SubmissionsRepository } from '../submissions/submissions.repository.js';
import { SubmissionsService } from '../submissions/submissions.service.js';
import type { ChairOverviewResponse } from './dto/chair-overview.dto.js';
import { DecisionsService } from './decisions.service.js';
import { ReviewsRepository } from './reviews.repository.js';

/** The chair's conference pages in one read: papers with review progress, decision types, screening. */
@Injectable()
export class ChairOverviewService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly papers: SubmissionsService,
    private readonly submissions: SubmissionsRepository,
    private readonly decisions: DecisionsService,
    private readonly screening: ScreeningService,
    private readonly reviews: ReviewsRepository,
  ) {}

  async get(
    user: AuthUser,
    conferenceId: string,
  ): Promise<ChairOverviewResponse> {
    const db = this.database.db;
    const access = await this.access.requireConference(user, conferenceId, db);
    if (!rules.isChair(access)) {
      throw AppException.forbidden(
        'Only a chair of this conference can see this overview.',
      );
    }
    const [papers, decisionTypes, screening, info, stats] = await Promise.all([
      this.papers.listForConference(user, conferenceId),
      this.decisions.decisionTypes(user, conferenceId),
      this.screening.getSettings(user, conferenceId),
      this.submissions.conferenceInfo(db, conferenceId),
      this.reviews.paperStats(db, conferenceId),
    ]);
    return {
      conferenceId,
      cfpStatus: info?.cfpStatus ?? 'draft',
      papers: papers.map((paper) => ({
        ...paper,
        reviewersAssigned: stats.get(paper.id)?.reviewersAssigned ?? 0,
        reviewsReceived: stats.get(paper.id)?.reviewsReceived ?? 0,
        averageScore: stats.get(paper.id)?.averageScore ?? null,
      })),
      decisionTypes,
      screening,
    };
  }
}
