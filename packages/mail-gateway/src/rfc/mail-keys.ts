/**
 * The two content keys of the mail journal (contract section 21.2).
 *
 * Pure: no I/O, clock, randomness or shared state. Both results are 64
 * lower-case hex characters, the form the journal stores and compares. They
 * are durable keys: changing what either function hashes changes its tag and
 * the journal format in the same change.
 *
 * Mail key: identity of one RFC 5322 message, computed over its bytes (the
 * SMTP `DATA` bytes after dot-unstuffing, or the exact signed bytes a job
 * stores).
 *
 *   SHA-256( "frank-mail-key/1" 0x00
 *            H(from) H(to) H(cc) H(subject) H(date)
 *            H(message-id) H(in-reply-to) H(references)
 *            body' )
 *   H(name) = u32be(count), then per occurrence in section order:
 *             u32be(length) value'
 *
 * - Headers and the body offset come from `readHeaderSection` and nowhere
 *   else. `value'` is that reader's value (name matched lowercased,
 *   continuation lines appended as written) with leading and trailing space,
 *   tab and CR removed, as Latin-1 bytes, which are the bytes of the input.
 *   An absent header is count 0; a header present with an empty value is count
 *   1 and length 0. Every other header (trace, signature, MIME) is outside the
 *   key, and so is the position of a header among headers of other names.
 * - `body'` is the bytes from the body offset with each line ending (CRLF, a
 *   lone LF, a lone CR) written as CRLF, all trailing empty lines removed and
 *   exactly one CRLF at the end; an empty body is one CRLF. This is what the
 *   signer and the outbound transport do to a body, so a message keys alike
 *   before and after the gateway sends it. In the header section a lone CR
 *   stays a byte of its line, as the header reader has it.
 *
 * Item key: identity of what a Frank user authored, independent of the seal.
 *
 *   SHA-256( "frank-email-item-key/1" 0x00
 *            S(messageId) O(inReplyTo) L(references)
 *            L(to[i].address) L(cc[i].address) S(subject) S(textBody) O(htmlBody) )
 *   S(x)  = u32be(UTF-8 byte length) UTF-8 bytes
 *   O(x)  = 0x00 if undefined, else 0x01 S(x)
 *   L(xs) = u32be(count) S(each), in item order; undefined is count 0
 *
 * - Strings exactly as the item carries them: no case folding, trimming,
 *   sorting or de-duplication.
 * - Outside the key: the seal (payload digest, sealed message ID, stamp),
 *   conversation, received time, `from`, `replyTo`, display names, `bcc` and
 *   attachments.
 */

import { createHash, type Hash } from 'node:crypto';

import { readHeaderSection } from './message-headers';

const MAIL_KEY_TAG = 'frank-mail-key/1';
const ITEM_KEY_TAG = 'frank-email-item-key/1';

/** The headers inside the mail key, lowercased, in the order they are hashed. */
const MAIL_KEY_HEADERS = [
  'from',
  'to',
  'cc',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
] as const;

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const CRLF = Buffer.from([CR, LF]);

function u32be(value: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32BE(value, 0);
  return out;
}

function tagged(tag: string): Hash {
  return createHash('sha256').update(tag, 'latin1').update(Buffer.from([0x00]));
}

function isOuterWhitespace(code: number): boolean {
  return code === SPACE || code === TAB || code === CR;
}

/** The value without leading and trailing spaces, tabs and CRs. */
function trimHeaderValue(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isOuterWhitespace(value.charCodeAt(start))) start++;
  while (end > start && isOuterWhitespace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

/**
 * The body with each line ending (CRLF, a lone LF, a lone CR) written as
 * CRLF, trailing empty lines removed and one CRLF at the end. An empty body is
 * one CRLF. CR CR LF is two line endings: a lone CR, then CRLF.
 */
function normalisedBody(body: Buffer): Buffer {
  // Each input byte gives at most two output bytes (a lone CR or LF), plus a final CRLF.
  const out = Buffer.allocUnsafe(body.length * 2 + 2);
  let written = 0;
  /** Length of the output up to and including the last non-empty line. */
  let kept = 0;
  let lineHasBytes = false;
  const endLine = (): void => {
    out[written++] = CR;
    out[written++] = LF;
    if (lineHasBytes) kept = written;
    lineHasBytes = false;
  };
  for (let i = 0; i < body.length; i++) {
    const byte = body[i];
    if (byte === CR) {
      if (body[i + 1] === LF) i++;
      endLine();
    } else if (byte === LF) {
      endLine();
    } else {
      out[written++] = byte;
      lineHasBytes = true;
    }
  }
  if (lineHasBytes) endLine();
  return kept === 0 ? CRLF : out.subarray(0, kept);
}

/**
 * The mail key of an RFC 5322 message: 64 lower-case hex characters. Accepts
 * any bytes and never throws. See the module comment for the definition.
 */
export function mailKey(raw: Uint8Array): string {
  const { fields, bodyOffset } = readHeaderSection(raw);
  const hash = tagged(MAIL_KEY_TAG);
  for (const name of MAIL_KEY_HEADERS) {
    const values = fields.filter(([n]) => n === name).map(([, v]) => trimHeaderValue(v));
    hash.update(u32be(values.length));
    for (const value of values) {
      const bytes = Buffer.from(value, 'latin1');
      hash.update(u32be(bytes.length)).update(bytes);
    }
  }
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  hash.update(normalisedBody(bytes.subarray(bodyOffset)));
  return hash.digest('hex');
}

/** The authored fields of an email item that the item key covers. */
export interface EmailItemKeyInput {
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly to?: ReadonlyArray<{ readonly address: string }>;
  readonly cc?: ReadonlyArray<{ readonly address: string }>;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string;
}

function hashString(hash: Hash, label: string, value: string): void {
  // A value of another type must not be hashed as if it were text.
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const bytes = Buffer.from(value, 'utf8');
  hash.update(u32be(bytes.length)).update(bytes);
}

function hashOptionalString(hash: Hash, label: string, value: string | undefined): void {
  if (value === undefined) {
    hash.update(Buffer.from([0x00]));
    return;
  }
  hash.update(Buffer.from([0x01]));
  hashString(hash, label, value);
}

function hashStringList(hash: Hash, label: string, values: readonly string[] | undefined): void {
  if (values === undefined) {
    hash.update(u32be(0));
    return;
  }
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  hash.update(u32be(values.length));
  values.forEach((value, i) => hashString(hash, `${label}[${i}]`, value));
}

/**
 * The item key of an authored email item: 64 lower-case hex characters. The
 * item must be the decoded item of a message that passed validation; a field
 * of the wrong type throws a `TypeError`. See the module comment for the
 * definition.
 */
export function emailItemKey(item: EmailItemKeyInput): string {
  const hash = tagged(ITEM_KEY_TAG);
  hashString(hash, 'messageId', item.messageId);
  hashOptionalString(hash, 'inReplyTo', item.inReplyTo);
  hashStringList(hash, 'references', item.references);
  hashStringList(hash, 'to', item.to?.map((party) => party.address));
  hashStringList(hash, 'cc', item.cc?.map((party) => party.address));
  hashString(hash, 'subject', item.subject);
  hashString(hash, 'textBody', item.textBody);
  hashOptionalString(hash, 'htmlBody', item.htmlBody);
  return hash.digest('hex');
}
