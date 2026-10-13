/**
 * Single-record HTTPS domain discovery (`/.well-known/cashweb.json`) and
 * federated `user@domain` handle resolution (Issue #973).
 *
 * Architectural invariant: Any domain (`signet.mx`, `example.com`) only ever
 * publishes ONE domain-level `/.well-known/cashweb.json` descriptor (or one
 * `_cashweb._tcp.<domain>` SRV record), never per-user DNS records. Individual
 * handle resolution (`alice`) happens over the discovered relay's directory API
 * (`GET /usernames/:name`).
 */

export const DEFAULT_DOMAIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface DomainCashwebDescriptor {
  readonly version: 1;
  readonly relay: string;
  readonly mail_gateway?: string;
  readonly network?: string;
  readonly fallbackRelays?: readonly string[];
  readonly emailGatewayAddress?: string;
  readonly supportedChains?: readonly string[];
}

export interface DiscoverDomainRelayOptions {
  readonly fetch?: typeof fetch;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
  readonly forceRefresh?: boolean;
}

export interface FederatedIdentifierResolution {
  readonly address: string;
  readonly relayUrl: string;
  readonly username?: string;
  readonly domain?: string;
  readonly subject?: string;
  readonly claim?: string;
  readonly entry?: {
    readonly content_type: string;
    readonly raw_hex: string;
  };
}

export interface ResolveFederatedIdentifierOptions extends DiscoverDomainRelayOptions {
  readonly verifySignature?: (
    record: Record<string, unknown>,
    username: string,
    domain: string,
  ) => boolean | Promise<boolean>;
}

interface CacheEntry {
  readonly descriptor: DomainCashwebDescriptor;
  readonly expiresAt: number;
}

const domainRelayCache = new Map<string, CacheEntry>();

/**
 * Clears the in-memory `/.well-known/cashweb.json` domain discovery cache.
 */
export function clearDomainDiscoveryCache(): void {
  domainRelayCache.clear();
}

/**
 * Normalizes and validates a domain name for `/.well-known/cashweb.json` discovery.
 * Rejects empty strings, IP literals, single-label names, or URLs with paths/ports.
 */
export function normalizeDiscoveryDomain(domain: string): string | undefined {
  if (typeof domain !== 'string') return undefined;
  const trimmed = domain.trim().replace(/^@+/, '').toLowerCase().replace(/\.+$/, '');
  if (!trimmed || trimmed.length > 253) return undefined;
  if (!trimmed.includes('.') || /^[0-9.]+$/.test(trimmed)) return undefined;
  const labels = trimmed.split('.');
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      return undefined;
    }
  }
  return trimmed;
}

/**
 * Validates that a candidate relay URL is an HTTPS origin without credentials,
 * query parameters, fragments, or non-root paths.
 */
