/**
 * What a bot is given to write amounts with: the unit of the chain the host runs on, read from
 * the chain registry by canonical identifier. The chain objects here are the real ones
 * (`createEvmChain`); nothing is stubbed.
 */
import { getChainRegistryEntry } from "@frank/wallet/chain/chains-registry";
import {
  createEvmChain,
  loadMonadChainConfigFromEnv,
} from "@frank/wallet/chain/monad-chain";
import { chainAmounts } from "../src/amounts";

const chainOf = (chainIdentifier: string) => {
  const entry = getChainRegistryEntry(chainIdentifier)!;
  return createEvmChain({
    ...loadMonadChainConfigFromEnv(),
    networkId: entry.id,
    rpcChain: entry.id,
    chainIdentifier: entry.id,
    chainId: BigInt(entry.nativeChainId!),
    networkTag: entry.networkTag!,
    relayBaseUrl: "http://relay.invalid",
    walletStorageLocation: false,
  });
};

describe("a bot's amounts are written in its chain's unit", () => {
  it.each([
    ["monad-testnet", "0.01 MONT"],
    ["monad-mainnet", "0.01 MON"],
    ["monad-regtest", "0.01 MONR"],
    ["ethereum-sepolia", "0.01 SEP"],
  ])("%s writes 0.01 of its coin as %s", (chainIdentifier, text) => {
    const amounts = chainAmounts(chainOf(chainIdentifier));
    expect(amounts.formatAmount(10_000_000_000_000_000n)).toBe(text);
    // The unit is the registry's, whatever it is: no network's name is written in the bot code.
    expect(text.split(" ")[1]).toBe(getChainRegistryEntry(chainIdentifier)!.unit);
  });

  it("prints the exact amount and reads a typed one back", () => {
    const amounts = chainAmounts(chainOf("monad-testnet"));
    expect(amounts.formatAmount(0n)).toBe("0.0 MONT");
    expect(amounts.formatAmount(1n)).toBe("0.000000000000000001 MONT");
    expect(amounts.formatAmount(245_000_000_000_000_000n)).toBe("0.245 MONT");
    expect(amounts.parseAmount("0.245")).toBe(245_000_000_000_000_000n);
    expect(() => amounts.parseAmount("a lot")).toThrow();
  });
});
