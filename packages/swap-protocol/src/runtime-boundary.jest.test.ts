import { build } from 'esbuild'
import { resolve } from 'node:path'
test('headless recovery bundles for browser without wallet, host storage, UI or transport implementations', async () => {
  const output = await build({
    absWorkingDir: resolve(__dirname, '../../..'),
    entryPoints: [
      'packages/swap-protocol/src/runtime.ts',
      'packages/swap-protocol/src/host-identity.ts',
      'packages/swap-protocol/src/outgoing-negotiation.ts',
      'packages/swap-protocol/src/swap-execution-runtime.ts',
    ],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    outdir: '/unused',
  })
  for (const input of Object.keys(output.metafile!.inputs)) {
    expect(input).not.toMatch(
      /packages\/(?:wallet|cashweb|bot-framework)|negotiation-(?:browser|native)|node_modules\/(?:level|vue|pinia)/,
    )
    expect(
      output.metafile!.inputs[input].imports.some((item) =>
        item.path.startsWith('node:'),
      ),
    ).toBe(false)
  }
  expect(
    Object.values(output.metafile!.outputs).every(
      (value) => value.imports.length === 0,
    ),
  ).toBe(true)
})
