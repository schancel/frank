/**
 * Native account/nonce admission across two same-origin pages (separate JS realms) of one
 * browser context, using the production persistent bundle, admission and journal over real
 * IndexedDB (LevelJS) and the Web Locks taken by `runNativeTransactionExclusive`.
 * Synthetic mnemonic only; no provider, relay, broadcast or network.
 *
 * Run (Playwright is not a repo dependency; point at an install whose browsers are present):
 *   ADMISSION_PLAYWRIGHT=/path/to/node_modules/playwright \
 *     node packages/wallet/evm-input-admission.browser-test.mjs [--browsers=chromium,webkit] [--out=DIR]
 * CHROME_BIN overrides the Chromium executable. Playwright WebKit is not Safari.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const playwright = require(process.env.ADMISSION_PLAYWRIGHT || "playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argument = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const out = resolve(
  argument("out") ?? join(tmpdir(), `frank-browser-admission-${process.pid}`)
);
const browsers = (argument("browsers") ?? "chromium,webkit").split(",");
await mkdir(out, { recursive: true });

const destinations = ["0x" + "12".repeat(20), "0x" + "34".repeat(20)];
const monad = { chainIdentifier: "monad-testnet", nativeChainId: "10143" };
const sepolia = {
  chainIdentifier: "ethereum-sepolia",
  nativeChainId: "11155111",
};
const ITERATIONS = 4;
const isConflict = (result) =>
  result.status === "rejected" &&
  ((result.error.name === "EvmNativeJournalError" &&
    result.error.code === "conflict") ||
    (result.error.name === "EvmInputAdmissionError" &&
      result.error.reason === "conflicting-authorization"));
// The race loser and the other page's disjoint claim must be refused by the durable journal under
// its cross-page lock; a page-local admission refusal would not prove cross-page exclusion.
const isJournalConflict = (result) =>
  result.status === "rejected" &&
  result.error.name === "EvmNativeJournalError" &&
  result.error.code === "conflict";
const invoke = (page, method, ...args) =>
  page.evaluate(
    ([name, values]) => globalThis.walletAdmissionFixture[name](...values),
    [method, args]
  );
async function start(page, id, index, recipient) {
  await invoke(page, "arm", id, index, recipient);
  assert.equal(
    await invoke(page, "arrived", id),
    true,
    "Admission snapshot did not reach the barrier"
  );
}
async function admit(page, id, index = 0, recipient = destinations[0]) {
  await start(page, id, index, recipient);
  await invoke(page, "release", id);
  return invoke(page, "result", id);
}

async function runBrowser(name, origin, report) {
  const type = playwright[name];
  const browser = await type.launch(
    name === "chromium" && process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {}
  );
  try {
    report.browser = `${name} ${browser.version()}`;
    // One context = one origin's storage partition; each page is its own JS realm.
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url === origin + "/" || url === origin + "/suite.js")
        return route.continue();
      report.blocked.push(url.split("?")[0]);
      return route.abort("blockedbyclient");
    });
    await context.addInitScript(() => {
      for (const transport of [
        "WebSocket",
        "EventSource",
        "Worker",
        "SharedWorker",
      ])
        Object.defineProperty(globalThis, transport, {
          value: class {
            constructor() {
              throw Error("Fixture transport forbidden: " + transport);
            }
          },
          configurable: false,
        });
    });
    const pages = [];
    for (let i = 0; i < 2; i++) {
      const page = await context.newPage();
      page.on("pageerror", (error) =>
        report.runtimeErrors.push(String(error.stack ?? error))
      );
      await page.goto(origin);
      await page.waitForFunction(
        () => globalThis.walletAdmissionFixture !== undefined
      );
      assert.equal(
        await page.evaluate(() =>
          fetch("https://invalid.example/containment-control").then(
            () => false,
            () => true
          )
        ),
        true
      );
      pages.push(page);
    }
    // Distinct realms: a global set in one page is invisible in the other.
    await pages[0].evaluate(() => {
      globalThis.realmProbe = "page-0";
    });
    assert.equal(
      await pages[1].evaluate(() => globalThis.realmProbe),
      undefined
    );

    const marker = createHash("sha256")
      .update(`${name}:${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 16);
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const location = `native-browser-${marker}-${iteration}`;
      const openedA = await invoke(pages[0], "open", {
        location,
        ...monad,
        create: true,
      });
      assert.equal(openedA.durability, "persistent");
      assert.equal(openedA.webLocks, true);
      const duplicate = await invoke(pages[0], "duplicateOpen");
      assert.match(duplicate.message, /wallet manifest already has an owner$/);
      const openedB = await invoke(pages[1], "open", { location, ...monad });
      assert.deepEqual(openedB, openedA);

      // Race: both pages hold a ready snapshot for the same [account 0, nonce 0] before either proceeds.
      const ids = [
        `stealth-payment:race-${iteration}-A`,
        `stealth-payment:race-${iteration}-B`,
      ];
      const before = await Promise.all(
        pages.map((page) => invoke(page, "capabilities"))
      );
      await Promise.all(
        pages.map((page, index) =>
          start(page, ids[index], 0, destinations[index])
        )
      );
      const order = iteration % 2 === 0 ? [0, 1] : [1, 0];
      await Promise.all(
        order.map((index) => invoke(pages[index], "release", ids[index]))
      );
      const results = await Promise.all(
        pages.map((page, index) => invoke(page, "result", ids[index]))
      );
      const race = {
        iteration,
        ids,
        order,
        duplicate,
        openedA,
        openedB,
        results,
      };
      report.races.push(race);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
        "Exactly one native claim must succeed"
      );
      const winner = results.findIndex(
          (result) => result.status === "fulfilled"
        ),
        loser = 1 - winner;
      race.winner = winner;
      assert.ok(
        isJournalConflict(results[loser]),
        `Unexpected loser category: ${JSON.stringify(results[loser])}`
      );
      assert.equal(results[winner].signerCalls - before[winner].signerCalls, 1);
      assert.equal(results[loser].signerCalls - before[loser].signerCalls, 0);

      // No wallet-wide lock: while the winner's claim stays outstanding, the losing page
      // admits a disjoint input (account 1) of the same wallet.
      const disjointId = `stealth-payment:disjoint-${iteration}`;
      const disjoint = await admit(
        pages[loser],
        disjointId,
        1,
        destinations[loser]
      );
      assert.equal(
        disjoint.status,
        "fulfilled",
        `Disjoint claim refused: ${JSON.stringify(disjoint)}`
      );
      assert.equal(disjoint.signerCalls - results[loser].signerCalls, 1);
      // Both reservations stay exclusive across pages.
      const heldSame = await admit(
        pages[winner],
        `stealth-payment:held-${iteration}-0`,
        0
      );
      assert.ok(
        isConflict(heldSame),
        `Held account 0 re-admitted: ${JSON.stringify(heldSame)}`
      );
      const heldOther = await admit(
        pages[winner],
        `stealth-payment:held-${iteration}-1`,
        1
      );
      assert.ok(
        isJournalConflict(heldOther),
        `Held account 1 re-admitted: ${JSON.stringify(heldOther)}`
      );
      assert.equal(heldOther.signerCalls, results[winner].signerCalls);

      // Reopen in the opposite pages: persisted rows are exactly the two admitted claims.
      await Promise.all(pages.map((page) => invoke(page, "close")));
      await invoke(pages[loser], "open", { location, ...monad });
      const reopenedRows = await invoke(pages[loser], "rows");
      assert.equal(reopenedRows.length, 2);
      assert.deepEqual(
        reopenedRows.map((row) => row.preparationId).sort(),
        [ids[winner], disjointId].sort()
      );
      assert.deepEqual(
        reopenedRows.find((row) => row.preparationId === ids[winner]),
        results[winner].row
      );
      assert.deepEqual(
        reopenedRows.find((row) => row.preparationId === disjointId),
        disjoint.row
      );
      for (const row of reopenedRows) {
        assert.equal(row.binding.chainIdentifier, monad.chainIdentifier);
        assert.ok(
          row.members.every((member) => member.signedHash && !member.exposed)
        );
      }
      await invoke(pages[loser], "close");
      await invoke(pages[winner], "open", { location, ...monad });
      const original = await invoke(pages[winner], "original", ids[winner]);
      assert.equal(original.exactOriginal, true);
      assert.deepEqual(original.row, results[winner].row);
      const reopenedHeld = await admit(
        pages[winner],
        `stealth-payment:reopened-held-${iteration}`,
        0
      );
      assert.ok(
        isConflict(reopenedHeld),
        `Reopened account 0 re-admitted: ${JSON.stringify(reopenedHeld)}`
      );
      assert.equal((await invoke(pages[winner], "rows")).length, 2);

      // Chain isolation: the same account 0 on another canonical chain is independent.
      const chainLocation = location + "-sepolia";
      await invoke(pages[loser], "open", {
        location: chainLocation,
        ...sepolia,
        create: true,
      });
      const isolated = await admit(
        pages[loser],
        `stealth-payment:isolated-${iteration}`
      );
      assert.equal(isolated.status, "fulfilled");
      await Promise.all(pages.map((page) => invoke(page, "close")));
      await invoke(pages[winner], "open", {
        location: chainLocation,
        ...sepolia,
      });
      const isolatedRows = await invoke(pages[winner], "rows");
      assert.equal(isolatedRows.length, 1);
      assert.equal(
        isolatedRows[0].binding.chainIdentifier,
        sepolia.chainIdentifier
      );
      await invoke(pages[winner], "close");
      // The separate location above is the test's choice; the real guard is the journal's chain
      // binding. Monad's persisted journal must refuse to open as another canonical chain.
      const misbound = await invoke(pages[winner], "open", {
        location,
        ...sepolia,
      }).then(
        async () => {
          await invoke(pages[winner], "close");
          return null;
        },
        (error) => String(error?.message ?? error)
      );
      assert.match(
        misbound ?? "opened",
        /EvmNativeJournalError: EVM native operation journal: binding/
      );
      Object.assign(race, {
        disjoint,
        heldSame,
        heldOther,
        reopenedRows,
        original,
        reopenedHeld,
        isolated,
        isolatedRows,
        misbound,
      });
    }
    report.winners = report.races.map((race) => race.winner);
    report.storage = await Promise.all(
      pages.map((page) => invoke(page, "capabilities"))
    );
    for (const evidence of report.storage) {
      assert.ok(
        evidence.transactions.some(
          (tx) => tx.mode === "readwrite" && tx.durability === "strict"
        )
      );
      assert.equal(evidence.activeGates, 0);
    }
    assert.deepEqual(report.runtimeErrors, []);
    assert.ok(
      report.blocked.every(
        (url) => url === "https://invalid.example/containment-control"
      ),
      "Unexpected network request"
    );
    report.passed = true;
  } finally {
    await browser.close();
  }
}

const source = await readFile(
  join(root, "packages/wallet/evm-input-admission.browser-suite.ts")
);
const summary = {
  sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  fixtureHash: createHash("sha256").update(source).digest("hex"),
  scope:
    "Native account/nonce admission across two same-origin pages using the production persistent bundle/admission/journal",
  limitations: [
    "No broadcast, chain observation, full chain factory, cross-journal race, independent device, native Safari, or power-loss claim",
  ],
  runs: {},
};
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["packages/wallet/evm-input-admission.browser-suite.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120", "safari17"],
  define: { global: "globalThis" },
  inject: [
    "packages/cashweb/relay/storage/outgoing-application-intent.browser-globals.mjs",
  ],
  // Node-only durability paths remain fail-closed dynamic requires; never empty stubs.
  external: ["fs"],
  write: false,
  metafile: true,
  alias: {
    path: "path-browserify",
    "@frank/nakamoto/curve": "./packages/nakamoto/src/curve.ts",
    "@frank/nakamoto/constructors": "./packages/nakamoto/src/constructors.ts",
    "@frank/nakamoto": "./packages/nakamoto/src/index.ts",
    "@frank/crypto-box": "./packages/crypto-box/src/index.ts",
    "@frank/codec": "./packages/frank-codec/src/index.ts",
  },
});
const inputs = Object.keys(bundle.metafile.inputs);
for (const required of [
  "packages/wallet/evm-input-admission.ts",
  "packages/wallet/storage/evm-native-operation-journal.ts",
  "packages/wallet/storage/evm-wallet-bundle.ts",
  "packages/wallet/chain/chain-wallet.ts",
])
  assert.ok(inputs.includes(required), required);
assert.ok(
  inputs.some((path) => /node_modules\/level-js\//.test(path)),
  "Actual LevelJS missing"
);
assert.ok(
  !inputs.some((path) => /node_modules\/leveldown\//.test(path)),
  "Node Level backend bundled"
);
assert.ok(
  !inputs.some((path) => path.startsWith("app/")),
  "App orchestration imported"
);
for (const output of Object.values(bundle.metafile.outputs))
  for (const dependency of output.imports)
    assert.ok(
      dependency.path === "fs" && dependency.kind === "require-call",
      `Unexpected external: ${dependency.path}`
    );
summary.bundleHash = createHash("sha256")
  .update(bundle.outputFiles[0].contents)
  .digest("hex");
await writeFile(
  join(out, "bundle-inputs.json"),
  JSON.stringify(bundle.metafile, null, 2)
);

const server = createServer((request, response) => {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; connect-src 'self'; frame-src 'none'; worker-src 'none'"
  );
  if (request.url === "/suite.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(bundle.outputFiles[0].contents);
  } else if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><title>Disposable wallet admission</title><script type="module" src="/suite.js"></script>'
    );
  } else {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const name of browsers) {
    const report = {
      passed: false,
      browser: "",
      races: [],
      blocked: [],
      runtimeErrors: [],
    };
    summary.runs[name] = report;
    try {
      await runBrowser(name, origin, report);
    } catch (error) {
      report.error = error.stack ?? String(error);
      process.exitCode = 1;
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(out, "evidence.json"),
    JSON.stringify(summary, null, 2) + "\n"
  );
  console.log(
    JSON.stringify({
      runs: Object.fromEntries(
        Object.entries(summary.runs).map(([name, run]) => [
          name,
          {
            passed: run.passed,
            browser: run.browser,
            winners: run.winners,
            error: run.error,
          },
        ])
      ),
      evidence: join(out, "evidence.json"),
    })
  );
}
