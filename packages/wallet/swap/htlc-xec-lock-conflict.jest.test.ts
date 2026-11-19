/**
 * The eCash HTLC capability's handling of a lock operation that became conflicted (issue 2089):
 * the runner's observation reconciles an exposed lock, and funding a conflicted lock signs the
 * same lock again from fresh inputs. The wallet's own conflict detection is covered in
 * ecash-preparation.jest.test.ts and on a real node in ecash-input-conflict.livecheck.ts.
 */
import { createXecHtlcSwapCapability } from "./htlc-swap-capabilities";
import { xecHtlcOutputScript, type XecHtlcTerms } from "../ecash-htlc";
import type { EcashNativeOperation } from "../ecash-operation-store";

const SWAP = "11".repeat(32);
const ID = `swap:${SWAP}:xec-lock`;
const TERMS: XecHtlcTerms = {
  hashLock: new Uint8Array(32).fill(7),
  claimPublicKey: new Uint8Array([2, ...new Array(32).fill(1)]),
  refundPublicKey: new Uint8Array([3, ...new Array(32).fill(2)]),
  refundTime: 1_800_000_000,
};
const SCRIPT = Buffer.from(xecHtlcOutputScript(TERMS)).toString("hex");
const WINNER = "cc".repeat(32);
const CONFLICT = { input: { txid: "dd".repeat(32), vout: 0 }, spentBy: WINNER };

function harness(
  initial: EcashNativeOperation["state"],
  lookupFails = false,
  winnerScripts: string[] = ["76a914" + "00".repeat(20) + "88ac"]
) {
  let state = initial;
  const calls: string[] = [];
  const op = () =>
    ({
      operationId: ID,
      state,
      ...(state === "conflicted" ? { conflict: CONFLICT } : {}),
    } as unknown as EcashNativeOperation);
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
    chronik: {
      tx: async (txid: string) => {
        calls.push(`tx:${txid === WINNER ? "winner" : txid}`);
        return { txid, outputs: winnerScripts.map((outputScript) => ({ outputScript })) };
      },
    } as never,
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
    terms: TERMS,
    principalSats: 10_000n,
  });
  expect(calls).toEqual(["tx:winner", "retry", "submit"]);
});

it("never funds again when the conflicting spend itself pays this HTLC (another device locked it)", async () => {
  const { capability, calls } = harness("conflicted", false, [
    "76a914" + "00".repeat(20) + "88ac",
    SCRIPT,
  ]);
  expect(
    await capability.fund({ swapId: SWAP, terms: TERMS, principalSats: 10_000n })
  ).toEqual({ txid: WINNER, fundedElsewhere: true });
  expect(calls).toEqual(["tx:winner"]);
});

it("keeps the stored state when the reconcile lookup fails", async () => {
  const { capability, calls } = harness("submitted", true);
  expect(await capability.lockOperation(SWAP)).toBe("submitted");
  expect(calls).toEqual(["reconcile"]);
});
