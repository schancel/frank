import { decodeRlp, encodeRlp, Wallet } from "ethers";
import {
  decodeSignedTempoTransaction,
  encodeSignedTempoTransaction,
  tempoPathUsdMaximumFee,
  tempoSigningHash,
} from "./tempo-transaction";
import type { TempoTransaction } from "./tempo-transaction";

const sender = new Wallet(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
);

it("matches the upstream Tempo Go secp256k1 transaction vector exactly", () => {
  // tempoxyz/tempo-go pkg/transaction/transaction_vectors_test.go, minimal_transaction.
  const tx: TempoTransaction = {
    chainId: 1n,
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 2_000_000_000n,
    gasLimit: 21_000n,
    calls: [
      {
        to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        value: 0n,
        data: "0x",
      },
    ],
    nonce: 0n,
    feeToken: "0x0000000000000000000000000000000000000000",
  };
  const signed = encodeSignedTempoTransaction(
    tx,
    sender.signingKey.sign(tempoSigningHash(tx)),
    sender.address
  );
  expect(signed.rawTransaction).toBe(
    "0x76f87201843b9aca008477359400825208d8d79470997970c51812dc3a010c7d01b50e0d17dc79c88080c0808080808080c0b8415699d8feb5ace056f1c1e93c420f53942e7b9f31058cb2a2bb26550e5930ef1a55f6bdd3a27105268536dfe17f386d79f6c8b949698d105838455a20a857c33801"
  );
  expect(decodeSignedTempoTransaction(signed.rawTransaction, 1n)).toMatchObject(
    {
      sender: sender.address,
      transactionHash: signed.transactionHash,
    }
  );
  expect(() =>
    decodeSignedTempoTransaction(signed.rawTransaction, 42431n)
  ).toThrow("belongs to another chain");

  const malformed = decodeRlp(`0x${signed.rawTransaction.slice(4)}`);
  if (!Array.isArray(malformed)) throw new Error("Invalid test vector");
  malformed[4] = "0x";
  expect(() =>
    decodeSignedTempoTransaction(`0x76${encodeRlp(malformed).slice(2)}`, 1n)
  ).toThrow("Invalid Tempo calls");
});

it("charges PathUSD six decimal units and rounds fee holds upward", () => {
  expect(tempoPathUsdMaximumFee(100_000n, 2_000_000_000n)).toBe(200n);
  expect(tempoPathUsdMaximumFee(1n, 1n)).toBe(1n);
  expect(tempoPathUsdMaximumFee(0n, 1n)).toBe(0n);
});

it("rejects a signature from a different spending account", () => {
  const tx: TempoTransaction = {
    chainId: 42431n,
    maxPriorityFeePerGas: 1n,
    maxFeePerGas: 2n,
    gasLimit: 65_000n,
    calls: [
      {
        to: "0x20c0000000000000000000000000000000000000",
        value: 0n,
        data: "0x",
      },
    ],
    nonce: 0n,
    feeToken: "0x20c0000000000000000000000000000000000000",
  };
  expect(() =>
    encodeSignedTempoTransaction(
      tx,
      sender.signingKey.sign(tempoSigningHash(tx)),
      "0x2222222222222222222222222222222222222222"
    )
  ).toThrow("does not match");
  expect(() => tempoSigningHash({ ...tx, chainId: 0n })).toThrow(
    "chain and gas limit must be positive"
  );
  expect(() => tempoSigningHash({ ...tx, gasLimit: 0n })).toThrow(
    "chain and gas limit must be positive"
  );
  expect(() =>
    tempoSigningHash({ ...tx, nonceKey: (1n << 256n) - 1n })
  ).toThrow("requires validBefore");
});
