/**
 * The wallet side of the HTLC swap runner (`@frank/swap-protocol/src/htlc-swap-runner`): the
 * eCash and EVM capabilities it is composed with. Their shapes are the runner's
 * `XecHtlcCapability` / `EvmHtlcCapability`, matched structurally; this package does not import
 * the swap protocol (dependency direction: the host composes both).
 *
 * eCash: keys and signing stay in `EcashWallet` (`htlcPublicKey`, `signHtlcSpend`); A's funding
 * is the wallet's native operation `swap:<swapId>:xec-lock`, prepared once and only resumed
 * afterwards; the chain is read through Chronik (outputs at the HTLC's P2SH script, who spent
 * them, and the tip's median-time-past).
 *
 * EVM: every GenericHTLC step is a `sendContractCall` from the main account with an `htlc`
 * record, so the native journal owns the signed bytes and re-sends them; locks are read with
 * `locks(lockId)` at the latest block and at the network's final depth.
 */
import type { ChronikClient, Tx } from "chronik-client";
import { ZeroAddress } from "ethers";
import type { EcashWallet } from "../ecash-wallet";
import {
  extractXecHtlcPreimage,
  xecHtlcAddress,
  xecHtlcFundingValue,
  xecHtlcLockOperationId,
  xecHtlcOutputScript,
  type XecHtlcBranch,
  type XecHtlcTerms,
} from "../ecash-htlc";
import type { NativeWalletHandle } from "../chain/chain-wallet";
import { htlcMainAccountOf } from "../chain/evm-chain";
import {
  HTLC_NATIVE_TOKEN,
  encodeHtlcLock,
  encodeHtlcRefund,
  encodeHtlcWithdraw,
  evmHtlcInterface,
  htlcLockId,
  readHtlcLock,
  type EvmHtlcLock,
} from "../swap-escrow";
import {
  nativeMemberAbandoned,
  nativeMemberSuperseded,
  type EvmNativeOperation,
} from "../storage/evm-native-operation-journal";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** When an eCash transaction counts as final: Avalanche (testnet, mainnet), or a number of
 * confirmations (a single regtest node has no Avalanche quorum). */
export type XecFinality =
  | { readonly kind: "avalanche" }
  | { readonly kind: "confirmations"; readonly depth: number };

