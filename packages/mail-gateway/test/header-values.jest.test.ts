import { CheckoutServer } from '../src/http/checkout-server';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { DkimSigner, generateDkimKeyPair } from '../src/mta/dkim-signer';
import { MxDirectTransport } from '../src/mta/mx-transport';
import { OutboundEmailDelivery } from '../src/mta/outbound-delivery';
import { OutboundMtaWorker } from '../src/mta/outbound-worker';
import { RelayMailboxListener } from '../src/relay/mailbox-listener';
import type { GatewayStampProvider } from '../src/stamps/stamp-provider.interface';
import type {
  ActiveChain,
  DirectMessageReceived,
  WalletHandle,
} from '@frank/wallet/chain/active-chain';

const NOW = 1791288000000;
const DATE = 'Tue, 06 Oct 2026 12:00:00 GMT';
const FOOTER =
  '\n\n---\nSent via Frank. Reply to this email to continue the thread for free, or sign up at https://frank.org.';
const SENDER = '0x1111111111111111111111111111111111111111';

/** Values that hold a character which may not appear in a header line. */
const BROKEN_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ['CR', '\rX-Extra: 1'],
  ['LF', '\nX-Extra: 1'],
  ['CRLF', '\r\nX-Extra: 1'],
  ['NUL', '\u0000X-Extra: 1'],
];

const KNOWN_HEADER =
  /^(DKIM-Signature|From|To|Cc|Subject|Date|Message-ID|In-Reply-To|References|MIME-Version|Content-Type): [^\r\u0000]+$/;

/** Asserts the header section holds only the renderer's own header lines and returns them. */
function headerLines(rendered: string): string[] {
  const lines = rendered.slice(0, rendered.indexOf('\n\n')).split('\n');
  for (const line of lines) expect(line).toMatch(KNOWN_HEADER);
  return lines;
}

let ledger: CreditLedger;
let delivery: OutboundEmailDelivery;
let warn: jest.SpyInstance;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  ledger = new CreditLedger(':memory:');
  delivery = new OutboundEmailDelivery({ gatewayDomain: 'frank.org', ledger });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function base(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv_1',
    frankMessageId: 'fmsg_1',
    senderFrankAddress: SENDER,
    recipientEmail: 'bob@remote.com',
    bodyText: 'Hello Bob.',
    subject: 'Greeting',
    ...overrides,
  } as Parameters<OutboundEmailDelivery['processOutboundDirectMessage']>[0];
}

function expectNothingRecorded(): void {
  expect(ledger.getLatestThreadMappingByConversationId('conv_1')).toBeUndefined();
  expect(ledger.getThreadAllowance('bob@remote.com', SENDER)).toBe(0);
  expect(ledger.countInitiatedThreadsInPast24Hours(SENDER)).toBe(0);
}

