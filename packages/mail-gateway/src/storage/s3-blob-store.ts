import * as crypto from 'node:crypto';
import { BlobStore } from './blob-store';

export interface S3BlobStoreOptions {
  readonly endpoint?: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string;
  readonly forcePathStyle?: boolean;
  readonly fetchFn?: typeof fetch;
}

export class S3BlobStore implements BlobStore {
  readonly endpoint?: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly forcePathStyle: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(options: S3BlobStoreOptions) {
    this.endpoint = options.endpoint;
    this.bucket = options.bucket;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.region = options.region ?? 'us-east-1';
    this.forcePathStyle = options.forcePathStyle ?? (options.endpoint !== undefined);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  buildUrl(cleanKey: string): URL {
    const encodedKey = cleanKey
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    if (this.endpoint) {
      const base = this.endpoint.replace(/\/+$/, '');
      if (this.forcePathStyle) {
        return new URL(`${base}/${encodeURIComponent(this.bucket)}/${encodedKey}`);
      } else {
        const baseUrl = new URL(base);
        return new URL(`${baseUrl.protocol}//${this.bucket}.${baseUrl.host}/${encodedKey}`);
      }
    }

    if (this.forcePathStyle) {
      return new URL(`https://s3.${this.region}.amazonaws.com/${this.bucket}/${encodedKey}`);
    } else {
      return new URL(`https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodedKey}`);
    }
  }

  signRequest(
    method: string,
    url: URL,
    body: Buffer,
    extraHeaders: Record<string, string> = {}
  ): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = crypto.createHash('sha256').update(body).digest('hex');

    const headersToSign: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };

    const sortedHeaderKeys = Object.keys(headersToSign).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    const canonicalHeaders = sortedHeaderKeys
      .map((k) => `${k.toLowerCase()}:${headersToSign[k].trim()}\n`)
      .join('');

    const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(';');

    const canonicalUri = url.pathname || '/';
    const canonicalQueryString = url.search
      ? url.search
          .slice(1)
          .split('&')
          .sort()
          .join('&')
      : '';

    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const hashedCanonicalRequest = crypto
      .createHash('sha256')
      .update(canonicalRequest, 'utf-8')
      .digest('hex');

    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      hashedCanonicalRequest,
    ].join('\n');

    const kDate = crypto
      .createHmac('sha256', 'AWS4' + this.secretAccessKey)
      .update(dateStamp, 'utf-8')
      .digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(this.region, 'utf-8').digest();
    const kService = crypto.createHmac('sha256', kRegion).update('s3', 'utf-8').digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request', 'utf-8').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf-8').digest('hex');

    const authorization = `${algorithm} Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      ...headersToSign,
      Authorization: authorization,
    };
  }

  async put(key: string, data: Uint8Array | string): Promise<string> {
    const cleanKey = key.replace(/^blob:\/\//, '').replace(/^\/+/, '');
    const body =
      typeof data === 'string'
        ? Buffer.from(data, 'utf-8')
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

    const url = this.buildUrl(cleanKey);
    const headers = this.signRequest('PUT', url, body, {
      'content-type': 'message/rfc822',
      'content-length': String(body.length),
    });

    const response = await this.fetchFn(url.toString(), {
      method: 'PUT',
      headers,
      body: new Uint8Array(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`S3 PutObject failed with HTTP ${response.status}: ${errorText}`);
    }

    return `blob://${cleanKey}`;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const cleanKey = key.replace(/^blob:\/\//, '').replace(/^\/+/, '');
    const url = this.buildUrl(cleanKey);
    const body = Buffer.alloc(0);
    const headers = this.signRequest('GET', url, body);

    const response = await this.fetchFn(url.toString(), {
      method: 'GET',
      headers,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`S3 GetObject failed with HTTP ${response.status}: ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  async delete(key: string): Promise<void> {
    const cleanKey = key.replace(/^blob:\/\//, '').replace(/^\/+/, '');
    const url = this.buildUrl(cleanKey);
    const body = Buffer.alloc(0);
    const headers = this.signRequest('DELETE', url, body);

    const response = await this.fetchFn(url.toString(), {
      method: 'DELETE',
      headers,
    });

    if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(`S3 DeleteObject failed with HTTP ${response.status}: ${errorText}`);
    }
  }

  async has(key: string): Promise<boolean> {
    const cleanKey = key.replace(/^blob:\/\//, '').replace(/^\/+/, '');
    const url = this.buildUrl(cleanKey);
    const body = Buffer.alloc(0);
    const headers = this.signRequest('HEAD', url, body);

    const response = await this.fetchFn(url.toString(), {
      method: 'HEAD',
      headers,
    });

    if (response.status === 200) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }

    const errorText = await response.text();
    throw new Error(`S3 HeadObject failed with HTTP ${response.status}: ${errorText}`);
  }
}
