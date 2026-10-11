import { createEvmChain } from "./monad-chain";
import { createRelayStampDefaultResolver } from "./evm-host";
import { ASSET_DECIMALS } from "../oracle/price-oracle";
import type { EvmChainConfig } from "./evm-chain-config";
import { Tip20TransactionBuilder } from "./evm-transaction-builder";

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
