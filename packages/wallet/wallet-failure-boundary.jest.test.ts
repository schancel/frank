import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

function dependencies(source: string): string[] {
  const found: string[] = []
  const file = ts.createSourceFile('wallet-failure.ts', source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      found.push(node.moduleSpecifier.getText(file))
    else if (ts.isImportTypeNode(node) || ts.isImportEqualsDeclaration(node))
      found.push(node.getText(file))
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      found.push(node.getText(file))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}
it('keeps generic failure facts independent of every runtime owner', () => {
  expect(dependencies(readFileSync(join(__dirname, 'wallet-failure.ts'), 'utf8'))).toEqual([])
})
it('keeps the EVM vendor adapter dependent only on the failure facts it records', () => {
  expect(dependencies(readFileSync(join(__dirname, 'evm-rpc-failure.ts'), 'utf8'))).toEqual(["'./wallet-failure'"])
})
it.each([
  "import type { WalletHandle } from './chain'",
  "export { activeChain } from './chain'",
  "import { ref } from 'vue'",
  "type Provider = import('ethers').Provider",
  "const runtime = import(path)",
  "const runtime = require(path)",
  "import runtime = require('./chain')",
])('rejects dependency syntax %s', source => {
  expect(dependencies(source)).toHaveLength(1)
})
