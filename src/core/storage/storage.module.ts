import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { FileStorage, LocalFileStorage } from './file-storage.js';
import { createS3Client, S3FileStorage } from './s3-file-storage.js';

@Global()
@Module({
  providers: [
    {
      provide: FileStorage,
      inject: [ConfigService],
      useFactory: async (
        config: ConfigService<Env, true>,
      ): Promise<FileStorage> => {
        if (config.get('FILE_STORAGE_DRIVER', { infer: true }) === 'local') {
          return new LocalFileStorage(
            config.get('FILE_STORAGE_DIR', { infer: true }),
          );
        }
        // validateEnv makes sure every S3_* value is set for this driver.
        const bucket = config.get('S3_BUCKET', { infer: true })!;
        const storage = new S3FileStorage(
          createS3Client({
            endpoint: config.get('S3_ENDPOINT', { infer: true })!,
            region: config.get('S3_REGION', { infer: true }),
            bucket,
            accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true })!,
            secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', {
              infer: true,
            })!,
            forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
          }),
          bucket,
        );
        // Wrong keys or bucket stop the start, instead of failing at the first upload.
        await storage.verify();
        return storage;
      },
    },
  ],
  exports: [FileStorage],
})
export class StorageModule {}
