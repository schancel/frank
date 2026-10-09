/**
 * RFC 5322 thread-header reader and writer (Message-ID, In-Reply-To, References).
 *
 * Pure: no I/O, clock, randomness or shared state.
 *
 * Rules as implemented:
 * - A message ID is an opaque identifier. It is accepted or rejected whole and
 *   is returned and compared exactly as written: never trimmed, lowercased,
 *   unbracketed or repaired, so two distinct IDs never compare equal.
 * - Header values are split into whole angle-bracket tokens (`<` up to the next
 *   `>`). Each whole token is validated against the grammar. A token that fails
 *   yields nothing from its interior; an ID is never extracted from inside it.
 * - Outside bracket tokens, double-quoted phrases and parenthesised comments
 *   (nested, backslash escapes honoured) are skipped. An unbalanced quote or
 *   parenthesis swallows the rest of the value.
 * - Message-ID must be exactly one valid bracket token with nothing outside it
 *   but spaces, tabs and balanced comments; any other text, quote, stray angle
 *   bracket or unbalanced comment is `bad_message_id`. Under this strict rule two
 *   distinct Message-IDs never compare equal. In-Reply-To yields its first valid
 *   token; References yields every valid token in order. Invalid tokens and free
 *   text are skipped there, and an unterminated `<` swallows the rest of the value.
 * - Known residual (needs a full RFC parser): in In-Reply-To and References,
 *   tokens found before an unbalanced point are kept, so `<"a> <b@c> "@d>`
 *   yields `<b@c>`, the interior of one exotic RFC-valid ID.
 * - The header section ends at the first empty line (or one holding only
 *   whitespace or CR), or at the first non-continuation line without a colon.
 *   Nothing after that point is read. Continuation lines attach only to a header
 *   line inside the section.
 * - Nothing here infers a parent from a subject, a recipient or recency.
 */

/** Length bounds of a whole message ID, brackets included. */
export const MESSAGE_ID_MIN_LENGTH = 5;
export const MESSAGE_ID_MAX_LENGTH = 256;

/** Longest rendered header line, unless a single ID is longer. */
const MAX_LINE_LENGTH = 78;

const ID_CHARS = '\\x21-\\x3b\\x3d\\x3f\\x41-\\x7e';
const ID_EXACT = new RegExp(`^<[${ID_CHARS}]+@[${ID_CHARS}]+>$`);

function isMessageId(candidate: string): boolean {
  return (
    candidate.length >= MESSAGE_ID_MIN_LENGTH &&
    candidate.length <= MESSAGE_ID_MAX_LENGTH &&
    ID_EXACT.test(candidate)
  );
}

interface BracketScan {
  /** Whole bracket tokens (`<` .. first `>`), valid or not, in order. */
  tokens: string[];
  /** True if a quote, comment or bracket was left open. */
  unbalanced: boolean;
}

function scanBracketTokens(value: string): BracketScan {
  const tokens: string[] = [];
  const n = value.length;
  let i = 0;
  while (i < n) {
    const c = value[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && value[j] !== '"') j += value[j] === '\\' ? 2 : 1;
      if (j >= n) return { tokens, unbalanced: true };
      i = j + 1;
    } else if (c === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const d = value[j];
        if (d === '\\') j += 2;
        else {
          if (d === '(') depth++;
          else if (d === ')') depth--;
          j++;
        }
      }
      if (depth > 0) return { tokens, unbalanced: true };
      i = j;
    } else if (c === '<') {
      const close = value.indexOf('>', i + 1);
      if (close < 0) return { tokens, unbalanced: true };
      tokens.push(value.slice(i, close + 1));
      i = close + 1;
    } else {
      i++;
    }
  }
  return { tokens, unbalanced: false };
}

/** Every well-formed whole-token ID in the value, in order, exactly as written. */
function scanMessageIds(value: string): string[] {
  return scanBracketTokens(value).tokens.filter(isMessageId);
}

/** The first well-formed ID in the value, brackets included, or undefined. */
export function parseMessageId(value: string): string | undefined {
  return scanMessageIds(value)[0];
}

/** Every well-formed ID in the value, in order. Text between tokens is ignored. */
export function parseMessageIdList(value: string): string[] {
  return scanMessageIds(value);
}

export type ThreadHeadersReadResult =
  | { ok: true; messageId?: string; inReplyTo?: string; references: string[] }
  | { ok: false; reason: 'duplicate_header' | 'bad_message_id' };

export interface HeaderSection {
  /** Unfolded `[lowercased name, value as written]` pairs, in section order. */
  readonly fields: ReadonlyArray<readonly [name: string, value: string]>;
  /** Byte index in the input at which the body starts. */
  readonly bodyOffset: number;
}

const LF = 0x0a;
const CR = 0x0d;

