import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export interface DkimKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface DkimSignerOptions {
  readonly domain: string;
  readonly selector: string;
  readonly privateKey: string;
  readonly signedHeaders?: string[];
}

export const DEFAULT_SIGNED_HEADERS = [
  'from',
  'to',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
];

/**
 * Generates an RSA-2048 keypair suitable for DKIM signing according to RFC 6376.
 */
export function generateDkimKeyPair(): DkimKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });
  return { publicKey, privateKey };
}

/**
 * Loads a private key from either a raw PEM string or a file path on disk.
 */
export function loadPrivateKey(keyOrPath: string): string {
  const trimmed = keyOrPath.trim();
  if (trimmed.includes('-----BEGIN') || trimmed.includes('PRIVATE KEY')) {
    return trimmed;
  }
  try {
    if (fs.existsSync(trimmed)) {
      return fs.readFileSync(trimmed, 'utf-8');
    }
  } catch {
    // If reading file fails, return raw string
  }
  return trimmed;
}

/**
 * A line ending: CRLF, a lone LF, or a lone CR. The transport sends each of
 * them as CRLF, so signing treats them alike and the bytes signed are the
 * bytes sent.
 */
const LINE_ENDING = '(?:\\r\\n|\\r(?!\\n)|\\n)';
const LINE_ENDING_PATTERN = new RegExp(LINE_ENDING, 'g');
const BLANK_LINE_PATTERN = new RegExp(LINE_ENDING + LINE_ENDING);
const FOLD_PATTERN = new RegExp(LINE_ENDING + '[ \\t]+', 'g');

/**
 * Splits an RFC 5322 message into headers section and body section.
 */
export function splitMessage(rawRfc822: string): { headers: string; body: string } {
  const match = rawRfc822.match(BLANK_LINE_PATTERN);
  if (!match || match.index === undefined) {
    return { headers: rawRfc822, body: '' };
  }
  const headers = rawRfc822.slice(0, match.index);
  const body = rawRfc822.slice(match.index + match[0].length);
  return { headers, body };
}

/**
 * Canonicalizes message body according to RFC 6376 Section 3.4.4 (relaxed body).
 */
export function canonicalizeBodyRelaxed(body: string): string {
  if (!body) {
    return '';
  }
  const normalized = body.replace(LINE_ENDING_PATTERN, '\r\n');
  const lines = normalized.split('\r\n');
  const processed: string[] = [];

  for (const line of lines) {
    // Reduce sequences of [ \t]+ to single SP and remove trailing WSP
    const cleaned = line.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, '');
    processed.push(cleaned);
  }

  // Remove trailing empty lines
  while (processed.length > 0 && processed[processed.length - 1] === '') {
    processed.pop();
  }

  if (processed.length === 0) {
    return '';
  }

  return processed.join('\r\n') + '\r\n';
}

/**
 * Computes base64 SHA-256 body hash (bh) under relaxed body canonicalization.
 */
export function computeBodyHash(body: string): string {
  const canonicalBody = canonicalizeBodyRelaxed(body);
  return crypto.createHash('sha256').update(canonicalBody, 'utf-8').digest('base64');
}

/**
 * Parses header fields from the header section, handling multiline unfolding.
 */
export function parseHeaderFields(
  headerSection: string
): Array<{ name: string; raw: string; value: string }> {
  const lines = headerSection.split(LINE_ENDING_PATTERN);
  const fields: Array<{ name: string; raw: string; value: string }> = [];

  for (const line of lines) {
    if (line.length === 0) continue;
    if (/^[ \t]/.test(line)) {
      // Multiline folding continuation of the previous header
      if (fields.length > 0) {
        const last = fields[fields.length - 1];
        last.raw += '\r\n' + line;
        last.value += ' ' + line.trim();
      }
    } else {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const name = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();
        fields.push({ name, raw: line, value });
      }
    }
  }
  return fields;
}

/**
 * Canonicalizes a single header field according to RFC 6376 Section 3.4.2 (relaxed header).
 */
export function canonicalizeHeaderRelaxed(headerLine: string): string {
  const colonIndex = headerLine.indexOf(':');
  if (colonIndex === -1) {
    return '';
  }
  const name = headerLine.slice(0, colonIndex).toLowerCase().trim();
  let value = headerLine.slice(colonIndex + 1);

  // Unfold continuation lines
  value = value.replace(FOLD_PATTERN, ' ');
  // Convert sequences of [ \t]+ to single SP
  value = value.replace(/[ \t]+/g, ' ');
  // Delete leading whitespace after colon and trailing whitespace
  value = value.trim();

  return `${name}:${value}\r\n`;
}

/**
 * DKIM Signer implementing RFC 6376 standard RSA-SHA256 signing with relaxed/relaxed canonicalization.
 */
export class DkimSigner {
  readonly domain: string;
  readonly selector: string;
  readonly privateKey: string;
  readonly signedHeaders: string[];

  constructor(options: DkimSignerOptions) {
    this.domain = options.domain.toLowerCase().trim();
    this.selector = options.selector.trim();
    this.privateKey = loadPrivateKey(options.privateKey);
    this.signedHeaders = options.signedHeaders ?? DEFAULT_SIGNED_HEADERS;
  }

