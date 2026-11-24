import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Where uploaded files live. Keys are paths like `<conference>/<submission>/<name>`. One
 * implementation per FILE_STORAGE_DRIVER: `local` (a folder, for development and tests) and `s3`
 * (any S3-compatible store: Cloudflare R2, DigitalOcean Spaces, MinIO…, in s3-file-storage.ts).
 */
export abstract class FileStorage {
  abstract put(key: string, data: Buffer, contentType: string): Promise<void>;
  abstract get(key: string): Promise<Buffer>;
  abstract delete(key: string): Promise<void>;
  /** Removes everything under a folder (e.g. all of one person's files). Nothing to remove is not an error. */
  abstract deleteFolder(prefix: string): Promise<void>;
}

/** Files in a folder on this machine. */
export class LocalFileStorage extends FileStorage {
  private readonly root: string;

  constructor(directory: string) {
    super();
    this.root = resolve(directory);
  }

  /** The file's path, refusing any key that would leave the storage folder. */
  private path(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async deleteFolder(prefix: string): Promise<void> {
    await rm(this.path(prefix), { recursive: true, force: true });
  }
}
