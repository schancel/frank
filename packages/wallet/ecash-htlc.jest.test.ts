import { execFileSync } from "child_process";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { HDNodeWallet } from "ethers";
import {
  XEC_HTLC_SPEND_FEE_SATS,
  buildXecHtlcSpend,
  extractXecHtlcPreimage,
  findXecHtlcPreimage,
  xecHtlcAddress,
  xecHtlcFundingValue,
  xecHtlcLockOperationId,
  xecHtlcOutputScript,
  xecHtlcRedeemScript,
  type XecHtlcTerms,
} from "./ecash-htlc";
import {
  XEC_HTLC_KEY_LABEL,
  deriveXecHtlcSecretKey,
  xecHtlcKeyInfo,
  xecHtlcKeyRoot,
} from "./ecash-htlc-keys";
import { Address } from "ecash-lib/dist/address/address";
import { XEC_TESTNET, parseTransaction } from "@frank/nakamoto";
import { ripemd160 } from "@noble/hashes/ripemd160";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const shaRmd160 = (data: Uint8Array) => ripemd160(sha256(data));
/** Independent parse of the signed bytes (ecash-lib's Tx needs WASM, which Jest cannot load). */
const Tx = {
  fromHex(raw: string) {
    const parsed = parseTransaction(bytes(raw), XEC_TESTNET);
    if (!parsed.ok) throw new Error("unparseable eCash transaction");
    const tx = parsed.value;
    return {
      version: tx.version,
      locktime: tx.locktime,
      inputs: tx.inputs.map((input) => ({
        sequence: input.sequence,
        script: { bytecode: input.scriptSig },
      })),
      outputs: tx.outputs.map((output) => ({ sats: output.value })),
    };
  },
};

/** Pinned vector of the explicit derivation frank/xec-htlc-key/v1 (ecash-htlc-keys.ts). */
const VECTOR = {
  domainRoot: "07".repeat(32),
  chainIdentifier: "xec-testnet",
  swapId: "11".repeat(32),
  claimPublicKey:
    "0205645c990147a288339fd6b31574a0bac3b0c8cc757ac7fc9d91930fe59c0405",
  refundPublicKey:
    "03fcf38399671855327d25b3880dad68594c2d86c6560e9925c05c45f39b401ac9",
  regtestClaimPublicKey:
    "03fe9e0bbeef5ddd2e5ee17cba7d1b3abcf1fc1d5cff41cca809e68ee2ecddd3c2",
};

/** The XEC account secret key, independently of ecash-lib: ethers BIP32 at m/44'/1899'/0'. */
function accountSecretKey(domainRoot: string): Uint8Array {
  return bytes(
    HDNodeWallet.fromSeed(bytes(domainRoot))
      .derivePath("m/44'/1899'/0'")
      .privateKey.slice(2)
  );
}

const preimage = new Uint8Array(32).fill(0x42);
const claimKey = new Uint8Array(32).fill(0x01);
const refundKey = new Uint8Array(32).fill(0x02);
const terms: XecHtlcTerms = {
  hashLock: sha256(preimage),
  claimPublicKey: secp256k1.getPublicKey(claimKey, true),
  refundPublicKey: secp256k1.getPublicKey(refundKey, true),
  refundTime: 1_800_000_000,
};
const FUNDING = { txid: "ab".repeat(32), vout: 1 };
const signer = (key: Uint8Array) => (digest: Uint8Array) =>
  secp256k1.sign(digest, key, { lowS: true }).toDERRawBytes();

