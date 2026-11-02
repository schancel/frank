/** @jest-environment node */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import type { FrankSolanaWalletStandard } from './inpage'

it('packages a standalone inpage provider that returns Wallet Standard signature bytes for every browser', async () => {
  // Run the real packager with no PWA assets, keeping all outputs in this fixture.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-inpage-bundle-'))
  const appDir = path.resolve(__dirname, '..')
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'))
    fs.copyFileSync(
      path.join(appDir, 'scripts/build-extension.mjs'),
      path.join(fixture, 'scripts/build-extension.mjs'),
    )
    fs.copyFileSync(
      path.join(appDir, 'package.json'),
      path.join(fixture, 'package.json'),
    )
    fs.symlinkSync(
      path.join(appDir, 'src-bex'),
      path.join(fixture, 'src-bex'),
      'dir',
    )
    fs.symlinkSync(
      path.dirname(require.resolve('typescript/package.json')) + '/..',
      path.join(fixture, 'node_modules'),
      'dir',
    )
    execFileSync(
      process.execPath,
      [
        path.join(fixture, 'scripts/build-extension.mjs'),
        '--skip-pwa-build',
        '--zip',
      ],
      {
        env: {
          ...process.env,
          APP_DIST_DIR: path.join(fixture, 'missing-pwa'),
        },
        stdio: 'pipe',
        timeout: 30000,
      },
    )

    for (const target of ['chrome', 'firefox', 'safari']) {
      const archive = path.join(
        fixture,
        'dist/extensions',
        `frank-extension-${target}.zip`,
      )
      const script = execFileSync('unzip', ['-p', archive, 'inpage.js'], {
        encoding: 'utf8',
      })
      expect(script).toBe(
        fs.readFileSync(
          path.join(fixture, 'dist/extensions', target, 'inpage.js'),
          'utf8',
        ),
      )

      const calls: unknown[] = []
      const page = Object.assign(new EventTarget(), {
        postMessage(request: {
          channel: string
          id: string
          payload: { method: string; params: unknown }
        }) {
          calls.push(request.payload)
          const result =
            request.payload.method === 'solana_connect'
              ? { address: 'dummy-account', publicKey: Array(32).fill(0) }
              : '1'.repeat(63) + '2'
          page.dispatchEvent(
            new MessageEvent('message', {
              data: {
                channel: request.channel,
                direction: 'to-inpage',
                type: 'rpc-response',
                id: request.id,
                result,
              },
            }),
          )
        },
      })
      let wallet: FrankSolanaWalletStandard | undefined
      page.addEventListener('wallet-standard:register-wallet', event => {
        const register = (event as CustomEvent).detail
        register({
          register: (registered: FrankSolanaWalletStandard) => {
            wallet = registered
          },
        })
      })
      // Classic page script: deliberately provide no Node loader or dynamic-import resolver.
      vm.runInNewContext(
        script,
        { window: page, CustomEvent, Uint8Array, console },
        { filename: `${target}/inpage.js` },
      )
      expect(wallet).toBeDefined()
      const { accounts } = await wallet!.features['standard:connect'].connect()
      const account = accounts[0]
      const results = await wallet!.features[
        'solana:signAndSendTransaction'
      ].signAndSendTransaction({
        account,
        chain: 'solana:devnet',
        transaction: new Uint8Array([1, 2, 3]),
      })
      expect(calls).toEqual([
        { method: 'solana_connect', params: undefined },
        {
          method: 'solana_signAndSendTransaction',
          params: {
            transaction: [1, 2, 3],
            account: 'dummy-account',
            chain: 'solana:devnet',
          },
        },
      ])
      expect(results).toEqual([
        {
          signature: Uint8Array.from([...Array(63).fill(0), 1]),
          account,
          chain: 'solana:devnet',
        },
      ])
      expect(script).not.toMatch(/\bimport\s*\(/)
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}, 45000)
