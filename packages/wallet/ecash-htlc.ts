/**
 * eCash (UTXO family) hash time-locked contract: the P2SH redeem script, its address, the two
 * spends and the reading of a revealed preimage. Pure construction; no keys, inventory or
 * network effects. Custody signs through `EcashWallet.signHtlcSpend`, which supplies the
 * `sign` callback here from a key that never leaves the wallet.
 *
 * Redeem script (P2SH):
 *
 *   OP_IF
 *     OP_SIZE <0x20> OP_EQUALVERIFY OP_SHA256 <hashLock:32> OP_EQUALVERIFY <claimPublicKey:33>
 *   OP_ELSE
 *     <refundTime> OP_CHECKLOCKTIMEVERIFY OP_DROP <refundPublicKey:33>
 *   OP_ENDIF OP_CHECKSIG
 *
 * Claim scriptSig  `<sig‖0x41> <preimage:32> OP_1 <redeem>`, nLockTime 0, sequence 0xffffffff.
 * Refund scriptSig `<sig‖0x41> OP_0 <redeem>`, nLockTime refundTime, sequence 0xfffffffe.
 *
 * The funding output holds exactly `principal + XEC_HTLC_SPEND_FEE_SATS`. Either spend has one
 * input and one output of exactly `principal` to the spender's own primary address, so the fee is
 * exactly XEC_HTLC_SPEND_FEE_SATS. With deterministic (RFC 6979) signatures two devices of one
 * account build byte-identical spends with the same txid.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import type { ChronikClient } from "chronik-client";
// Deep imports: ecash-lib's index loads its WASM hashes, which this pure module never needs.
import { Address } from "ecash-lib/dist/address/address";
import { Script } from "ecash-lib/dist/script";
import { isPushOp, pushBytesOp, pushNumberOp } from "ecash-lib/dist/op";
import type { Op } from "ecash-lib/dist/op";
import {
  OP_0,
  OP_1,
  OP_CHECKLOCKTIMEVERIFY,
  OP_CHECKSIG,
  OP_DROP,
  OP_ELSE,
  OP_ENDIF,
  OP_EQUALVERIFY,
  OP_IF,
  OP_SHA256,
  OP_SIZE,
} from "ecash-lib/dist/opcode";
import {
  CHAINS,
  internalHashFromDisplay,
  displayTxidFromBytes,
  serializeTransaction,
  sighash,
  transactionId,
} from "@frank/nakamoto";
import type { ChainDescriptor, Transaction } from "@frank/nakamoto";
import { getChainRegistryEntry } from "./chain/chains-registry";

const shaRmd160 = (data: Uint8Array): Uint8Array => ripemd160(sha256(data));

/** The exact fee of a claim or refund spend; the funding output carries it on top of principal. */
export const XEC_HTLC_SPEND_FEE_SATS = 1000n;
/** Smallest principal the spend output may carry (the node's dust limit). */
export const XEC_HTLC_MIN_PRINCIPAL_SATS = 546n;
export const XEC_HTLC_PREIMAGE_BYTES = 32;
/** nLockTime values at or above this are UNIX times, not heights. */
const LOCKTIME_THRESHOLD = 500_000_000;
const SEQUENCE_FINAL = 0xffffffff;
const SEQUENCE_LOCKTIME_ENABLED = 0xfffffffe;
/** SIGHASH_ALL | SIGHASH_FORKID. */
const SIGHASH_ALL_FORKID = 0x41;

export type XecHtlcBranch = "claim" | "refund";

export interface XecHtlcTerms {
  /** sha256 of the 32-byte preimage. */
  readonly hashLock: Uint8Array;
  /** Compressed key that may claim with the preimage (party B). */
  readonly claimPublicKey: Uint8Array;
  /** Compressed key that may refund after `refundTime` (party A). */
  readonly refundPublicKey: Uint8Array;
  /** T_A: UNIX seconds; refund is valid once the previous block's MTP is above it. */
  readonly refundTime: number;
}

export interface XecHtlcFundingOutput {
  /** Display-order transaction id. */
  readonly txid: string;
  readonly vout: number;
}

export interface XecHtlcSpend {
  readonly rawTx: string;
  readonly txid: string;
}

