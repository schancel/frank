/** Pure projection of protocol-owned facts; no client or runtime configuration is read here. */
export type ProtocolChainFamily = "evm" | "bitcoin" | "solana";
export type ProtocolNetwork = "mainnet" | "testnet" | "regtest";
export type ProxyCapability = "json-rpc" | "chronik" | "electrum";
export type ChainIdentityProbe =
  | {
      readonly kind: "evm-chain-id" | "genesis-hash";
      readonly capability: ProxyCapability;
      readonly expected: string;
    }
  | {
      readonly kind: "block-hash";
      readonly capability: ProxyCapability;
      readonly height: number;
      readonly expected: string;
    }
  | {
      readonly kind: "operator-block-checkpoint";
      readonly capability: ProxyCapability;
    };
export interface ProtocolChainFacts {
  readonly id: string;
  readonly family: ProtocolChainFamily;
  readonly network: ProtocolNetwork;
  readonly isTestnet: boolean;
  readonly caip2?: string;
  readonly nativeChainId?: string | number;
  readonly allowedProxyCapabilities: readonly ProxyCapability[];
  readonly identityProbes: readonly ChainIdentityProbe[];
}

const clientKeys = new Set([
  "kind",
  "curve",
  "keyType",
  "enabled",
  "name",
  "unit",
  "networkTag",
  "addressPrefix",
  "rpcUrl",
  "rpcUrls",
  "explorerUrl",
  "contracts",
  "dex",
  "gasChargedOn",
  "reserveBalanceWei",
  "spendSpacingBlocks",
  "paymentPollIntervalMs",
  "exchange",
  "wallet",
]);
const capabilities = new Set(["json-rpc", "chronik", "electrum"]);
function invalid(detail: string): never {
  throw new Error(`Invalid protocol chain registry: ${detail}`);
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("expected object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    invalid("expected nonempty string");
  return value;
}
function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    invalid("expected canonical decimal native ID");
  return value;
}
function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, immutableCopy(item)])
      )
    ) as T;
  }
  return value;
}
function probe(
  value: unknown,
  allowed: readonly ProxyCapability[]
): ChainIdentityProbe {
  const row = object(value);
  if (!allowed.includes(row.capability as ProxyCapability))
    invalid("probe capability not permitted");
  const capability = row.capability as ProxyCapability;
  let keys: string[];
  switch (row.kind) {
    case "evm-chain-id":
      decimal(row.expected);
      keys = ["kind", "capability", "expected"];
      break;
    case "genesis-hash":
      text(row.expected);
      keys = ["kind", "capability", "expected"];
      break;
    case "block-hash":
      text(row.expected);
      if (!Number.isSafeInteger(row.height) || (row.height as number) < 0)
        invalid("invalid checkpoint height");
      keys = ["kind", "capability", "height", "expected"];
      break;
    case "operator-block-checkpoint":
      keys = ["kind", "capability"];
      break;
    default:
      invalid("unknown identity probe");
  }
  if (Object.keys(row).some((key) => !keys.includes(key)))
    invalid("unknown probe field");
  return { ...row, capability } as ChainIdentityProbe;
}
function protocolFacts(value: unknown): ProtocolChainFacts {
  const row = object(value);
  const id = text(row.id);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id))
    invalid("invalid canonical ID");
  if (!["evm", "bitcoin", "solana"].includes(row.family as string))
    invalid("unknown family");
  if (!["mainnet", "testnet", "regtest"].includes(row.network as string))
    invalid("unknown network");
  if (row.caip2 !== null) text(row.caip2);
  const native =
    row.native_chain_id === null ? undefined : decimal(row.native_chain_id);
  if (
    !Array.isArray(row.allowed_proxy_capabilities) ||
    !row.allowed_proxy_capabilities.length
  )
    invalid("missing permitted capabilities");
  const allowed = row.allowed_proxy_capabilities as ProxyCapability[];
  if (
    allowed.some((capability) => !capabilities.has(capability)) ||
    new Set(allowed).size !== allowed.length
  )
    invalid("invalid permitted capabilities");
  if (!Array.isArray(row.identity_probes) || !row.identity_probes.length)
    invalid("missing identity probes");
  const probes = row.identity_probes.map((value) => probe(value, allowed));
  if (
    allowed.some(
      (capability) => !probes.some((probe) => probe.capability === capability)
    )
  )
    invalid("capability missing identity probe");
  return {
    id,
    family: row.family as ProtocolChainFamily,
    network: row.network as ProtocolNetwork,
    isTestnet: row.network !== "mainnet",
    ...(row.caip2 === null ? {} : { caip2: row.caip2 as string }),
    ...(native === undefined
      ? {}
      : {
          nativeChainId:
            BigInt(native) <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(native)
              : native,
        }),
    allowedProxyCapabilities: allowed,
    identityProbes: probes,
  };
}

/** Extensions select an explicit supported subset and may never supply protocol facts. */
export function projectProtocolChains<T extends object>(
  document: unknown,
  extensions: Readonly<Record<string, T>>
): Readonly<Record<string, T & ProtocolChainFacts>> {
  const source = object(document);
  if (source.schema_version !== 1 || !Array.isArray(source.chains))
    invalid("unsupported schema");
  const facts = new Map<string, ProtocolChainFacts>();
  for (const value of source.chains) {
    const row = protocolFacts(value);
    if (facts.has(row.id)) invalid(`duplicate canonical ID ${row.id}`);
    facts.set(row.id, row);
  }
  const entries: Record<string, T & ProtocolChainFacts> = Object.create(null);
  for (const [id, extension] of Object.entries(extensions)) {
    const metadata = object(extension);
    if (Object.keys(metadata).some((key) => !clientKeys.has(key)))
      invalid(`unknown client extension field for ${id}`);
    const row = facts.get(id);
    if (!row) invalid(`unsupported client reference ${id}`);
    // A client wallet may read only through a capability the protocol permits for the chain.
    const wallet = metadata.wallet;
    if (wallet !== undefined) {
      const indexer = object(wallet).indexer;
      if (!row.allowedProxyCapabilities.includes(indexer as ProxyCapability))
        invalid(`wallet indexer not permitted for ${id}`);
    }
    entries[id] = immutableCopy({ ...extension, ...row });
  }
  return Object.freeze(entries);
}
