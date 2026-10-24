import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

const allowed = new Set([
  '@frank/cashweb/types/messages',
  '@frank/wallet/chain',
])
function forbiddenDependencies(source: string): string[] {
  const file = ts.createSourceFile(
    'recovery.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const forbidden: string[] = []
  const reject = (node?: ts.Node) =>
    forbidden.push(
      node && ts.isStringLiteralLike(node) ? node.text : '<computed module>',
    )
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (
        !node.importClause?.isTypeOnly ||
        !ts.isStringLiteralLike(node.moduleSpecifier) ||
        !allowed.has(node.moduleSpecifier.text)
      )
        reject(node.moduleSpecifier)
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
  return forbidden
}
it('allows only public capability types, with no UI/runtime/store imports', () => {
  expect(
    forbiddenDependencies(
      readFileSync(join(__dirname, 'outgoing-recovery.ts'), 'utf8'),
    ),
  ).toEqual([])
})
it.each([
  "import { ref } from 'vue'",
  "import type { Store } from 'pinia'",
  "import type { ChatMessage } from '../stores/chats'",
  "import { useChatStore } from '@/stores/chats'",
  "import { activeChain } from '@frank/wallet/chain'",
  "import * as wallet from '@frank/wallet/chain'",
  "export type { Message } from '@frank/cashweb/types/messages'",
  "type State = import('../stores/chats').ChatMessage",
  "const state = require('../stores/chats')",
  "const state = import('../stores/chats')",
  "import state = require('../stores/chats')",
  'const state = import(name)',
])('rejects a runtime or private dependency: %s', source => {
  expect(forbiddenDependencies(source)).toHaveLength(1)
})
it('keeps the three public Pinia actions as delegates, not duplicate algorithms', () => {
  const file = ts.createSourceFile(
    'chats.ts',
    readFileSync(join(__dirname, '../stores/chats.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const wanted = new Set([
    'resumeCutOffOutgoing',
    'reconcileOutgoing',
    'applyAttemptStatus',
  ])
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isMethodDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      wanted.has(node.name.text)
    ) {
      found.push(node.name.text)
      expect(node.body?.statements).toHaveLength(1)
      expect(node.body?.statements[0].getText(file)).toContain(
        `createChatOutgoingRecovery(this).${node.name.text}`,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(found.sort()).toEqual([...wanted].sort())
})
