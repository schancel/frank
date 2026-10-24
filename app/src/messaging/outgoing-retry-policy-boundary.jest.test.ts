import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

// Only the pre-existing error-class identity crosses this local policy boundary.
// Inspect dependency syntax, including type-only edges and computed module access.
function forbiddenDependencies(source: string): string[] {
  const file = ts.createSourceFile(
    'policy.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const forbidden: string[] = []
  const inspect = (node: ts.Node | undefined, classImport = false) => {
    const name =
      node && ts.isStringLiteralLike(node) ? node.text : '<computed module>'
    if (name !== '@frank/wallet/chain' || !classImport) forbidden.push(name)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const bindings = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : undefined
      const classImport =
        ts.isImportDeclaration(node) &&
        node.importClause?.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length === 1 &&
        (bindings.elements[0].propertyName ?? bindings.elements[0].name)
          .text === 'CanonicalMessagingPendingError'
      if (node.moduleSpecifier) inspect(node.moduleSpecifier, classImport)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      inspect(node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node)) {
      inspect(
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
      )
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      inspect(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return forbidden
}

it('keeps retry policy free of UI, store and application runtime imports', () => {
  expect(
    forbiddenDependencies(
      readFileSync(join(__dirname, 'outgoing-retry-policy.ts'), 'utf8'),
    ),
  ).toEqual([])
})

it.each([
  "import { ref } from 'vue'",
  "import type { Store } from 'pinia'",
  "import { useChatStore } from '../stores/chats'",
  "import { useChatStore } from 'src/stores/chats'",
  "import { useChatStore } from '@/stores/chats'",
  "import { activeChain } from '@frank/wallet/chain'",
  "import * as wallet from '@frank/wallet/chain'",
  "export { CanonicalMessagingPendingError } from '@frank/wallet/chain'",
  "export { messagingWallet } from '../utils/identity-session'",
  "export type { MessagingState } from '../utils/identity-session'",
  "type State = import('../utils/identity-session').MessagingState",
  "const session = require('../utils/identity-session')",
  "const session = import('../utils/identity-session')",
  "import session = require('../utils/identity-session')",
  'const runtime = import(moduleName)',
  'const runtime = require(moduleName)',
])('rejects prohibited dependency syntax: %s', source => {
  expect(forbiddenDependencies(source)).toHaveLength(1)
})

it('allows the retained error-class dependency', () => {
  expect(
    forbiddenDependencies(
      "import { CanonicalMessagingPendingError } from '@frank/wallet/chain'",
    ),
  ).toEqual([])
})
