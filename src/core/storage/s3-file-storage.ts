import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { FileStorage } from './file-storage.js';

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** The S3 client for any S3-compatible service (Cloudflare R2, DigitalOcean Spaces, MinIO, AWS). */
export function createS3Client(options: S3StorageOptions): S3Client {
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    // Checksums only where the API requires them: not every S3-compatible service accepts the
    // newer default ones.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** Files in a bucket of an S3-compatible object store. Keys are used as object names as they are. */
export class S3FileStorage extends FileStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    super();
  }

  /** Refuses keys the local driver would refuse too, so both drivers accept the same keys. */
  private key(key: string): string {
    if (
      !key ||
      key.startsWith('/') ||
      key.includes('\\') ||
      key.split('/').some((part) => part === '..' || part === '.')
    ) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return key;
  }

  /** Fails with a readable message when the bucket can't be reached with these settings. */
  async verify(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      const reason =
        status === 404
          ? 'the bucket does not exist'
          : status === 401 || status === 403
            ? 'access denied (check S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and the key’s bucket permissions)'
            : error instanceof Error
              ? error.message
              : String(error);
      throw new Error(
        `File storage: cannot use bucket "${this.bucket}": ${reason}. Check the S3_* settings.`,
      );
    }
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: data,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
    );
    if (!result.Body) {
      throw new Error(`Empty response for storage key: ${key}`);
    }
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    // Deleting a missing object succeeds, as in the local driver.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
    );
  }

  async deleteFolder(prefix: string): Promise<void> {
    // Always end with "/", so "abc" never also matches "abcdef/…".
    const folder = this.key(prefix).replace(/\/*$/, '/');
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: folder,
          ContinuationToken: token,
        }),
      );
      const keys = (page.Contents ?? []).flatMap((o) =>
        o.Key ? [{ Key: o.Key }] : [],
      );
      // A page holds at most 1,000 keys, the most one DeleteObjects call takes.
      if (keys.length) {
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys, Quiet: true },
          }),
        );
        if (result.Errors?.length) {
          const first = result.Errors[0];
          throw new Error(
            `Could not delete ${result.Errors.length} file(s) under ${folder}: ${first.Key ?? ''} ${first.Message ?? first.Code ?? ''}`.trim(),
          );
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}