describe('rendering an outbound email', () => {
  it('renders a new message with the expected bytes', async () => {
    const result = await delivery.processOutboundDirectMessage(
      base({ ccRecipients: ['carol@remote.com', 'dave@remote.com'] })
    );
    expect(result.renderedEmail).toBe(
      `From: ${SENDER} <${SENDER}@frank.org>\n` +
        'To: bob@remote.com\n' +
        'Cc: carol@remote.com, dave@remote.com\n' +
        'Subject: Greeting\n' +
        `Date: ${DATE}\n` +
        `Message-ID: <frank_fmsg_1_${NOW}@frank.org>\n` +
        'MIME-Version: 1.0\n' +
        'Content-Type: text/plain; charset=utf-8\n' +
        '\n' +
        `Hello Bob.${FOOTER}`
    );
  });

  it('renders a reply to a stored parent with the expected bytes', async () => {
    ledger.recordThreadMapping({
      conversationId: 'conv_1',
      frankMessageId: 'parent_1',
      rfc822MessageId: '<original@external.com>',
      subject: 'Hello',
      senderAddress: 'bob@remote.com',
      createdAtMs: NOW - 1000,
    });
    const result = await delivery.processOutboundDirectMessage(
      base({ subject: undefined, recipientEmail: ' Bob@Remote.com ', inReplyToFrankMessageId: 'parent_1' })
    );
    expect(result.inReplyToRfc822).toBe('<original@external.com>');
    expect(result.renderedEmail).toBe(
      `From: ${SENDER} <${SENDER}@frank.org>\n` +
        'To: bob@remote.com\n' +
        'Subject: Re: Frank Message\n' +
        `Date: ${DATE}\n` +
        `Message-ID: <frank_fmsg_1_${NOW}@frank.org>\n` +
        'In-Reply-To: <original@external.com>\n' +
        'References: <original@external.com>\n' +
        'MIME-Version: 1.0\n' +
        'Content-Type: text/plain; charset=utf-8\n' +
        '\n' +
        `Hello Bob.${FOOTER}`
    );
  });

  it('renders the default subject and a non-ASCII subject as before', async () => {
    const plain = await delivery.processOutboundDirectMessage(base({ subject: undefined }));
    expect(headerLines(plain.renderedEmail)).toContain('Subject: Message from Frank');
    const accented = await delivery.processOutboundDirectMessage(
      base({ frankMessageId: 'fmsg_2', subject: 'Café at 9 – réunion' })
    );
    expect(headerLines(accented.renderedEmail)).toContain('Subject: Café at 9 – réunion');
  });

  it.each(['ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59jrf5035', '0xalice_1234', '0xAbC'])(
    'accepts the sender form %s',
    async (sender) => {
      const result = await delivery.processOutboundDirectMessage(base({ senderFrankAddress: sender }));
      expect(headerLines(result.renderedEmail)[0]).toBe(`From: ${sender} <${sender}@frank.org>`);
    }
  );

  describe.each(BROKEN_SUFFIXES)('a value holding %s', (_name, suffix) => {
    it.each([
      ['the sender, used for the From name and address', { senderFrankAddress: SENDER + suffix }],
      ['the recipient', { recipientEmail: 'bob@remote.com' + suffix }],
      ['the recipient, at its end', { recipientEmail: 'bob@remote.com' + suffix[0] }],
      ['the message identifier', { frankMessageId: 'fmsg_1' + suffix }],
    ])('is refused in %s and nothing is recorded', async (_field, overrides) => {
      await expect(delivery.processOutboundDirectMessage(base(overrides))).rejects.toMatchObject({
        name: 'OutboundRenderRefusal',
      });
      expectNothingRecorded();
    });

    it('is left out as a Cc entry while the other entries are kept', async () => {
      const result = await delivery.processOutboundDirectMessage(
        base({ ccRecipients: ['carol@remote.com', 'eve@remote.com' + suffix, 'dave@remote.com'] })
      );
      expect(headerLines(result.renderedEmail)).toContain('Cc: carol@remote.com, dave@remote.com');
      expect(result.renderedEmail).not.toContain('X-Extra');
    });

    it('is written as a single-line Subject', async () => {
      const result = await delivery.processOutboundDirectMessage(base({ subject: 'Greeting' + suffix }));
      expect(headerLines(result.renderedEmail)).toContain('Subject: Greeting X-Extra: 1');
    });

    it('in a stored parent identifier yields only the valid identifier', async () => {
      ledger.recordThreadMapping({
        conversationId: 'conv_1',
        frankMessageId: 'parent_1',
        rfc822MessageId: '<original@external.com>' + suffix,
        createdAtMs: NOW - 1000,
      });
      const result = await delivery.processOutboundDirectMessage(
        base({ inReplyToFrankMessageId: 'parent_1' })
      );
      const lines = headerLines(result.renderedEmail);
      expect(lines).toContain('In-Reply-To: <original@external.com>');
      expect(lines).toContain('References: <original@external.com>');
      expect(result.renderedEmail).not.toContain('X-Extra');
    });

    it('in a stored parent identifier with no valid identifier yields an unthreaded reply', async () => {
      ledger.recordThreadMapping({
        conversationId: 'conv_1',
        frankMessageId: 'parent_1',
        rfc822MessageId: '<original' + suffix + '@external.com>',
        createdAtMs: NOW - 1000,
      });
      const result = await delivery.processOutboundDirectMessage(
        base({ inReplyToFrankMessageId: 'parent_1' })
      );
      const lines = headerLines(result.renderedEmail);
      expect(lines.some((l) => /^(In-Reply-To|References):/.test(l))).toBe(false);
      expect(result.inReplyToRfc822).toBeUndefined();
      expect(result.renderedEmail).toContain('Hello Bob.');
    });
  });

  it.each(['a b', 'a<b', 'a>b', 'a@b', 'a,b', 'a"b', 'a(b', 'a;b', ''])(
    'refuses the sender %j, which cannot be written in a From header',
    async (sender) => {
      await expect(
        delivery.processOutboundDirectMessage(base({ senderFrankAddress: sender }))
      ).rejects.toMatchObject({ name: 'OutboundRenderRefusal' });
      expectNothingRecorded();
    }
  );

  it.each(['Bob <bob@remote.com>', 'bob@remote', 'bob remote.com', 'a@b.com, c@d.com'])(
    'refuses the recipient %j, which is not one email address',
    async (recipient) => {
      await expect(
        delivery.processOutboundDirectMessage(base({ recipientEmail: recipient }))
      ).rejects.toMatchObject({ name: 'OutboundRenderRefusal' });
    }
  );
});