function copyBytes(
  value: Uint8Array,
  length: number,
  label: string
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new Error(`eCash HTLC ${label} must be ${length} bytes`);
  return Uint8Array.from(value);
}

function compressedPoint(value: Uint8Array, label: string): Uint8Array {
  const point = copyBytes(value, 33, label);
  if (point[0] !== 0x02 && point[0] !== 0x03)
    throw new Error(`eCash HTLC ${label} must be a compressed public key`);
  try {
    secp256k1.ProjectivePoint.fromHex(point).assertValidity();
  } catch {
    throw new Error(`eCash HTLC ${label} is not a valid public key`);
  }
  return point;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Validated defensive copy of the terms. */
export function validateXecHtlcTerms(terms: XecHtlcTerms): XecHtlcTerms {
  const hashLock = copyBytes(terms.hashLock, 32, "hash lock");
  const claimPublicKey = compressedPoint(terms.claimPublicKey, "claim key");
  const refundPublicKey = compressedPoint(terms.refundPublicKey, "refund key");
  if (sameBytes(claimPublicKey, refundPublicKey))
    throw new Error("eCash HTLC claim and refund keys must differ");
  if (
    !Number.isSafeInteger(terms.refundTime) ||
    terms.refundTime < LOCKTIME_THRESHOLD ||
    terms.refundTime > 0xffffffff
  )
    throw new Error(
      "eCash HTLC refund time must be UNIX seconds that fit nLockTime"
    );
  return Object.freeze({
    hashLock,
    claimPublicKey,
    refundPublicKey,
    refundTime: terms.refundTime,
  });
}

/** The redeem script bytes, exactly as documented above. */
export function xecHtlcRedeemScript(terms: XecHtlcTerms): Uint8Array {
  const valid = validateXecHtlcTerms(terms);
  const ops: Op[] = [
    OP_IF,
    OP_SIZE,
    pushNumberOp(XEC_HTLC_PREIMAGE_BYTES),
    OP_EQUALVERIFY,
    OP_SHA256,
    pushBytesOp(valid.hashLock),
    OP_EQUALVERIFY,
    pushBytesOp(valid.claimPublicKey),
    OP_ELSE,
    // Minimal script number; 4 or 5 bytes for any time at or above LOCKTIME_THRESHOLD.
    pushNumberOp(valid.refundTime),
    OP_CHECKLOCKTIMEVERIFY,
    OP_DROP,
    pushBytesOp(valid.refundPublicKey),
    OP_ENDIF,
    OP_CHECKSIG,
  ];
  return Script.fromOps(ops).bytecode;
}

/** The cashaddr prefix of an eCash network, from the chain registry. */
export function xecAddressPrefix(chainIdentifier: string): string {
  const chain = getChainRegistryEntry(chainIdentifier);
  if (
    chain?.id !== chainIdentifier ||
    chain.kind !== "ecash" ||
    typeof chain.addressPrefix !== "string"
  )
    throw new Error(`${chainIdentifier} is not a supported eCash network`);
  return chain.addressPrefix;
}

/** The transaction-format descriptor of that network, matched by the registry's prefix. */
function xecTransactionChain(chainIdentifier: string): ChainDescriptor {
  const prefix = xecAddressPrefix(chainIdentifier);
  const matches = CHAINS.filter(
    (chain) => chain.family === "xec" && chain.cashaddrPrefix === prefix
  );
  if (matches.length !== 1)
    throw new Error(`${chainIdentifier} has no eCash transaction format`);
  return matches[0];
}

function must<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
  label: string
): T {
  if (!result.ok)
    throw new Error(
      `eCash HTLC ${label} failed: ${JSON.stringify(result.error)}`
    );
  return result.value;
}

/** Minimal push of `data` (at most 520 bytes; the redeem script is far below). */
function push(data: Uint8Array): Uint8Array {
  return Script.fromOps([pushBytesOp(data)]).bytecode;
}

/** The P2SH output script locking the HTLC. */
export function xecHtlcOutputScript(terms: XecHtlcTerms): Uint8Array {
  return Script.p2sh(shaRmd160(xecHtlcRedeemScript(terms))).bytecode;
}

