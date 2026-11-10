import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import ts from 'typescript'

it('resolves optional public leaves to the same source in Node and TypeScript', () => {
  // A package self-reference exercises its own export map without following another
  // worktree's shared node_modules workspace link. Neither resolver evaluates the modules.
  const requireFromPackage = createRequire(
    resolve(__dirname, '../package.json'),
  )
  for (const [specifier, source] of [
    ['@frank/price-feeds', 'src/index.ts'],
    [
      '@frank/price-feeds/temporary-direct-feed',
      'src/temporary-direct-feed.ts',
    ],
    ['@frank/price-feeds/historical', 'src/historical/index.ts'],
  ]) {
    const expected = resolve(__dirname, '..', source)
    expect(requireFromPackage.resolve(specifier)).toBe(expected)
    const resolution = ts.resolveModuleName(
      specifier,
      __filename,
      {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      ts.sys,
    )
    expect(resolution.resolvedModule?.resolvedFileName).toBe(expected)
  }
})
