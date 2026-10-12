// Clean-checkout smoke test using only Node builtins and committed package files.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { openExperimentalRecipientCustody } from "./runtime.mjs";

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
  "Committed Solana WASM imports, verifies, instantiates and closes without network access"
);
