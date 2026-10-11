/**
 * The amount formatter a bot gets from its host, for a unit test: the host's own `chainAmounts`
 * over the real chain object of a registered EVM network. No unit name is written here; it is
 * the chain registry's for the canonical identifier.
 */
import { chainAmounts, type BotAmounts } from "@frank/bot-framework";
import { getChainRegistryEntry } from "@frank/wallet/chain/chains-registry";
import {
  createEvmChain,
  loadMonadChainConfigFromEnv,
} from "@frank/wallet/chain/monad-chain";

export function amountsOf(chainIdentifier: string): BotAmounts {
  const entry = getChainRegistryEntry(chainIdentifier);
  if (entry?.family !== "evm" || entry.nativeChainId === undefined || !entry.networkTag)
    throw new Error(`${chainIdentifier} is not a registered EVM network`);
  return chainAmounts(
    createEvmChain({
      ...loadMonadChainConfigFromEnv(),
      networkId: entry.id,
      rpcChain: entry.id,
      chainIdentifier: entry.id,
      chainId: BigInt(entry.nativeChainId),
      networkTag: entry.networkTag,
      relayBaseUrl: "http://relay.invalid",
      walletStorageLocation: false,
    })
  );
}
