import * as dns from 'node:dns';
import * as net from 'node:net';

export interface MxDeliveryOptions {
  readonly heloDomain: string;
  readonly defaultPort?: number;
  readonly timeoutMs?: number;
  readonly resolveMxFn?: (domain: string) => Promise<dns.MxRecord[]>;
}

/**
 * What one `deliver` call established.
 *
 * - `accepted`: a server answered the end of the message data with a 2xx reply.
 * - `refused`: no server accepted the message and no message data is left
 *   unanswered. `responseCode` is present when a server replied 4xx or 5xx;
 *   it is absent when the message was refused locally before connecting or
 *   no server could be reached.
 * - `ambiguous`: the message data was written to a server and the connection
 *   ended, timed out or went out of step before a reply answered it. The
 *   server may or may not have taken the message.
 */
export type MxDeliveryOutcome = 'accepted' | 'refused' | 'ambiguous';

export interface MxDeliveryResult {
  /** True exactly when the outcome is `accepted`. */
  readonly success: boolean;
  /** Always set by `MxDirectTransport`. */
  readonly outcome?: MxDeliveryOutcome;
  readonly mxHost?: string;
  readonly responseCode?: number;
  readonly responseMessage?: string;
  readonly error?: string;
}

const MAX_ADDRESS_LENGTH = 254;
const MAX_REPLY_LENGTH = 64 * 1024;

const CR = 0x0d;
const LF = 0x0a;
const DOT = 0x2e;

const ENVELOPE_ADDRESS_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const HELO_HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const HELO_ADDRESS_LITERAL_PATTERN = /^\[(?:[0-9.]{7,15}|ipv6:[0-9a-f:.]{2,45})\]$/;

/** An address that may be written between the angle brackets of MAIL FROM or RCPT TO. */
export function isEnvelopeAddress(address: string): boolean {
  if (address.length > MAX_ADDRESS_LENGTH || !ENVELOPE_ADDRESS_PATTERN.test(address)) {
    return false;
  }
  const localPart = address.slice(0, address.indexOf('@'));
  return !localPart.startsWith('.') && !localPart.endsWith('.') && !localPart.includes('..');
}

/** A host name or address literal that may follow EHLO. Expects lower case. */
function isHeloName(name: string): boolean {
  return (
    name.length <= 255 &&
    (HELO_HOSTNAME_PATTERN.test(name) || HELO_ADDRESS_LITERAL_PATTERN.test(name))
  );
}

/**
 * Prepares message bytes for the SMTP data phase.
 *
 * Every line ending (CRLF, a lone LF, a lone CR) becomes CRLF, a line that
 * begins with a dot gains one more leading dot (RFC 5321 section 4.5.2), and
 * the result always ends with CRLF. Lines of any length are kept. The
 * end-of-data line is not included; the transport writes it.
 */
export function encodeMessageData(raw: Uint8Array): Buffer {
  // Each input byte produces at most two output bytes, plus a final CRLF.
  const out = Buffer.allocUnsafe(raw.length * 2 + 2);
  let written = 0;
  let atLineStart = true;

  const endLine = () => {
    out[written++] = CR;
    out[written++] = LF;
    atLineStart = true;
  };

  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i];
    if (byte === CR) {
      if (raw[i + 1] === LF) i++;
      endLine();
      continue;
    }
    if (byte === LF) {
      endLine();
      continue;
    }
    if (atLineStart && byte === DOT) {
      out[written++] = DOT;
    }
    atLineStart = false;
    out[written++] = byte;
  }

  if (!atLineStart || written === 0) {
    endLine();
  }
  return out.subarray(0, written);
}

function refusedBeforeConnecting(error: string): MxDeliveryResult {
  return { success: false, outcome: 'refused', error };
}

export class MxDirectTransport {
  private readonly heloDomain: string;
  private readonly defaultPort: number;
  private readonly timeoutMs: number;
  private readonly resolveMxFn: (domain: string) => Promise<dns.MxRecord[]>;

  constructor(options: MxDeliveryOptions) {
    this.heloDomain = options.heloDomain.toLowerCase();
    this.defaultPort = options.defaultPort ?? 25;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.resolveMxFn = options.resolveMxFn ?? dns.promises.resolveMx;
  }

  /** Resolves destination domain's MX hosts in priority order, with RFC 5321 A-record fallback. */
  async resolveMxHosts(domain: string): Promise<string[]> {
    try {
      const records = await this.resolveMxFn(domain);
      if (records && records.length > 0) {
        return records
          .sort((a, b) => a.priority - b.priority)
          .map((rec) => rec.exchange);
      }
    } catch {
      // RFC 5321 fallback: if no MX record found, fallback directly to domain A/AAAA record
    }
    return [domain];
  }

