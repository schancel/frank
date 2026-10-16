import { useFactoryIdentityFixture } from "./evm-identity-rpc.testutil";
useFactoryIdentityFixture();
import { createEvmChain } from "./evm-chain";
import { createNativeOnlyEvmChain, createRelayStampDefaultResolver } from "./evm-host";
import { ASSET_DECIMALS } from "../oracle/price-oracle";
import type { EvmChainConfig } from "./evm-chain-config";
import { Tip20TransactionBuilder } from "./evm-transaction-builder";
import { DERIVATION_REGISTRY_ID } from "@frank/domain-roots";

const config: EvmChainConfig = {
  networkId: "monad-testnet",
  rpcChain: "monad-testnet",
  chainId: 10143,
  relayBaseUrl: "http://127.0.0.1:1",
  networkTag: "MONT",
  stampBurnAddress: "0x000000000000000000000000000000000000dEaD",
  defaultTopicVoteValueWei: 1n,
  subAccountPoolSize: 0,
  walletStorageLocation: false,
};

it("uses the real native EVM adapter unit basis without opening a wallet", () => {
  const chain = createEvmChain(config);
  expect(chain.fromDisplayAmount("1")).toBe(
    10n ** BigInt(ASSET_DECIMALS.monad)
  );
  expect(chain.minimumWagerValue).toBe(10_000_000_000_000_000n);
});

it("refuses a token transfer asset even when the display adapter still reports native decimals", async () => {
  const tokenConfig = {
    ...config,
    transactionBuilder: new Tip20TransactionBuilder(
      "0x0000000000000000000000000000000000000001"
    ),
  };
  const chain = createEvmChain(tokenConfig);
  expect(chain.fromDisplayAmount("1")).toBe(
    10n ** BigInt(ASSET_DECIMALS.monad)
  );
  const resolve = createRelayStampDefaultResolver(tokenConfig, chain);
  expect(
    await resolve({ chainIdentifier: "monad-testnet", minimumStamp: 0n })
  ).toMatchObject({ status: "unavailable", reason: "unsupported" });
});

it("exposes a Sepolia native wallet without claiming application messaging or contracts", () => {
  const chain = createNativeOnlyEvmChain({
    ...config,
    networkId: "ethereum-sepolia",
    rpcChain: "ethereum-sepolia",
    chainId: 11155111,
    networkTag: "SEPO",
  });

  expect(chain).toMatchObject({
    family: "evm",
    chainIdentifier: "ethereum-sepolia",
    name: "Sepolia",
    unit: "ETH",
    isTestnet: true,
    capabilities: {
      profiles: false,
      directMessages: false,
      topics: false,
      stealthPayments: false,
      legacyConsolidation: "evm-staging",
    },
  });
  expect(chain.fromDisplayAmount("0.000000000000000001")).toBe(1n);
  expect(chain.toDisplayAmount(1n)).toBe("0.000000000000000001");
  expect(chain.nativeTransfers).toBeDefined();
  expect(chain.nativeTransfers.sendToContact).toBeUndefined();
  expect("directMessages" in chain).toBe(false);
  expect("topics" in chain).toBe(false);
  expect(chain.getStateChannelAddress).toBeUndefined();
});

it("uses the same native-only boundary for Hyperliquid Testnet", () => {
  const chain = createNativeOnlyEvmChain({
    ...config,
    networkId: "hyperliquid-testnet",
    rpcChain: "hyperliquid-testnet",
    chainId: 998,
    networkTag: "HYPT",
  });
  expect(chain.unit).toBe("tHYPE");
  expect(chain.fromDisplayAmount("1")).toBe(10n ** 18n);
  expect(chain.capabilities).toMatchObject({
    profiles: false,
    directMessages: false,
    topics: false,
    stealthPayments: false,
  });
});

it("refuses a peer native send before signing when its sync delivery is absent", async () => {
  const chain = createNativeOnlyEvmChain({
    ...config,
    networkId: "ethereum-sepolia",
    rpcChain: "ethereum-sepolia",
    chainIdentifier: "ethereum-sepolia",
    chainId: 11155111,
    networkTag: "SEPO",
  });
  const root = (purpose: string, value: number) => ({
    registry: DERIVATION_REGISTRY_ID,
    purpose,
    bytes: new Uint8Array(32).fill(value),
  });
  const wallet = await chain.createWallet({
    evm: root("evm-wallet", 51),
    authentication: root("identity-authentication", 52),
    messaging: root("messaging-encryption", 53),
  });
  const sign = jest.spyOn(wallet, "sendNative");
  try {
    await expect(chain.nativeTransfers.send({
      wallet,
      recipient: { raw: "0x000000000000000000000000000000000000dEaD" },
      value: 1n,
    })).rejects.toThrow("sync delivery is unavailable");
    expect(sign).not.toHaveBeenCalled();
    await expect(wallet.sendNative({
      recipient: { raw: "0x000000000000000000000000000000000000dEaD" },
      value: 1n,
    })).rejects.toThrow("sync delivery is unavailable");
  } finally {
    await wallet.close();
  }
});


it.each([
  ['monad-testnet', 10143, 'MONT'],
  ['ethereum-sepolia', 11155111, 'SEPO'],
] as const)('real EVM composition scopes HD and change coins to %s', async (chainIdentifier, chainId, networkTag) => {
  const chain = createEvmChain({ ...config, chainIdentifier, rpcChain: chainIdentifier, networkId: chainIdentifier, chainId, networkTag })
  const root = (purpose: string, value: number) => ({ registry: DERIVATION_REGISTRY_ID, purpose, bytes: new Uint8Array(32).fill(value) })
  const wallet = await chain.createWallet({ evm: root('evm-wallet', 61), authentication: root('identity-authentication', 62), messaging: root('messaging-encryption', 63) })
  try {
    expect(wallet.accountUtxoPool!.getCleanCoins(chainIdentifier).length).toBeGreaterThan(0)
    const coins = wallet.accountUtxoPool!.getAllCoins()
    expect(coins.length).toBeGreaterThan(0)
    expect(new Set(coins.map(coin => coin.chainIdentifier))).toEqual(new Set([chainIdentifier]))
    expect(coins.some(coin => coin.origin === 'subaccount')).toBe(true)
    expect(coins.some(coin => coin.origin === 'change')).toBe(true)
  } finally { await wallet.close() }
})
