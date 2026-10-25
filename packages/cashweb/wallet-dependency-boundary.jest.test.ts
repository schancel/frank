import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import ts from "typescript";

// Cashweb is below the wallet: production modules never import it, including type-only
// imports, re-exports, import types and dynamic loads. Tests may use the wallet devDependency.
const packageRoot = __dirname;
const walletRoot = resolve(packageRoot, "../wallet");
const sourceFile = /\.(ts|js|mjs|cjs)$/;
const testOnly = /\.(jest\.test|testutil|browser-test)\.[cm]?[jt]s$/;

function productionFiles(dir = packageRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : productionFiles(path);
    return sourceFile.test(entry.name) && !testOnly.test(entry.name)
      ? [path]
      : [];
  });
}

function walletDependencies(source: string, path: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const checkName = (name: string) => {
    const target = name.startsWith(".") ? resolve(dirname(path), name) : "";
    if (
      /^@frank\/wallet(\/|$)/.test(name) ||
      target === walletRoot ||
      target.startsWith(walletRoot + sep)
    )
      found.push(name);
  };
  const check = (node: ts.Node | undefined) =>
    node && ts.isStringLiteralLike(node)
      ? checkName(node.text)
      : found.push("<computed module>");
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) check(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      check(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      check(
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined
      );
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      check(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  // Triple-slash path references are relative even without a leading dot.
  for (const ref of file.referencedFiles)
    checkName(
      ref.fileName.startsWith(".") ? ref.fileName : `./${ref.fileName}`
    );
  for (const ref of file.typeReferenceDirectives) checkName(ref.fileName);
  return found;
}

it("keeps every production cashweb module independent of the wallet", () => {
  const files = productionFiles();
  expect(files.length).toBeGreaterThan(50);
  const violations = files.flatMap((path) =>
    walletDependencies(readFileSync(path, "utf8"), path).map(
      (name) => `${relative(packageRoot, path)}: ${name}`
    )
  );
  expect(violations).toEqual([]);
});

it("exempts only named test helpers, not declarations or production modules", () => {
  expect(testOnly.test("relay/fake.testutil.ts")).toBe(true);
  expect(testOnly.test("relay/storage/intent.browser-test.mjs")).toBe(true);
  expect(testOnly.test("relay/canonical-dm-transport.ts")).toBe(false);
  expect(testOnly.test("relay/storage/message-store-level-types.d.ts")).toBe(
    false
  );
});

const fixturePath = join(packageRoot, "relay", "fixture.ts");
it.each([
  "import { activeChain } from '@frank/wallet/chain'",
  "import type { WalletHandle } from '@frank/wallet'",
  "export { recordWalletFailure } from '@frank/wallet/wallet-failure'",
  "export type { WalletHandle } from '@frank/wallet/chain'",
  "type Handle = import('@frank/wallet/chain').WalletHandle",
  "import wallet = require('@frank/wallet/chain')",
  "const wallet = require('@frank/wallet/chain')",
  "const wallet = import('@frank/wallet/chain')",
  "import type { WalletHandle } from '../../wallet/chain'",
  "const wallet = import(walletModule)",
  '/// <reference path="../../wallet/level.d.ts" />',
  '/// <reference types="@frank/wallet" />',
])("rejects a wallet dependency: %s", (source) => {
  expect(walletDependencies(source, fixturePath)).toHaveLength(1);
});

it("permits cashweb-local, sibling-package and comment references", () => {
  expect(
    walletDependencies(
      `
      import { encode } from '@frank/codec'
      import type { MessageStore } from './storage/storage'
      import { walletName } from '../legacy-wallet/wallet'
      // see @frank/wallet/message-item-plugins/blackjack
      const store = require('./storage/level-storage')
    `,
      fixturePath
    )
  ).toEqual([]);
});
