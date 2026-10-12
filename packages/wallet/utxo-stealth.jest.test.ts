import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { UTXO_NETWORKS } from "./utxo-wallet";
import {
  deriveUtxoStealthDestination,
  requireCompressedStealthPoint,
} from "./utxo-stealth";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const scalar = (value: bigint) =>
  Uint8Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));
const recipient = 21n;
const ephemeral = 17n;
const identityPublicKey = secp256k1.getPublicKey(scalar(recipient), true);

describe.each([UTXO_NETWORKS["btc-testnet"], UTXO_NETWORKS["bch-testnet"]])(
  "$chainIdentifier recipient-only derivation",
  (network) => {
    it("matches independent point addition and only the recipient's full scalar signs for the destination", () => {
      const identity = secp256k1.ProjectivePoint.fromHex(identityPublicKey);
      const shared = identity.multiply(ephemeral).toRawBytes(true);
      const tweak = BigInt("0x" + hex(sha256(shared))) % secp256k1.CURVE.n;
      const expected = identity
        .add(secp256k1.ProjectivePoint.BASE.multiply(tweak))
        .toRawBytes(true);
      const destination = deriveUtxoStealthDestination({
        network,
        identityPublicKey,
        ephemeralSecret: scalar(ephemeral),
      });
      expect(hex(destination.publicKey)).toBe(hex(expected));
      expect(destination.derivation.chainIdentifier).toBe(
        network.chainIdentifier
      );
      expect(hex(destination.derivation.ephemeralPubKey)).toBe(
        hex(secp256k1.getPublicKey(scalar(ephemeral), true))
      );
      const digest = sha256(new Uint8Array([1, 2, 3]));
      const signature = secp256k1.sign(
        digest,
        scalar((recipient + tweak) % secp256k1.CURVE.n)
      );
      expect(secp256k1.verify(signature, digest, destination.publicKey)).toBe(
        true
      );
      // Neither of the scalars known to the sender opens the recipient destination.
      expect(
        secp256k1.verify(
          secp256k1.sign(digest, scalar(ephemeral)),
          digest,
          destination.publicKey
        )
      ).toBe(false);
      expect(
        secp256k1.verify(
          secp256k1.sign(digest, scalar(tweak)),
          digest,
          destination.publicKey
        )
      ).toBe(false);
    });

    it("rejects invalid recipient points and ephemeral scalars without changing caller buffers", () => {
      const secret = scalar(ephemeral);
      const before = hex(secret);
      for (const point of [
        new Uint8Array(33),
        Uint8Array.from([2, ...new Uint8Array(32).fill(255)]),
        new Uint8Array(32),
      ]) {
        expect(() => requireCompressedStealthPoint(point)).toThrow();
        expect(() =>
          deriveUtxoStealthDestination({
            network,
            identityPublicKey: point,
            ephemeralSecret: secret,
          })
        ).toThrow();
      }
      expect(() =>
        deriveUtxoStealthDestination({
          network,
          identityPublicKey,
          ephemeralSecret: new Uint8Array(32),
        })
      ).toThrow();
      expect(hex(secret)).toBe(before);
    });
  }
);
