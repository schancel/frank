// The app injects this same Buffer browser polyfill in quasar.config.js.
import { Buffer } from "buffer";
/** Actual EcashWallet/SDK with public synthetic Chronik replies and disposable browser storage. */
import { EcashWallet, ECASH_MAINNET_CHECKPOINT_HASH } from "../../ecash-wallet";
import { createEcashSeedBackend } from "../../ecash-seed-boundary";
import { InMemoryNativeTransactionAttemptStore } from "../../chain/chain-wallet";
import { createBrowserEcashOperationStore } from "./browser";
import { HdNode, shaRmd160, Address } from "ecash-lib";
import { bytesToHex } from "@noble/hashes/utils";

export async function runHost() {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
  const root = {
    registry: "frank-domain-roots-v1" as const,
    purpose: "ecash-bch-wallet" as const,
    bytes: new Uint8Array(32).fill(9),
  };
  const firstPkh = bytesToHex(
    shaRmd160(
      HdNode.fromSeed(root.bytes).derivePath("m/44'/1899'/0'/0/0").pubkey()
    )
  );
  const coins = Array.from({ length: 4 }, (_, i) => ({
    outpoint: { txid: (i + 1).toString(16).padStart(64, "0"), outIdx: i },
    sats: 10000n,
    blockHeight: 800000,
    isCoinbase: false,
    isFinal: true,
  }));
  const chronik = {
    proxyInterface: () => ({
      getEndpointArray: () => [{ url: "http://synthetic.invalid" }],
    }),
    blockchainInfo: async () => ({ tipHeight: 900000 }),
    batchSummary: async (scripts: Array<{ payload: string }>) =>
      scripts.map((s) => ({
        numTxs: s.payload === firstPkh ? 1 : 0,
        numUtxos: s.payload === firstPkh ? coins.length : 0,
      })),
    batchUtxos: async (scripts: Array<{ payload: string }>) =>
      scripts.map((s) => ({
        utxos: {
          outputScript: "76a914" + s.payload + "88ac",
          utxos: s.payload === firstPkh ? coins : [],
        },
      })),
    broadcastTx: async () => {
      throw new Error("No broadcast permitted in host fixture");
    },
  };
  const open = () =>
    EcashWallet.fromDomainRoot({
      domainRoot: root,
      networkId: "xec-mainnet",
      chronik: chronik as never,
      walletFactory: createEcashSeedBackend,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      operationStoreFactory: (binding) =>
        createBrowserEcashOperationStore({
          ...binding,
          namespace: "host-qualification",
        }),
      checkpointClientFactory: () => ({
        block: async () =>
          ({
            blockInfo: { hash: ECASH_MAINNET_CHECKPOINT_HASH },
          } as never),
      }),
    });
  const wallets = await Promise.all([open(), open()]);
  try {
    const recipient = {
      raw: Address.p2pkh(new Uint8Array(20).fill(31), "ecash").toString(),
    };
    const [left, right] = await Promise.all(
      wallets.map((wallet, i) =>
        wallet.prepareNativeOperation({
          operationId: "browser-host-" + i,
          recipient,
          value: 1000n,
          maxFee: 1000n,
        })
      )
    );
    const keys = (operation: typeof left) =>
      operation.inputs.map((input) => `${input.txid}:${input.vout}`);
    if (keys(left).some((key) => keys(right).includes(key)))
      throw new Error("Exact reserved outpoint selected twice");
    if ((await wallets[0].getEcashOperations()).length !== 2)
      throw new Error("Independent handle lacks fresh reservations");
    await Promise.all(wallets.map((wallet) => wallet.close()));
    const reopened = await open();
    try {
      const next = await reopened.prepareNativeOperation({
        operationId: "browser-host-reopen",
        recipient,
        value: 1000n,
        maxFee: 1000n,
      });
      if (
        keys(next).some((key) => [...keys(left), ...keys(right)].includes(key))
      )
        throw new Error("Reopen selected reserved outpoint");
      if ((await reopened.getEcashOperations()).length !== 3)
        throw new Error("Restart ledger lost original claims");
    } finally {
      await reopened.close();
    }
    return {
      checks: [
        "actual SDK/wallet + strict IndexedDB",
        "two handles exclude exact reserved outpoints under canonical lock",
        "reopened wallet preserves original reservations",
      ],
    };
  } finally {
    await Promise.all(wallets.map((wallet) => wallet.close()));
  }
}
