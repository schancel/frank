/** Disposable browser-only characterization. No provider, relay, or broadcast capability. */
import { Transaction, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { openEvmWalletBundle } from "./storage/evm-wallet-bundle";
import { nativeAdmissionJournal } from "./evm-input-admission";
import { MonadHdKeyring } from "./secp256k1-hd-keyring";
import type {
  EvmNativeBinding,
  EvmNativeOperation,
  EvmNativePlan,
} from "./storage/evm-native-operation-journal";

const mnemonic = "test test test test test test test test test test test junk";
const keyring = MonadHdKeyring.fromMnemonic(mnemonic);
type Bundle = Awaited<ReturnType<typeof openEvmWalletBundle>>;
let bundle: Bundle | undefined;
let location = "";
let binding: EvmNativeBinding;
let signerCalls = 0;
const originals = new Map<string, string>();
const gates = new Map<string, () => void>();
const arrivals = new Set<string>();
const operations = new Map<string, Promise<unknown>>();
const transactions: Array<{ mode: IDBTransactionMode; durability: string }> =
  [];
const originalTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (
  this: IDBDatabase,
  ...args: Parameters<typeof originalTransaction>
) {
  const transaction = originalTransaction.apply(this, args);
  transactions.push({
    mode: transaction.mode,
    durability: transaction.durability,
  });
  return transaction;
} as typeof originalTransaction;

function requireBundle(): Bundle {
  if (!bundle) throw new Error("Fixture bundle is closed");
  return bundle;
}
function summary(row: EvmNativeOperation) {
  return {
    operationId: row.operationId,
    preparationId: row.preparationId,
    binding: row.binding,
    recipient: row.recipient,
    cancelled: row.cancelled,
    members: row.members.map((member) => ({
      source: member.source,
      nonce: Transaction.from(member.unsignedTransaction).nonce,
      unsignedHash: keccak256(member.unsignedTransaction),
      signedHash: member.signed && keccak256(member.signed.rawTransaction),
      recordedHash: member.signed?.transactionHash ?? null,
      exposed: member.exposed,
    })),
  };
}
function errorFacts(error: unknown) {
  const fields = error as {
    name?: string;
    code?: string;
    reason?: string;
    validation?: string;
  };
  return {
    name: fields?.name,
    code: fields?.code,
    reason: fields?.reason,
    validation: fields?.validation,
  };
}
function plan(
  preparationId: string,
  index: number,
  recipient: string
): EvmNativePlan {
  return {
    kind: "native",
    preparationId,
    recipient,
    intendedValueWei: "32",
    members: [
      {
        source: {
          kind: "spend",
          index,
          address: keyring.deriveSubAccount(index).address.toLowerCase(),
        },
        dependencies: [],
        unsignedTransaction: Transaction.from({
          type: 2,
          chainId: BigInt(binding.nativeChainId),
          nonce: 0,
          to: recipient,
          value: 32n,
          gasLimit: 21000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        }).unsignedSerialized,
      },
    ],
  };
}
const api = {
  async open(input: {
    location: string;
    chainIdentifier: string;
    nativeChainId: string;
    create?: boolean;
  }) {
    if (bundle) throw new Error("Fixture must close before changing binding");
    location = input.location;
    binding = {
      chainIdentifier: input.chainIdentifier,
      nativeChainId: input.nativeChainId,
      publicTuple: keccak256(
        toUtf8Bytes(keyring.deriveSubAccount(0).address.toLowerCase())
      ),
    };
    bundle = await openEvmWalletBundle({
      location,
      nativeBinding: binding,
      seed: { mnemonic },
      ...(input.create ? { mode: "create" as const } : {}),
    });
    return {
      durability: bundle.durability,
      binding,
      webLocks: typeof navigator.locks?.request === "function",
    };
  },
  async duplicateOpen() {
    try {
      const duplicate = await openEvmWalletBundle({
        location,
        nativeBinding: binding,
        seed: { mnemonic },
      });
      await duplicate.close();
      throw new Error("Duplicate same-realm opener unexpectedly succeeded");
    } catch (error) {
      return {
        ...errorFacts(error),
        message: String((error as Error).message),
        signerCalls,
      };
    }
  },
  arm(preparationId: string, index: number, recipient: string) {
    if (operations.has(preparationId))
      throw new Error("Duplicate fixture intent");
    const owner = requireBundle();
    const requested = plan(preparationId, index, recipient);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(preparationId, release);
    const execution = owner.runLifetime(async (lifetime) => {
      try {
        const snapshot = owner.inputAdmission.inspect(lifetime);
        if (snapshot.status !== "ready")
          throw new Error(`Snapshot refused: ${snapshot.reason}`);
        arrivals.add(preparationId);
        await gate;
        const prepared = await owner.inputAdmission.prepareNative(
          lifetime,
          snapshot.epoch,
          requested
        );
        const admitted = await owner.inputAdmission.authorizeNativeSigning(
          lifetime,
          prepared.operationId
        );
        const member = admitted.members[0];
        const expected = requested.members[0];
        if (
          member.source.kind !== "spend" ||
          member.source.index !== index ||
          member.source.address !== expected.source.address ||
          member.unsignedTransaction !== expected.unsignedTransaction
        )
          throw new Error("Signer intent/source differs from admitted member");
        signerCalls++;
        const raw = await new Wallet(
          keyring.deriveSubAccount(index).privateKey
        ).signTransaction(Transaction.from(member.unsignedTransaction));
        const signed = await nativeAdmissionJournal(
          owner.inputAdmission,
          lifetime
        ).checkpointSigned(admitted.operationId, 0, raw);
        originals.set(preparationId, JSON.stringify(signed));
        return { status: "fulfilled", row: summary(signed), signerCalls };
      } catch (error) {
        return { status: "rejected", error: errorFacts(error), signerCalls };
      } finally {
        gates.delete(preparationId);
      }
    });
    operations.set(preparationId, execution);
    return { arrived: arrivals.has(preparationId), signerCalls };
  },
  arrived(preparationId: string) {
    return arrivals.has(preparationId);
  },
  release(preparationId: string) {
    const release = gates.get(preparationId);
    if (!release) throw new Error("Missing admission gate");
    release();
  },
  result(preparationId: string) {
    const operation = operations.get(preparationId);
    if (!operation) throw new Error("Missing execution");
    return operation;
  },
  rows() {
    return requireBundle().nativeJournal!.list().map(summary);
  },
  async original(preparationId: string) {
    const owner = requireBundle();
    const row = await owner.runLifetime((lifetime) =>
      nativeAdmissionJournal(owner.inputAdmission, lifetime).refreshPreparation(
        preparationId
      )
    );
    if (!row) throw new Error("Original operation disappeared");
    const original = originals.get(preparationId);
    return {
      row: summary(row),
      exactOriginal: original !== undefined && original === JSON.stringify(row),
      signerCalls,
    };
  },
  capabilities() {
    return { transactions, signerCalls, activeGates: gates.size };
  },
  async close() {
    for (const release of gates.values()) release();
    await Promise.all(operations.values());
    const owner = bundle;
    bundle = undefined;
    await owner?.close();
  },
};
(
  globalThis as typeof globalThis & { walletAdmissionFixture: typeof api }
).walletAdmissionFixture = api;
