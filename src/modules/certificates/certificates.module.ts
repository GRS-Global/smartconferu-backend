import { Module } from '@nestjs/common';
import {
  AssetsController,
  CertificatesController,
  SignaturesController,
} from './certificates.controller.js';
import { AssetsService } from './assets.service.js';
import { CertificatesService } from './certificates.service.js';
import { SignaturesService } from './signatures.service.js';

/** Certificate designs, sends, issued certificates and verification, plus the conference signature library. */
@Module({
  controllers: [CertificatesController, SignaturesController, AssetsController],
  providers: [CertificatesService, SignaturesService, AssetsService],
})
export class CertificatesModule {}
