import type { MailJournal } from '../ledger/mail-journal';
import {
  isOperationalLocalPart,
  isOperatorContactLocalPart,
} from '../mailbox/operational-local-parts';
import type { InboundRecipientResolution } from './inbound-server';

const ISSUED_LOCAL_PART = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const DIRECT_ADDRESS_LOCAL_PART = /^0x[0-9a-f]{40}$/;
const PREFIXED_ADDRESS_LOCAL_PART = /^u\.(0x[0-9a-f]{40})$/;

export interface IssuedMailboxLookupOptions {
  readonly relayUrl?: string;
  readonly relayBaseUrl?: string;
  readonly operatorAccountAddress?: string;
  readonly fetcher?: typeof fetch;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Extracts a canonical lowercase `0x` + 40-hex account address from a direct
 * user ID fallback local-part (`0x...` or `u.0x...`).
 */
export function extractUserIdFallbackAddress(localPart: string): string | undefined {
  const canonical = localPart.trim().toLowerCase();
  if (DIRECT_ADDRESS_LOCAL_PART.test(canonical)) return canonical;
  const prefixed = canonical.match(PREFIXED_ADDRESS_LOCAL_PART);
  return prefixed ? prefixed[1] : undefined;
}

function extractOwnerAddress(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (record.status === 'tombstoned' || record.isTombstoned === true) return undefined;
  const candidate =
    record.address ??
    record.account_address ??
    record.accountAddress ??
    record.ownerAddress ??
    record.owner;
  if (typeof candidate !== 'string') return undefined;
  const normalized = candidate.trim().toLowerCase();
  return DIRECT_ADDRESS_LOCAL_PART.test(normalized) ? normalized : undefined;
}

async function lookupRelayUsernameOwner(
  relayUrl: string,
  localPart: string,
  fetcher: typeof fetch,
): Promise<string | undefined> {
  const base = relayUrl.replace(/\/+$/, '');
  const encoded = encodeURIComponent(localPart);
  const urls = [
    `${base}/usernames/${encoded}`,
    `${base}/directory/user/${encoded}`,
  ];
  for (const url of urls) {
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { 'ngrok-skip-browser-warning': '1' },
      });
      if (response.status === 404 || response.status === 400) continue;
      if (!response.ok) return undefined;
      const body = await response.json().catch(() => undefined);
      const owner = extractOwnerAddress(body);
      if (owner) return owner;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Bind both SMTP and signed-webhook ingress to the same durable issuance owner. */
export function createIssuedMailboxLookup(
  journal: Pick<MailJournal, 'issuedMailbox'>,
  options?: IssuedMailboxLookupOptions,
): (localPart: string) => Promise<InboundRecipientResolution | undefined> {
  const operatorAccount = options?.operatorAccountAddress?.trim().toLowerCase();
  const relayUrl = (options?.relayUrl ?? options?.relayBaseUrl)?.trim();
  const fetcher = options?.fetcher ?? options?.fetchImpl ?? fetch;

  return async (localPart) => {
    const canonical = localPart.trim().toLowerCase();
    if (!canonical || canonical.startsWith('bounce+')) return undefined;

    if (isOperationalLocalPart(canonical)) {
      return operatorAccount ? { accountAddress: operatorAccount } : undefined;
    }

    if (ISSUED_LOCAL_PART.test(canonical)) {
      const issued = journal.issuedMailbox(canonical);
      if (issued) {
        return {
          accountAddress: issued.scopeAccount,
          ...(issued.conversationId ? { conversationId: issued.conversationId } : {}),
        };
      }
    }

    if (isOperatorContactLocalPart(canonical) && operatorAccount) {
      return { accountAddress: operatorAccount };
    }

    const fallbackAddress = extractUserIdFallbackAddress(canonical);
    if (fallbackAddress) {
      return { accountAddress: fallbackAddress };
    }

    if (relayUrl && ISSUED_LOCAL_PART.test(canonical)) {
      const ownerAddress = await lookupRelayUsernameOwner(relayUrl, canonical, fetcher);
      if (ownerAddress) {
        return { accountAddress: ownerAddress };
      }
    }

    return undefined;
  };
}
