import type { Readable } from 'node:stream';

export interface StorageAdapter {
  /** Signed, short-lived URL the browser uploads the binary to (PUT). */
  createUploadUrl(storageKey: string, opts: { ttlSeconds: number }): { url: string; expiresAt: Date };
  verifyUploadSignature(storageKey: string, expires: string, sig: string): boolean;
  verifyDownloadSignature(storageKey: string, expires: string, sig: string): boolean;
  createDownloadUrl(storageKey: string, ttlSeconds: number): string;
  putObject(storageKey: string, body: Buffer): Promise<void>;
  getObject(storageKey: string): Promise<Buffer>;
  getObjectStream(storageKey: string): Readable;
  statObject(storageKey: string): Promise<{ sizeBytes: number } | null>;
  deleteObject(storageKey: string): Promise<void>;
}