/** The P2SH cashaddr of the HTLC on one canonical eCash network. */
export function xecHtlcAddress(
  chainIdentifier: string,
  terms: XecHtlcTerms
): string {
  return Address.p2sh(
    shaRmd160(xecHtlcRedeemScript(terms)),
    xecAddressPrefix(chainIdentifier)
  ).toString();
}

/** Value the funding output must carry: principal plus the fixed spend fee. */
export function xecHtlcFundingValue(principalSats: bigint): bigint {
  if (
    typeof principalSats !== "bigint" ||
    principalSats < XEC_HTLC_MIN_PRINCIPAL_SATS
  )
    throw new RangeError(
      `eCash HTLC principal must be at least ${XEC_HTLC_MIN_PRINCIPAL_SATS} sats`
    );
  return principalSats + XEC_HTLC_SPEND_FEE_SATS;
}

/** Native-operation id of A's funding transaction for one swap. */
export function xecHtlcLockOperationId(swapId: string): string {
  if (!/^[0-9a-f]{64}$/.test(swapId))
    throw new Error("Swap id must be 32 bytes of lowercase hex");
  return `swap:${swapId}:xec-lock`;
}

/** Whether an eCash operation id is a swap's lock (`xecHtlcLockOperationId`). */
export function isXecHtlcLockOperationId(operationId: string): boolean {
  return /^swap:[0-9a-f]{64}:xec-lock$/.test(operationId);
}

/**
 * Builds the claim or refund spend. `sign` receives the BIP143/FORKID sighash digest (32 bytes)
 * and returns a DER ECDSA signature without the hash-type byte. The signature is checked against
 * the branch's key before the spend is returned.
 */
export function buildXecHtlcSpend(params: {
  chainIdentifier: string;
  terms: XecHtlcTerms;
  funding: XecHtlcFundingOutput;
  principalSats: bigint;
  branch: XecHtlcBranch;
  /** Required for, and only for, the claim branch. */
  preimage?: Uint8Array;
  /** The spender's own primary address on `chainIdentifier`. */
  destination: string;
  sign: (digest: Uint8Array) => Uint8Array;
}): XecHtlcSpend {
  const terms = validateXecHtlcTerms(params.terms);
  const redeem = xecHtlcRedeemScript(terms);
  if (
    !/^[0-9a-f]{64}$/.test(params.funding.txid) ||
    !Number.isSafeInteger(params.funding.vout) ||
    params.funding.vout < 0 ||
    params.funding.vout > 0xffffffff
  )
    throw new Error("Invalid eCash HTLC funding outpoint");
  const fundingValue = xecHtlcFundingValue(params.principalSats);
  const prefix = xecAddressPrefix(params.chainIdentifier);
  let destination: Address;
  try {
    destination = Address.fromCashAddress(params.destination.toLowerCase());
  } catch {
    throw new Error("Invalid eCash HTLC destination");
  }
  if (destination.prefix !== prefix)
    throw new Error("eCash HTLC destination is on another network");

  let preimage: Uint8Array | undefined;
  if (params.branch === "claim") {
    if (params.preimage === undefined)
      throw new Error("eCash HTLC claim needs the preimage");
    preimage = copyBytes(params.preimage, XEC_HTLC_PREIMAGE_BYTES, "preimage");
    if (!sameBytes(sha256(preimage), terms.hashLock))
      throw new Error("eCash HTLC preimage does not match the hash lock");
  } else if (params.branch === "refund") {
    if (params.preimage !== undefined)
      throw new Error("eCash HTLC refund takes no preimage");
  } else {
    throw new Error("Unknown eCash HTLC branch");
  }
  const signer =
    params.branch === "claim" ? terms.claimPublicKey : terms.refundPublicKey;
  const chain = xecTransactionChain(params.chainIdentifier);
  const txid = must(
    displayTxidFromBytes(
      new Uint8Array(Buffer.from(params.funding.txid, "hex"))
    ),
    "funding txid"
  );
  const unsigned: Transaction = {
    version: 2,
    inputs: [
      {
        prevout: {
          txid: internalHashFromDisplay(txid),
          vout: params.funding.vout,
        },
        scriptSig: new Uint8Array(),
        sequence:
          params.branch === "claim"
            ? SEQUENCE_FINAL
            : SEQUENCE_LOCKTIME_ENABLED,
      },
    ],
    outputs: [
      {
        value: params.principalSats,
        scriptPubKey: destination.toScript().bytecode,
      },
    ],
    locktime: params.branch === "claim" ? 0 : terms.refundTime,
  };
  const digest = must(
    sighash(unsigned, 0, chain, SIGHASH_ALL_FORKID, {
      algorithm: "forkid",
      scriptCode: redeem,
      amount: fundingValue,
    }),
    "sighash"
  );
  const der = params.sign(Uint8Array.from(digest));
  if (
    !(der instanceof Uint8Array) ||
    !secp256k1.verify(der, digest, signer, { lowS: true, format: "der" })
  )
    throw new Error("eCash HTLC signature is not by the branch key");
  const signature = Uint8Array.from([...der, SIGHASH_ALL_FORKID]);
  const scriptSig =
    params.branch === "claim"
      ? Uint8Array.from([
          ...push(signature),
          ...push(preimage!),
          OP_1,
          ...push(redeem),
        ])
      : Uint8Array.from([...push(signature), OP_0, ...push(redeem)]);
  const signed: Transaction = {
    ...unsigned,
    inputs: [{ ...unsigned.inputs[0], scriptSig }],
  };
  return Object.freeze({
    rawTx: Buffer.from(
      must(serializeTransaction(signed, chain), "serialize")
    ).toString("hex"),
    txid: Buffer.from(must(transactionId(signed, chain), "txid"))
      .reverse()
      .toString("hex"),
  });
}

