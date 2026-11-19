import {
  branchLeaf,
  decodeAddress,
  encodeKeyhashAddress,
  keyhashOf,
  keyhashProgram,
  LotusV2UnsupportedNetworkError,
  nativeTransactionId,
  nativeTransactionSize,
  requireLotusV2Network,
  signNativeTransaction,
  toHex,
  xOnlyPublicKey,
} from "./native";
import { LotusV2Wallet, lotusV2NetworkOf, memoryLotusV2WalletStore } from "./wallet";

const scalar = (n: number) => {
  const secret = new Uint8Array(32);
  secret[31] = n;
  return secret;
};

describe("Lotus v2 native codec", () => {
  it("reproduces the type-1 address vector of docs/lotus-v2/addresses.md (public scalar 1)", () => {
    const xOnly = xOnlyPublicKey(scalar(1));
    expect(toHex(xOnly)).toBe("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    const keyhash = keyhashOf(xOnly);
    expect(toHex(keyhash)).toBe("f9f2a0b353f482f415281da3a00929d08a7d9a6498054f5ef6623b5580e607f7");
    expect(toHex(branchLeaf(keyhashProgram(keyhash)))).toBe(
      "84f3ac422780d391bc9210fa6e19dc8d0fd2bb1acd390e065c6a0acda9f667bb"
    );
    const address = encodeKeyhashAddress("regtest", keyhash);
    expect(address).toBe("rxpi1pl8e2pv6n7jp0g9fgrk36qzff6z98mxnynqz57hhkvga4tq8xqlmsq2859j5u");
    expect(decodeAddress("regtest", address)).toEqual({
      type: 1,
      keyhash: toHex(keyhash),
      root: "84f3ac422780d391bc9210fa6e19dc8d0fd2bb1acd390e065c6a0acda9f667bb",
    });
    expect(decodeAddress("regtest", address.toUpperCase()).root).toBe(
      "84f3ac422780d391bc9210fa6e19dc8d0fd2bb1acd390e065c6a0acda9f667bb"
    );
  });

  it("rejects malformed addresses with the reference reasons", () => {
    const good = "rxpi1pl8e2pv6n7jp0g9fgrk36qzff6z98mxnynqz57hhkvga4tq8xqlmsq2859j5u";
    expect(() => decodeAddress("regtest", good.slice(0, 10) + good.slice(10).toUpperCase())).toThrow("mixed case");
    expect(() => decodeAddress("regtest", "ecregtest:qq")).toThrow("unknown prefix");
    expect(() => decodeAddress("regtest", good.slice(0, -1))).toThrow("bad length");
    const flipped = good.slice(0, 20) + (good[20] === "q" ? "p" : "q") + good.slice(21);
    expect(() => decodeAddress("regtest", flipped)).toThrow("bad checksum");
  });

  it("the id recomputed from the signed bytes is the id it was signed under, and the size is exact", () => {
    const destination = decodeAddress("regtest", encodeKeyhashAddress("regtest", keyhashOf(xOnlyPublicKey(scalar(2)))));
    const tx = signNativeTransaction({
      network: "regtest",
      inputs: [
        { txid: "11".repeat(32), outIdx: 0, value: 10_000_000n, secret: scalar(1) },
        { txid: "22".repeat(32), outIdx: 3, value: 5_000_000n, secret: scalar(3) },
      ],
      outputs: [
        { value: 12_000_000n, root: destination.root },
        { value: 2_999_000n, root: destination.root },
      ],
    });
    expect(tx.size).toBe(nativeTransactionSize(2, 2));
    expect(tx.raw.length / 2).toBe(tx.size);
    expect(nativeTransactionId("regtest", tx.raw)).toBe(tx.txid);
  });
});

describe("Lotus v2 is regtest-only (owner rule 2026-11-19)", () => {
  it("the codec refuses any other network explicitly", () => {
    for (const network of ["mainnet", "testnet", "devnet", ""]) {
      expect(() => requireLotusV2Network(network)).toThrow(LotusV2UnsupportedNetworkError);
      expect(() =>
        signNativeTransaction({
          network: network as "regtest",
          inputs: [{ txid: "11".repeat(32), outIdx: 0, value: 1_000_000n, secret: scalar(1) }],
          outputs: [{ value: 900_000n, root: "22".repeat(32) }],
        })
      ).toThrow(LotusV2UnsupportedNetworkError);
      expect(() => encodeKeyhashAddress(network as "regtest", new Uint8Array(32))).toThrow(
        LotusV2UnsupportedNetworkError
      );
    }
  });

  it("a well-formed mainnet or testnet address is unsupported, not malformed", () => {
    // Mainnet type-0 example from addresses.md.
    expect(() =>
      decodeAddress("regtest", "xpi1q80z6tf5zlwd794z4dpe28fehp3qdt2lg8q3jz3mzacmrqw20vseq37xlywnx")
    ).toThrow(LotusV2UnsupportedNetworkError);
    expect(() => decodeAddress("regtest", "txpi1" + "q".repeat(61))).toThrow(LotusV2UnsupportedNetworkError);
  });

  it("the wallet opens only for the Lotus v2 regtest registry row", async () => {
    expect(lotusV2NetworkOf("lotus-v2-regtest")).toBe("regtest");
    for (const chainIdentifier of ["xpi-mainnet", "xpi-testnet", "xpi-regtest", "xec-regtest", "monad-regtest", "lotus-v2-mainnet", "evm"]) {
      expect(() => lotusV2NetworkOf(chainIdentifier)).toThrow(LotusV2UnsupportedNetworkError);
      const indexer = {
        listUnspent: jest.fn(),
        hasHistory: jest.fn(),
        transactionState: jest.fn(),
        broadcast: jest.fn(),
        blockHash: jest.fn(),
      };
      await expect(
        LotusV2Wallet.create({
          chainIdentifier,
          seed: new Uint8Array(32).fill(9),
          indexer,
          storeFor: () => memoryLotusV2WalletStore(),
          checkpoint: { height: 1, hash: "00".repeat(32) },
        })
      ).rejects.toThrow(LotusV2UnsupportedNetworkError);
      // Refused before anything was read or derived.
      expect(indexer.blockHash).not.toHaveBeenCalled();
    }
  });
});
