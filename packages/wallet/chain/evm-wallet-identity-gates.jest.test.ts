import { JsonRpcProvider } from "ethers";
import { createEvmChain, loadMonadChainConfigFromEnv } from "./monad-chain";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import * as providers from "../monad-provider";
import { getChainRegistryEntry } from "./chains-registry";

const checkpoint = getChainRegistryEntry("monad-testnet")!.identityProbes.find(
  (p) => p.kind === "block-hash"
)!;
if (checkpoint.kind !== "block-hash") throw new Error("missing checkpoint");
const config: EvmChainConfig = {
  networkId: "monad-testnet",
  rpcChain: "monad-testnet",
  chainIdentifier: "monad-testnet",
  chainId: 10143,
  networkTag: "MONT",
  relayBaseUrl: "https://relay.invalid",
  stampBurnAddress: "0x000000000000000000000000000000000000dEaD",
  defaultTopicVoteValueWei: 1n,
  subAccountPoolSize: 0,
  walletStorageLocation: false,
};
let wrong = false;
let provider: JsonRpcProvider;
let send: jest.Mock;
let wallets: EvmChainWalletHandle[] = [];
beforeEach(() => {
  wrong = false;
  send = jest.fn(async (method: string, params: unknown[]) => {
    if (method === "eth_chainId") return "0x279f";
    if (method === "eth_getBlockByNumber")
      return {
        number: params[0],
        hash: wrong ? "0x" + "ff".repeat(32) : checkpoint.expected,
      };
    throw new Error("unexpected RPC " + method);
  });
  jest.spyOn(providers, "createMonadJsonRpcProvider").mockImplementation(() => {
    provider = new JsonRpcProvider("http://127.0.0.1:1", 10143, {
      staticNetwork: true,
    });
    jest.spyOn(provider, "send").mockImplementation(send);
    return provider;
  });
});
afterEach(async () => {
  await Promise.all(wallets.splice(0).map((wallet) => wallet.close()));
  jest.restoreAllMocks();
});
async function open(chain = createEvmChain(config)) {
  const wallet = (await chain.createWallet({
    evm: {
      registry: "frank-domain-roots-v1",
      purpose: "evm-wallet",
      bytes: new Uint8Array(32).fill(43),
    },
    authentication: {
      registry: "frank-domain-roots-v1",
      purpose: "identity-authentication",
      bytes: new Uint8Array(32).fill(44),
    },
    messaging: {
      registry: "frank-domain-roots-v1",
      purpose: "messaging-encryption",
      bytes: new Uint8Array(32).fill(45),
    },
  })) as EvmChainWalletHandle;
  wallets.push(wallet);
  return wallet;
}
it("refuses a correct native ID with the wrong pinned checkpoint before factory publication", async () => {
  wrong = true;
  await expect(open()).rejects.toThrow(/checkpoint mismatch/);
});
it("refuses changed upstream identity when publishing an already cached handle", async () => {
  const chain = createEvmChain(config);
  await open(chain);
  wrong = true;
  await expect(open(chain)).rejects.toThrow(/checkpoint mismatch/);
});
it("qualifies the installed recovery pass before any chain evidence read", async () => {
  const wallet = await open();
  wrong = true;
  await expect(wallet.reobserveNativeOperations!()).rejects.toThrow(
    /checkpoint mismatch/
  );
});

