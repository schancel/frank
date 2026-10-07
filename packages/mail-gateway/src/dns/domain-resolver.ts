import * as dns from 'node:dns';

export interface SrvRelay {
  readonly name: string;
  readonly port: number;
  readonly priority: number;
  readonly weight: number;
}

export interface MxHost {
  readonly exchange: string;
  readonly priority: number;
}

export interface FrankDomainResolution {
  readonly domain: string;
  readonly srvRelay?: SrvRelay;
  readonly allSrvRelays?: readonly SrvRelay[];
  readonly mxHosts: readonly MxHost[];
}

export interface ResolveFrankDomainOptions {
  /** Custom SRV resolver function (defaults to dns.promises.resolveSrv). */
  readonly resolveSrv?: (name: string) => Promise<dns.SrvRecord[]>;
  /** Custom MX resolver function (defaults to dns.promises.resolveMx). */
  readonly resolveMx?: (name: string) => Promise<dns.MxRecord[]>;
  /** Disable fallback to relay.<domain>:443 when SRV is absent (defaults to false). */
  readonly disableFallback?: boolean;
  /** Custom default fallback relay port (defaults to 443). */
  readonly fallbackPort?: number;
  /** Custom default fallback relay priority (defaults to 10). */
  readonly fallbackPriority?: number;
  /** Custom default fallback relay weight (defaults to 0). */
  readonly fallbackWeight?: number;
}

/**
 * Normalizes a target domain name by trimming whitespace, lowercasing, and stripping trailing dots.
 */
export function normalizeDomain(domain: string): string {
  if (typeof domain !== 'string' || !domain.trim()) {
    throw new Error('Domain must be a non-empty string');
  }
  return domain.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Resolves dual-protocol Frank domain routing information:
 * 1. Resolves DNS SRV `_frank._tcp.<domain>` for native Frank federated Cashweb relays.
 *    If absent or resolution fails, provides fallback heuristic `relay.<domain>:443`.
 * 2. Resolves DNS MX `<domain>` for standard Internet email delivery to the Frank Email Gateway.
 */
export async function resolveFrankDomain(
  domain: string,
  options?: ResolveFrankDomainOptions,
): Promise<FrankDomainResolution> {
  const normalizedDomain = normalizeDomain(domain);
  const srvName = `_frank._tcp.${normalizedDomain}`;

  const resolveSrvFn = options?.resolveSrv ?? dns.promises.resolveSrv;
  const resolveMxFn = options?.resolveMx ?? dns.promises.resolveMx;

  // Resolve SRV and MX concurrently with individual error handling
  const [srvResult, mxResult] = await Promise.allSettled([
    resolveSrvFn(srvName),
    resolveMxFn(normalizedDomain),
  ]);

  let srvRelay: SrvRelay | undefined;
  let allSrvRelays: SrvRelay[] | undefined;

  if (srvResult.status === 'fulfilled' && Array.isArray(srvResult.value) && srvResult.value.length > 0) {
    // Sort candidate relays by ascending priority (lowest value first),
    // and descending weight for equal priorities (RFC 2782)
    const sorted = [...srvResult.value].sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return b.weight - a.weight;
    });

    allSrvRelays = sorted.map((rec) => ({
      name: rec.name.replace(/\.+$/, ''),
      port: rec.port,
      priority: rec.priority,
      weight: rec.weight,
    }));

    srvRelay = allSrvRelays[0];
  } else if (!options?.disableFallback) {
    // Fallback heuristic when SRV is absent: default relay host `relay.<domain>:443`
    srvRelay = {
      name: `relay.${normalizedDomain}`,
      port: options?.fallbackPort ?? 443,
      priority: options?.fallbackPriority ?? 10,
      weight: options?.fallbackWeight ?? 0,
    };
    allSrvRelays = [srvRelay];
  }

  let mxHosts: MxHost[] = [];
  if (mxResult.status === 'fulfilled' && Array.isArray(mxResult.value) && mxResult.value.length > 0) {
    mxHosts = [...mxResult.value]
      .sort((a, b) => a.priority - b.priority)
      .map((rec) => ({
        exchange: rec.exchange.replace(/\.+$/, ''),
        priority: rec.priority,
      }));
  }

  return {
    domain: normalizedDomain,
    ...(srvRelay ? { srvRelay } : {}),
    ...(allSrvRelays ? { allSrvRelays } : {}),
    mxHosts,
  };
}
