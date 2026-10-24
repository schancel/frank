import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

const allowed = new Map([
  [
    '@frank/cashweb/relay/storage/storage',
    new Set(['FinancialEnvelopeBinding', 'MessageStore']),
  ],
  ['@frank/cashweb/types/messages', new Set(['OutgoingFinancialOperation'])],
  ['@frank/wallet/chain', new Set(['DirectMessageAttemptStatus'])],
])
function forbidden(source: string): string[] {
  const file = ts.createSourceFile(
    'recovery.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const failures: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const path = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : '<computed>'
      const names = allowed.get(path)
      const bindings = node.importClause?.namedBindings
      if (
        !node.importClause?.isTypeOnly ||
        node.importClause.name ||
        !names ||
        !bindings ||
        !ts.isNamedImports(bindings) ||
        bindings.elements.some(
          item => !names.has((item.propertyName ?? item.name).text),
        )
      )
        failures.push(path)
    } else if (
      (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isImportTypeNode(node) ||
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require')))
    ) {
      failures.push(node.getText(file))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return failures
}

it('keeps retained-envelope recovery behind injected capabilities and type contracts', () => {
  expect(
    forbidden(
      readFileSync(join(__dirname, 'financial-envelope-recovery.ts'), 'utf8'),
    ),
  ).toEqual([])
})
it.each([
  "import { ref } from 'vue'",
  "import type { Store } from 'pinia'",
  "import { accountSession } from '../accounts/session'",
  "import type { Session } from '@/accounts/session'",
  "import type { Session } from 'src/accounts/session'",
  "import { activeChain } from '@frank/wallet/chain'",
  "import type { WalletHandle } from '@frank/wallet/chain'",
  "export type { MessageStore } from '@frank/cashweb/relay/storage/storage'",
  "type Session = import('../accounts/session').Session",
  "import session = require('../accounts/session')",
  'const session = require(moduleName)',
  "const session = import('../accounts/session')",
])('rejects an implementation dependency: %s', source => {
  expect(forbidden(source)).toHaveLength(1)
})
