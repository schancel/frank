/** Public projections of the UTXO owner's signed operation and current indexer evidence. */
import {
  parseTransaction,
  transactionId,
  lockingScript,
  decodeAddress,
} from "@frank/nakamoto";
import { requireCompressedStealthPoint } from "./utxo-stealth";
import type {
  PreparedUtxoPayment,
  UtxoNetwork,
  UtxoIndexer,
} from "./utxo-wallet";
import type {
  PreparedStealthPayment,
  StealthPaymentProgress,
} from "./stealth-payment";

export interface UtxoStealthOperationDescriptor {
  readonly recipientSpendPublicKey: string;
  readonly ephemeralPublicKey: string;
  readonly maxNativeFeeAtomic: string;
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
export function utxoStealthPaymentManifest(
  payment: PreparedUtxoPayment,
  network: UtxoNetwork
): PreparedStealthPayment {
  const descriptor = payment.stealth;
  if (payment.value <= 0n || payment.value > 2n ** 64n - 1n)
    throw new Error("Invalid stored stealth amount");
  if (!descriptor || payment.chainIdentifier !== network.chainIdentifier)
    throw new Error("Not a stealth payment on this chain");
  requireCompressedStealthPoint(unhex(descriptor.recipientSpendPublicKey));
  const ephemeralPublicKey = requireCompressedStealthPoint(
    unhex(descriptor.ephemeralPublicKey)
  );
  if (
    BigInt(descriptor.maxNativeFeeAtomic) > 2n ** 64n - 1n ||
    BigInt(descriptor.maxNativeFeeAtomic) < payment.fee
  )
    throw new Error("Stored stealth fee exceeds authorization");
  const decoded = decodeAddress(payment.recipient.raw, network.descriptor);
  if (!decoded.ok || decoded.value.destination.kind !== network.ownOutput)
    throw new Error("Invalid stored stealth recipient");
  const destination = decoded.value.destination;
  const members = utxoRecipientMembers(
    payment.transaction.rawTransactions,
    network,
    lockingScript(destination)
  );
  if (
    members.length === 0 ||
    members.reduce((sum, member) => sum + member.recipientAmountAtomic, 0n) !==
      payment.value ||
    new Set(members.map((member) => member.txHash)).size !== 1 ||
    members[0].txHash !== payment.transaction.txHash
  )
    throw new Error("Stored stealth transaction does not match its intent");
  return {
    operationId: payment.operationId,
    chainIdentifier: payment.chainIdentifier,
    asset: { kind: "native" },
    amountAtomic: payment.value,
    recipientSpendPublicKey: unhex(descriptor.recipientSpendPublicKey),
    recipientAddress: payment.recipient.raw,
    recipientDestination: lockingScript(destination),
    ephemeralPublicKey,
    members,
  };
}
export function utxoRecipientMembers(
  rawTransactions: readonly string[],
  network: UtxoNetwork,
  script: Uint8Array
): PreparedStealthPayment["members"] {
  const seen = new Set<string>();
  return rawTransactions.flatMap((rawTransaction) => {
    if (
      !/^(?:[a-f0-9]{2})+$/.test(rawTransaction) ||
      rawTransaction.length > 32768
    )
      throw new Error("Invalid stealth transaction bytes");
    const parsed = parseTransaction(unhex(rawTransaction), network.descriptor);
    if (!parsed.ok) throw new Error("Invalid stealth transaction");
    const id = transactionId(parsed.value, network.descriptor);
    if (!id.ok) throw new Error("Invalid stealth transaction id");
    const txHash = hex(Uint8Array.from(id.value).reverse());
    if (seen.has(txHash)) throw new Error("Duplicate stealth transaction");
    seen.add(txHash);
    return parsed.value.outputs.flatMap((output, vout) =>
      hex(output.scriptPubKey) === hex(script) && output.value > 0n
        ? [
            {
              rawTransaction,
              txHash,
              recipientAmountAtomic: output.value,
              vout,
            },
          ]
        : []
    );
  });
}
/** Each observation asks for current inclusion; a previous observation is never reorg-proof. */
export async function observeUtxoStealthPayment(params: {
  indexer: UtxoIndexer;
  script: Uint8Array;
  members: PreparedStealthPayment["members"];
  amount: bigint;
  fee?: bigint;
}): Promise<StealthPaymentProgress> {
  if (!params.indexer.transactionConfirmation)
    throw new Error("UTXO confirmation observation is unavailable");
  let received = 0n;
  for (const txid of new Set(params.members.map((member) => member.txHash))) {
    const confirmation = await params.indexer.transactionConfirmation(
      txid,
      params.script
    );
    if (confirmation !== undefined) {
      if (
        !Number.isSafeInteger(confirmation.height) ||
        confirmation.height <= 0
      )
        throw new Error("Invalid UTXO confirmation evidence");
      received += params.members
        .filter((member) => member.txHash === txid)
        .reduce((sum, member) => sum + member.recipientAmountAtomic, 0n);
    }
  }
  return {
    status:
      received === params.amount
        ? "succeeded"
        : received > 0n
        ? "partial"
        : "pending",
    intendedAmountAtomic: params.amount,
    ...(received > 0n ? { verifiedReceivedAmountAtomic: received } : {}),
    ...(params.fee !== undefined ? { nativeFeeAtomic: params.fee } : {}),
  };
}
