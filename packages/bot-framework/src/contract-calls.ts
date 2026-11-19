/**
 * The narrow wallet capabilities a game bot's table escrow uses, built from its wallet handle:
 * contract calls through the wallet's journaled contract-call path (`sendContractCall`, re-sent
 * byte for byte by `resumeNativeOperation`) and the table secret (`tableSecretCapabilityOf`),
 * which hands out preimages only. Neither exposes the wallet itself.
 */
import { getAddress } from "ethers";
import type { EvmChainWalletHandle } from "@frank/wallet/evm-wallet-handle";
import { tableSecretCapabilityOf } from "@frank/wallet/chain/evm-chain";
import type { TableSecretCapability } from "@frank/wallet/table-preimage";
import type { BotContractCalls } from "./types";

/** The contract-call capability of `wallet`, or undefined where it makes none. `htlcContract`
 * names this network's GenericHTLC (and throws where none is deployed). */
export function botContractCallsOf(
  wallet: Pick<
    EvmChainWalletHandle,
    "sendContractCall" | "getContractCallFunds" | "resumeNativeOperation"
  >,
  htlcContract: () => string
): BotContractCalls | undefined {
  const { sendContractCall, getContractCallFunds, resumeNativeOperation } = wallet;
  if (!sendContractCall || !getContractCallFunds || !resumeNativeOperation)
    return undefined;
  return Object.freeze({
    account: async () =>
      getAddress((await getContractCallFunds.call(wallet)).mainAddress),
    htlcContract: () => getAddress(htlcContract()),
    send: async (params: Parameters<BotContractCalls["send"]>[0]) => {
      const handle = await sendContractCall.call(wallet, {
        to: { raw: params.to },
        data: params.data,
        value: params.value,
        ...(params.gasLimit === undefined ? {} : { gasLimit: params.gasLimit }),
        record: params.record,
      });
      return { operationId: handle.operationId, txHash: handle.txHash };
    },
    resume: async (operationId: string) => {
      await resumeNativeOperation.call(wallet, operationId);
    },
  });
}

/** The table-secret capability of `wallet`, or undefined where it has no typed messaging root. */
export function botTableSecretsOf(
  wallet: EvmChainWalletHandle
): TableSecretCapability | undefined {
  return tableSecretCapabilityOf(wallet);
}