export function createXecHtlcSwapCapability(params: {
  wallet: Pick<
    EcashWallet,
    | "chainIdentifier"
    | "htlcPublicKey"
    | "signHtlcSpend"
    | "getEcashOperations"
    | "prepareNativeOperation"
    | "submitNativeOperation"
    | "releaseNativeOperation"
  >;
  chronik: Pick<
    ChronikClient,
    "script" | "tx" | "blockchainInfo" | "blocks" | "broadcastTx"
  >;
  finality: XecFinality;
}) {
  const { wallet, chronik, finality } = params;
  const chainIdentifier = wallet.chainIdentifier;
  const final = (tx: Pick<Tx, "isFinal" | "block">, tipHeight: number) =>
    finality.kind === "avalanche"
      ? tx.isFinal
      : tx.block !== undefined &&
        tipHeight - tx.block.height + 1 >= finality.depth;
  const operation = (swapId: string) =>
    wallet
      .getEcashOperations()
      .find((op) => op.operationId === xecHtlcLockOperationId(swapId));

  return Object.freeze({
    chainIdentifier,
    htlcPublicKey: (swapId: string, role: XecHtlcBranch) =>
      wallet.htlcPublicKey(swapId, role),

    async observe(terms: XecHtlcTerms) {
      const script = hex(xecHtlcOutputScript(terms));
      const info = await chronik.blockchainInfo();
      const tip = info.tipHeight;
      const recent = await chronik.blocks(Math.max(0, tip - 10), tip);
      const times = recent.map((b) => b.timestamp).sort((a, b) => a - b);
      const tipMedianTime = times[Math.floor(times.length / 2)] ?? 0;
      // The script's whole history (mempool first); a swap's script has a handful of txs.
      const txs: Tx[] = [];
      for (let page = 0; ; page++) {
        const history = await chronik
          .script("p2sh", script.slice(4, 44))
          .history(page, 200);
        txs.push(...history.txs);
        if (page + 1 >= history.numPages) break;
      }
      const seen = new Set<string>();
      const outputs = [];
      for (const tx of txs) {
        for (const [vout, output] of tx.outputs.entries()) {
          const key = `${tx.txid}:${vout}`;
          if (output.outputScript !== script || seen.has(key)) continue;
          seen.add(key);
          let spentBy:
            | { txid: string; branch: XecHtlcBranch; final: boolean }
            | undefined;
          if (output.spentBy) {
            const spending = await chronik.tx(output.spentBy.txid);
            const input = spending.inputs[output.spentBy.outIdx];
            spentBy = {
              txid: spending.txid,
              branch:
                input &&
                extractXecHtlcPreimage(input.inputScript, terms) !== undefined
                  ? "claim"
                  : "refund",
              final: final(spending, tip),
            };
          }
          outputs.push({
            txid: tx.txid,
            vout,
            valueSats: output.sats,
            final: final(tx, tip),
            ...(spentBy ? { spentBy } : {}),
          });
        }
      }
      return { tipMedianTime, outputs };
    },

    async lockOperation(swapId: string) {
      return operation(swapId)?.state;
    },

    async fund(input: {
      swapId: string;
      terms: XecHtlcTerms;
      principalSats: bigint;
    }) {
      const operationId = xecHtlcLockOperationId(input.swapId);
      const existing = operation(input.swapId);
      if (existing?.state === "released")
        throw new Error("This swap's eCash lock was released; it is never funded again");
      if (existing === undefined)
        await wallet.prepareNativeOperation({
          operationId,
          recipient: { raw: xecHtlcAddress(chainIdentifier, input.terms) },
          value: xecHtlcFundingValue(input.principalSats),
        });
      // prepareNativeOperation is bound to the id: a second call returns the same operation.
      const sent = await wallet.submitNativeOperation(operationId);
      return { txid: sent.txHash };
    },

    async releaseLock(swapId: string) {
      const existing = operation(swapId);
      if (existing?.state === "prepared")
        await wallet.releaseNativeOperation(existing.operationId);
    },

    async signSpend(input: {
      swapId: string;
      terms: XecHtlcTerms;
      funding: { txid: string; vout: number };
      principalSats: bigint;
      branch: XecHtlcBranch;
      preimage?: Uint8Array;
    }) {
      return wallet.signHtlcSpend(input);
    },

    async broadcast(rawTx: string) {
      try {
        await chronik.broadcastTx(rawTx);
      } catch (error) {
        // The node already has it (in its mempool or a block): nothing more to hand over.
        if (/already|txn-already-known|txn-already-in-mempool/i.test(String(error)))
          return;
        throw error;
      }
    },
  });
}

/** The reads the EVM capability makes; an ethers provider of the wallet's own network. */
export interface EvmHtlcSwapReader {
  call(tx: { to: string; data: string; blockTag?: number }): Promise<string>;
  getBlock(
    tag: "latest" | number
  ): Promise<{ number: number; timestamp: number } | null>;
  getBalance(address: string): Promise<bigint>;
  getFeeData(): Promise<{ maxFeePerGas: bigint | null; gasPrice: bigint | null }>;
}

/** Gas limit of one GenericHTLC lock, withdraw or refund from the main account. */
export const HTLC_CALL_GAS_LIMIT = 300_000n;

function lockView(lock: EvmHtlcLock | null) {
  if (lock === null) return null;
  return {
    state: lock.state,
    preimage:
      lock.preimage === null
        ? null
        : new Uint8Array(Buffer.from(lock.preimage.slice(2), "hex")),
  };
}

function callState(
  row: EvmNativeOperation
): "pending" | "landed" | "reverted" | "ended" {
  const member = row.members[0];
  if (row.cancelled || member === undefined) return "ended";
  if (member.observation.state === "included-success") return "landed";
  if (member.observation.state === "included-revert") return "reverted";
  if (nativeMemberAbandoned(member) || nativeMemberSuperseded(member))
    return "ended";
  return member.signed === null ? "ended" : "pending";
}

