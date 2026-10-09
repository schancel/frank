/**
 * RFC 5322 thread-header reader and writer (Message-ID, In-Reply-To, References).
 *
 * Pure: no I/O, clock, randomness or shared state. A message ID is an opaque
 * identifier: it is accepted or rejected as written and is never trimmed,
 * lowercased, unbracketed or otherwise normalised, so two distinct IDs can
 * never compare equal after processing. Nothing here infers a parent from a
 * subject, a recipient or recency.
 */

/** Length bounds of a whole message ID, brackets included. */
export const MESSAGE_ID_MIN_LENGTH = 5;
export const MESSAGE_ID_MAX_LENGTH = 256;

/** Longest rendered header line, unless a single ID is longer. */
const MAX_LINE_LENGTH = 78;

const ID_CHARS = '\\x21-\\x3b\\x3d\\x3f\\x41-\\x7e';
const ID_SOURCE = `<[${ID_CHARS}]+@[${ID_CHARS}]+>`;
const ID_SCAN = new RegExp(ID_SOURCE, 'g');
const ID_EXACT = new RegExp(`^${ID_SOURCE}$`);

function isMessageId(candidate: string): boolean {
  return (
    candidate.length >= MESSAGE_ID_MIN_LENGTH &&
    candidate.length <= MESSAGE_ID_MAX_LENGTH &&
    ID_EXACT.test(candidate)
  );
}

/** Every well-formed ID in the value, in order, exactly as written. */
function scanMessageIds(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(ID_SCAN)) {
    if (isMessageId(match[0])) found.push(match[0]);
  }
  return found;
}

/** The first well-formed ID in the value, brackets included, or undefined. */
export function parseMessageId(value: string): string | undefined {
  return scanMessageIds(value)[0];
}

/** Every well-formed ID in the value, in order. Text between matches is ignored. */
export function parseMessageIdList(value: string): string[] {
  return scanMessageIds(value);
}

export type ThreadHeadersReadResult =
  | { ok: true; messageId?: string; inReplyTo?: string; references: string[] }
  | { ok: false; reason: 'duplicate_header' | 'bad_message_id' };

/** Header section as unfolded `[lowercased name, value]` pairs. */
function readHeaderFields(raw: Uint8Array): Array<[string, string]> {
  // Latin-1 keeps bytes one-to-one; non-ASCII bytes can never be part of an ID.
  const text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('latin1');
  const lines = text.split(/\r\n|\n/);
  const fields: Array<[string, string]> = [];
  for (const line of lines) {
    if (line === '') break;
    if (line[0] === ' ' || line[0] === '\t') {
      const last = fields[fields.length - 1];
      if (last) last[1] += line;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields.push([line.slice(0, colon).replace(/[ \t]+$/, '').toLowerCase(), line.slice(colon + 1)]);
  }
  return fields;
}

export function readThreadHeaders(raw: Uint8Array): ThreadHeadersReadResult {
  const fields = readHeaderFields(raw);
  const pick = (name: string): string | undefined => {
    const values = fields.filter(([n]) => n === name).map(([, v]) => v);
    return values.length === 1 ? values[0] : undefined;
  };
  const count = (name: string): number => fields.filter(([n]) => n === name).length;
  for (const name of ['message-id', 'in-reply-to', 'references']) {
    if (count(name) > 1) return { ok: false, reason: 'duplicate_header' };
  }

  const result: { ok: true; messageId?: string; inReplyTo?: string; references: string[] } = {
    ok: true,
    references: [],
  };

  const messageIdValue = pick('message-id');
  if (messageIdValue !== undefined) {
    // A Message-ID names exactly one message: none or several is not an identity.
    const ids = scanMessageIds(messageIdValue);
    if (ids.length !== 1) return { ok: false, reason: 'bad_message_id' };
    result.messageId = ids[0];
  }
  const inReplyToValue = pick('in-reply-to');
  if (inReplyToValue !== undefined) {
    const first = parseMessageId(inReplyToValue);
    if (first !== undefined) result.inReplyTo = first;
  }
  const referencesValue = pick('references');
  if (referencesValue !== undefined) result.references = parseMessageIdList(referencesValue);
  return result;
}

function requireMessageId(label: string, id: string): void {
  if (!isMessageId(id)) throw new Error(`${label} is not a valid message ID`);
}

export function renderThreadHeaders(h: {
  messageId: string;
  inReplyTo?: string;
  references: readonly string[];
}): string {
  requireMessageId('messageId', h.messageId);
  if (h.inReplyTo !== undefined) requireMessageId('inReplyTo', h.inReplyTo);
  h.references.forEach((id, i) => requireMessageId(`references[${i}]`, id));

  let out = `Message-ID: ${h.messageId}\r\n`;
  if (h.inReplyTo !== undefined) out += `In-Reply-To: ${h.inReplyTo}\r\n`;
  if (h.references.length > 0) {
    let line = 'References:';
    let lineHasId = false;
    for (const id of h.references) {
      if (lineHasId && line.length + 1 + id.length > MAX_LINE_LENGTH) {
        out += `${line}\r\n`;
        line = ` ${id}`;
      } else {
        line += ` ${id}`;
      }
      lineHasId = true;
    }
    out += `${line}\r\n`;
  }
  return out;
}

/** Throws if any code unit is a control character (below 0x20) or DEL (0x7f). */
export function assertHeaderValue(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`header value contains a control character at index ${i}`);
    }
  }
}
