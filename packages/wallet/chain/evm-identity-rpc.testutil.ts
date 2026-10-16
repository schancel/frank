import * as providers from "../monad-provider";
import type { JsonRpcProvider } from "ethers";
import { getChainRegistryEntry } from "./chains-registry";
import type { OperatorCheckpoint } from "./evm-rpc-identity";

/** Explicit offline RPC fixture, retaining actual production qualification and all other RPCs. */
export function installIdentityRpcFixture(
  provider: JsonRpcProvider,
  chainIdentifier: string,
  operatorCheckpoint?: OperatorCheckpoint
): void {
  const entry = getChainRegistryEntry(chainIdentifier);
  if (!entry || entry.family !== "evm")
    throw new Error("Unknown fixture network");

  provider.send = async (
    method: string,
    params: unknown[] | Record<string, unknown>
  ) => {
    if (method === "eth_chainId")
      return "0x" + BigInt(entry.nativeChainId!).toString(16);
    if (
      method === "eth_getBlockByNumber" &&
      Array.isArray(params) &&
      params[1] === false
    ) {
      const probe = entry.identityProbes.find(
        (probe) => probe.kind === "block-hash"
      );
      const expected =
        probe?.kind === "block-hash"
          ? { blockNumber: probe.height, blockHash: probe.expected }
          : operatorCheckpoint;
      if (expected && params[0] === "0x" + expected.blockNumber.toString(16))
        return { number: params[0], hash: expected.blockHash };
    }
    return Reflect.get(Object.getPrototypeOf(provider), "send").call(
      provider,
      method,
      params
    );
  };
}

/** Suite-local setup for old offline owners that install financial reads after opening. */
export function useFactoryIdentityFixture(): () => void {
  const original = providers.createMonadJsonRpcProvider;
  let factory: jest.SpyInstance;
  const install = () => {
    factory = jest
      .spyOn(providers, "createMonadJsonRpcProvider")
      .mockImplementation((options) => {
        const provider = original(options);
        if (!options.rpcUrl)
          throw new Error("Fixture requires an explicit RPC route");
        const id = decodeURIComponent(
          new URL(options.rpcUrl).pathname.split("/")[2]
        );
        installIdentityRpcFixture(provider, id);
        return provider;
      });
  };
  beforeEach(install);
  afterEach(() => factory?.mockRestore());
  return install;
}