it("cleans up a refused opening and allows a valid retry on the same factory", async () => {
  const chain = createEvmChain(config);
  wrong = true;
  await expect(open(chain)).rejects.toThrow(/checkpoint mismatch/);
  expect(provider.destroyed).toBe(true);
  wrong = false;
  const wallet = await open(chain);
  expect(wallet.chainIdentifier).toBe("monad-testnet");
});
it("shares one physical qualification between concurrent opens and between overlapping recovery passes", async () => {
  const chain = createEvmChain(config);
  const [first, second] = await Promise.all([open(chain), open(chain)]);
  expect(first).toBe(second);
  expect(send).toHaveBeenCalledTimes(2);
  let release!: () => void;
  const original = send.getMockImplementation()!;
  send.mockImplementationOnce(async (method, params) => {
    await new Promise<void>((done) => {
      release = done;
    });
    return original(method, params);
  });
  const a = first.reobserveNativeOperations!();
  const b = first.reobserveNativeOperations!();
  expect(send).toHaveBeenCalledTimes(3);
  release();
  await Promise.all([a, b]);
  expect(send).toHaveBeenCalledTimes(4);
});
it("bounds opening qualification and destroys the owned provider without waiting on an unresolved RPC", async () => {
  const chain = createEvmChain({ ...config, identityQualificationWaitMs: 10 });
  let release!: (value: unknown) => void;
  send.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = done;
      })
  );
  await expect(open(chain)).rejects.toThrow(/timed out/);
  expect(provider.destroyed).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  release("0x279f");
  await new Promise((done) => setTimeout(done, 0));
  expect(send).toHaveBeenCalledTimes(1);
});
it("keeps an expired physical probe single-flight across repeated polls and retries only after settlement", async () => {
  const wallet = await open(
    createEvmChain({ ...config, identityQualificationWaitMs: 10 })
  );
  let release!: (value: unknown) => void;
  send.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = done;
      })
  );
  await expect(wallet.reobserveNativeOperations!()).rejects.toThrow(
    /timed out/
  );
  await expect(wallet.reobserveNativeOperations!()).rejects.toThrow(
    /timed out/
  );
  await expect(wallet.reobserveNativeOperations!()).rejects.toThrow(
    /timed out/
  );
  expect(send).toHaveBeenCalledTimes(3);
  release("0x279f");
  await new Promise((done) => setTimeout(done, 0));
  expect(send).toHaveBeenCalledTimes(3);
  await wallet.reobserveNativeOperations!();
  expect(send).toHaveBeenCalledTimes(5);
});
it("close refuses a pending qualification immediately and prevents its late checkpoint request", async () => {
  const wallet = await open();
  let release!: (value: unknown) => void;
  send.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = done;
      })
  );
  const observing = wallet.reobserveNativeOperations!();
  const refused = expect(observing).rejects.toThrow(/closed/);
  await wallet.close();
  await refused;
  release("0x279f");
  await new Promise((done) => setTimeout(done, 0));
  expect(send).toHaveBeenCalledTimes(3);
});
it("qualifies watch before a watcher can read a head or look up transaction evidence", async () => {
  const wallet = await open();
  wrong = true;
  const evidence = jest.spyOn(provider, "getTransactionReceipt");
  const head = jest.spyOn(provider, "getBlockNumber");
  await expect(wallet.watchNativeOperation!("missing")).rejects.toThrow(
    /checkpoint mismatch/
  );
  expect(evidence).not.toHaveBeenCalled();
  expect(head).not.toHaveBeenCalled();
});
it("captures caller identity, relay routing and checkpoint before opening yields", async () => {
  const input = { ...config };
  const chain = createEvmChain(input);
  Object.assign(input, {
    rpcChain: "monad-mainnet",
    chainId: 143,
    relayBaseUrl: "https://changed.invalid",
    networkTag: "MON1",
  });
  const wallet = await open(chain);
  expect(wallet.chainIdentifier).toBe("monad-testnet");
  expect(wallet.relayBaseUrl).toBe(config.relayBaseUrl);
});
it.each([0, -1, 1.5, NaN, Infinity, 30_001])(
  "refuses invalid wait budget %s",
  (wait) => {
    expect(() =>
      createEvmChain({ ...config, identityQualificationWaitMs: wait })
    ).toThrow(/deadline/);
  }
);
it("refuses missing regtest anchor before provider construction", async () => {
  const chain = createEvmChain({
    ...config,
    networkId: "monad-regtest",
    rpcChain: "monad-regtest",
    chainIdentifier: "monad-regtest",
    chainId: 20143,
    networkTag: "MONR",
  });
  await expect(open(chain)).rejects.toThrow(/operator checkpoint/);
  expect(providers.createMonadJsonRpcProvider).not.toHaveBeenCalled();
});
it("retries fresh after a rejected physical qualification settles", async () => {
  const wallet = await open();
  send.mockRejectedValueOnce(new Error("transport refused"));
  await expect(wallet.reobserveNativeOperations!()).rejects.toThrow(
    "transport refused"
  );
  await wallet.reobserveNativeOperations!();
  expect(send).toHaveBeenCalledTimes(5);
});
it.each(["monad-mainnet", "monad-regtest"])(
  "qualifies actual %s opening against the captured configured anchor",
  async (id) => {
    const entry = getChainRegistryEntry(id)!;
    const publicPin = entry.identityProbes.find((p) => p.kind === "block-hash");
    const anchor = { blockNumber: 1, blockHash: "0x" + "ab".repeat(32) };
    send.mockImplementation(async (method, params) =>
      method === "eth_chainId"
        ? "0x" + BigInt(entry.nativeChainId!).toString(16)
        : {
            number: params[0],
            hash:
              publicPin?.kind === "block-hash"
                ? publicPin.expected
                : anchor.blockHash,
          }
    );
    const input = {
      ...config,
      networkId: id,
      rpcChain: id,
      chainIdentifier: id,
      networkTag: entry.networkTag!,
      chainId: BigInt(entry.nativeChainId!),
      operatorCheckpoint: anchor,
    };
    const chain = createEvmChain(input);
    anchor.blockHash = "0x" + "ff".repeat(32);
    // The expected run hash was captured by the factory, independently of this caller's object.
    if (id === "monad-regtest")
      send.mockImplementation(async (method, params) =>
        method === "eth_chainId"
          ? "0x4eaf"
          : { number: params[0], hash: "0x" + "ab".repeat(32) }
      );
    await open(chain);
    expect(send.mock.calls[1][1][0]).toBe(
      "0x" +
        (publicPin?.kind === "block-hash" ? publicPin.height : 1).toString(16)
    );
  }
);
it("preserves the native-wallet-ineligible Tempo boundary without any RPC", () => {
  const entry = getChainRegistryEntry("tempo-testnet")!;
  expect(() =>
    createEvmChain({
      ...config,
      networkId: entry.id,
      rpcChain: entry.id,
      chainIdentifier: entry.id,
      chainId: BigInt(entry.nativeChainId!),
      networkTag: entry.networkTag!,
    })
  ).toThrow(/no native coin/);
  expect(send).not.toHaveBeenCalled();
});

