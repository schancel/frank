import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { BlobStore } from './blob-store';

export interface LocalFsBlobStoreOptions {
  readonly storageDir?: string;
  readonly inMemory?: boolean;
}

export function getNamespacedPath(baseDir: string, key: string): string {
  const clean = key.replace(/^blob:\/\//, '').replace(/^\/+/, '');
  const segments = clean.split('/');
  const name = segments[segments.length - 1];

  let d1: string;
  let d2: string;
  let filename: string;

  if (/^[a-f0-9]{4,}/i.test(name)) {
    d1 = name.slice(0, 2).toLowerCase();
    d2 = name.slice(2, 4).toLowerCase();
    filename = name;
  } else {
    const hash = crypto.createHash('sha256').update(clean).digest('hex');
    d1 = hash.slice(0, 2);
    d2 = hash.slice(2, 4);
    filename = hash;
  }

  const prefixSegments = segments.slice(0, -1);
  return path.join(baseDir, ...prefixSegments, d1, d2, filename);
}

export class LocalFsBlobStore implements BlobStore {
  readonly storageDir: string;
  readonly inMemory: boolean;
  private readonly memoryBlobs = new Map<string, Uint8Array>();

  constructor(options?: LocalFsBlobStoreOptions) {
    this.inMemory = options?.inMemory ?? false;
    this.storageDir = options?.storageDir ?? './data/blobs';
  }

  async put(key: string, data: Uint8Array | string): Promise<string> {
    const cleanKey = key.replace(/^blob:\/\//, '');
    const bytes =
      typeof data === 'string'
        ? Buffer.from(data, 'utf-8')
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

    if (this.inMemory) {
      this.memoryBlobs.set(cleanKey, bytes);
      return `blob://${cleanKey}`;
    }

    const filePath = getNamespacedPath(this.storageDir, cleanKey);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, bytes);
    return `blob://${cleanKey}`;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const cleanKey = key.replace(/^blob:\/\//, '');

    if (this.inMemory) {
      const val = this.memoryBlobs.get(cleanKey);
      return val ? new Uint8Array(val) : null;
    }

    const filePath = getNamespacedPath(this.storageDir, cleanKey);
    try {
      const data = await fs.promises.readFile(filePath);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const cleanKey = key.replace(/^blob:\/\//, '');

    if (this.inMemory) {
      this.memoryBlobs.delete(cleanKey);
      return;
    }

    const filePath = getNamespacedPath(this.storageDir, cleanKey);
    try {
      await fs.promises.unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async has(key: string): Promise<boolean> {
    const cleanKey = key.replace(/^blob:\/\//, '');

    if (this.inMemory) {
      return this.memoryBlobs.has(cleanKey);
    }

    const filePath = getNamespacedPath(this.storageDir, cleanKey);
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
