# `@frank/adaptor-signatures`

Transaction-agnostic ECDSA adaptor signatures over secp256k1. The package
consumes an explicit 32-byte message or transaction sighash; transaction
construction and sighash selection belong to `@frank/nakamoto`.

The construction and its 162-byte encoding follow the DLC specification. The
wire bytes are an external cryptographic format and are intentionally not
wrapped in CBOR. A Frank protocol message may carry those bytes in a CBOR byte
string later.

The public API uses copied `Uint8Array` values, opaque TypeScript brands, and
typed results. It supports:

- generating an adaptor secret from a caller-supplied CSPRNG;
- proving and verifying knowledge of the secret behind an adaptor point;
- encrypted signing and verification;
- completion with the adaptor secret;
- extraction of the secret from encrypted and completed signatures; and
- strict parsing of points, scalars, proofs, and exact signature encodings.

```ts
const material = generateAdaptorSecret(secureRandomBytes)
if (!material.ok) throw new Error(material.error.code)

const encrypted = adaptorSign({
  privateKey,
  adaptorPoint: material.value.point,
  adaptorProof: material.value.proof,
  digest: explicit32ByteSighash,
})
```

The adaptor-signature encoding is exactly:

```
R (33) || R_a (33) || s_a (32) || proof.b (32) || proof.c (32)
```

The test suite includes the 11 upstream `dlcspecs` vectors vendored from commit
`fcc9619f3505afbb5a3d2f7ba3896fc4910ae08e`, plus round-trip and adversarial
tests.

Signing and acceptance require a proof of knowledge bound to the exact adaptor
point. Safe completion takes the full public key, adaptor point and proof,
digest, encrypted signature, and secret. It verifies the proof and encrypted
signature, then requires `secret·G` to equal the adaptor point before producing
bytes. The arithmetic-only primitive remains internal and is not the exported
safe default.

## Frank adaptor-secret PoK v1

The mandatory Frank proof-of-knowledge wire contract is frozen as
`R33 || z32` (65 bytes):

- `T` and `R` are canonical 33-byte compressed SEC1 secp256k1 points.
- `z` is a canonical nonzero 32-byte big-endian scalar below the group order.
- The ASCII domain tag is exactly `ADAPTOR-TWEAK-POK`.
- `e = SHA256(SHA256(tag) || SHA256(tag) || T33 || R33) mod n`.
- Verification requires the relationship `z·G = R + e·T`.
- Signing, verification, and completion verify this proof against the exact
  adaptor point in the same transcript; a TypeScript brand is never trusted as
  runtime evidence.

The fixed compatibility vector uses:

```
T = 03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe
proof = 038094126a4a9cf7e9945a7b152a55a5ee90a61013df9dfface9f935e6d8ec88ee3b5b7372c6bf2ef36cde2e8ea8cfdfa8a3100b548c3cff5f57fe12c891d2652b
```

## Security status

This experimental JavaScript implementation has **not** received an external
cryptographic or side-channel audit. Passing vectors is correctness evidence,
not a production security review. JavaScript bigint operations are not
guaranteed constant-time. Do not use this package to secure real funds.

Atomic swaps additionally need chain-specific refund paths, timelocks,
confirmation/finality policy, transcript binding, persistence, and a watcher.
Those protocol concerns do not belong in this primitive package.
