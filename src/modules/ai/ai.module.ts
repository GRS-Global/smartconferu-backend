import { Module } from '@nestjs/common';
import { AiCoreService } from './ai-core.service.js';
import { AiToolsService } from './ai-tools.service.js';
import { AiController, PaperAiController } from './ai.controller.js';
import { PaperRagService } from './paper-rag.service.js';
import { ConferenceWebsiteService } from './website/conference-website.service.js';

/** The AI features: form fill, screening help, topics, review help, paper RAG and chat. */
@Module({
  controllers: [AiController, PaperAiController],
  providers: [
    AiCoreService,
    AiToolsService,
    PaperRagService,
    ConferenceWebsiteService,
  ],
  exports: [PaperRagService],
})
export class AiModule {}