/**
 * The preimage revealed by a claim spend's scriptSig (push #2), or undefined when the script is
 * not a claim of exactly these terms with a preimage matching the hash lock.
 */
export function extractXecHtlcPreimage(
  inputScript: Uint8Array | string,
  terms: XecHtlcTerms
): Uint8Array | undefined {
  const valid = validateXecHtlcTerms(terms);
  const bytes =
    typeof inputScript === "string"
      ? /^(?:[0-9a-f]{2})*$/i.test(inputScript)
        ? new Uint8Array(Buffer.from(inputScript, "hex"))
        : undefined
      : Uint8Array.from(inputScript);
  if (bytes === undefined) return undefined;
  const ops: Op[] = [];
  try {
    const iter = new Script(bytes).ops();
    for (let op = iter.next(); op !== undefined; op = iter.next()) ops.push(op);
  } catch {
    return undefined;
  }
  if (ops.length !== 4) return undefined;
  const [, revealed, selector, redeem] = ops;
  if (
    !isPushOp(revealed) ||
    revealed.data.length !== XEC_HTLC_PREIMAGE_BYTES ||
    selector !== OP_1 ||
    !isPushOp(redeem) ||
    !sameBytes(redeem.data, xecHtlcRedeemScript(valid))
  )
    return undefined;
  const preimage = Uint8Array.from(revealed.data);
  return sameBytes(sha256(preimage), valid.hashLock) ? preimage : undefined;
}

/**
 * Reads the chain: the preimage from the transaction that spent the funding output, or
 * undefined while it is unspent or was spent by a refund.
 */
export async function findXecHtlcPreimage(
  chronik: Pick<ChronikClient, "tx">,
  funding: XecHtlcFundingOutput,
  terms: XecHtlcTerms
): Promise<Uint8Array | undefined> {
  const fundingTx = await chronik.tx(funding.txid);
  const output = fundingTx.outputs[funding.vout];
  if (output === undefined)
    throw new Error("eCash HTLC funding output does not exist");
  if (
    output.outputScript !==
    Buffer.from(xecHtlcOutputScript(terms)).toString("hex")
  )
    throw new Error("eCash HTLC funding output has another script");
  if (output.spentBy === undefined) return undefined;
  const spending = await chronik.tx(output.spentBy.txid);
  const input = spending.inputs[output.spentBy.outIdx];
  if (
    input === undefined ||
    input.prevOut.txid !== funding.txid ||
    input.prevOut.outIdx !== funding.vout
  )
    throw new Error("Chronik spentBy does not point at the funding output");
  return extractXecHtlcPreimage(input.inputScript, terms);
}
