import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import type { StorageAdapter } from './storage.interface.js';

const sign = (data: string) => crypto.createHmac('sha256', env.UPLOAD_SIGNING_SECRET).update(data).digest('hex');

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export class LocalStorageAdapter implements StorageAdapter {
  private resolve(key: string) {
    const full = path.resolve(env.STORAGE_LOCAL_DIR, key);
    if (!full.startsWith(env.STORAGE_LOCAL_DIR + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  createUploadUrl(storageKey: string, opts: { ttlSeconds: number }) {
    const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000);
    const expires = String(Math.floor(expiresAt.getTime() / 1000));
    const sig = sign(`PUT\n${storageKey}\n${expires}`);
    const url = `${env.STORAGE_PUBLIC_BASE_URL}/api/v1/media/uploads/${encodeURIComponent(storageKey)}?expires=${expires}&sig=${sig}`;
    return { url, expiresAt };
  }

  verifyUploadSignature(storageKey: string, expires: string, sig: string) {
    if (!/^\d+$/.test(expires) || Number(expires) * 1000 < Date.now()) return false;
    return safeEqual(sign(`PUT\n${storageKey}\n${expires}`), sig);
  }

  createDownloadUrl(storageKey: string, ttlSeconds: number) {
    const expires = String(Math.floor(Date.now() / 1000) + ttlSeconds);
    const sig = sign(`GET\n${storageKey}\n${expires}`);
    return `${env.STORAGE_PUBLIC_BASE_URL}/api/v1/media/files/${encodeURIComponent(storageKey)}?expires=${expires}&sig=${sig}`;
  }

  verifyDownloadSignature(storageKey: string, expires: string, sig: string) {
    if (!/^\d+$/.test(expires) || Number(expires) * 1000 < Date.now()) return false;
    return safeEqual(sign(`GET\n${storageKey}\n${expires}`), sig);
  }

  async putObject(storageKey: string, body: Buffer) {
    const full = this.resolve(storageKey);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, body);
  }

  getObject(storageKey: string) {
    return fsp.readFile(this.resolve(storageKey));
  }

  getObjectStream(storageKey: string) {
    return fs.createReadStream(this.resolve(storageKey));
  }

  async statObject(storageKey: string) {
    try {
      const s = await fsp.stat(this.resolve(storageKey));
      return { sizeBytes: s.size };
    } catch {
      return null;
    }
  }

  async deleteObject(storageKey: string) {
    await fsp.rm(this.resolve(storageKey), { force: true });
  }
}

export const storage: StorageAdapter = new LocalStorageAdapter();