export function createEvmHtlcSwapCapability(params: {
  wallet: NativeWalletHandle;
  reader: EvmHtlcSwapReader;
  /** This network's GenericHTLC (the registry deployment, or a regtest run's injected one). */
  contract: string;
  /** Blocks below the latest at which a lock read counts as final (Monad: 10). */
  finalityDepth: number;
}) {
  const { wallet, reader, contract } = params;
  if (
    typeof wallet.sendContractCall !== "function" ||
    typeof wallet.getNativeOperations !== "function"
  )
    throw new Error("This wallet cannot make GenericHTLC calls");
  const sendContractCall = wallet.sendContractCall.bind(wallet);
  const getNativeOperations = wallet.getNativeOperations.bind(wallet);
  const mainAccount = () => {
    const main = htlcMainAccountOf(wallet);
    if (!main) throw new Error("The EVM wallet is closed or has no main account");
    return main;
  };
  const send = async (
    record: { action: "lock" | "withdraw" | "refund"; swapId: string; lockId: string },
    call: { to: string; data: string; value: bigint },
    deadline?: number
  ) => {
    const sent = await sendContractCall({
      to: { raw: call.to },
      data: call.data,
      value: call.value,
      gasLimit: HTLC_CALL_GAS_LIMIT,
      record: { kind: "htlc", ...record, lockId: record.lockId.toLowerCase() },
      ...(deadline === undefined ? {} : { deadline }),
    });
    return { operationId: sent.operationId };
  };

  return Object.freeze({
    chainIdentifier: wallet.chainIdentifier,
    mainAccount,
    htlcContract: () => contract.toLowerCase(),

    async observe(lockId: string) {
      const latest = await reader.getBlock("latest");
      if (!latest) throw new Error("The EVM node returned no latest block");
      const main = mainAccount();
      const [atLatest, atFinal, owedWord, mainBalanceWei, fees] =
        await Promise.all([
          readHtlcLock(reader, contract, lockId, { blockTag: latest.number }),
          readHtlcLock(reader, contract, lockId, {
            blockTag: Math.max(0, latest.number - params.finalityDepth),
          }),
          reader.call({
            to: contract,
            data: evmHtlcInterface.encodeFunctionData("owed", [main, ZeroAddress]),
            blockTag: latest.number,
          }),
          reader.getBalance(main),
          reader.getFeeData(),
        ]);
      const gasPrice = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
      return {
        latest: lockView(atLatest),
        final: lockView(atFinal),
        blockTimestamp: latest.timestamp,
        owedWei: BigInt(
          evmHtlcInterface.decodeFunctionResult("owed", owedWord)[0]
        ),
        mainBalanceWei,
        callCostWei: HTLC_CALL_GAS_LIMIT * gasPrice,
      };
    },

    async ownCalls(swapId: string) {
      return getNativeOperations()
        .filter(
          (row) =>
            row.kind === "contract" &&
            row.record?.kind === "htlc" &&
            row.record.swapId === swapId
        )
        .map((row) => ({
          action: (row.record as { action: "lock" | "withdraw" | "refund" })
            .action,
          operationId: row.operationId,
          state: callState(row),
        }));
    },

    async lock(input: {
      swapId: string;
      lockId: string;
      terms: {
        recipient: string;
        refundAddress: string;
        amount: bigint;
        hashLock: string;
        expiresAt: number;
      };
    }) {
      const terms = {
        ...input.terms,
        token: HTLC_NATIVE_TOKEN,
        expiresAt: BigInt(input.terms.expiresAt),
      };
      if (htlcLockId(mainAccount(), terms).toLowerCase() !== input.lockId.toLowerCase())
        throw new Error("The lock's terms do not give its lock id from this main account");
      // A lock needs block.timestamp < expiresAt: given up once the chain reaches it.
      return send(
        { action: "lock", swapId: input.swapId, lockId: input.lockId },
        encodeHtlcLock(contract, terms),
        input.terms.expiresAt - 1
      );
    },

    async withdraw(input: {
      swapId: string;
      lockId: string;
      preimage: Uint8Array;
      expiresAt: number;
    }) {
      return send(
        { action: "withdraw", swapId: input.swapId, lockId: input.lockId },
        encodeHtlcWithdraw(contract, input.lockId, input.preimage),
        input.expiresAt - 1
      );
    },

    async refund(input: { swapId: string; lockId: string }) {
      return send(
        { action: "refund", swapId: input.swapId, lockId: input.lockId },
        encodeHtlcRefund(contract, input.lockId)
      );
    },

    async claimOwed() {
      await sendContractCall({
        to: { raw: contract },
        data: evmHtlcInterface.encodeFunctionData("claimOwed", [
          ZeroAddress,
          mainAccount(),
        ]),
        value: 0n,
        gasLimit: HTLC_CALL_GAS_LIMIT,
      });
    },
  });
}
