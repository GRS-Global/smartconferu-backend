import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.module.js';
import { DecisionsService } from './decisions.service.js';
import { ReviewRemindersService } from './reminders/review-reminders.service.js';
import { ReviewEmailsService } from './review-emails.service.js';
import {
  AssignmentsController,
  ChairReviewsController,
  DecisionTypesController,
  MyReviewsController,
  PaperReviewsController,
  PendingAssignmentsController,
} from './reviews.controller.js';
import { ReviewsRepository } from './reviews.repository.js';
import { ReviewsService } from './reviews.service.js';

/** Peer review and sending decisions. */
@Module({
  imports: [SubmissionsModule],
  controllers: [
    MyReviewsController,
    PaperReviewsController,
    AssignmentsController,
    PendingAssignmentsController,
    ChairReviewsController,
    DecisionTypesController,
  ],
  providers: [
    ReviewsRepository,
    ReviewsService,
    DecisionsService,
    ReviewEmailsService,
    ReviewRemindersService,
  ],
  exports: [ReviewsRepository, ReviewRemindersService],
})
export class ReviewsModule {}