describe("eCash HTLC script", () => {
  it("is exactly the documented redeem script", () => {
    const script = hex(xecHtlcRedeemScript(terms));
    // 1_800_000_000 = 0x6b49d200, minimal little-endian script number 00d2496b.
    expect(script).toBe(
      "63" +
        "82" +
        "0120" +
        "88" +
        "a8" +
        "20" +
        hex(terms.hashLock) +
        "88" +
        "21" +
        hex(terms.claimPublicKey) +
        "67" +
        "0400d2496b" +
        "b1" +
        "75" +
        "21" +
        hex(terms.refundPublicKey) +
        "68" +
        "ac"
    );
    expect(hex(xecHtlcOutputScript(terms))).toMatch(/^a914[0-9a-f]{40}87$/);
  });

  it("pays to a P2SH address with the registry prefix of the chain", () => {
    expect(xecHtlcAddress("xec-testnet", terms)).toMatch(/^ectest:p/);
    expect(xecHtlcAddress("xec-regtest", terms)).toMatch(/^ecregtest:p/);
    expect(xecHtlcAddress("xec-mainnet", terms)).toMatch(/^ecash:p/);
    expect(() => xecHtlcAddress("monad-testnet", terms)).toThrow(
      /not a supported eCash network/
    );
    expect(() => xecHtlcAddress("ecash-testnet", terms)).toThrow();
    expect(() => xecHtlcAddress("bch-testnet", terms)).toThrow();
  });

  it("refuses malformed terms", () => {
    expect(() =>
      xecHtlcRedeemScript({ ...terms, hashLock: new Uint8Array(31) })
    ).toThrow(/hash lock/);
    expect(() =>
      xecHtlcRedeemScript({ ...terms, refundTime: 499_999_999 })
    ).toThrow(/refund time/);
    expect(() =>
      xecHtlcRedeemScript({ ...terms, refundTime: 2 ** 32 })
    ).toThrow(/refund time/);
    expect(() =>
      xecHtlcRedeemScript({ ...terms, claimPublicKey: terms.refundPublicKey })
    ).toThrow(/differ/);
    expect(() =>
      xecHtlcRedeemScript({
        ...terms,
        claimPublicKey: Uint8Array.from([0x04, ...new Uint8Array(32)]),
      })
    ).toThrow(/compressed/);
  });

  it("names the funding value and lock operation", () => {
    expect(xecHtlcFundingValue(10_000n)).toBe(11_000n);
    expect(() => xecHtlcFundingValue(545n)).toThrow(RangeError);
    expect(xecHtlcLockOperationId("ab".repeat(32))).toBe(
      `swap:${"ab".repeat(32)}:xec-lock`
    );
    expect(() => xecHtlcLockOperationId("AB".repeat(32))).toThrow();
  });
});

