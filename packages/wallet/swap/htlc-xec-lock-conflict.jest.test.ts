/**
 * The eCash HTLC capability's handling of a lock operation that became conflicted (issue 2089):
 * the runner's observation reconciles an exposed lock, and funding a conflicted lock signs the
 * same lock again from fresh inputs. The wallet's own conflict detection is covered in
 * ecash-preparation.jest.test.ts and on a real node in ecash-input-conflict.livecheck.ts.
 */
import { createXecHtlcSwapCapability } from "./htlc-swap-capabilities";
import type { EcashNativeOperation } from "../ecash-operation-store";

const SWAP = "11".repeat(32);
const ID = `swap:${SWAP}:xec-lock`;

function harness(initial: EcashNativeOperation["state"], lookupFails = false) {
  let state = initial;
  const calls: string[] = [];
  const op = () =>
    ({ operationId: ID, state } as unknown as EcashNativeOperation);
  const wallet = {
    chainIdentifier: "xec-regtest",
    htlcPublicKey: () => new Uint8Array(33),
    signHtlcSpend: () => {
      throw new Error("unused");
    },
    getEcashOperations: () => [op()],
    prepareNativeOperation: async () => {
      calls.push("prepare");
      return op();
    },
    submitNativeOperation: async () => {
      calls.push("submit");
      state = "submitted";
      return { txHash: "aa".repeat(32) };
    },
    releaseNativeOperation: async () => op(),
    reconcileNativeOperation: async () => {
      calls.push("reconcile");
      if (lookupFails) throw new Error("indexer offline");
      return op();
    },
    retryConflictedNativeOperation: async () => {
      calls.push("retry");
      state = "prepared";
      return op();
    },
  };
  const capability = createXecHtlcSwapCapability({
    wallet: wallet as never,
    chronik: {} as never,
    finality: { kind: "confirmations", depth: 1 },
  });
  return {
    capability,
    calls,
    set: (next: EcashNativeOperation["state"]) => {
      state = next;
    },
  };
}

it("reconciles an exposed lock when observing it, and reports a conflicted lock", async () => {
  const { capability, calls, set } = harness("exposed");
  expect(await capability.lockOperation(SWAP)).toBe("exposed");
  expect(calls).toEqual(["reconcile"]);
  set("conflicted");
  expect(await capability.lockOperation(SWAP)).toBe("conflicted");
  // A conflicted lock is terminal: no further lookups.
  expect(calls).toEqual(["reconcile"]);
});

it("funds a conflicted lock again from fresh inputs under the same operation", async () => {
  const { capability, calls } = harness("conflicted");
  await capability.fund({
    swapId: SWAP,
    terms: {} as never,
    principalSats: 10_000n,
  });
  expect(calls).toEqual(["retry", "submit"]);
});

it("keeps the stored state when the reconcile lookup fails", async () => {
  const { capability, calls } = harness("submitted", true);
  expect(await capability.lockOperation(SWAP)).toBe("submitted");
  expect(calls).toEqual(["reconcile"]);
});
