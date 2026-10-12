import { createHash } from 'node:crypto';
import { SMTPServer, type SMTPServerSession } from 'smtp-server';
import { authenticate } from 'mailauth';
import { isOperationalLocalPart } from '../mailbox/operational-local-parts';
import type { JournaledInboundSend } from '../relay/journaled-inbound-send';
import type { InboundRecipientResolution } from './inbound-server';
import { parseRawRfc822 } from './smtp-listener';

const MAX_RAW_BYTES = 20 * 1024 * 1024;

export interface DirectSmtpEnvelope {
  readonly clientIp: string;
  readonly helo: string;
  readonly mailFrom: string;
  readonly recipients: readonly string[];
}

export interface DirectSmtpAuthentication {
  /** Exact parsed RFC From principal on strict DMARC pass; absent on ambiguity or failure. */
  authenticatedAuthor(raw: Uint8Array, envelope: DirectSmtpEnvelope): Promise<string | undefined>;
}

/** Authenticate against the actual SMTP peer, never user-supplied Received/Auth-Results headers. */
export const strictSmtpAuthentication: DirectSmtpAuthentication = {
  async authenticatedAuthor(raw, envelope) {
    const result = await authenticate(Buffer.from(raw), {
      ip: envelope.clientIp,
      helo: envelope.helo,
      sender: envelope.mailFrom,
      strict: true,
      trustReceived: false,
    });
    if (result.dmarc === false || result.dmarc.status.result !== 'pass' ||
      result.dkim.fromFields !== 1 || result.dkim.fromSyntax !== 'valid' ||
      result.dkim.headerFrom.length !== 1) return undefined;
    return result.dkim.headerFrom[0].toLowerCase();
  },
};

export class SmtpAdmissionRefusal extends Error {
  constructor(readonly responseCode: number, message: string) {
    super(message);
    this.name = 'SmtpAdmissionRefusal';
  }
}

export interface JournaledSmtpIngressOptions {
  readonly gatewayDomain: string;
  readonly issuedMailboxLookup: (localPart: string) => Promise<InboundRecipientResolution | undefined>;
  readonly sender: Pick<JournaledInboundSend, 'admit'>;
  readonly stampValue: bigint;
  readonly authentication?: DirectSmtpAuthentication;
}

/** Both SMTP and signed-webhook ingress end at the same durable admission owner. */
export class JournaledSmtpIngress {
  private readonly domain: string;
  private readonly lookup: JournaledSmtpIngressOptions['issuedMailboxLookup'];
  private readonly sender: Pick<JournaledInboundSend, 'admit'>;
  private readonly stampValue: bigint;
  private readonly authentication: DirectSmtpAuthentication;

  constructor(options: JournaledSmtpIngressOptions) {
    if (options.stampValue < 0n) throw new Error('SMTP stamp value must be non-negative');
    this.domain = options.gatewayDomain.toLowerCase();
    this.lookup = options.issuedMailboxLookup;
    this.sender = options.sender;
    this.stampValue = options.stampValue;
    this.authentication = options.authentication ?? strictSmtpAuthentication;
  }

  private localPart(address: string): string {
    const parts = address.toLowerCase().split('@');
    if (parts.length !== 2 || parts[1] !== this.domain ||
      !/^[a-z0-9][a-z0-9._+-]*$/.test(parts[0]) ||
      isOperationalLocalPart(parts[0]) || parts[0].startsWith('bounce+')) {
      throw new SmtpAdmissionRefusal(550, 'Recipient unavailable');
    }
    return parts[0];
  }

  async acceptsRecipient(address: string): Promise<boolean> {
    try { return !!(await this.lookup(this.localPart(address))); }
    catch (error) {
      if (error instanceof SmtpAdmissionRefusal) return false;
      throw error;
    }
  }

  /** Returns only after every recipient is journaled. A partial failure invites an idempotent retry. */
  async accept(raw: Uint8Array, envelope: DirectSmtpEnvelope): Promise<void> {
    if (raw.byteLength > MAX_RAW_BYTES) throw new SmtpAdmissionRefusal(552, 'Message too large');
    if (!envelope.clientIp || !envelope.helo || !envelope.mailFrom || envelope.recipients.length === 0)
      throw new SmtpAdmissionRefusal(550, 'Invalid SMTP envelope');
    const recipients = [...new Set(envelope.recipients.map(address => this.localPart(address)))];
    const scopes = await Promise.all(recipients.map(localPart => this.lookup(localPart)));
    if (scopes.some(scope => !scope)) throw new SmtpAdmissionRefusal(550, 'Recipient unavailable');
    const author = await this.authentication.authenticatedAuthor(raw, envelope);
    if (!author)
      throw new SmtpAdmissionRefusal(550, 'Sender authentication failed');
    const email = parseRawRfc822(raw);
    const from = email.fromAddress.toLowerCase();
    if (from !== author) throw new SmtpAdmissionRefusal(550, 'Mail From projection differs');
    const transportId = `smtp:${createHash('sha256').update(raw).digest('hex')}`;
    for (let index = 0; index < recipients.length; index += 1) {
      const scope = scopes[index]!;
      const admission = this.sender.admit({
        email,
        verifiedTransportId: transportId,
        authenticatedSenderEmail: from,
      }, scope.accountAddress, this.stampValue, scope.conversationId, recipients[index]);
      if (admission.kind === 'refused')
        throw new SmtpAdmissionRefusal(451, 'Mail admission unavailable');
    }
  }
}

export interface JournaledSmtpServerOptions {
  readonly ingress: JournaledSmtpIngress;
  readonly hostname: string;
  readonly tlsKey: string | Buffer;
  readonly tlsCert: string | Buffer;
}

/** SMTP protocol boundary; never reports 250 until the journal has committed. */
export class JournaledSmtpServer {
  private readonly server: SMTPServer;

  constructor(options: JournaledSmtpServerOptions) {
    if (!options.tlsKey || !options.tlsCert) throw new Error('SMTP TLS key and certificate are required');
    const envelope = (session: SMTPServerSession): DirectSmtpEnvelope => ({
      clientIp: session.remoteAddress,
      helo: session.hostNameAppearsAs,
      mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
      recipients: session.envelope.rcptTo.map(recipient => recipient.address),
    });
    this.server = new SMTPServer({
      name: options.hostname,
      key: options.tlsKey,
      cert: options.tlsCert,
      authOptional: true,
      disabledCommands: ['AUTH'],
      size: MAX_RAW_BYTES,
      onRcptTo(address, _session, callback) {
        void options.ingress.acceptsRecipient(address.address).then(accepted => {
          callback(accepted ? null : new SmtpAdmissionRefusal(550, 'Recipient unavailable'));
        }, () => callback(new SmtpAdmissionRefusal(451, 'Recipient lookup unavailable')));
      },
      onData(stream, session, callback) {
        void (async () => {
          const chunks: Buffer[] = [];
          let length = 0;
          let tooLarge = false;
          for await (const chunk of stream) {
            length += chunk.length;
            if (length > MAX_RAW_BYTES) { tooLarge = true; continue; }
            chunks.push(Buffer.from(chunk));
          }
          if (tooLarge || stream.sizeExceeded)
            throw new SmtpAdmissionRefusal(552, 'Message too large');
          await options.ingress.accept(Buffer.concat(chunks, length), envelope(session));
        })().then(() => callback(null, 'Message queued'), error => {
          callback(error instanceof SmtpAdmissionRefusal
            ? error : new SmtpAdmissionRefusal(451, 'Mail admission unavailable'));
        });
      },
    });
  }

  start(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()));
  }
}
