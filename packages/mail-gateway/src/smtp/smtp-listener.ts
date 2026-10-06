import * as net from 'node:net';
import { InboundEmailHandler } from './inbound-server';
import { InboundEmail } from '../types';

export interface SmtpListenerOptions {
  readonly gatewayDomain: string;
  readonly handler: InboundEmailHandler;
  readonly maxMessageSizeBytes?: number;
}

/** Extracts email address from RFC 822 header like "Alice <alice@example.com>" */
export function extractEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  if (match) return match[1].trim().toLowerCase();
  return raw.trim().toLowerCase();
}

/** Parses raw RFC 822 message bytes into structured InboundEmail fields. */
export function parseRawRfc822(
  rawRfc822: Uint8Array,
  fallbackFrom?: string,
  fallbackTo?: string
): InboundEmail {
  const text = new TextDecoder('utf-8').decode(rawRfc822);
  const headerEndIndex = text.search(/\r?\n\r?\n/);
  
  const headerSection = headerEndIndex !== -1 ? text.slice(0, headerEndIndex) : text;
  const bodySection = headerEndIndex !== -1 ? text.slice(headerEndIndex).replace(/^\r?\n\r?\n/, '') : '';

  // Unfold headers
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
  const headerLines = unfolded.split(/\r?\n/);

  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const name = line.slice(0, colonIndex).trim().toLowerCase();
      const val = line.slice(colonIndex + 1).trim();
      headers.set(name, val);
    }
  }

  const rawFrom = headers.get('from') || fallbackFrom || 'unknown@example.com';
  const fromAddress = extractEmailAddress(rawFrom);
  const fromDomain = fromAddress.split('@')[1] || '';

  const rawTo = headers.get('to') || fallbackTo || 'unknown@gateway.local';
  const toAddress = extractEmailAddress(rawTo);
  const localPart = toAddress.split('@')[0] || '';

  const subject = headers.get('subject') || '(No Subject)';
  const messageId = headers.get('message-id') || `<msg_${Date.now()}_${Math.random().toString(36).slice(2)}@${fromDomain}>`;

  // Check DKIM / SPF verification headers
  const authResults = (headers.get('authentication-results') || '').toLowerCase();
  const dkimSig = headers.has('dkim-signature');
  const dkimPass = authResults.includes('dkim=pass') || (dkimSig && !authResults.includes('dkim=fail'));
  const spfPass = authResults.includes('spf=pass');

  // Check In-Reply-To and References headers for threading
  const rawInReplyTo = headers.get('in-reply-to');
  const inReplyTo = rawInReplyTo
    ? rawInReplyTo.match(/<[^>]+>/)?.[0] ?? rawInReplyTo.trim()
    : undefined;

  const rawReferences = headers.get('references');
  const references = rawReferences
    ? (rawReferences.match(/<[^>]+>/g) ?? rawReferences.split(/\s+/).filter(Boolean))
    : undefined;

  return {
    messageId,
    fromAddress,
    fromDomain,
    toAddress,
    localPart,
    subject,
    textBody: bodySection,
    dkimValid: dkimPass,
    spfValid: spfPass,
    inReplyTo,
    references,
    rawRfc822,
  };
}

export class SmtpListener {
  private readonly gatewayDomain: string;
  private readonly handler: InboundEmailHandler;
  private readonly maxMessageSizeBytes: number;
  private server?: net.Server;

