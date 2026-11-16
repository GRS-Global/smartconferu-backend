import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { JobsRunner } from './jobs.runner.js';

/** The background jobs (review reminders, cleanup). */
@Module({
  imports: [ReviewsModule, AiModule],
  providers: [JobsRunner],
  exports: [JobsRunner],
})
export class JobsModule {}
