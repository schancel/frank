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

## Security status

This experimental JavaScript implementation has **not** received an external
cryptographic or side-channel audit. Passing vectors is correctness evidence,
not a production security review. JavaScript bigint operations are not
guaranteed constant-time. Do not use this package to secure real funds.

Atomic swaps additionally need chain-specific refund paths, timelocks,
confirmation/finality policy, transcript binding, persistence, and a watcher.
Those protocol concerns do not belong in this primitive package.
