/**
 * The two content keys of the mail journal (contract section 21.2).
 *
 * Pure: no I/O, clock, randomness or shared state. Both results are 64
 * lower-case hex characters, the form the journal stores and compares. They
 * are durable keys: changing what either function hashes changes its tag and
 * the journal format in the same change.
 *
 * Mail key: identity of one RFC 5322 message by eight of its headers and its
 * body, computed over its bytes (the SMTP `DATA` bytes after dot-unstuffing,
 * or the exact signed bytes a job stores).
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
 *   continuation lines appended, so the line break of a fold is gone and its
 *   whitespace stays) with every run of spaces and tabs written as one space,
 *   then spaces, tabs and CRs removed from both ends. Letter case and every
 *   other byte are kept; the bytes hashed are the bytes of the input (the
 *   reader's Latin-1 text, one byte per character). An absent header is count
 *   0; a header present with an empty value is count 1 and length 0.
 * - `body'` is the bytes from the body offset, line by line. Each line ending
 *   (CRLF, a lone LF, a lone CR) is written as CRLF. On each line, spaces and
 *   tabs at the end are removed and every other run of spaces and tabs is
 *   written as one space. Then all trailing empty lines are removed, a line
 *   left empty by the step before included, and the body ends with exactly one
 *   CRLF; an empty body is one CRLF. This is the relaxed body canonicalisation
 *   of RFC 6376 section 3.4.4, except that an empty body is one CRLF. In the
 *   header section a lone CR stays a byte of its line, as the header reader
 *   has it.
 * - Stable under what relaxed/relaxed DKIM canonicalisation tolerates (RFC
 *   6376 sections 3.4.2 and 3.4.4): the gateway signs that way, so a relay may
 *   refold a header at whitespace, change the length of a whitespace run or
 *   strip trailing whitespace from a body line without breaking the signature,
 *   and the key does not change either. A fold put where there was no
 *   whitespace, whitespace removed entirely between two words, and any other
 *   changed byte give another key.
 * - Deliberately outside the key: every header other than the eight. That
 *   includes Content-Type, Content-Transfer-Encoding, MIME-Version, Reply-To,
 *   Sender, Bcc, Received and DKIM-Signature, and the position of a header
 *   among headers of other names. Two emails with the same eight headers and
 *   the same body bytes therefore have the same key even when their Reply-To,
 *   charset or transfer encoding differ, and so may read differently to a
 *   person. The key compares bytes; it decodes nothing.
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

/**
 * The bytes of a header value with every run of spaces and tabs written as
 * one space, then spaces, tabs and CRs removed from both ends.
 */
function canonicalHeaderValue(value: string): Buffer {
  // Latin-1 gives back the bytes the reader decoded, one per character.
  const bytes = Buffer.from(value, 'latin1');
  const out = Buffer.allocUnsafe(bytes.length);
  let written = 0;
  let inRun = false;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === SPACE || byte === TAB) {
      if (!inRun) out[written++] = SPACE;
      inRun = true;
    } else {
      out[written++] = byte;
      inRun = false;
    }
  }
  let start = 0;
  let end = written;
  while (start < end && (out[start] === SPACE || out[start] === CR)) start++;
  while (end > start && (out[end - 1] === SPACE || out[end - 1] === CR)) end--;
  return out.subarray(start, end);
}

/**
 * The body in the relaxed form of RFC 6376 section 3.4.4: each line ending
 * (CRLF, a lone LF, a lone CR) written as CRLF; on each line, spaces and tabs
 * at the end removed and every other run of them written as one space; then
 * trailing empty lines removed and one CRLF at the end. An empty body is one
 * CRLF. CR CR LF is two line endings: a lone CR, then CRLF.
 */
function normalisedBody(body: Buffer): Buffer {
  // Each input byte gives at most two output bytes (a lone CR or LF), plus a final CRLF.
  const out = Buffer.allocUnsafe(body.length * 2 + 2);
  let written = 0;
  /** Length of the output up to and including the last non-empty line. */
  let kept = 0;
  let lineHasBytes = false;
  /** Spaces or tabs were read and no other byte of the line has followed yet. */
  let pendingSpace = false;
  const endLine = (): void => {
    out[written++] = CR;
    out[written++] = LF;
    if (lineHasBytes) kept = written;
    lineHasBytes = false;
    pendingSpace = false;
  };
  for (let i = 0; i < body.length; i++) {
    const byte = body[i];
    if (byte === CR) {
      if (body[i + 1] === LF) i++;
      endLine();
    } else if (byte === LF) {
      endLine();
    } else if (byte === SPACE || byte === TAB) {
      pendingSpace = true;
    } else {
      if (pendingSpace) out[written++] = SPACE;
      pendingSpace = false;
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
    const values = fields.filter(([n]) => n === name).map(([, v]) => canonicalHeaderValue(v));
    hash.update(u32be(values.length));
    for (const bytes of values) hash.update(u32be(bytes.length)).update(bytes);
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

/** The addresses of a party list; undefined stays undefined, anything but an array is refused. */
function addresses(
  label: string,
  parties: ReadonlyArray<{ readonly address: string }> | undefined,
): string[] | undefined {
  if (parties === undefined) return undefined;
  if (!Array.isArray(parties)) throw new TypeError(`${label} must be an array`);
  return parties.map((party, i) => {
    if (party === null || typeof party !== 'object') throw new TypeError(`${label}[${i}] must be an object`);
    return party.address;
  });
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
  hashStringList(hash, 'to', addresses('to', item.to));
  hashStringList(hash, 'cc', addresses('cc', item.cc));
  hashString(hash, 'subject', item.subject);
  hashString(hash, 'textBody', item.textBody);
  hashOptionalString(hash, 'htmlBody', item.htmlBody);
  return hash.digest('hex');
}