/**
 * Reads the header section of a message and reports where its body starts.
 * This is the one place that decides the header/body boundary; every reader
 * of headers or of the body goes through it. It accepts any bytes and never
 * throws.
 *
 * - Bytes are read as Latin-1, one byte per character. A line ends at CRLF or
 *   at a lone LF; a lone CR is an ordinary character of its line.
 * - The section ends at the first line that is empty or holds only spaces,
 *   tabs or CRs, or that is not a continuation and has no colon after at least
 *   one character.
 * - A line starting with a space or tab continues the field before it and is
 *   appended to that field's value as written, with no separator. With no
 *   field before it, the section ends there.
 * - Names lose trailing spaces and tabs and are lowercased. Values are kept as
 *   written, leading whitespace included. Repeated headers are all returned.
 * - `bodyOffset` is the index just after the line separator of the terminating
 *   empty, whitespace-only or CR-only line; the index of the terminating line
 *   itself when that line is body text (no colon, or a continuation with no
 *   field before it); and the input length when the input ends inside the
 *   headers or on a terminating line that has no separator.
 */
export function readHeaderSection(raw: Uint8Array): HeaderSection {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const fields: Array<[string, string]> = [];
  let lineStart = 0;
  for (;;) {
    const lf = bytes.indexOf(LF, lineStart);
    const afterLine = lf < 0 ? bytes.length : lf + 1;
    // A CR directly before the LF belongs to the separator, not to the line.
    const lineEnd = lf < 0 ? bytes.length : lf > lineStart && bytes[lf - 1] === CR ? lf - 1 : lf;
    // Latin-1 keeps bytes one-to-one; non-ASCII bytes can never be part of an ID.
    const line = bytes.toString('latin1', lineStart, lineEnd);
    if (/^[ \t\r]*$/.test(line)) return { fields, bodyOffset: afterLine };
    if (line[0] === ' ' || line[0] === '\t') {
      const last = fields[fields.length - 1];
      if (!last) return { fields, bodyOffset: lineStart };
      last[1] += line;
    } else {
      const colon = line.indexOf(':');
      if (colon <= 0) return { fields, bodyOffset: lineStart };
      // The name loses trailing spaces and tabs. A loop, because a pattern
      // anchored at the end takes quadratic time on a long run of spaces.
      let nameEnd = colon;
      while (nameEnd > 0 && (line[nameEnd - 1] === ' ' || line[nameEnd - 1] === '\t')) nameEnd--;
      fields.push([line.slice(0, nameEnd).toLowerCase(), line.slice(colon + 1)]);
    }
    if (lf < 0) return { fields, bodyOffset: bytes.length };
    lineStart = afterLine;
  }
}

/**
 * The Message-ID header value must be exactly one valid bracket token, with
 * only spaces, tabs and balanced parenthesised comments around it. Anything
 * else outside the token (quotes, stray angle brackets, text) is rejected.
 */
function readSoleMessageId(value: string): string | undefined {
  let found: string | undefined;
  const n = value.length;
  let i = 0;
  while (i < n) {
    const c = value[i];
    if (c === ' ' || c === '\t') {
      i++;
    } else if (c === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const d = value[j];
        if (d === '\\') j += 2;
        else {
          if (d === '(') depth++;
          else if (d === ')') depth--;
          j++;
        }
      }
      if (depth > 0) return undefined;
      i = j;
    } else if (c === '<') {
      const close = value.indexOf('>', i + 1);
      if (close < 0 || found !== undefined) return undefined;
      const token = value.slice(i, close + 1);
      if (!isMessageId(token)) return undefined;
      found = token;
      i = close + 1;
    } else {
      return undefined;
    }
  }
  return found;
}

export function readThreadHeaders(raw: Uint8Array): ThreadHeadersReadResult {
  const { fields } = readHeaderSection(raw);
  const all = (name: string): string[] => fields.filter(([n]) => n === name).map(([, v]) => v);
  for (const name of ['message-id', 'in-reply-to', 'references']) {
    if (all(name).length > 1) return { ok: false, reason: 'duplicate_header' };
  }

  const result: { ok: true; messageId?: string; inReplyTo?: string; references: string[] } = {
    ok: true,
    references: [],
  };

  const [messageIdValue] = all('message-id');
  if (messageIdValue !== undefined) {
    // A Message-ID names exactly one message: one whole valid token and nothing
    // else but spaces, tabs and balanced comments.
    const only = readSoleMessageId(messageIdValue);
    if (only === undefined) return { ok: false, reason: 'bad_message_id' };
    result.messageId = only;
  }
  const [inReplyToValue] = all('in-reply-to');
  if (inReplyToValue !== undefined) {
    const first = parseMessageId(inReplyToValue);
    if (first !== undefined) result.inReplyTo = first;
  }
  const [referencesValue] = all('references');
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
      const overflows = line.length + 1 + id.length > MAX_LINE_LENGTH;
      // A first ID that would overflow moves to a continuation line if it fits there.
      const foldable = lineHasId || 1 + id.length <= MAX_LINE_LENGTH;
      if (overflows && foldable) {
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

/**
 * Throws if any code unit is below 0x20 or equals 0x7f. This guards CR/LF/NUL
 * (and other control) injection only; the caller must encode non-ASCII text and
 * bound the length.
 */
export function assertHeaderValue(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`header value contains a control character at index ${i}`);
    }
  }
}

/**
 * Returns the text as one header line: every run of code units below 0x20 or
 * equal to 0x7f becomes a single space, and the result is trimmed. Text with
 * no such code unit and no outer whitespace is returned unchanged.
 */
export function singleLineHeaderText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
}
