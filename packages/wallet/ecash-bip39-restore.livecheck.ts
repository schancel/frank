import { createNativeEcashOperationStore } from './storage/ecash-operations/native';
/** Read-only proof against a real relay's Chronik route; synthetic public phrase only.
 * Run: yarn tsx packages/wallet/ecash-bip39-restore.livecheck.ts http://127.0.0.1:<relay-port>
 * No transactions are signed, broadcast, or funded. The indexer must actually be reachable.
 */
import assert from "node:assert/strict";
import { mnemonicToSeedSync } from "bip39";
import { ChronikClient } from "chronik-client";
import { HDNodeWallet, getBytes } from "ethers";
import { encodeCashAddress } from "ecashaddrjs";
import { ripemd160 } from "@noble/hashes/ripemd160.js";
import { sha256 } from "@noble/hashes/sha256.js";
import { BIP39_DERIVATION } from "../domain-roots/src";
import { EcashWallet } from "./ecash-wallet";
import { InMemoryNativeTransactionAttemptStore } from "./chain/chain-wallet";

async function main() {
  const base = process.argv[2];
  if (!base || !/^https?:\/\//.test(base))
    throw new Error("Pass the real relay HTTP base URL");
  const seed = new Uint8Array(
    mnemonicToSeedSync(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    )
  );
  try {
    const node = HDNodeWallet.fromSeed(seed).derivePath("m/44'/1899'/0'/0/0");
    const expected = encodeCashAddress(
      "ectest",
      "p2pkh",
      ripemd160(sha256(getBytes(node.publicKey)))
    );
    const wallet = await EcashWallet.fromDerivationMaterial({
  operationStoreFactory: binding => createNativeEcashOperationStore({
    ...binding, rootLocation: process.env.ECASH_OPERATION_STORE_ROOT!,
  }),
      material: { derivation: BIP39_DERIVATION, seed },
      chronik: new ChronikClient([
        `${base.replace(/\/$/, "")}/chain-rpc/xec-testnet/chronik`,
      ]),
      networkId: "xec-testnet",
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    });
    assert.equal(wallet.identity.address.raw, expected);
    const balance = await wallet.getBalance();
    assert.equal(typeof balance, "bigint");
    console.log(
      JSON.stringify({
        network: "xec-testnet",
        derivedAddressMatches: true,
        indexerReadSucceeded: true,
        balance: balance.toString(),
      })
    );
  } finally {
    seed.fill(0);
  }
}
main().catch(() => {
  console.error("Real eCash restoration/indexer read failed");
  process.exitCode = 1;
});