  /**
   * Delivers an RFC 5322 message to the recipient domain's mail servers over SMTP.
   *
   * Everything written into a command line and the message data itself are
   * checked before any connection is opened. MX hosts are then tried in
   * priority order while the result is `refused`. An `accepted` or `ambiguous`
   * result ends the call: after `ambiguous` a server may already hold the
   * message, so no further host is contacted.
   */
  async deliver(params: {
    fromAddress: string;
    toAddress: string;
    rawRfc822: Uint8Array;
  }): Promise<MxDeliveryResult> {
    if (!isHeloName(this.heloDomain)) {
      return refusedBeforeConnecting(
        `Invalid EHLO name: ${JSON.stringify(this.heloDomain)}`
      );
    }
    if (!isEnvelopeAddress(params.fromAddress)) {
      return refusedBeforeConnecting(
        `Invalid envelope sender address: ${JSON.stringify(params.fromAddress)}`
      );
    }
    if (!isEnvelopeAddress(params.toAddress)) {
      return refusedBeforeConnecting(
        `Invalid envelope recipient address: ${JSON.stringify(params.toAddress)}`
      );
    }
    const messageData = encodeMessageData(params.rawRfc822);

    const toDomain = params.toAddress.slice(params.toAddress.indexOf('@') + 1);
    const mxHosts = await this.resolveMxHosts(toDomain);
    let lastResult: MxDeliveryResult = {
      success: false,
      outcome: 'refused',
      error: `All MX hosts for ${toDomain} failed delivery: No MX hosts could be reached`,
    };

    for (const host of mxHosts) {
      let result: MxDeliveryResult;
      try {
        result = await this.deliverToMxHost({
          mxHost: host,
          fromAddress: params.fromAddress,
          toAddress: params.toAddress,
          messageData,
        });
      } catch (err: unknown) {
        // Thrown while opening the connection: nothing was written.
        result = {
          success: false,
          outcome: 'refused',
          mxHost: host,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (result.outcome !== 'refused') {
        return result;
      }
      lastResult = result;
    }

    return lastResult;
  }

  /**
   * Runs one SMTP session. Each command is written only after the reply to
   * the previous one has been read in full.
   */
  private deliverToMxHost(params: {
    mxHost: string;
    fromAddress: string;
    toAddress: string;
    messageData: Buffer;
  }): Promise<MxDeliveryResult> {
    return new Promise((resolve) => {
      const socket = net.createConnection({
        host: params.mxHost,
        port: this.defaultPort,
      });
      socket.setEncoding('utf8');

      let buffer = '';
      let stage: 'GREETING' | 'EHLO' | 'MAIL' | 'RCPT' | 'DATA' | 'BODY' = 'GREETING';
      let continuationCode: string | undefined;
      let messageDataWritten = false;
      let settled = false;

      /**
       * Ends the session without acceptance. A 4xx or 5xx reply is a refusal
       * wherever it arrives. Anything else is a refusal while no message data
       * has been written, and ambiguous afterwards.
       */
      const stop = (error: string, reply?: { code: number; text: string }) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({
          success: false,
          outcome: reply || !messageDataWritten ? 'refused' : 'ambiguous',
          mxHost: params.mxHost,
          ...(reply ? { responseCode: reply.code, responseMessage: reply.text } : {}),
          error,
        });
      };

      const handleReply = (code: number, text: string) => {
        if (code >= 400 && code <= 599) {
          stop(`SMTP error ${code}: ${text}`, { code, text });
          return;
        }
        const expected = stage === 'DATA' ? code === 354 : code >= 200 && code <= 299;
        if (!expected) {
          stop(`Unexpected SMTP reply ${code} at ${stage}`);
          return;
        }
        if (stage !== 'BODY' && buffer.length > 0) {
          // The next command has not been written yet, so nothing can answer it.
          stop(`Unexpected data after the SMTP reply at ${stage}`);
          return;
        }

        switch (stage) {
          case 'GREETING':
            stage = 'EHLO';
            socket.write(`EHLO ${this.heloDomain}\r\n`);
            break;

          case 'EHLO':
            stage = 'MAIL';
            socket.write(`MAIL FROM:<${params.fromAddress}>\r\n`);
            break;

          case 'MAIL':
            stage = 'RCPT';
            socket.write(`RCPT TO:<${params.toAddress}>\r\n`);
            break;

          case 'RCPT':
            stage = 'DATA';
            socket.write('DATA\r\n');
            break;

          case 'DATA':
            stage = 'BODY';
            messageDataWritten = true;
            socket.write(params.messageData);
            socket.write('.\r\n');
            break;

          case 'BODY':
            // This reply answers the end of the message data and decides the
            // result. QUIT is a courtesy; its reply is not waited for.
            settled = true;
            resolve({
              success: true,
              outcome: 'accepted',
              mxHost: params.mxHost,
              responseCode: code,
              responseMessage: text,
            });
            socket.end('QUIT\r\n');
            break;
        }
      };

      socket.setTimeout(this.timeoutMs, () => {
        stop('Connection timed out');
        socket.destroy();
      });

      socket.on('error', (err) => {
        stop(err.message);
      });

      socket.on('close', () => {
        stop('Connection closed before the server replied');
      });

      socket.on('data', (chunk: string) => {
        if (settled) return;
        buffer += chunk;
        if (buffer.length > MAX_REPLY_LENGTH) {
          stop('SMTP reply too long');
          return;
        }

        while (!settled) {
          const lineEnd = buffer.indexOf('\n');
          if (lineEnd === -1) break;
          const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
          buffer = buffer.slice(lineEnd + 1);

          const match = line.match(/^(\d{3})(?:([ -])(.*))?$/);
          if (!match || (continuationCode !== undefined && match[1] !== continuationCode)) {
            stop(`Malformed SMTP reply at ${stage}`);
            return;
          }

          // A multi-line reply (e.g. 250-SIZE) ends with its first "code SP" line.
          if (match[2] === '-') {
            continuationCode = match[1];
            continue;
          }
          continuationCode = undefined;

          handleReply(parseInt(match[1], 10), match[3] || '');
        }
      });
    });
  }
}
