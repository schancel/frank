/**
 * The real eCash SDK wallet on eCash testnet, through a real relay's Chronik proxy.
 *
 *   FRANK_LIVE_RELAY_URL=http://127.0.0.1:8098 node --import tsx ecash-wallet.livecheck.ts
 *
 * Jest cannot load the SDK's WASM glue, so `utxo-chains.live.jest.test.ts` runs this file in a
 * Node subprocess and checks the one JSON line it prints. FRANK_LIVE_UTXO_SEED_HEX keeps one
 * wallet across runs; with FRANK_LIVE_SEND=1 and a funded wallet it sends 10 XEC to itself.
 */
import { ChronikClient } from "chronik-client";
import { encodeCashAddress } from "ecashaddrjs";
import { getBytes, HDNodeWallet } from "ethers";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { createEcashChain } from "./chain/ecash-chain";
import { InMemoryNativeTransactionAttemptStore } from "./chain/chain-wallet";

async function main() {
  const relay = process.env.FRANK_LIVE_RELAY_URL?.replace(/\/+$/, "");
  if (!relay) throw new Error("FRANK_LIVE_RELAY_URL is required");
  const seedHex = process.env.FRANK_LIVE_UTXO_SEED_HEX;
  const bytes = seedHex
    ? Uint8Array.from(Buffer.from(seedHex, "hex"))
    : crypto.getRandomValues(new Uint8Array(32));
  const chronik = new ChronikClient([`${relay}/chain-rpc/xec-testnet/chronik`]);
  const chain = createEcashChain({
    networkId: "xec-testnet",
    chronik,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  });
  // Opening the wallet checks the chain's checkpoint block through the relay.
  const wallet = await chain.createWallet({
    registry: "frank-domain-roots-v1",
    purpose: "ecash-bch-wallet",
    bytes,
  });
  const address = (await wallet.getReceiveAddress()).raw;
  const balance = await wallet.getBalance();
  // The address the app showed as the eCash deposit address before it had this wallet
  // (app/src/accounts/session.ts: m/44'/1899'/0'/0/0 of the same root). It must be the wallet's
  // first address, so money already sent there is this wallet's money.
  const legacyNode = HDNodeWallet.fromSeed(bytes).derivePath("m/44'/1899'/0'/0/0");
  const legacyAddress = encodeCashAddress(
    "ectest",
    "p2pkh",
    ripemd160(sha256(getBytes(legacyNode.publicKey)))
  );
  const result: Record<string, unknown> = {
    firstAddress: wallet.identity.displayAddress,
    addressShownBefore: legacyAddress,
    address,
    balance: balance.toString(),
    parses: chain.parseAddress(address)?.raw === address,
    walletChain: wallet.chainIdentifier,
    chain: chain.chainIdentifier,
  };
  if (balance === 0n) {
    // An empty wallet cannot pay: the SDK refuses to build, so nothing is signed or broadcast.
    try {
      await chain.nativeTransfers.send({
        wallet,
        recipient: { raw: address },
        value: 1_000n,
      });
      result.emptySend = "sent";
    } catch (error) {
      result.emptySend = error instanceof Error ? error.message : String(error);
    }
    result.unresolved = wallet.getUnresolvedNativeTransaction() ?? null;
  } else if (process.env.FRANK_LIVE_SEND === "1") {
    const sent = await chain.nativeTransfers.send({
      wallet,
      recipient: { raw: address },
      value: 1_000n,
    });
    result.sent = sent.txHash;
    result.status = await chain.nativeTransfers.getTransactionStatus({
      wallet,
      transaction: sent,
    });
    result.balanceAfter = (await wallet.getBalance()).toString();
    result.nextAddress = (await wallet.getReceiveAddress()).raw;
  }
  console.log(JSON.stringify(result));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
