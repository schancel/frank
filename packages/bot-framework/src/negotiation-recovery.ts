import type {
  ActiveChain,
  WalletHandle,
} from "@frank/wallet/chain/active-chain";
import type { NegotiationJournalOwner } from "@frank/swap-protocol/src/negotiation-journal";
import { botNegotiationIncarnation } from "@frank/swap-protocol/src/host-identity";
import {
  NegotiationRecovery,
  type NegotiationRecoverySnapshot,
} from "@frank/swap-protocol/src/runtime";
import { TESTNET_NEGOTIATION_POLICY } from "@frank/swap-protocol/src/negotiation";
import { createNativeNegotiationJournalStore } from "@frank/swap-protocol/src/storage/negotiation-native";

export interface BotNegotiationRecovery {
  readonly snapshot: NegotiationRecoverySnapshot;
  stop(): Promise<void>;
}
/** Original scan history has no path to handler dispatch, financial recovery, or ordinary cursors. */
export function startBotNegotiationRecovery(input: {
  readonly chain: ActiveChain;
  readonly wallet: WalletHandle;
  readonly owner: {
    readonly botId: string;
    readonly chainIdentifier: string;
    readonly subject: string;
    readonly address: string;
  };
  readonly rootLocation: string;
}): BotNegotiationRecovery {
  let snapshot: NegotiationRecoverySnapshot = {
    state: "unsupported",
    coverage: undefined,
    journals: [],
  };
  const messages = input.chain.directMessages;
  const wallet = input.wallet;
  const rootLocation = input.rootLocation;
  const scanner = messages?.scanAuthenticatedMailbox;
  if (input.owner.chainIdentifier !== input.chain.chainIdentifier)
    throw new Error("Bot negotiation chain affinity");
  if (
    input.chain.chainIdentifier !==
      TESTNET_NEGOTIATION_POLICY.evmChainIdentifier ||
    !scanner
  )
    return {
      get snapshot() {
        return snapshot;
      },
      stop: async () => undefined,
    };
  const accountIncarnation = botNegotiationIncarnation(input.owner);
  const localPublicKey = Uint8Array.from(
    Buffer.from(input.owner.subject, "hex")
  );
  const owner: NegotiationJournalOwner = {
    accountIncarnation,
    localPublicKey,
    messagingChainIdentifier: input.owner.chainIdentifier,
  };
  const recovery = new NegotiationRecovery({
    owner,
    policy: TESTNET_NEGOTIATION_POLICY,
    openStore: () =>
      createNativeNegotiationJournalStore({
        hostDiscriminator: "bot",
        accountIncarnation,
        localPublicKey,
        rootLocation,
      }),
    scan: (sinceMs) => scanner.call(messages, { wallet, sinceMs }),
    schedule: (work, delay) => {
      const timer = setTimeout(work, delay);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    publish: (value) => {
      const changed = snapshot.state !== value.state;
      snapshot = value;
      if (
        changed &&
        (value.state === "capacity" || value.state === "storage-error")
      )
        console.warn(
          `[bot-host] Swap recovery ${value.state}; evidence and coverage retained`
        );
    },
  });
  recovery.start();
  return {
    get snapshot() {
      return recovery.snapshot;
    },
    stop: () => recovery.stop(),
  };
}
