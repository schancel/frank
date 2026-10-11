/** Real local Monad + relay proof of bot receipt, claim and refund persistence.
 * CASHWEBD_BIN=<reviewed binary> node --import tsx money-receipt.livecheck.ts
 * Uses the local faucet; preserves all wallet/relay state and returns main-account funds.
 * Replacement recovery is a separate expected-failure proof in payment-credit.livecheck.ts.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { Wallet } from "ethers";
import { LevelBotStateStore, type BotContext } from "@frank/bot-framework";
import { chainAmounts } from "@frank/bot-framework/amounts";
import { conversationIdentity } from "@frank/bot-framework/inbound-operation-store";
import { confirmReceived, Outbox } from "./src/bots/money";
import { openMonadWallet, monadOf } from "./demo/regtest/monad-wallets";
import { startRegtestStack } from "./demo/regtest/regtest-stack";
import type { RealWallet } from "./demo/real-stack";

const STAMP = 10n ** 16n;
async function main() {
  const stack = await startRegtestStack({
    chains: ["monad-regtest"],
    env: { ...process.env, FRANK_REGTEST_KEEP: "1" },
  });
  console.log(
    `[money-receipt] preserved funded local state: ${stack.stateDir}`
  );
  const monad = monadOf(stack);
  const wallets: RealWallet[] = [];
  let state: LevelBotStateStore | undefined;
  let fundedWei = 0n;
  try {
    const alice = await openMonadWallet(stack, "money-receipt-alice");
    wallets.push(alice);
    const bob = await openMonadWallet(stack, "money-receipt-bob");
    wallets.push(bob);
    for (const wallet of wallets) {
      await monad.fund(wallet.mainAccount, 10n * STAMP);
      fundedWei += 10n * STAMP;
    }
    const digest = await alice.send(
      bob.address,
      [{ type: "text", text: "receipt and refund proof" }],
      STAMP
    );
    const incoming = await bob.receive(
      (message) => message.payloadDigest === digest
    );
    const location = join(stack.stateDir, "bot-credit-state");
    state = await LevelBotStateStore.open(location);
    const unsupported = async (): Promise<never> => {
      throw new Error("unused livecheck capability");
    };
    const ctx: BotContext = {
      ...chainAmounts(bob.chain),
      botId: "receipt-proof",
      address: bob.address,
      subject: bob.handle.identity.compressedPubKey.toString("hex"),
      relayBaseUrl: stack.relayUrl,
      networkTag: "MONR",
      provider: monad.provider,
      stopping: new AbortController().signal,
      subscriptions: {
        subscribe: unsupported,
        unsubscribe: unsupported,
        isSubscribed: unsupported,
        listSubscribers: unsupported,
        broadcast: unsupported,
        handleSubscriptionCommand: unsupported,
      },
      lookupPeer: unsupported,
      onNewUserRegistered: () => {
        throw new Error("unused livecheck capability");
      },
      sendTransfer: unsupported,
      sendTransaction: unsupported,
      buildAndSignTransfer: unsupported,
      waitForReceipt: (hash, timeout = 30_000) =>
        monad.provider.waitForTransaction(hash, 1, timeout),
      getBalance: (address) =>
        monad.provider.getBalance(address ?? bob.mainAccount),
      sendDirectMessage: (...args) => ctx.sendMessage(...args),
      state,
      checkMessagePayment: (payloadDigest: string) =>
        bob.handle.checkMessagePayment!(payloadDigest),
      sendMessage: (to, items, conversationId, options) =>
        bob.chain.directMessages.send({
          wallet: bob.handle,
          recipient: { raw: to },
          items,
          ...(conversationId
            ? { conversationId: conversationIdentity(conversationId) }
            : {}),
          stampValue: options?.stampValueWei,
          messageId: options?.messageId,
          ...(options?.settlement ? { settlement: true } : {}),
        }),
      attemptStatus: async (payloadDigest) =>
        (
          await bob.chain.directMessages.reconcileAttempts({
            wallet: bob.handle,
            payloadDigests: [payloadDigest],
          })
        )[payloadDigest] ?? "unknown",
    };
    const received = await confirmReceived(incoming, ctx, 10_000);
    assert.equal(received.confirmedWei, STAMP);
    assert.equal((await confirmReceived(incoming, ctx, 0)).confirmedWei, STAMP);
    const replay = { ...incoming, payloadDigest: "ff".repeat(32) };
    assert.equal((await confirmReceived(replay, ctx, 0)).confirmedWei, 0n);
    await new Outbox("receipt-proof").owe(ctx, `refund:${digest}`, {
      to: alice.address,
      items: [{ type: "text", text: "verified refund" }],
      valueWei: received.confirmedWei,
    });
    await state.close();
    state = await LevelBotStateStore.open(location);
    Object.assign(ctx, { state });
    const restarted = new Outbox("receipt-proof");
    for (
      const deadline = Date.now() + 90_000;
      !(await restarted.sent(ctx, `refund:${digest}`));

    ) {
      await restarted.settle(ctx);
      assert(Date.now() < deadline, "persisted refund must settle");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await restarted.settle(ctx);
    const refund = await alice.receive((message) =>
      message.items.some(
        (item) => item.type === "text" && item.text === "verified refund"
      )
    );
    assert.equal(
      (await alice.handle.checkMessagePayment!(refund.payloadDigest))
        .receivedWei,
      STAMP
    );
    await state.close();
    state = await LevelBotStateStore.open(location);
    Object.assign(ctx, { state });
    await new Outbox("receipt-proof").settle(ctx);
    assert(await new Outbox("receipt-proof").sent(ctx, `refund:${digest}`));
    console.log(
      "[money-receipt] PASS: verified receipt, duplicate control, persistent claim/outbox restart, actual refund"
    );
  } finally {
    await state?.close();
    for (const wallet of wallets) {
      try {
        const digests = [
          ...new Set(
            (wallet.handle.getReceivedPayments?.() ?? []).flatMap((payment) =>
              payment.payloadDigest ? [payment.payloadDigest] : []
            )
          ),
        ];
        if (digests.length)
          await wallet.handle.sweepReceivedCoins?.({ payloadDigests: digests });
      } catch (error) {
        console.warn(
          `[money-receipt] received funds preserved: ${
            error instanceof Error
              ? error.message.split("\n")[0]
              : "sweep unresolved"
          }`
        );
      }
      await wallet.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let returnedWei = 0n;
    for (const wallet of wallets)
      for (const key of [
        wallet.handle.mainPrivateKey,
        wallet.handle.identity.toPrivateKeyHex(),
      ]) {
        if (!key) continue;
        const signer = new Wallet(key, monad.provider);
        try {
          const held = await monad.provider.getBalance(signer.address);
          const gasPrice = BigInt(
              await monad.provider.send("eth_gasPrice", [])
            ),
            fee = gasPrice * 21_000n;
          if (held <= fee) continue;
          const tx = await signer.sendTransaction({
            to: monad.faucetAddress,
            value: held - fee,
            type: 0,
            gasPrice,
            gasLimit: 21_000n,
          });
          assert.equal((await tx.wait(1, 30_000))?.status, 1);
          returnedWei += held - fee;
        } catch (error) {
          console.warn(
            `[money-receipt] main sweep unresolved: ${
              error instanceof Error ? error.message.split("\n")[0] : "unknown"
            }`
          );
        }
      }
    console.log(
      `[money-receipt] fundedWei=${fundedWei} returnedWei=${returnedWei}; fees and remaining pool/coin funds stay recoverable at ${stack.stateDir}`
    );
    await stack.stop();
  }
}
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
