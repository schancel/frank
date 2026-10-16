/** Fresh, observation-scoped qualification of an exact supplied EVM RPC transport. */
import { getChainRegistryEntry } from "./chains-registry";
import type { EvmChainConfig } from "./evm-chain-config";

export interface EvmIdentityRpc {
  send(method: string, params: unknown[]): Promise<unknown>;
}

export interface OperatorCheckpoint {
  readonly blockNumber: number;
  readonly blockHash: string;
}

export function validateEvmWalletConfiguration(
  config: EvmChainConfig,
  checkpoint?: OperatorCheckpoint
) {
  const entry = getChainRegistryEntry(config.networkId);
  if (
    !entry ||
    entry.family !== "evm" ||
    !entry.wallet ||
    entry.id !== config.chainIdentifier ||
    entry.id !== config.rpcChain ||
    entry.networkTag !== config.networkTag ||
    entry.nativeChainId === undefined ||
    BigInt(entry.nativeChainId) !== BigInt(config.chainId)
  )
    throw new Error("Unsupported or inconsistent EVM wallet configuration");
  if (
    entry.identityProbes.some(
      (probe) => probe.kind === "operator-block-checkpoint"
    ) &&
    (!checkpoint ||
      !Number.isSafeInteger(checkpoint.blockNumber) ||
      checkpoint.blockNumber <= 0 ||
      !/^0x[0-9a-fA-F]{64}$/.test(checkpoint.blockHash))
  )
    throw new Error("EVM operator checkpoint is required");
  return entry;
}

function quantity(value: unknown): bigint | undefined {
  return typeof value === "string" &&
    /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)
    ? BigInt(value)
    : undefined;
}

export async function verifyEvmWalletRpcIdentity(
  config: EvmChainConfig,
  provider: EvmIdentityRpc,
  checkpoint: OperatorCheckpoint | undefined,
  requireCurrent: () => void
): Promise<void> {
  requireCurrent();
  const entry = validateEvmWalletConfiguration(config, checkpoint);
  const nativeId = BigInt(entry.nativeChainId!);
  // Copy all values before yielding; callers retain ownership of their input objects.
  const probes = entry.identityProbes
    .filter((probe) => probe.capability === "json-rpc")
    .map((probe) => {
      if (probe.kind === "evm-chain-id")
        return { kind: "id" as const, expected: BigInt(probe.expected) };
      if (probe.kind === "block-hash")
        return {
          kind: "block" as const,
          height: probe.height,
          hash: probe.expected.toLowerCase(),
        };
      if (probe.kind === "operator-block-checkpoint" && checkpoint)
        return {
          kind: "block" as const,
          height: checkpoint.blockNumber,
          hash: checkpoint.blockHash.toLowerCase(),
        };
      throw new Error("Unsupported EVM identity probe");
    });
  const request = async (
    method: string,
    params: unknown[]
  ): Promise<unknown> => {
    requireCurrent();
    try {
      return await provider.send(method, params);
    } finally {
      requireCurrent();
    }
  };
  const chainId = quantity(await request("eth_chainId", []));
  if (chainId !== nativeId) throw new Error("EVM RPC chain identity mismatch");
  for (const probe of probes) {
    if (probe.kind === "id") {
      if (chainId !== probe.expected)
        throw new Error("EVM RPC chain identity mismatch");
      continue;
    }
    const block = await request("eth_getBlockByNumber", [
      "0x" + probe.height.toString(16),
      false,
    ]);
    if (
      typeof block !== "object" ||
      block === null ||
      !("number" in block) ||
      quantity(block.number) !== BigInt(probe.height) ||
      !("hash" in block) ||
      typeof block.hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
      block.hash.toLowerCase() !== probe.hash
    )
      throw new Error("EVM RPC checkpoint mismatch");
  }
  requireCurrent();
}
