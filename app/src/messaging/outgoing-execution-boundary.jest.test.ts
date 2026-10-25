import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

const typeModules = new Set([
  '@frank/wallet/chain',
  '@frank/cashweb/relay/storage/storage',
  '@frank/cashweb/types/messages',
  './outgoing-recovery',
])
const runtimeNames: Record<string, string[]> = {
  '@frank/wallet/chain': [
    'ContactPaymentReleasedError',
    'DirectMessageAlreadyAttemptedError',
  ],
  '@frank/wallet/chain/active-chain': ['isDirectMessageNotAttempted'],
  '@frank/wallet/evm-stamp-client': ['MonadStampPendingAttemptError'],
  './outgoing-retry-policy': ['decideOutgoingRetry'],
}
function forbidden(source: string): string[] {
  const file = ts.createSourceFile(
    'execution.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const errors: string[] = []
  const reject = (node?: ts.Node) =>
    errors.push(
      node && ts.isStringLiteralLike(node) ? node.text : '<computed module>',
    )
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const path = ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ''
      const bindings = clause?.namedBindings
      const names =
        bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map(e => (e.propertyName ?? e.name).text).sort()
          : undefined
      const allowed = clause?.isTypeOnly
        ? typeModules.has(path)
        : path === 'assert'
        ? clause?.name?.text === 'assert' && !bindings
        : names &&
          !clause?.name &&
          JSON.stringify(names) ===
            JSON.stringify(runtimeNames[path]?.slice().sort())
      if (!allowed) reject(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      reject(node.moduleSpecifier)
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      reject(node.moduleReference.expression)
    else if (ts.isImportTypeNode(node))
      reject(
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
      )
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    )
      reject(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(file)
  return errors
}
it('keeps execution behind public capability types and exact existing error/retry helpers', () => {
  expect(
    forbidden(readFileSync(join(__dirname, 'outgoing-execution.ts'), 'utf8')),
  ).toEqual([])
})
it.each([
  "import { ref } from 'vue'",
  "import type { Store } from 'pinia'",
  "import type { ChatMessage } from '../stores/chats'",
  "import { accountSession } from '@/accounts/session'",
  "import { activeChain } from '@frank/wallet/chain'",
  "import * as wallet from '@frank/wallet/chain'",
  "export { useChatStore } from '../stores/chats'",
  "type T = import('../stores/chats').ChatMessage",
  "const store = require('../stores/chats')",
  "const store = import('../stores/chats')",
  "import store = require('../stores/chats')",
  'const store = import(path)',
])('rejects private/runtime escape: %s', source =>
  expect(forbidden(source)).toHaveLength(1),
)
it('keeps both public execution actions as delegates rather than duplicate algorithms', () => {
  const file = ts.createSourceFile(
    'chats.ts',
    readFileSync(join(__dirname, '../stores/chats.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const wanted = new Set(['runOutgoing', 'runOutgoingExclusive']),
    found: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      wanted.has(node.name.text)
    ) {
      found.push(node.name.text)
      expect(node.body?.statements).toHaveLength(1)
      expect(node.body?.statements[0].getText(file)).toContain(
        `createChatOutgoingExecution(this).${node.name.text}`,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(found.sort()).toEqual([...wanted].sort())
})