describe("eCash HTLC spends", () => {
  const destination = Address.p2pkh(
    shaRmd160(terms.claimPublicKey),
    "ectest"
  ).toString();
  const base = {
    chainIdentifier: "xec-testnet",
    terms,
    funding: FUNDING,
    principalSats: 10_000n,
    destination,
  };

  it("claim: one input, one output of exactly principal, nLockTime 0, final sequence", () => {
    const spend = buildXecHtlcSpend({
      ...base,
      branch: "claim",
      preimage,
      sign: signer(claimKey),
    });
    const tx = Tx.fromHex(spend.rawTx);
    expect(tx.version).toBe(2);
    expect(tx.locktime).toBe(0);
    expect(tx.inputs).toHaveLength(1);
    expect(tx.inputs[0].sequence).toBe(0xffffffff);
    expect(tx.outputs).toHaveLength(1);
    expect(tx.outputs[0].sats).toBe(10_000n);
    expect(xecHtlcFundingValue(10_000n) - tx.outputs[0].sats).toBe(
      XEC_HTLC_SPEND_FEE_SATS
    );
    // Deterministic: a second signing yields the same bytes and txid.
    expect(
      buildXecHtlcSpend({
        ...base,
        branch: "claim",
        preimage,
        sign: signer(claimKey),
      })
    ).toEqual(spend);
    const script = tx.inputs[0].script!.bytecode;
    expect(hex(extractXecHtlcPreimage(script, terms)!)).toBe(hex(preimage));
    expect(hex(extractXecHtlcPreimage(hex(script), terms)!)).toBe(
      hex(preimage)
    );
    // Same script against other terms reveals nothing.
    expect(
      extractXecHtlcPreimage(script, {
        ...terms,
        refundTime: terms.refundTime + 1,
      })
    ).toBeUndefined();
  });

  it("refund: nLockTime T_A and a non-final sequence; reveals no preimage", () => {
    const spend = buildXecHtlcSpend({
      ...base,
      branch: "refund",
      sign: signer(refundKey),
    });
    const tx = Tx.fromHex(spend.rawTx);
    expect(tx.locktime).toBe(terms.refundTime);
    expect(tx.inputs[0].sequence).toBe(0xfffffffe);
    expect(tx.outputs.map((o) => o.sats)).toEqual([10_000n]);
    expect(
      extractXecHtlcPreimage(tx.inputs[0].script!.bytecode, terms)
    ).toBeUndefined();
  });

  it("refuses a wrong preimage, a wrong key and a destination on another network", () => {
    expect(() =>
      buildXecHtlcSpend({
        ...base,
        branch: "claim",
        preimage: new Uint8Array(32),
        sign: signer(claimKey),
      })
    ).toThrow(/hash lock/);
    expect(() =>
      buildXecHtlcSpend({
        ...base,
        branch: "claim",
        preimage: new Uint8Array(33),
        sign: signer(claimKey),
      })
    ).toThrow(/32 bytes/);
    expect(() =>
      buildXecHtlcSpend({
        ...base,
        branch: "claim",
        preimage,
        sign: signer(refundKey),
      })
    ).toThrow(/branch key/);
    expect(() =>
      buildXecHtlcSpend({
        ...base,
        branch: "refund",
        preimage,
        sign: signer(refundKey),
      })
    ).toThrow(/no preimage/);
    expect(() =>
      buildXecHtlcSpend({
        ...base,
        destination: xecHtlcAddress("xec-regtest", terms),
        branch: "refund",
        sign: signer(refundKey),
      })
    ).toThrow(/another network/);
  });

  it("reads the preimage through Chronik spentBy, and nothing while unspent", async () => {
    const claim = buildXecHtlcSpend({
      ...base,
      branch: "claim",
      preimage,
      sign: signer(claimKey),
    });
    const inputScript = hex(Tx.fromHex(claim.rawTx).inputs[0].script!.bytecode);
    const outputScript = hex(xecHtlcOutputScript(terms));
    const chronik = (spent: boolean) => ({
      tx: async (txid: string) =>
        txid === FUNDING.txid
          ? {
              outputs: [
                { outputScript: "6a" },
                {
                  outputScript,
                  ...(spent
                    ? { spentBy: { txid: claim.txid, outIdx: 0 } }
                    : {}),
                },
              ],
            }
          : {
              inputs: [
                {
                  prevOut: { txid: FUNDING.txid, outIdx: FUNDING.vout },
                  inputScript,
                },
              ],
            },
    });
    type Client = Parameters<typeof findXecHtlcPreimage>[0];
    expect(
      hex(
        (await findXecHtlcPreimage(
          chronik(true) as unknown as Client,
          FUNDING,
          terms
        ))!
      )
    ).toBe(hex(preimage));
    expect(
      await findXecHtlcPreimage(
        chronik(false) as unknown as Client,
        FUNDING,
        terms
      )
    ).toBeUndefined();
    await expect(
      findXecHtlcPreimage(
        chronik(true) as unknown as Client,
        { ...FUNDING, vout: 0 },
        terms
      )
    ).rejects.toThrow(/another script/);
  });
});