function makeWorker() {
  const mxTransport = new MxDirectTransport({
    heloDomain: 'frank.org',
    resolveMxFn: async () => [{ exchange: 'mx.example.com', priority: 10 }],
  });
  const sent: Array<{ to: string; raw: string }> = [];
  const deliver = jest.spyOn(mxTransport, 'deliver').mockImplementation(async (params) => {
    sent.push({ to: params.toAddress, raw: new TextDecoder().decode(params.rawRfc822) });
    return { success: true, outcome: 'accepted', responseCode: 250, responseMessage: 'OK' };
  });
  const worker = new OutboundMtaWorker({
    gatewayDomain: 'frank.org',
    ledger,
    delivery,
    dkimSigner: new DkimSigner({
      domain: 'frank.org',
      selector: 'test',
      privateKey: generateDkimKeyPair().privateKey,
    }),
    mxTransport,
  });
  return { worker, deliver, sent };
}

describe('dispatching a message the renderer refuses', () => {
  it('reports a permanent failure, delivers nothing and queues nothing', async () => {
    const { worker, deliver } = makeWorker();
    const result = await worker.dispatchMessage(base({ recipientEmail: 'bob@remote.com\r\nX-Extra: 1' }));
    expect(result).toMatchObject({ success: false, spooled: false });
    expect(result.error).toBeDefined();
    expect(deliver).not.toHaveBeenCalled();
    expect(ledger.getPendingSpoolCount()).toBe(0);
    expectNothingRecorded();

    const summary = await worker.processSpool(NOW + 365 * 24 * 3600 * 1000);
    expect(summary.processed).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });
});

function makeDm(overrides: Partial<DirectMessageReceived>): DirectMessageReceived {
  return {
    senderAddress: { raw: SENDER },
    recipientAddress: { raw: '0xgateway' },
    conversationId: 'conv_1',
    messageId: 'fmsg_1',
    payloadDigest: 'digest_1',
    stampValueWei: 1000n,
    stampPayments: [],
    receivedTime: NOW,
    items: [],
    ...overrides,
  } as DirectMessageReceived;
}

function emailDm(email: Record<string, unknown>, overrides: Partial<DirectMessageReceived> = {}) {
  return makeDm({
    items: [
      {
        type: 'email',
        messageId: '<draft@frank>',
        from: { address: 'alice@frank.org' },
        to: [{ address: 'bob@remote.com' }],
        subject: 'Greeting',
        textBody: 'Hello Bob.',
        ...email,
      },
    ] as DirectMessageReceived['items'],
    ...overrides,
  });
}

function makeListener(fetchSince?: (sinceMs: number) => DirectMessageReceived[]) {
  const { worker, deliver, sent } = makeWorker();
  const listener = new RelayMailboxListener({
    gatewayDomain: 'frank.org',
    activeChain: {
      directMessages: {
        fetchSince: async (params: { sinceMs: number }) => fetchSince?.(params.sinceMs) ?? [],
      },
    } as unknown as ActiveChain,
    wallet: {} as WalletHandle,
    ledger,
    outboundWorker: worker,
  });
  return { listener, worker, deliver, sent };
}

