import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROTOCOL_CHAINS } from "./chains-registry";
import type { EvmChainConfig } from "./evm-chain-config";
import {
  verifyEvmWalletRpcIdentity,
  validateEvmWalletConfiguration,
} from "./evm-rpc-identity";

const entries = Object.values(PROTOCOL_CHAINS).filter(
  (entry) => entry.family === "evm"
);
const anchor = { blockNumber: 37, blockHash: "0x" + "ab".repeat(32) };
function fixture(id = "monad-regtest") {
  const entry = PROTOCOL_CHAINS[id];
  const config = {
    networkId: id,
    chainIdentifier: id,
    rpcChain: id,
    chainId: BigInt(entry.nativeChainId!),
    networkTag: entry.networkTag,
  } as EvmChainConfig;
  const send = jest.fn(
    async (method: string, params: unknown[]): Promise<unknown> => {
      if (method === "eth_chainId")
        return "0x" + BigInt(entry.nativeChainId!).toString(16);
      const probe = entry.identityProbes.find(
        (probe) => probe.kind === "block-hash"
      );
      return {
        number: params[0],
        hash: probe?.kind === "block-hash" ? probe.expected : anchor.blockHash,
      };
    }
  );
  return { config, provider: { send }, send };
}

it("covers every registered EVM identity without changing native coin eligibility", () => {
  expect(entries).toHaveLength(17);
  expect(
    entries
      .filter((entry) => entry.kind === "tempo")
      .every((entry) => entry.nativeDecimals === null)
  ).toBe(true);
});
it.each(entries.map((entry) => entry.id))(
  "qualifies registry identity %s using explicit raw block tags",
  async (id) => {
    const { config, provider, send } = fixture(id);
    await verifyEvmWalletRpcIdentity(config, provider, anchor, () => undefined);
    expect(send.mock.calls[0]).toEqual(["eth_chainId", []]);
    for (const [method, params] of send.mock.calls.slice(1)) {
      expect(method).toBe("eth_getBlockByNumber");
      expect(params).toEqual([expect.stringMatching(/^0x[0-9a-f]+$/), false]);
    }
  }
);
it.each([
  undefined,
  { ...anchor, blockNumber: 0 },
  { ...anchor, blockNumber: -1 },
  { ...anchor, blockNumber: 1.5 },
  { ...anchor, blockNumber: Number.MAX_SAFE_INTEGER + 1 },
  { ...anchor, blockHash: "0x12" },
])("refuses invalid operator checkpoint %j before RPC", async (checkpoint) => {
  const { config, provider, send } = fixture();
  await expect(
    verifyEvmWalletRpcIdentity(config, provider, checkpoint, () => undefined)
  ).rejects.toThrow(/operator checkpoint/);
  expect(send).not.toHaveBeenCalled();
});
it.each([
  "networkId",
  "chainIdentifier",
  "rpcChain",
  "networkTag",
  "chainId",
] as const)("rejects inconsistent %s before RPC", async (key) => {
  const { config, provider, send } = fixture();
  const changed = { ...config, [key]: key === "chainId" ? 1 : "invalid" };
  await expect(
    verifyEvmWalletRpcIdentity(changed, provider, anchor, () => undefined)
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
it.each([
  null,
  {},
  { number: 37, hash: anchor.blockHash },
  { number: "0x26", hash: anchor.blockHash },
  { number: "0x25", hash: "0x12" },
  { number: "0x25", hash: "0x" + "ff".repeat(32) },
])("refuses malformed or mismatched block %j", async (block) => {
  const { config, provider, send } = fixture();
  send.mockResolvedValueOnce("0x4eaf").mockResolvedValueOnce(block);
  await expect(
    verifyEvmWalletRpcIdentity(config, provider, anchor, () => undefined)
  ).rejects.toThrow(/checkpoint mismatch/);
});
it.each([null, 20143, "20143", "0x04eaf", "0xzz", "0x1"])(
  "refuses malformed or mismatched native ID %j",
  async (id) => {
    const { config, provider, send } = fixture();
    send.mockResolvedValueOnce(id);
    await expect(
      verifyEvmWalletRpcIdentity(config, provider, anchor, () => undefined)
    ).rejects.toThrow(/chain identity mismatch/);
    expect(send).toHaveBeenCalledTimes(1);
  }
);
it("keeps registry public checkpoints authoritative despite an operator override", async () => {
  const { config, provider, send } = fixture("monad-testnet");
  await verifyEvmWalletRpcIdentity(
    config,
    provider,
    { blockNumber: 0, blockHash: "bad" },
    () => undefined
  );
  const probe = PROTOCOL_CHAINS["monad-testnet"].identityProbes.find(
    (probe) => probe.kind === "block-hash"
  );
  if (probe?.kind !== "block-hash")
    throw new Error("missing registry checkpoint");
  expect(send.mock.calls[1][1]).toEqual([
    "0x" + probe.height.toString(16),
    false,
  ]);
});
it("captures caller inputs before awaiting native ID", async () => {
  const { config, provider, send } = fixture();
  const checkpoint = { ...anchor };
  const original = send.getMockImplementation()!;
  send.mockImplementationOnce(async (method, params) => {
    Object.assign(config, { chainId: 1, networkId: "monad-testnet" });
    checkpoint.blockNumber = 99;
    checkpoint.blockHash = "0x" + "ff".repeat(32);
    return original(method, params);
  });
  await verifyEvmWalletRpcIdentity(
    config,
    provider,
    checkpoint,
    () => undefined
  );
  expect(send.mock.calls[1][1]).toEqual(["0x25", false]);
});
it.each([0, 1])("refuses lifetime revocation during RPC %s", async (index) => {
  const { config, provider, send } = fixture();
  let current = true;
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (method, params) => {
    if (send.mock.calls.length === index + 1) current = false;
    return original(method, params);
  });
  await expect(
    verifyEvmWalletRpcIdentity(config, provider, anchor, () => {
      if (!current) throw new Error("revoked");
    })
  ).rejects.toThrow("revoked");
  expect(send).toHaveBeenCalledTimes(index + 1);
});
it("refuses a revoked lifetime before any RPC", async () => {
  const { config, provider, send } = fixture();
  await expect(
    verifyEvmWalletRpcIdentity(config, provider, anchor, () => {
      throw new Error("revoked");
    })
  ).rejects.toThrow("revoked");
  expect(send).not.toHaveBeenCalled();
  expect(validateEvmWalletConfiguration(config, anchor).id).toBe(
    "monad-regtest"
  );
});

it("keeps qualification independent of app composition and cached provider methods", () => {
  const source = readFileSync(
    resolve(__dirname, "evm-rpc-identity.ts"),
    "utf8"
  );
  const imports = [...source.matchAll(/from ["']([^"']+)["']/g)].map(
    (match) => match[1]
  );
  expect(imports).toEqual(["./chains-registry", "./evm-chain-config"]);
  expect(source).not.toMatch(/\.(getNetwork|getBlock)\s*\(/);
});

it("rechecks checkpoint responses on every invocation", async () => {
  const { config, provider, send } = fixture();
  await verifyEvmWalletRpcIdentity(config, provider, anchor, () => undefined);
  send
    .mockResolvedValueOnce("0x4eaf")
    .mockResolvedValueOnce({ number: "0x25", hash: "0x" + "ff".repeat(32) });
  await expect(
    verifyEvmWalletRpcIdentity(config, provider, anchor, () => undefined)
  ).rejects.toThrow(/checkpoint mismatch/);
  expect(send).toHaveBeenCalledTimes(4);
});
