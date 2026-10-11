/**
 * Expected-failure replacement baseline on the real local Monad client and relay.
 * The bot receipt predecessor does not repair this wallet evidence failure.
 * Run from packages/bot: node --import tsx payment-credit.livecheck.ts
 *
 * The HTTP fault injector forwards every RPC to the real client, except submissions of
 * the original signed payment. Its fee replacement is accepted by the real client.
 * No testnet funds, simulated chain, or simulated mailbox are used.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { JsonRpcProvider, Transaction, Wallet, hexlify } from "ethers";
import {
  defaultCanonicalFetch,
  restoreCanonicalRequest,
  type CanonicalFetch,
} from "@frank/cashweb/relay/canonical-dm-transport";
import { installCanonicalDirectory } from "@frank/wallet/chain/monad-chain";
import { ensureSolonet } from "./demo/regtest/monad-regtest";
import { monadOf, openMonadWallet } from "./demo/regtest/monad-wallets";
import { startRegtestStack } from "./demo/regtest/regtest-stack";
import type { RealWallet } from "./demo/real-stack";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const STAKE = 10n ** 16n;

async function main(): Promise<void> {
  const { rpcUrl } = await ensureSolonet();
  const refused = new Set<string>();
  let refusals = 0;
  const proxy = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      type RpcRequest = { id: unknown; method: string; params?: string[] };
      const parsed = JSON.parse(body.toString()) as RpcRequest | RpcRequest[];
      const forward = async (call: RpcRequest): Promise<unknown> => {
        if (
          call.method === "eth_sendRawTransaction" &&
          refused.has(call.params?.[0]?.toLowerCase() ?? "")
        ) {
          refusals++;
          return {
            jsonrpc: "2.0",
            id: call.id,
            error: {
              code: -32000,
              message:
                "original submission refused by regression fault injector",
            },
          };
        }
        const actual = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(call),
        });
        if (!actual.ok)
          throw new Error(`real RPC returned HTTP ${actual.status}`);
        return actual.json();
      };
      const answer = Array.isArray(parsed)
        ? await Promise.all(parsed.map(forward))
        : await forward(parsed);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer));
    } catch (error) {
      response.writeHead(502);
      response.end(
        error instanceof Error ? error.message : "RPC forwarding failed"
      );
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert(address && typeof address !== "string");
  const provider = new JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
  const wallets: RealWallet[] = [];
  let stack: Awaited<ReturnType<typeof startRegtestStack>> | undefined;
  let recipient: string | undefined;
  let payer: string | undefined;
  try {
    // Preserve all funded state, including on a failed assertion. Local faucet funds have
    // no external value; this directory can be reused for inspection/recovery.
    stack = await startRegtestStack({
      chains: ["monad-regtest"],
      env: {
        ...process.env,
        FRANK_SOLONET_RPC_URL: `http://127.0.0.1:${address.port}`,
        FRANK_REGTEST_KEEP: "1",
      },
    });
    console.log(
      `[payment-credit] preserved local-chain state: ${stack.stateDir}`
    );
    const alice = await openMonadWallet(stack, "payment-credit-alice");
    wallets.push(alice);
    const bob = await openMonadWallet(stack, "payment-credit-bob");
    wallets.push(bob);
    await monadOf(stack).fund(alice.mainAccount, 10n * STAKE);
    let originalRaw: string | undefined;
    const base = alice.directory;
    const intercept: CanonicalFetch = async (url, init) => {
      if (originalRaw === undefined && init.method !== "GET" && init.body) {
        try {
          const request = restoreCanonicalRequest({
            body: new Uint8Array(init.body),
            contentType: init.headers["Content-Type"],
          });
          if (request.parts.transactions.length === 1) {
            originalRaw = hexlify(request.parts.transactions[0]).toLowerCase();
            refused.add(originalRaw);
          }
        } catch {
          // Directory requests are not message requests.
        }
      }
      return (base.fetch ?? defaultCanonicalFetch)(url, init);
    };
    installCanonicalDirectory(alice.handle, { ...base, fetch: intercept });
    const digest = await alice.send(
      bob.address,
      [{ type: "text", text: "replacement receipt regression" }],
      STAKE
    );
    const incoming = await bob.receive(
      (message) => message.payloadDigest === digest
    );
    assert(originalRaw, "the real paid request must have been intercepted");
    const original = Transaction.from(originalRaw);
    recipient = original.to!;
    payer = original.from!;
    assert.equal(incoming.stampPayments.length, 1);
    assert.equal(
      incoming.stampPayments[0].txHash.toLowerCase(),
      original.hash!.toLowerCase()
    );
    for (const deadline = Date.now() + 120_000; ; ) {
      await alice.chain.directMessages.reconcileAttempts({
        wallet: alice.handle,
        payloadDigests: [digest],
      });
      const balance = await provider.getBalance(original.to!);
      if (balance >= STAKE) break;
      assert(
        Date.now() < deadline,
        "the real replacement must fund the recipient within two minutes"
      );
      await sleep(500);
    }
    assert(
      refusals > 0,
      "the original submission must actually have been refused"
    );
    assert.equal(
      await provider.getTransactionReceipt(original.hash!),
      null,
      "the immutable original hash must not be mined"
    );
    assert.equal(
      await provider.getTransactionCount(original.from!),
      original.nonce + 1,
      "one payer nonce must be consumed"
    );
    assert(
      bob.handle.checkMessagePayment,
      "wallet receipt evidence capability is required"
    );
    const payment = await bob.handle.checkMessagePayment(digest);
    assert.equal(
      payment.receivedWei,
      STAKE,
      "replacement-only inclusion must be credited through the existing wallet evidence boundary"
    );
    console.log(
      "[payment-credit] PASS: original hash absent; replacement funded real recipient; wallet reports the actual amount"
    );
  } finally {
    for (const wallet of wallets) await wallet.close().catch(() => undefined);
    if (stack) {
      await sleep(2500);
      let returnedWei = 0n;
      for (const wallet of wallets) {
        for (const key of [
          wallet.handle.mainPrivateKey,
          wallet.handle.identity.toPrivateKeyHex(),
        ]) {
          if (!key) continue;
          const signer = new Wallet(key, provider);
          try {
            const held = await provider.getBalance(signer.address);
            const gasPrice = BigInt(await provider.send("eth_gasPrice", []));
            const fee = gasPrice * 21_000n;
            if (held <= fee) continue;
            const sent = await signer.sendTransaction({
              to: monadOf(stack).faucetAddress,
              value: held - fee,
              type: 0,
              gasPrice,
              gasLimit: 21_000n,
            });
            assert.equal((await sent.wait(1, 30_000))?.status, 1);
            returnedWei += held - fee;
          } catch (error) {
            console.warn(
              `[payment-credit] sweep unresolved for ${signer.address}: ${
                error instanceof Error
                  ? error.message.split("\n")[0]
                  : "unknown"
              }`
            );
          }
        }
      }
      console.log(
        `[payment-credit] fundedWei=${
          10n * STAKE
        } returnedWei=${returnedWei} recipientResidualWei=${
          recipient ? await provider.getBalance(recipient) : 0n
        } payerResidualWei=${
          payer ? await provider.getBalance(payer) : 0n
        }; remaining pool/coin state preserved at ${stack.stateDir}`
      );
    }
    await stack?.stop();
    provider.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      "[payment-credit] FAILED:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  });
}
