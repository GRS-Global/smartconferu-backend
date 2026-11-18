import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

/** Uploads that are not tied to a paper: profile photo, conference logo, review instructions, screening report. */
@Module({
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
