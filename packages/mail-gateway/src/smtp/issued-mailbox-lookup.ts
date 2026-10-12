import type { MailJournal } from '../ledger/mail-journal';
import type { InboundRecipientResolution } from './inbound-server';

/** Bind both SMTP and signed-webhook ingress to the same durable issuance owner. */
export function createIssuedMailboxLookup(
  journal: MailJournal
): (localPart: string) => Promise<InboundRecipientResolution | undefined> {
  return async (localPart) => {
    const issued = journal.issuedMailbox(localPart);
    return issued && {
      accountAddress: issued.scopeAccount,
      ...(issued.conversationId ? { conversationId: issued.conversationId } : {}),
    };
  };
}