export function validateRelayOrigin(relayUrl: unknown): string | undefined {
  if (typeof relayUrl !== 'string' || !relayUrl.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(relayUrl.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return undefined;
  if (!parsed.hostname || !parsed.hostname.includes('.') || /^[0-9.]+$/.test(parsed.hostname)) {
    return undefined;
  }
  return parsed.origin;
}

/**
 * Discovers a domain's Cashweb relay descriptor via `GET https://<domain>/.well-known/cashweb.json`.
 * Validates HTTPS origin and `version: 1` schema, and caches positive results per domain
 * (default 24h TTL).
 */
export async function discoverDomainRelay(
  domain: string,
  options?: DiscoverDomainRelayOptions,
): Promise<DomainCashwebDescriptor | undefined> {
  const normalizedDomain = normalizeDiscoveryDomain(domain);
  if (!normalizedDomain) return undefined;

  const nowFn = options?.now ?? Date.now;
  const now = nowFn();
  const ttlMs = options?.cacheTtlMs ?? DEFAULT_DOMAIN_CACHE_TTL_MS;

  if (!options?.forceRefresh && ttlMs > 0) {
    const cached = domainRelayCache.get(normalizedDomain);
    if (cached && cached.expiresAt > now) {
      return cached.descriptor;
    }
  }

  const fetchFn = options?.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return undefined;

  let response: Response;
  try {
    response = await fetchFn(`https://${normalizedDomain}/.well-known/cashweb.json`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return undefined;
  }

  if (!response || !response.ok) return undefined;

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return undefined;
  }

  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return undefined;

  const validatedRelay = validateRelayOrigin(obj.relay);
  if (!validatedRelay) return undefined;

  if (obj.mail_gateway !== undefined && (typeof obj.mail_gateway !== 'string' || !obj.mail_gateway.trim())) {
    return undefined;
  }
  if (obj.network !== undefined && (typeof obj.network !== 'string' || !obj.network.trim())) {
    return undefined;
  }

  const descriptor: DomainCashwebDescriptor = {
    version: 1,
    relay: validatedRelay,
    ...(typeof obj.mail_gateway === 'string' && obj.mail_gateway.trim()
      ? { mail_gateway: obj.mail_gateway.trim().toLowerCase() }
      : {}),
    ...(typeof obj.network === 'string' && obj.network.trim()
      ? { network: obj.network.trim() }
      : {}),
    ...(Array.isArray(obj.fallbackRelays)
      ? {
          fallbackRelays: obj.fallbackRelays
            .map((r: unknown) => validateRelayOrigin(r))
            .filter((r): r is string => r !== undefined),
        }
      : {}),
    ...(typeof obj.emailGatewayAddress === 'string' && obj.emailGatewayAddress.trim()
      ? { emailGatewayAddress: obj.emailGatewayAddress.trim() }
      : {}),
    ...(Array.isArray(obj.supportedChains)
      ? {
          supportedChains: obj.supportedChains.filter(
            (c: unknown): c is string => typeof c === 'string' && c.trim().length > 0,
          ),
        }
      : {}),
  };

  if (ttlMs > 0) {
    domainRelayCache.set(normalizedDomain, {
      descriptor,
      expiresAt: now + ttlMs,
    });
  }

  return descriptor;
}

/**
 * Parses a federated handle such as `alice@signet.mx` or `@alice@signet.mx` into
 * normalized `{ username, domain }`.
 */
export function parseFederatedIdentifier(
  identifier: string,
): { readonly username: string; readonly domain: string } | undefined {
  if (typeof identifier !== 'string') return undefined;
  const trimmed = identifier.trim().replace(/^@/, '');
  const parts = trimmed.split('@');
  if (parts.length !== 2) return undefined;
  const username = parts[0].trim().toLowerCase();
  if (!username || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) {
    return undefined;
  }
  const domain = normalizeDiscoveryDomain(parts[1]);
  if (!domain) return undefined;
  return { username, domain };
}

/**
 * Resolves a federated identifier (`alice@signet.mx` or `@alice@signet.mx`) by:
 * 1. Discovering the domain's authoritative relay via `discoverDomainRelay(domain)`
 *    (`GET https://<domain>/.well-known/cashweb.json`), and
 * 2. Querying `GET <relayUrl>/usernames/<username>` to obtain the user's canonical
 *    Frank identity address and directory record.
 */
export async function resolveFederatedIdentifier(
  identifier: string,
  options?: ResolveFederatedIdentifierOptions,
): Promise<FederatedIdentifierResolution | undefined> {
  const parsed = parseFederatedIdentifier(identifier);
  if (!parsed) return undefined;

  const descriptor = await discoverDomainRelay(parsed.domain, options);
  if (!descriptor) return undefined;

  const fetchFn = options?.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return undefined;

  const lookupUrl = `${descriptor.relay}/usernames/${encodeURIComponent(parsed.username)}`;
  let response: Response;
  try {
    response = await fetchFn(lookupUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return undefined;
  }

  if (!response || !response.ok) return undefined;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }

  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;

  if (
    typeof record.status === 'string' &&
    record.status !== 'active'
  ) {
    return undefined;
  }

  const rawAddress =
    typeof record.address === 'string'
      ? record.address
      : typeof record.account_address === 'string'
        ? record.account_address
        : typeof record.account === 'string'
          ? record.account
          : undefined;

  if (!rawAddress || !/^0x[0-9a-fA-F]{40}$/.test(rawAddress.trim())) {
    return undefined;
  }

  if (options?.verifySignature) {
    const valid = await options.verifySignature(record, parsed.username, parsed.domain);
    if (!valid) return undefined;
  }

  return {
    address: rawAddress.trim().toLowerCase(),
    relayUrl: descriptor.relay,
    username: parsed.username,
    domain: parsed.domain,
    ...(typeof record.subject === 'string' ? { subject: record.subject } : {}),
    ...(typeof record.claim === 'string' ? { claim: record.claim } : {}),
    ...(record.entry &&
    typeof record.entry === 'object' &&
    typeof (record.entry as Record<string, unknown>).content_type === 'string' &&
    typeof (record.entry as Record<string, unknown>).raw_hex === 'string'
      ? {
          entry: {
            content_type: (record.entry as Record<string, unknown>).content_type as string,
            raw_hex: (record.entry as Record<string, unknown>).raw_hex as string,
          },
        }
      : {}),
  };
}
