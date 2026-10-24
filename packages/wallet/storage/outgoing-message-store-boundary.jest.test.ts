import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

// Keep the repository and its local durability helper below execution/composition.
// Include type-only imports and alternate module syntax: those edges still couple owners.
function dependencies(source: string): string[] {
  const file = ts.createSourceFile(
    'boundary.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const result: string[] = []
  const add = (node: ts.Node | undefined) => {
    result.push(
      node && ts.isStringLiteralLike(node) ? node.text : '<computed module>',
    )
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node.argument.literal)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

const repositoryDependencies = new Set([
  'level',
  'path',
  'fs',
  './level-durability',
])
const forbidden = (source: string, allowed = repositoryDependencies) =>
  dependencies(source).filter(name => !allowed.has(name))

it('keeps outgoing storage and its durability dependency independent of execution and custody', () => {
  expect(
    forbidden(
      readFileSync(join(__dirname, 'outgoing-message-store.ts'), 'utf8'),
    ),
  ).toEqual([])
  expect(
    forbidden(
      readFileSync(join(__dirname, 'level-durability.ts'), 'utf8'),
      new Set(['level', 'path']),
    ),
  ).toEqual([])
})

it.each([
  "import { canonicalDirectMessages } from '../chain/canonical-dm'",
  "import type { CanonicalMessagingOwner } from '../chain/canonical-dm'",
  "export { canonicalDirectMessages } from '../chain/canonical-dm'",
  "export type { CanonicalMessagingOwner } from '../chain/canonical-dm'",
  "import { canonicalDirectMessages } from '@frank/wallet/chain/canonical-dm'",
  "type Owner = import('../chain/canonical-dm').CanonicalMessagingOwner",
  "const execution = require('../chain/canonical-dm')",
  "const execution = import('../chain/canonical-dm')",
  "import execution = require('../chain/canonical-dm')",
  'const execution = import(moduleName)',
  'const execution = require(moduleName)',
])('detects a prohibited dependency: %s', source => {
  expect(forbidden(source)).toHaveLength(1)
})

it('permits only the explicitly owned storage dependencies', () => {
  expect(
    forbidden(`
    import level, { type LevelDB } from 'level'
    import { join } from 'path'
    import { durablePut } from './level-durability'
    const exists = (require('fs') as typeof import('fs')).existsSync
  `),
  ).toEqual([])
})