  constructor(options: SmtpListenerOptions) {
    this.gatewayDomain = options.gatewayDomain.toLowerCase();
    this.handler = options.handler;
    this.maxMessageSizeBytes = options.maxMessageSizeBytes ?? 20 * 1024 * 1024; // 20 MB
  }

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      server.once('error', reject);
      server.listen(port, host, () => {
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = undefined;
        resolve();
      });
    });
  }

  getPort(): number {
    const address = this.server?.address();
    if (address && typeof address === 'object') {
      return address.port;
    }
    return 0;
  }

  private handleConnection(socket: net.Socket): void {
    let state: 'GREET' | 'COMMAND' | 'DATA' = 'COMMAND';
    let mailFrom = '';
    let rcptTo = '';
    let dataBuffer: Buffer[] = [];
    let dataBytesCount = 0;
    let lineBuffer = '';

    socket.write(`220 ${this.gatewayDomain} ESMTP Frank-MailGateway Ready\r\n`);

    socket.on('data', async (chunk) => {
      if (state === 'DATA') {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        dataBuffer.push(buf);
        dataBytesCount += buf.length;

        if (dataBytesCount > this.maxMessageSizeBytes) {
          socket.write('552 5.3.4 Message size exceeds fixed limit\r\n');
          socket.end();
          return;
        }

        // Check for end of DATA delimiter: \r\n.\r\n
        const combined = Buffer.concat(dataBuffer);
        const dataEndIndex = combined.indexOf('\r\n.\r\n');
        const fallbackEndIndex = combined.indexOf('\n.\n');
        
        if (dataEndIndex !== -1 || fallbackEndIndex !== -1) {
          state = 'COMMAND';
          const fullRaw = combined.subarray(0, dataEndIndex !== -1 ? dataEndIndex : fallbackEndIndex);
          dataBuffer = [];
          dataBytesCount = 0;

          try {
            const parsedEmail = parseRawRfc822(fullRaw, mailFrom, rcptTo);
            const result = await this.handler.processInboundEmail(parsedEmail);

            switch (result.status) {
              case 'delivered':
                socket.write(`250 2.0.0 Message accepted and delivered via Frank DM (${result.txHash || 'ok'})\r\n`);
                break;
              case 'held':
                socket.write(`250 2.0.0 Message queued for funding (${result.heldMessageId})\r\n`);
                break;
              case 'bounce':
                socket.write('250 2.0.0 Bounce notification processed\r\n');
                break;
              case 'rejected_tombstone':
                socket.write('550 5.2.1 Recipient account deactivated and tombstoned\r\n');
                break;
              case 'rejected_unknown':
                socket.write('550 5.1.1 User unknown\r\n');
                break;
              case 'rejected_unauthenticated':
                socket.write('550 5.7.1 Message authentication failed\r\n');
                break;
            }
          } catch (err: unknown) {
            socket.write('451 4.3.0 Internal mail server error\r\n');
          }
        }
        return;
      }

      lineBuffer += chunk.toString('utf-8');
      while (lineBuffer.includes('\n')) {
        const newlineIndex = lineBuffer.indexOf('\n');
        const rawLine = lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(newlineIndex + 1);

        const spaceIndex = rawLine.indexOf(' ');
        const verb = (spaceIndex === -1 ? rawLine : rawLine.slice(0, spaceIndex)).toUpperCase().trim();
        const param = (spaceIndex === -1 ? '' : rawLine.slice(spaceIndex + 1)).trim();

        switch (verb) {
          case 'HELO':
          case 'EHLO':
            socket.write(
              `250-${this.gatewayDomain} Hello ${param || 'client'}\r\n` +
              `250-SIZE ${this.maxMessageSizeBytes}\r\n` +
              `250-8BITMIME\r\n` +
              `250 OK\r\n`
            );
            break;

          case 'MAIL':
            if (param.toUpperCase().startsWith('FROM:')) {
              mailFrom = extractEmailAddress(param.slice(5));
              socket.write('250 2.1.0 Ok\r\n');
            } else {
              socket.write('501 5.5.4 Syntax error in parameters\r\n');
            }
            break;

          case 'RCPT':
            if (param.toUpperCase().startsWith('TO:')) {
              rcptTo = extractEmailAddress(param.slice(3));
              socket.write('250 2.1.5 Ok\r\n');
            } else {
              socket.write('501 5.5.4 Syntax error in parameters\r\n');
            }
            break;

          case 'DATA':
            if (!rcptTo) {
              socket.write('503 5.5.1 Error: need RCPT command\r\n');
            } else {
              state = 'DATA';
              dataBuffer = [];
              dataBytesCount = 0;
              socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            }
            break;

          case 'RSET':
            mailFrom = '';
            rcptTo = '';
            dataBuffer = [];
            dataBytesCount = 0;
            state = 'COMMAND';
            socket.write('250 2.0.0 Ok\r\n');
            break;

          case 'NOOP':
            socket.write('250 2.0.0 Ok\r\n');
            break;

          case 'QUIT':
            socket.write(`221 2.0.0 Bye\r\n`);
            socket.end();
            return;

          default:
            socket.write('502 5.5.2 Command not implemented\r\n');
            break;
        }
      }
    });
  }
}