describe("explicit derivation frank/xec-htlc-key/v1", () => {
  it("matches the pinned vector", () => {
    expect(XEC_HTLC_KEY_LABEL).toBe("frank/xec-htlc-key/v1");
    expect(hex(xecHtlcKeyInfo("xec-testnet", "11".repeat(32), "claim"))).toBe(
      "0b" +
        Buffer.from("xec-testnet").toString("hex") +
        "11".repeat(32) +
        Buffer.from("claim").toString("hex")
    );
    const root = xecHtlcKeyRoot(accountSecretKey(VECTOR.domainRoot));
    const pub = (chain: string, role: "claim" | "refund") =>
      hex(
        secp256k1.getPublicKey(
          deriveXecHtlcSecretKey(root, chain, VECTOR.swapId, role),
          true
        )
      );
    expect({
      claimPublicKey: pub(VECTOR.chainIdentifier, "claim"),
      refundPublicKey: pub(VECTOR.chainIdentifier, "refund"),
      regtestClaimPublicKey: pub("xec-regtest", "claim"),
    }).toEqual({
      claimPublicKey: VECTOR.claimPublicKey,
      refundPublicKey: VECTOR.refundPublicKey,
      regtestClaimPublicKey: VECTOR.regtestClaimPublicKey,
    });
    // Another swap id gives another key.
    expect(
      hex(
        secp256k1.getPublicKey(
          deriveXecHtlcSecretKey(
            root,
            VECTOR.chainIdentifier,
            "12".repeat(32),
            "claim"
          ),
          true
        )
      )
    ).not.toBe(VECTOR.claimPublicKey);
  });

  it("is what two EcashWallet instances of one root expose, and signs identical spends", () => {
    // Real SDK in a subprocess (Jest cannot load its WASM ESM glue); no socket is opened.
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        `
      const assert = require('node:assert/strict');
      const { EcashWallet, ECASH_TESTNET_CHECKPOINT_HASH } = require('./ecash-wallet.ts');
      const { InMemoryNativeTransactionAttemptStore } = require('./chain/chain-wallet.ts');
      const { InMemoryEcashOperationStore } = require('./ecash-operation-store.ts');
      const htlc = require('./ecash-htlc.ts');
      const { secp256k1 } = require('@noble/curves/secp256k1');
      const { sha256 } = require('@noble/hashes/sha256');
      const hex = b => Buffer.from(b).toString('hex');
      const chronik = {
        blockchainInfo: async () => ({ tipHeight: 1500000 }),
        proxyInterface: () => ({ getEndpointArray: () => [{ url: 'http://127.0.0.1:1' }] }),
        batchSummary: async scripts => scripts.map(() => ({ numTxs: 0, numUtxos: 0 })),
        batchUtxos: async scripts => scripts.map(s => ({ utxos: { outputScript: '76a914' + s.payload + '88ac', utxos: [] } })),
      };
      const open = () => EcashWallet.fromDomainRoot({
        domainRoot: { registry: 'frank-domain-roots-v1', purpose: 'ecash-bch-wallet', bytes: Buffer.from('${VECTOR.domainRoot}', 'hex') },
        networkId: 'xec-testnet', chronik,
        checkpointClientFactory: () => ({ block: async () => ({ blockInfo: { hash: ECASH_TESTNET_CHECKPOINT_HASH } }) }),
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        operationStore: new InMemoryEcashOperationStore(),
      });
      (async () => {
        const [a, b] = [await open(), await open()];
        const swapId = '${VECTOR.swapId}';
        const claim = hex(a.htlcPublicKey(swapId, 'claim'));
        const refund = hex(a.htlcPublicKey(swapId, 'refund'));
        assert.equal(hex(b.htlcPublicKey(swapId, 'claim')), claim);
        const preimage = new Uint8Array(32).fill(0x42);
        const terms = { hashLock: sha256(preimage), claimPublicKey: a.htlcPublicKey(swapId, 'claim'),
          refundPublicKey: secp256k1.getPublicKey(new Uint8Array(32).fill(9), true), refundTime: 1800000000 };
        const params = { swapId, terms, funding: { txid: 'cd'.repeat(32), vout: 0 }, principalSats: 5000n, branch: 'claim', preimage };
        const one = a.signHtlcSpend(params), two = b.signHtlcSpend(params);
        assert.deepEqual(one, two);
        assert.throws(() => a.signHtlcSpend({ ...params, branch: 'refund', preimage: undefined }), /does not hold the refund key/);
        console.log(JSON.stringify({ claim, refund, txid: one.txid }));
      })().catch(e => { console.error(e); process.exit(1); });
      `,
      ],
      {
        cwd: __dirname,
        env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.jest.json" },
        encoding: "utf8",
      }
    );
    const result = JSON.parse(output.trim().split("\n").at(-1)!);
    expect(result.claim).toBe(VECTOR.claimPublicKey);
    expect(result.refund).toBe(VECTOR.refundPublicKey);
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);
});
