/**
 * What a bot is given to write amounts with: the unit of the chain the host runs on, read from
 * the chain registry by canonical identifier. The chain objects here are the real ones
 * (`createEvmChain`); nothing is stubbed.
 */
import { getChainRegistryEntry } from "@frank/wallet/chain/chains-registry";
import {
  createEvmChain,
  loadMonadChainConfigFromEnv,
} from "@frank/wallet/chain/evm-chain";
import { registrySpendRule } from "@frank/wallet/chain/evm-spend-rule";
import { chainAmounts } from "../src/amounts";

const chainOf = (chainIdentifier: string) => {
  const entry = getChainRegistryEntry(chainIdentifier)!;
  return createEvmChain({
    ...loadMonadChainConfigFromEnv(),
    networkId: entry.id,
    rpcChain: entry.id,
    ...registrySpendRule(entry.id),
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
    ["ethereum-sepolia", "0.01 ETH"],
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

  it("shortens a limit rounded down and a minimum rounded up, only when asked", () => {
    const amounts = chainAmounts(chainOf("monad-testnet"));
    const limit = 510_496_892_794_540_437n;
    expect(amounts.formatAmount(limit)).toBe("0.510496892794540437 MONT");
    expect(amounts.formatAmount(limit, { round: "down" })).toBe("0.5104 MONT");
    expect(amounts.formatAmount(limit, { round: "up" })).toBe("0.5105 MONT");
    // An amount with no more digits than shown reads the same either way.
    expect(amounts.formatAmount(245_000_000_000_000_000n, { round: "up" })).toBe("0.245 MONT");
    expect(amounts.formatAmount(0n, { round: "down" })).toBe("0 MONT");
    expect(amounts.formatAmount(1n, { round: "up" })).toBe("0.000000000000000001 MONT");
  });
});