  /**
   * Signs an RFC 5322 message and appends the DKIM-Signature header.
   */
  sign(rawRfc822: string | Uint8Array): string {
    const rawText =
      typeof rawRfc822 === 'string'
        ? rawRfc822
        : new TextDecoder('utf-8').decode(rawRfc822);

    const { headers: headerSection, body: bodySection } = splitMessage(rawText);
    const bodyHash = computeBodyHash(bodySection);
    const parsedFields = parseHeaderFields(headerSection);

    // Pick headers to sign in order
    const canonicalHeadersToSign: string[] = [];
    const signedHeaderNames: string[] = [];

    for (const hName of this.signedHeaders) {
      const match = parsedFields.find((f) => f.name === hName.toLowerCase());
      if (match) {
        canonicalHeadersToSign.push(canonicalizeHeaderRelaxed(match.raw));
        signedHeaderNames.push(match.name);
      }
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const dkimHeaderWithoutB =
      `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${this.domain}; ` +
      `s=${this.selector}; t=${timestamp}; h=${signedHeaderNames.join(':')}; bh=${bodyHash}; b=`;

    const canonicalDkimHeader = canonicalizeHeaderRelaxed(dkimHeaderWithoutB);
    const dataToSign = canonicalHeadersToSign.join('') + canonicalDkimHeader;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(dataToSign, 'utf-8');
    const signature = signer.sign(this.privateKey, 'base64');

    const formattedDkimHeader = `${dkimHeaderWithoutB}${signature}`;

    // Append formatted DKIM-Signature to the header section
    const normalizedHeaders = headerSection ? headerSection.replace(LINE_ENDING_PATTERN, '\r\n') : '';
    const normalizedBody = bodySection ? bodySection.replace(LINE_ENDING_PATTERN, '\r\n') : '';

    if (normalizedHeaders.length > 0) {
      return `${normalizedHeaders}\r\n${formattedDkimHeader}\r\n\r\n${normalizedBody}`;
    } else {
      return `${formattedDkimHeader}\r\n\r\n${normalizedBody}`;
    }
  }

  signMessage(rawRfc822: string | Uint8Array): string {
    return this.sign(rawRfc822);
  }

  /**
   * Verifies the DKIM signature of a signed message using the corresponding public key.
   */
  verify(rawRfc822: string | Uint8Array, publicKey?: string): boolean {
    const key = publicKey || this.getPublicKey();
    return verifyDkimSignature(rawRfc822, key);
  }

  private getPublicKey(): string {
    return crypto
      .createPublicKey(this.privateKey)
      .export({ type: 'spki', format: 'pem' }) as string;
  }
}

/**
 * Standalone verification for RFC 6376 DKIM signature (RSA-SHA256, relaxed/relaxed).
 */
export function verifyDkimSignature(
  rawRfc822: string | Uint8Array,
  publicKey: string
): boolean {
  try {
    const rawText =
      typeof rawRfc822 === 'string'
        ? rawRfc822
        : new TextDecoder('utf-8').decode(rawRfc822);

    const { headers: headerSection, body: bodySection } = splitMessage(rawText);
    const parsedFields = parseHeaderFields(headerSection);

    const dkimField = parsedFields.find((f) => f.name === 'dkim-signature');
    if (!dkimField) {
      return false;
    }

    // Extract tags from dkim-signature value
    const unfoldedDkim = dkimField.raw.replace(FOLD_PATTERN, ' ');
    const tagMatches = unfoldedDkim.slice(unfoldedDkim.indexOf(':') + 1).split(';');
    const tags = new Map<string, string>();
    for (const tag of tagMatches) {
      const eqIdx = tag.indexOf('=');
      if (eqIdx > 0) {
        const k = tag.slice(0, eqIdx).trim().toLowerCase();
        const v = tag.slice(eqIdx + 1).trim();
        tags.set(k, v);
      }
    }

    if (tags.get('a') !== 'rsa-sha256') {
      return false;
    }

    const cTag = (tags.get('c') || '').toLowerCase();
    if (cTag && !cTag.includes('relaxed')) {
      return false;
    }

    const bh = tags.get('bh');
    const b = tags.get('b');
    const h = tags.get('h');
    if (!bh || !b || !h) {
      return false;
    }

    // Verify body hash
    const computedBh = computeBodyHash(bodySection);
    if (computedBh !== bh) {
      return false;
    }

    // Canonicalize signed headers in order of h tag
    const headerNamesToVerify = h.split(':').map((s) => s.trim().toLowerCase());
    const canonicalHeadersToVerify: string[] = [];

    for (const hName of headerNamesToVerify) {
      // Find matching header (excluding dkim-signature itself)
      const match = parsedFields.find(
        (f) => f.name === hName && f !== dkimField
      );
      if (match) {
        canonicalHeadersToVerify.push(canonicalizeHeaderRelaxed(match.raw));
      }
    }

    // Canonicalize DKIM-Signature header with b= empty
    const dkimHeaderWithoutB = dkimField.raw.replace(/b=[^;\r\n]*/, 'b=');
    const canonicalDkimHeader = canonicalizeHeaderRelaxed(dkimHeaderWithoutB);

    const dataToVerify = canonicalHeadersToVerify.join('') + canonicalDkimHeader;

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(dataToVerify, 'utf-8');
    return verifier.verify(publicKey, b, 'base64');
  } catch {
    return false;
  }
}
