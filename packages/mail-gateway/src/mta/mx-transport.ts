import * as dns from 'node:dns';
import * as net from 'node:net';

export interface MxDeliveryOptions {
  readonly heloDomain: string;
  readonly defaultPort?: number;
  readonly timeoutMs?: number;
  readonly resolveMxFn?: (domain: string) => Promise<dns.MxRecord[]>;
}

export interface MxDeliveryResult {
  readonly success: boolean;
  readonly mxHost?: string;
  readonly responseCode?: number;
  readonly responseMessage?: string;
  readonly error?: string;
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

  /** Directly delivers an RFC 822 email to the remote domain's authoritative MTA over SMTP. */
  async deliver(params: {
    fromAddress: string;
    toAddress: string;
    rawRfc822: Uint8Array;
  }): Promise<MxDeliveryResult> {
    const toDomain = params.toAddress.split('@')[1];
    if (!toDomain) {
      return { success: false, error: `Invalid recipient address without domain: ${params.toAddress}` };
    }

    const mxHosts = await this.resolveMxHosts(toDomain);
    let lastError = 'No MX hosts could be reached';

    for (const host of mxHosts) {
      try {
        const result = await this.deliverToMxHost({
          mxHost: host,
          fromAddress: params.fromAddress,
          toAddress: params.toAddress,
          rawRfc822: params.rawRfc822,
        });
        if (result.success) {
          return result;
        }
        lastError = result.error || result.responseMessage || 'SMTP transaction rejected';
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      success: false,
      error: `All MX hosts for ${toDomain} failed delivery: ${lastError}`,
    };
  }

  private deliverToMxHost(params: {
    mxHost: string;
    fromAddress: string;
    toAddress: string;
    rawRfc822: Uint8Array;
  }): Promise<MxDeliveryResult> {
    return new Promise((resolve) => {
      const socket = net.createConnection({
        host: params.mxHost,
        port: this.defaultPort,
      });

      let buffer = '';
      let stage: 'GREETING' | 'EHLO' | 'MAIL' | 'RCPT' | 'DATA' | 'BODY' | 'QUIT' | 'DONE' = 'GREETING';
      let resolved = false;

      const finish = (result: MxDeliveryResult) => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(this.timeoutMs, () => {
        finish({ success: false, mxHost: params.mxHost, error: 'Connection timed out' });
      });

      socket.on('error', (err) => {
        finish({ success: false, mxHost: params.mxHost, error: err.message });
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');

        while (buffer.includes('\n')) {
          const lineEnd = buffer.indexOf('\n');
          const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
          buffer = buffer.slice(lineEnd + 1);

          // If line is multiline continuation (e.g. 250-SIZE), continue reading
          if (/^\d{3}-/.test(line)) {
            continue;
          }

          const match = line.match(/^(\d{3})(?: (.*))?$/);
          if (!match) continue;

          const code = parseInt(match[1], 10);
          const msg = match[2] || '';

          if (code >= 400) {
            finish({
              success: false,
              mxHost: params.mxHost,
              responseCode: code,
              responseMessage: msg,
              error: `SMTP error ${code}: ${msg}`,
            });
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
              socket.write(Buffer.from(params.rawRfc822));
              socket.write('\r\n.\r\n');
              break;

            case 'BODY':
              stage = 'QUIT';
              socket.write('QUIT\r\n');
              break;

            case 'QUIT':
              stage = 'DONE';
              finish({
                success: true,
                mxHost: params.mxHost,
                responseCode: code,
                responseMessage: msg,
              });
              break;
          }
        }
      });
    });
  }
}
