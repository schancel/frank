/**
 * The funded send check for one UTXO testnet, through a real relay.
 *
 *   FRANK_LIVE_RELAY_URL=http://127.0.0.1:8098 FRANK_UTXO_TEST_SEED_FILE=<file with 64 hex> \
 *     node --import tsx utxo-funded-send.livecheck.ts <xec-testnet|btc-testnet|bch-testnet>
 *
 * Unfunded, it prints the wallet's address to fund and exits 2. Funded, it sends a small amount
 * to the wallet's next unused receive address, waits until the indexer shows the transaction and
 * the new coin, and exits 0. Any failure exits 1. Wallet state (next indices, a send whose
 * outcome is unknown) is kept beside the seed file, so a rerun finishes an interrupted send
 * instead of paying again. The seed file is a secret: keep it out of the repository.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import type {
  ChainTransaction,
  NativeTransactionAttemptStore,
} from "./chain/chain-wallet";
import { getChainRegistryEntry } from "./chain/chains-registry";
import { createEcashChain } from "./chain/ecash-chain";
import { ElectrumClient } from "./chain/electrum-client";
import { electrumIndexer, relayElectrumUrl } from "./chain/electrum-indexer";
import { createUtxoChain } from "./chain/utxo-chain";
import { ChronikClient } from "chronik-client";

const AMOUNT: Record<string, bigint> = {
  "xec-testnet": 1_000n, // 10 XEC
  "btc-testnet": 2_000n,
  "bch-testnet": 2_000n,
};
const WAIT_MS = 120_000;

function fileAttemptStore(path: string): NativeTransactionAttemptStore {
  const read = (): Record<string, ChainTransaction> =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return {
    coordinationScope: "single-realm",
    get: (key) => read()[key],
    put: (key, transaction) =>
      writeFileSync(path, JSON.stringify({ ...read(), [key]: transaction })),
    delete: (key) => {
      const all = read();
      delete all[key];
      if (Object.keys(all).length === 0 && existsSync(path)) unlinkSync(path);
      else writeFileSync(path, JSON.stringify(all));
    },
  };
}

async function main(): Promise<number> {
  const chainIdentifier = process.argv[2];
  const relay = process.env.FRANK_LIVE_RELAY_URL?.replace(/\/+$/, "");
  const seedFile = process.env.FRANK_UTXO_TEST_SEED_FILE;
  const amount = AMOUNT[chainIdentifier];
  const entry = getChainRegistryEntry(chainIdentifier);
  if (!relay || !seedFile || amount === undefined || !entry?.wallet) {
    console.error(
      "usage: FRANK_LIVE_RELAY_URL=<relay> FRANK_UTXO_TEST_SEED_FILE=<file> node --import tsx utxo-funded-send.livecheck.ts <xec-testnet|btc-testnet|bch-testnet>"
    );
    return 1;
  }
  const seed = Uint8Array.from(
    Buffer.from(readFileSync(seedFile, "utf8").trim(), "hex")
  );
  if (seed.length !== 32) throw new Error("seed file must hold 64 hex characters");
  const stateFile = `${seedFile}.${chainIdentifier}.state.json`;

  let close = async () => undefined as void;
  let chain: {
    unit: string;
    toDisplayAmount(raw: bigint): string;
    nativeTransfers: ReturnType<typeof createEcashChain>["nativeTransfers"];
  };
  let wallet: Awaited<ReturnType<ReturnType<typeof createEcashChain>["createWallet"]>> | Awaited<ReturnType<ReturnType<typeof createUtxoChain>["createWallet"]>>;
  let seen: (txid: string) => Promise<boolean>;
  if (entry.wallet.indexer === "chronik") {
    const chronik = new ChronikClient([`${relay}/chain-rpc/${chainIdentifier}/chronik`]);
    const ecash = createEcashChain({
      networkId: chainIdentifier as "xec-testnet",
      chronik,
      nativeAttemptStore: fileAttemptStore(stateFile),
    });
    chain = ecash;
    wallet = await ecash.createWallet({
      registry: "frank-domain-roots-v1",
      purpose: "ecash-bch-wallet",
      bytes: seed,
    });
    seen = (txid) => chronik.tx(txid).then(() => true, () => false);
  } else {
    const client = new ElectrumClient({
      endpoints: [relayElectrumUrl(relay, chainIdentifier)],
      requestTimeoutMs: 30_000,
    });
    close = () => client.close();
    const indexer = electrumIndexer(client);
    const utxo = createUtxoChain({
      chainIdentifier,
      indexer,
      storeFor: () => ({
        load: () => (existsSync(stateFile) ? readFileSync(stateFile, "utf8") : undefined),
        save: (serialized) => writeFileSync(stateFile, serialized),
      }),
    });
    chain = utxo as typeof chain;
    wallet = await utxo.createWallet(seed);
    seen = (txid) => indexer.hasTransaction(txid);
  }

  try {
    const show = (raw: bigint) => `${chain.toDisplayAmount(raw)} ${chain.unit}`;
    const fundingAddress = wallet.identity.displayAddress;
    const before = await wallet.getBalance();
    console.log(`${chainIdentifier} test wallet: fund ${fundingAddress}`);
    console.log(`balance ${show(before)}`);
    if (before < amount * 2n) {
      console.error(
        `NOT FUNDED: send at least ${show(amount * 5n)} to ${fundingAddress} and run this again.`
      );
      return 2;
    }
    const recipient = await wallet.getReceiveAddress();
    console.log(`sending ${show(amount)} to this wallet's next unused address ${recipient.raw}`);
    const sent = await chain.nativeTransfers.send({
      wallet: wallet as never,
      recipient,
      value: amount,
    });
    console.log(`broadcast ${sent.txHash}; waiting for the indexer to show it`);
    const deadline = Date.now() + WAIT_MS;
    let shown = false;
    while (!shown && Date.now() < deadline) {
      shown = await seen(sent.txHash).catch(() => false);
      if (!shown) await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    if (!shown) {
      console.error(`FAILED: the indexer did not show ${sent.txHash} within ${WAIT_MS / 1000}s`);
      return 1;
    }
    const after = await wallet.getBalance();
    const next = await wallet.getReceiveAddress();
    const fee = before - after;
    if (after >= before || fee > amount || next.raw === recipient.raw) {
      console.error(
        `FAILED: balance ${show(before)} -> ${show(after)}, next address ${next.raw}: the send to self should cost only a fee and use up the address`
      );
      return 1;
    }
    console.log(`indexer shows ${sent.txHash}; balance ${show(before)} -> ${show(after)} (fee ${show(fee)})`);
    console.log(
      `OK: a funded send was observed on ${chainIdentifier}. Set wallet.send to true for "${chainIdentifier}" in packages/wallet/chain/chains-registry.ts (and its expectation in chains-registry.jest.test.ts).`
    );
    return 0;
  } finally {
    await close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("FAILED:", error);
    process.exit(1);
  }
);
