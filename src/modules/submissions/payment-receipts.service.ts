import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppException } from '../../core/errors/app.exception.js';
import { FileStorage } from '../../core/storage/file-storage.js';
import { receiptContentType, receiptType } from './payment.js';

/** A receipt as Multer hands it over. */
export interface ReceiptUpload {
  originalname: string;
  size: number;
  buffer: Buffer;
}

export interface StoredReceipt {
  receiptPath: string;
  receiptName: string;
  receiptSize: number;
  receiptUploadedAt: Date;
}

export interface ReceiptFile {
  data: Buffer;
  fileName: string;
  contentType: string;
}

/** Receipts are small documents: a scan or a PDF. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/**
 * Payment receipts in storage, for papers and participants alike: checking an upload, putting it
 * away and reading it back. Who may do what is decided by the callers.
 */
@Injectable()
export class PaymentReceiptsService {
  constructor(private readonly storage: FileStorage) {}

  /**
   * Checks the file (PDF, JPG, PNG or WebP, at most 10 MB) and stores it at the key `keyFor`
   * builds from a new id and the file's extension. The caller deletes it again
   * (`discard`) if its transaction fails.
   */
  async store(
    file: ReceiptUpload | undefined,
    keyFor: (id: string, ext: string) => string,
  ): Promise<StoredReceipt> {
    if (!file || file.size === 0) {
      throw AppException.validation('Choose the receipt file to upload.');
    }
    if (file.size > MAX_RECEIPT_BYTES) {
      throw AppException.validation(
        'That file is too large: a receipt can be at most 10 MB.',
      );
    }
    const type = receiptType(file.originalname, file.buffer);
    if (!type) {
      throw AppException.validation(
        'A receipt must be a PDF, JPG, PNG or WebP file.',
      );
    }
    const key = keyFor(randomUUID(), type.ext);
    await this.storage.put(key, file.buffer, type.mime);
    return {
      receiptPath: key,
      receiptName: file.originalname.slice(-200) || `receipt.${type.ext}`,
      receiptSize: file.size,
      receiptUploadedAt: new Date(),
    };
  }

  async discard(stored: StoredReceipt | undefined): Promise<void> {
    if (stored) {
      await this.storage.delete(stored.receiptPath).catch(() => undefined);
    }
  }

  async read(row: {
    receiptPath: string | null;
    receiptName: string | null;
  }): Promise<ReceiptFile> {
    if (!row.receiptPath || !row.receiptName) {
      throw AppException.notFound('The receipt');
    }
    return {
      data: await this.storage.get(row.receiptPath),
      fileName: row.receiptName,
      contentType: receiptContentType(row.receiptPath),
    };
  }
}

/** No receipt (what clearing one stores). */
export const NO_RECEIPT = {
  receiptPath: null,
  receiptName: null,
  receiptSize: null,
  receiptUploadedAt: null,
};
