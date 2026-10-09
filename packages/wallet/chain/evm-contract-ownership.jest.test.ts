import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import ts from "typescript";

const root = join(__dirname, "../../..");
function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(join(root, path), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}
function declaration(path: string, name: string) {
  return source(path).statements.find(
    (node) =>
      (ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isFunctionDeclaration(node)) &&
      node.name?.text === name
  );
}
function interfaceOwner(path: string, name: string) {
  const node = declaration(path, name);
  if (!node || !ts.isInterfaceDeclaration(node))
    throw new Error(`${name} must own its interface in ${path}`);
  return node;
}
function sourcePaths(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      if (["node_modules", "dist", ".quasar"].includes(entry.name)) return [];
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourcePaths(path)
        : path.endsWith(".ts")
        ? [path]
        : [];
    }
  );
}

describe("generic EVM configuration and handle ownership", () => {
  it("removes generic declarations and the unconditional wrapper from the Monad composition module", () => {
    for (const name of [
      "MonadChainConfig",
      "EvmChainConfig",
      "MonadChainWalletHandle",
      "EvmChainWalletHandle",
      "createMonadChain",
    ]) {
      expect(
        declaration("packages/wallet/chain/monad-chain.ts", name)
      ).toBeUndefined();
    }
    expect(
      declaration("packages/wallet/monad-wallet-handle.ts", "MonadWalletHandle")
    ).toBeUndefined();
    expect(existsSync(join(root, "packages/wallet/chain/evm-chain.ts"))).toBe(
      false
    );
  });

  it("owns generic interfaces directly with type-only dependencies and no Monad handle back-edge", () => {
    const config = interfaceOwner(
      "packages/wallet/chain/evm-chain-config.ts",
      "EvmChainConfig"
    );
    expect(config.heritageClauses).toBeUndefined();
    const shared = interfaceOwner(
      "packages/wallet/evm-wallet-handle.ts",
      "EvmWalletHandle"
    );
    expect(shared.heritageClauses).toBeUndefined();
    const concrete = interfaceOwner(
      "packages/wallet/evm-wallet-handle.ts",
      "EvmChainWalletHandle"
    );
    expect(
      concrete.heritageClauses?.flatMap((clause) =>
        clause.types.map((type) => type.expression.getText())
      )
    ).toEqual(["EvmWalletHandle", "WalletHandle", "NativeWalletHandle"]);
    for (const path of [
      "packages/wallet/chain/evm-chain-config.ts",
      "packages/wallet/evm-wallet-handle.ts",
    ]) {
      for (const node of source(path).statements) {
        if (!ts.isImportDeclaration(node)) continue;
        expect(node.importClause?.isTypeOnly).toBe(true);
        expect(node.moduleSpecifier.getText()).not.toContain(
          "monad-wallet-handle"
        );
      }
    }
  });

  it("binds the factory and public type exports to their actual owners", () => {
    const imports = source(
      "packages/wallet/chain/chain-factory.ts"
    ).statements.filter(ts.isImportDeclaration);
    const configImport = imports.find((node) =>
      node.importClause?.namedBindings?.getText().includes("EvmChainConfig")
    );
    expect(configImport?.moduleSpecifier.getText()).toBe(
      '"./evm-chain-config"'
    );
    const exports = source("packages/wallet/chain/index.ts").statements.filter(
      ts.isExportDeclaration
    );
    expect(
      exports
        .find((node) => node.exportClause?.getText().includes("EvmChainConfig"))
        ?.moduleSpecifier?.getText()
    ).toBe('"./evm-chain-config"');
    expect(
      exports
        .find((node) =>
          node.exportClause?.getText().includes("EvmChainWalletHandle")
        )
        ?.moduleSpecifier?.getText()
    ).toBe('"../evm-wallet-handle"');
  });

  it("leaves no obsolete generic type or wrapper references in production and existing tests", () => {
    const obsolete =
      /\b(?:Monad(?:ChainConfig|ChainWalletHandle|WalletHandle)|createMonadChain)\b/;
    const paths = [
      "packages/wallet",
      "packages/bot",
      "packages/bot-framework",
      "app/src",
    ].flatMap(sourcePaths);
    const remaining = paths.filter(
      (path) =>
        !path.endsWith("evm-contract-ownership.jest.test.ts") &&
        obsolete.test(readFileSync(join(root, path), "utf8"))
    );
    expect(remaining).toEqual([]);
  });
});
