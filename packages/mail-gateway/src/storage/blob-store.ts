import { GatewayConfig } from '../types';
import { LocalFsBlobStore } from './local-fs-blob-store';
import { S3BlobStore } from './s3-blob-store';

export interface BlobStore {
  put(key: string, data: Uint8Array | string): Promise<string>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

export const BLOB_OFFLOAD_THRESHOLD_BYTES = 64 * 1024; // 64 KB

export function createBlobStore(config: GatewayConfig): BlobStore {
  const blobConfig = config.blobStorage;
  const isS3 =
    blobConfig?.provider === 's3' ||
    Boolean(config.s3Bucket) ||
    Boolean(blobConfig?.s3Bucket);

  if (isS3) {
    const bucket = config.s3Bucket ?? blobConfig?.s3Bucket;
    if (!bucket) {
      throw new Error('S3 bucket must be specified when S3 blob store is configured');
    }
    return new S3BlobStore({
      endpoint: config.s3Endpoint ?? blobConfig?.s3Endpoint,
      bucket,
      accessKeyId: (config.s3AccessKeyId ?? blobConfig?.s3AccessKeyId) ?? '',
      secretAccessKey: (config.s3SecretAccessKey ?? blobConfig?.s3SecretAccessKey) ?? '',
      region: config.s3Region ?? blobConfig?.s3Region ?? 'us-east-1',
      forcePathStyle: config.s3ForcePathStyle ?? blobConfig?.s3ForcePathStyle ?? true,
    });
  }

  if (blobConfig?.provider === 'memory') {
    return new LocalFsBlobStore({ inMemory: true });
  }

  const storageDir = config.storageDir ?? blobConfig?.storageDir ?? './data/blobs';
  return new LocalFsBlobStore({ storageDir });
}
