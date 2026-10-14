import type { JournaledInboundSend } from '../src/relay/journaled-inbound-send';
import {
  ResendInboundWebhook,
  handleResendWebhookRequest,
  type ResendInboundPort,
} from '../src/smtp/resend-inbound-webhook';

const RAW = Buffer.from(
  'From: Carol <carol@example.org>\r\nTo: alice@signet.mx\r\nMessage-ID: <one@example.org>\r\nSubject: Hello\r\n\r\nHello.',
);
const HEADERS = { id: 'event-1', timestamp: '1', signature: 'signed' };
const CONVERSATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT = { type: 'email.received', data: { email_id: 'email-1' } };
const RECEIVED = {
  id: 'email-1',
  from: 'Carol <carol@example.org>',
  received_for: ['alice@signet.mx'],
  authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
  raw: { download_url: 'https://raw.example.test/message?sig=1' },
};

describe('signed Resend inbound admission', () => {
  const verify = jest.fn(() => EVENT as unknown);
  const retrieve = jest.fn(async () => RECEIVED as unknown);
  const issuedMailbox = jest.fn<Promise<{ accountAddress: string; conversationId: string } | undefined>, [string]>(async () => ({
    accountAddress: `0x${'a'.repeat(40)}`,
    conversationId: CONVERSATION,
  }));
  const admit = jest.fn(() => ({ kind: 'held' as const }));
  const fetcher = jest.fn(async () => new Response(new Uint8Array(RAW)));

  const make = () => new ResendInboundWebhook({
    port: { verify, retrieve } as ResendInboundPort,
    webhookSecret: 'whsec_test',
    gatewayDomain: 'signet.mx',
    rawOrigins: ['https://raw.example.test'],
    issuedMailboxLookup: issuedMailbox,
    sender: { admit } as unknown as JournaledInboundSend,
    stampValue: 1000n,
    fetcher: fetcher as unknown as typeof fetch,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    verify.mockReturnValue(EVENT);
    retrieve.mockResolvedValue(RECEIVED);
    issuedMailbox.mockResolvedValue({ accountAddress: `0x${'a'.repeat(40)}`, conversationId: CONVERSATION });
  });

  it('durably admits only a signed, authenticated message for an issued mailbox', async () => {
    const result = await make().handle('raw signed JSON', HEADERS);
    expect(verify).toHaveBeenCalledWith('raw signed JSON', HEADERS, 'whsec_test');
    expect(retrieve).toHaveBeenCalledWith('email-1');
    expect(fetcher).toHaveBeenCalledWith(RECEIVED.raw.download_url, { redirect: 'error' });
    expect(issuedMailbox).toHaveBeenCalledWith('alice');
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedTransportId: 'email-1', authenticatedSenderEmail: 'carol@example.org' }),
      `0x${'a'.repeat(40)}`, 1000n, CONVERSATION, 'alice',
    );
    expect(result).toEqual({ kind: 'admitted', admissions: [{ kind: 'held' }] });
  });

  it('short-circuits when event data.to has only foreign recipients', async () => {
    verify.mockReturnValueOnce({ type: 'email.received', data: { email_id: 'email-1', to: ['other@example.com'] } });
    expect(await make().handle('signed', HEADERS)).toEqual({ kind: 'ignored', admissions: [] });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('ignores mail when retrieved received_for has only foreign recipients', async () => {
    retrieve.mockResolvedValueOnce({ ...RECEIVED, received_for: ['other@example.com'] });
    expect(await make().handle('signed', HEADERS)).toEqual({ kind: 'ignored', admissions: [] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('admits only own-domain recipients when received_for is mixed', async () => {
    retrieve.mockResolvedValueOnce({ ...RECEIVED, received_for: ['other@example.com', 'alice@signet.mx', 123] });
    expect((await make().handle('signed', HEADERS)).admissions).toHaveLength(1);
    expect(admit).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1000n, expect.anything(), 'alice');
  });

  it('passes each verified envelope alias separately even when both resolve to one account', async () => {
    const secondConversation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    retrieve.mockResolvedValueOnce({ ...RECEIVED, received_for: ['alice@signet.mx', 'bob@signet.mx'] });
    issuedMailbox.mockImplementation(async localPart => ({
      accountAddress: `0x${'a'.repeat(40)}`,
      conversationId: localPart === 'alice' ? CONVERSATION : secondConversation,
    }));
    expect((await make().handle('signed', HEADERS)).admissions).toHaveLength(2);
    expect(admit).toHaveBeenNthCalledWith(1, expect.anything(), `0x${'a'.repeat(40)}`, 1000n, CONVERSATION, 'alice');
    expect(admit).toHaveBeenNthCalledWith(2, expect.anything(), `0x${'a'.repeat(40)}`, 1000n, secondConversation, 'bob');
  });

  it('does not retrieve or spend when signature verification fails', async () => {
    verify.mockImplementationOnce(() => { throw new Error('bad signature'); });
    await expect(make().handle('forged', HEADERS)).rejects.toThrow('Invalid Resend webhook signature');
    expect(retrieve).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('ignores unrelated signed events and rejects unauthenticated or unissued mail', async () => {
    verify.mockReturnValueOnce({ type: 'email.bounced', data: { email_id: 'email-1' } });
    expect(await make().handle('bounce', HEADERS)).toEqual({ kind: 'ignored', admissions: [] });
    expect(retrieve).not.toHaveBeenCalled();
    retrieve.mockResolvedValueOnce({ ...RECEIVED, authentication: { dmarc: 'fail' } });
    expect(await make().handle('failed auth', HEADERS)).toEqual({ kind: 'rejected_unauthenticated', admissions: [] });
    issuedMailbox.mockResolvedValueOnce(undefined);
    expect(await make().handle('unknown mailbox', HEADERS)).toEqual({ kind: 'rejected_unknown', admissions: [] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('refuses a mismatched API identity and an unallowlisted raw URL', async () => {
    retrieve.mockResolvedValueOnce({ ...RECEIVED, id: 'different' });
    await expect(make().handle('signed', HEADERS)).rejects.toThrow(/ID differs/);
    retrieve.mockResolvedValueOnce({
      ...RECEIVED, raw: { download_url: 'https://untrusted.example.test/message' },
    });
    await expect(make().handle('signed', HEADERS)).rejects.toThrow(/origin is not configured/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('acknowledges only after admission and retries storage failures', async () => {
    const headers = { 'svix-id': HEADERS.id, 'svix-timestamp': HEADERS.timestamp, 'svix-signature': HEADERS.signature };
    const request = () => new Request('https://relay.example.test/mail/resend', {
      method: 'POST', headers, body: 'raw signed JSON',
    });
    expect((await handleResendWebhookRequest(request(), make())).status).toBe(204);
    expect(admit).toHaveBeenCalledTimes(1);
    admit.mockImplementationOnce(() => { throw new Error('SQLite unavailable'); });
    expect((await handleResendWebhookRequest(request(), make())).status).toBe(503);
    verify.mockImplementationOnce(() => { throw new Error('invalid signature'); });
    expect((await handleResendWebhookRequest(request(), make())).status).toBe(401);
    expect((await handleResendWebhookRequest(new Request('https://relay.example.test/mail/resend', {
      method: 'POST', headers, body: 'x'.repeat(65 * 1024),
    }), make())).status).toBe(413);
  });

  it('admits operational mailboxes like support@ and admin@ when issuedMailboxLookup resolves an operator account', async () => {
    const operatorAddress = `0x${'f'.repeat(40)}`;
    retrieve.mockResolvedValueOnce({ ...RECEIVED, received_for: ['support@signet.mx', 'admin@signet.mx'] });
    issuedMailbox.mockImplementation(async (localPart) =>
      localPart === 'support' || localPart === 'admin'
        ? { accountAddress: operatorAddress, conversationId: CONVERSATION }
        : undefined
    );
    const result = await make().handle('signed', HEADERS);
    expect(result.kind).toBe('admitted');
    expect(result.admissions).toHaveLength(2);
    expect(admit).toHaveBeenNthCalledWith(1, expect.anything(), operatorAddress, 1000n, CONVERSATION, 'support');
    expect(admit).toHaveBeenNthCalledWith(2, expect.anything(), operatorAddress, 1000n, CONVERSATION, 'admin');
  });

  it('admits direct user ID fallback local-parts like u.0x...@signet.mx', async () => {
    const userAddress = `0x${'b'.repeat(40)}`;
    const fallbackLocal = `u.${userAddress}`;
    retrieve.mockResolvedValueOnce({ ...RECEIVED, received_for: [`${fallbackLocal}@signet.mx`] });
    issuedMailbox.mockImplementation(async (localPart) =>
      localPart === fallbackLocal ? { accountAddress: userAddress } as never : undefined
    );
    const result = await make().handle('signed', HEADERS);
    expect(result.kind).toBe('admitted');
    expect(admit).toHaveBeenCalledWith(expect.anything(), userAddress, 1000n, undefined, fallbackLocal);
  });
});
