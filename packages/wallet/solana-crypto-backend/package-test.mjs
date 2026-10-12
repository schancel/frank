// Clean-checkout smoke test using only Node builtins and committed package files.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  openExperimentalRecipientCustody,
  unsignedTransferMessage,
  feeProbeMessage,
} from "./runtime.mjs";

const manifest = await readFile(
  new URL("./generated/SHA256SUMS", import.meta.url),
  "utf8"
);
for (const line of manifest.trim().split("\n")) {
  const [expected, name] = line.split(/\s+/);
  const bytes = await readFile(new URL(`./generated/${name}`, import.meta.url));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expected,
    name
  );
}
const vectors = JSON.parse(
  await readFile(
    new URL("../solana-stealth-vectors/vectors.json", import.meta.url)
  )
);
const vector = vectors.vectors[0];
const seed = Uint8Array.from(Buffer.from(vector.seed, "hex"));
// Bytes, not a remote URL: initialization must succeed with networking entirely unavailable.
const fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Package test attempted network access");
};
try {
  const wasm = await readFile(
    new URL("./generated/backend_bg.wasm", import.meta.url)
  );
  const bytes = (hex) => Array.from(Buffer.from(hex, "hex"));
  const descriptor = {
    chainIdentifier: vector.chainIdentifier,
    asset: { kind: "native" },
    recipient: bytes(vector.B),
    ephemeral: bytes(vector.R),
    operationId: Array(32).fill(90),
    memberIndex: 0,
    messageContext: Array(32).fill(91),
    recipientAmount: "42",
  };
  const spend = {
    chainIdentifier: vector.chainIdentifier,
    asset: { kind: "native" },
    owner: bytes(vector.P),
    destination: bytes(vector.B),
    amount: "42",
    recentBlockhash: Array(32).fill(85),
    operationId: descriptor.operationId,
    messageContext: descriptor.messageContext,
    decimals: null,
  };
  // Public builders initialize the package before any custody handle is opened.
  // These structural inputs do not assert private derivation/ownership.
  const unsigned = await unsignedTransferMessage(
    {
      descriptor,
      spend,
      authorization: {
        feeLamports: "0",
        maxFeeLamports: "0",
        rentLamports: "0",
        maxRentLamports: "0",
        maxNativeDebitLamports: "42",
        createDestinationAta: false,
      },
      source: { kind: "primary" },
    },
    wasm
  );
  const probe = await feeProbeMessage(
    {
      domain: "frank:solana-custody-fee-probe:v1",
      chainIdentifier: spend.chainIdentifier,
      asset: spend.asset,
      owner: spend.owner,
      destination: spend.destination,
      amount: spend.amount,
      recentBlockhash: spend.recentBlockhash,
      decimals: null,
      createDestinationAta: false,
    },
    wasm
  );
  assert(unsigned instanceof Uint8Array && unsigned.length > 0);
  assert.equal(unsigned.length, probe.length);
  assert.notDeepEqual(unsigned, probe);
  const custody = await openExperimentalRecipientCustody({
    accountId: new Uint8Array(32),
    chainIdentifier: vector.chainIdentifier,
    seed,
    wasm: await readFile(
      new URL("./generated/backend_bg.wasm", import.meta.url)
    ),
  });
  assert(seed.every((byte) => byte === 0));
  assert.equal(
    Buffer.from(custody.primaryPublicKey()).toString("hex"),
    vector.B
  );
  custody.close();
  assert.throws(() => custody.primaryPublicKey(), /Revoked/);
} finally {
  globalThis.fetch = fetch;
}
console.log(
  "Committed Solana WASM publicly constructs, verifies, instantiates and closes without network access"
);
