import {
  branchLeaf,
  decodeAddress,
  encodeKeyhashAddress,
  keyhashOf,
  keyhashProgram,
  LotusV2UnsupportedNetworkError,
  nativeTransactionSize,
  requireLotusV2Network,
  signNativeTransaction,
  toHex,
  xOnlyPublicKey,
} from "./native";
import {
  LOTUS_V2_DUST_ATOMS,
  type LotusV2Coin,
  LotusV2Wallet,
  lotusV2NetworkOf,
  memoryLotusV2WalletStore,
  planLotusV2Send,
} from "./wallet";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CONSTANTS: Record<string, bigint> = { xpi: 0xb70061479en, txpi: 0xadda0f1635n, rxpi: 0x8172b45d63n };
/** Re-checksum a valid address's body under another prefix's constant. */
function withPrefix(address: string, hrp: string): string {
  const [from, body] = address.split("1", 2) as [string, string];
  const symbols = [...body].map((c) => CHARSET.indexOf(c));
  let checksum = 0n;
  for (const s of symbols.slice(-8)) checksum = checksum * 32n + BigInt(s);
  checksum ^= CONSTANTS[from]! ^ CONSTANTS[hrp]!;
  const tail = Array.from({ length: 8 }, (_, i) => CHARSET[Number((checksum >> BigInt(5 * (7 - i))) & 31n)]);
  return `${hrp}1${body.slice(0, -8)}${tail.join("")}`;
}

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

  it("the signed size is exactly what the fee is computed from", () => {
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

  it("a well-formed mainnet or testnet address is unsupported; a malformed one is malformed", () => {
    // Mainnet type-0 example from addresses.md.
    const mainnet = "xpi1q80z6tf5zlwd794z4dpe28fehp3qdt2lg8q3jz3mzacmrqw20vseq37xlywnx";
    expect(() => decodeAddress("regtest", mainnet)).toThrow(LotusV2UnsupportedNetworkError);
    // The testnet address of the scalar-1 key: the regtest vector's body under the testnet
    // checksum constant (the checksum is the data polymod XOR the prefix's constant).
    const testnet = withPrefix("rxpi1pl8e2pv6n7jp0g9fgrk36qzff6z98mxnynqz57hhkvga4tq8xqlmsq2859j5u", "txpi");
    expect(() => decodeAddress("regtest", testnet)).toThrow(LotusV2UnsupportedNetworkError);
    // Bodies whose checksum does not hold are malformed whatever their prefix.
    expect(() => decodeAddress("regtest", "txpi1" + "q".repeat(61))).toThrow("bad checksum");
    expect(() => decodeAddress("regtest", mainnet.slice(0, -1) + (mainnet.endsWith("x") ? "q" : "x"))).toThrow(
      "bad checksum"
    );
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

describe("planLotusV2Send", () => {
  const coin = (value: bigint, n: number, state: "unspent" | "pending" = "unspent"): LotusV2Coin => ({
    txid: n.toString(16).padStart(64, "0"),
    outIdx: 0,
    value,
    origin: "receive",
    state,
    secret: scalar(1),
  });
  const fee = (inputs: number, outputs: number) => BigInt(nativeTransactionSize(inputs, outputs));
  const value = 1_000_000n;

  it("pays change when the remainder is at least dust", () => {
    const plan = planLotusV2Send([coin(value + fee(1, 2) + LOTUS_V2_DUST_ATOMS, 1)], value);
    expect(plan).toMatchObject({ fee: fee(1, 2), change: LOTUS_V2_DUST_ATOMS });
  });

  it("sends without change when the coin covers value and the one-output fee exactly", () => {
    const plan = planLotusV2Send([coin(value + fee(1, 1), 1)], value);
    expect(plan.change).toBeUndefined();
    expect(plan.fee).toBe(fee(1, 1));
  });

  it("gives a remainder below dust to the fee instead of making a dust output", () => {
    const total = value + fee(1, 2) + LOTUS_V2_DUST_ATOMS - 1n;
    const plan = planLotusV2Send([coin(total, 1)], value);
    expect(plan.change).toBeUndefined();
    expect(plan.fee).toBe(total - value);
  });

  it("gathers several coins, largest first, and never a claimed one", () => {
    const plan = planLotusV2Send(
      [coin(400_000n, 1), coin(900_000n, 2, "pending"), coin(700_000n, 3), coin(300_000n, 4)],
      value
    );
    expect(plan.inputs.map((c) => c.value)).toEqual([700_000n, 400_000n]);
    expect(plan.fee).toBe(fee(2, 2));
    expect(plan.change).toBe(1_100_000n - value - fee(2, 2));
  });

  it("refuses a value below dust and an amount the coins cannot cover", () => {
    expect(() => planLotusV2Send([coin(10n * value, 1)], LOTUS_V2_DUST_ATOMS - 1n)).toThrow(RangeError);
    expect(() => planLotusV2Send([coin(value, 1)], value)).toThrow(/Insufficient funds/);
    expect(() => planLotusV2Send([coin(10n * value, 1, "pending")], value)).toThrow(/Insufficient funds/);
  });
});