it.each([
  ["0", "0x" + "ab".repeat(32)],
  ["1.5", "0x" + "ab".repeat(32)],
  ["1", undefined],
  [undefined, "0x" + "ab".repeat(32)],
  ["1", "0x12"],
])(
  "refuses incomplete or malformed checkpoint environment (%s, %s)",
  (height, hash) => {
    const oldHeight = process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_NUMBER;
    const oldHash = process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_HASH;
    try {
      if (height === undefined)
        delete process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_NUMBER;
      else process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_NUMBER = height;
      if (hash === undefined)
        delete process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_HASH;
      else process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_HASH = hash;
      expect(() => loadMonadChainConfigFromEnv()).toThrow(
        /paired EVM operator checkpoint/
      );
    } finally {
      if (oldHeight === undefined)
        delete process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_NUMBER;
      else process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_NUMBER = oldHeight;
      if (oldHash === undefined)
        delete process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_HASH;
      else process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_HASH = oldHash;
    }
  }
);
it("forwards a validated checkpoint through the environment composition and honors typed run overrides", () => {
  const previous = {
    height: process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_NUMBER,
    hash: process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_HASH,
  };
  try {
    process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_NUMBER = "37";
    process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_HASH = "0x" + "ab".repeat(32);
    expect(loadMonadChainConfigFromEnv().operatorCheckpoint).toEqual({
      blockNumber: 37,
      blockHash: "0x" + "ab".repeat(32),
    });
    const override = { blockNumber: 1, blockHash: "0x" + "ff".repeat(32) };
    expect(
      loadMonadChainConfigFromEnv({ operatorCheckpoint: override })
        .operatorCheckpoint
    ).toEqual(override);
  } finally {
    if (previous.height === undefined)
      delete process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_NUMBER;
    else process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_NUMBER = previous.height;
    if (previous.hash === undefined)
      delete process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_HASH;
    else process.env.EVM_OPERATOR_CHECKPOINT_BLOCK_HASH = previous.hash;
  }
});