describe('accepting a Frank message for email', () => {
  describe.each(BROKEN_SUFFIXES)('with %s in a value', (_name, suffix) => {
    it('sends the message with a single-line Subject and records it as usual', async () => {
      const { listener, sent } = makeListener();
      await listener.processDirectMessage(emailDm({ subject: 'Greeting' + suffix }));

      expect(sent).toHaveLength(1);
      expect(headerLines(sent[0].raw.replace(/\r\n/g, '\n'))).toContain('Subject: Greeting X-Extra: 1');
      expect(sent[0].raw).toContain('Hello Bob.');
      expect(ledger.getLatestThreadMappingByConversationId('conv_1')?.subject).toBe(
        'Greeting X-Extra: 1'
      );
      expect(ledger.getThreadAllowance('bob@remote.com', SENDER)).toBe(3);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('does not send to a recipient that is not an email address, and records nothing', async () => {
      const { listener, deliver } = makeListener();
      await listener.processDirectMessage(emailDm({ to: [{ address: 'bob@remote.com' + suffix }] }));
      await listener.processDirectMessage(emailDm({ to: [{ address: 'bob@remote.com' + suffix[0] }] }));

      expect(deliver).not.toHaveBeenCalled();
      expectNothingRecorded();
      expect(ledger.getPendingSpoolCount()).toBe(0);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('leaves out a Cc entry that is not an email address and sends to the others', async () => {
      const { listener, sent } = makeListener();
      await listener.processDirectMessage(
        emailDm({
          to: [{ address: 'bob@remote.com' }, { address: 'carol@remote.com' }],
          cc: [{ address: 'eve@remote.com' + suffix }, { address: 'Dave@remote.com' }],
        })
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('bob@remote.com');
      expect(headerLines(sent[0].raw.replace(/\r\n/g, '\n'))).toContain(
        'Cc: carol@remote.com, dave@remote.com'
      );
      expect(sent[0].raw).not.toContain('X-Extra');
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  it('writes a stored thread subject as a single line in a reply', async () => {
    ledger.recordThreadMapping({
      conversationId: 'conv_1',
      frankMessageId: 'parent_1',
      rfc822MessageId: '<original@external.com>',
      subject: 'Hello\r\nAlice',
      senderAddress: 'bob@remote.com',
      createdAtMs: NOW - 1000,
    });
    const { listener, sent } = makeListener();
    await listener.processDirectMessage(makeDm({ items: [{ type: 'text', text: 'Sure.' }] as DirectMessageReceived['items'] }));

    expect(sent).toHaveLength(1);
    const lines = headerLines(sent[0].raw.replace(/\r\n/g, '\n'));
    expect(lines).toContain('Subject: Re: Hello Alice');
    expect(lines).toContain('In-Reply-To: <original@external.com>');
  });

  it('takes To, Cc and Subject from single lines at the top of a text message', async () => {
    const { listener, sent } = makeListener();
    await listener.processDirectMessage(
      makeDm({
        items: [
          {
            type: 'text',
            text:
              'To: Bob <bob@remote.com>, carol@remote.com\r\n' +
              'Cc: dave@remote.com\n' +
              'Subject: Lunch plans\n' +
              '\n' +
              'First line\n' +
              'Subject: not a header\n' +
              'Cc: eve@remote.com',
          },
        ] as DirectMessageReceived['items'],
      })
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('bob@remote.com');
    const raw = sent[0].raw.replace(/\r\n/g, '\n');
    const lines = headerLines(raw);
    expect(lines).toContain('Cc: carol@remote.com, dave@remote.com');
    expect(lines).toContain('Subject: Lunch plans');
    expect(raw).toContain(`\n\nFirst line\nSubject: not a header\nCc: eve@remote.com${FOOTER}`);
  });

  it('treats a text line with a carriage return inside it as body text', async () => {
    const { listener, sent } = makeListener();
    await listener.processDirectMessage(
      makeDm({
        items: [
          { type: 'text', text: 'To: bob@remote.com\nSubject: Lunch\rX-Extra: 1\nSee you there' },
        ] as DirectMessageReceived['items'],
      })
    );

    expect(sent).toHaveLength(1);
    const raw = sent[0].raw.replace(/\r\n/g, '\n');
    expect(headerLines(raw)).toContain('Subject: Message from Frank');
    const body = raw.slice(raw.indexOf('\n\n') + 2);
    expect(body).toContain('X-Extra: 1\nSee you there');
  });

  it('continues with later messages of a poll after one is refused', async () => {
    const refused = emailDm({}, { senderAddress: { raw: 'not a sender' }, messageId: 'fmsg_bad', conversationId: 'conv_bad', receivedTime: NOW });
    const later = emailDm({}, { messageId: 'fmsg_good', conversationId: 'conv_good', receivedTime: NOW + 1 });
    const { listener, sent } = makeListener((sinceMs) =>
      [refused, later].filter((m) => m.receivedTime >= sinceMs)
    );

    await listener.pollOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0].raw).toContain('Message-ID: <frank_fmsg_good_');
    expect(ledger.getLatestThreadMappingByConversationId('conv_bad')).toBeUndefined();
    expect(ledger.getLatestThreadMappingByConversationId('conv_good')).toBeDefined();
    expect(ledger.getPendingSpoolCount()).toBe(0);
  });

  it('offers a refused message for sending once when later polls return it again', async () => {
    const refused = emailDm({}, { senderAddress: { raw: 'not a sender' }, messageId: 'fmsg_bad', conversationId: 'conv_bad', receivedTime: NOW });
    const { listener, worker, deliver } = makeListener((sinceMs) =>
      [refused].filter((m) => m.receivedTime >= sinceMs)
    );
    const dispatch = jest.spyOn(worker, 'dispatchMessage');

    await listener.pollOnce();
    await listener.pollOnce();

    // The cursor is inclusive, so the newest message of a poll is returned again.
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(dispatch.mock.results[0].value).resolves.toMatchObject({ success: false, spooled: false });
    expect(deliver).not.toHaveBeenCalled();
    expect(ledger.getLatestThreadMappingByConversationId('conv_bad')).toBeUndefined();
    expect(ledger.getPendingSpoolCount()).toBe(0);
  });
});

describe('POST /api/mail/send', () => {
  let server: CheckoutServer;
  let port: number;

  beforeEach(async () => {
    server = new CheckoutServer({
      port: 0,
      ledger,
      stampProvider: {} as GatewayStampProvider,
      outboundDelivery: delivery,
    });
    await server.start();
    port = server.getPort();
  });

  afterEach(async () => {
    await server.stop();
  });

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`http://127.0.0.1:${port}/api/mail/send`, {
      method: 'POST',
      body: JSON.stringify({ bodyText: 'Hello Bob.', conversationId: 'conv_1', ...body }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('renders a request with valid values', async () => {
    const { status, json } = await post({ recipientEmail: 'bob@remote.com', senderFrankAddress: SENDER });
    expect(status).toBe(200);
    expect(headerLines(json.renderedEmail as string)).toContain('To: bob@remote.com');
  });

  describe.each(BROKEN_SUFFIXES)('with %s in a value', (_name, suffix) => {
    it.each([
      ['recipientEmail', { recipientEmail: 'bob@remote.com' + suffix }],
      ['senderFrankAddress', { recipientEmail: 'bob@remote.com', senderFrankAddress: SENDER + suffix }],
      ['frankMessageId', { recipientEmail: 'bob@remote.com', frankMessageId: 'fmsg_1' + suffix }],
    ])('answers 400 for %s and records nothing', async (_field, body) => {
      const { status, json } = await post({ senderFrankAddress: SENDER, ...body });
      expect(status).toBe(400);
      expect(typeof json.error).toBe('string');
      expect(json.renderedEmail).toBeUndefined();
      expectNothingRecorded();
    });

    it('writes the subject as a single line', async () => {
      const { status, json } = await post({
        recipientEmail: 'bob@remote.com',
        senderFrankAddress: SENDER,
        subject: 'Greeting' + suffix,
      });
      expect(status).toBe(200);
      expect(headerLines(json.renderedEmail as string)).toContain('Subject: Greeting X-Extra: 1');
    });
  });
});
