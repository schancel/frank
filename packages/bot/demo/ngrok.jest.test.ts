import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  locateUserNgrokConfig,
  renderDemoNgrokYaml,
  startNgrok,
} from './ngrok'
import { Supervisor } from './supervisor'

describe('ngrok launcher helper', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ngrok-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('renderDemoNgrokYaml', () => {
    it('generates v3 YAML with app tunnel by default for single-domain setups', () => {
      const yaml = renderDemoNgrokYaml({ relayPort: 8098, appPort: 8080 })
      expect(yaml).toContain('version: "3"')
      expect(yaml).toContain('app:')
      expect(yaml).toContain('addr: 8080')
      expect(yaml).not.toContain('relay:')
      expect(yaml).not.toContain('authtoken:')
      expect(yaml).not.toContain('domain:')
    })

    it('includes authtoken when provided', () => {
      const yaml = renderDemoNgrokYaml({
        relayPort: 8098,
        appPort: 8080,
        authtoken: 'test-token-123',
      })
      expect(yaml).toContain('agent:')
      expect(yaml).toContain('authtoken: test-token-123')
    })

    it('includes both tunnels when distinct custom domains are provided', () => {
      const yaml = renderDemoNgrokYaml({
        relayPort: 8098,
        appPort: 8080,
        relayDomain: 'relay.example.ngrok.app',
        appDomain: 'app.example.ngrok.app',
      })
      expect(yaml).toContain('app:')
      expect(yaml).toContain('domain: app.example.ngrok.app')
      expect(yaml).toContain('relay:')
      expect(yaml).toContain('domain: relay.example.ngrok.app')
    })

    it('includes both tunnels when explicitly requested', () => {
      const yaml = renderDemoNgrokYaml({
        relayPort: 8098,
        appPort: 8080,
        includeRelay: true,
        includeApp: true,
      })
      expect(yaml).toContain('app:')
      expect(yaml).toContain('relay:')
    })

    it('generates relay-only tunnel when includeApp is false', () => {
      const yaml = renderDemoNgrokYaml({
        relayPort: 8098,
        appPort: 8080,
        includeApp: false,
      })
      expect(yaml).not.toContain('app:')
      expect(yaml).toContain('relay:')
      expect(yaml).toContain('addr: 8098')
    })
  })

  describe('locateUserNgrokConfig', () => {
    it('returns a path or undefined without throwing', () => {
      expect(() => locateUserNgrokConfig()).not.toThrow()
    })
  })

  describe('startNgrok', () => {
    it('polls tunnels API and returns discovered public URLs', async () => {
      const supervisor = new Supervisor(process.env)
      const logDir = join(tmpDir, 'logs')
      mkdirSync(logDir, { recursive: true })

      // Mock fetch returning tunnels response on second attempt
      let attempts = 0
      const mockFetch = async () => {
        attempts++
        if (attempts === 1) {
          throw new Error('Connection refused')
        }
        return {
          ok: true,
          json: async () => ({
            tunnels: [
              { name: 'relay', public_url: 'https://relay-123.ngrok-free.dev', proto: 'https' },
              { name: 'app', public_url: 'https://app-456.ngrok-free.dev', proto: 'https' },
            ],
            uri: '/api/tunnels',
          }),
        }
      }

      // Use node -e to run a script that stays alive
      const result = await startNgrok({
        stateDir: tmpDir,
        logDir,
        relayPort: 8098,
        appPort: 8080,
        ngrokBin: process.execPath,
        argsOverride: ['-e', 'setTimeout(() => {}, 10000)'],
        ngrokConfig: join(tmpDir, 'user-ngrok.yml'),
        supervisor,
        pollMs: 10,
        timeoutMs: 2000,
        fetchFn: mockFetch,
      })

      expect(result.publicRelayUrl).toBe('https://relay-123.ngrok-free.dev')
      expect(result.publicAppUrl).toBe('https://app-456.ngrok-free.dev')
      await supervisor.stopAll()
    })

    it('throws if ngrok process exits prematurely', async () => {
      const supervisor = new Supervisor(process.env)
      const logDir = join(tmpDir, 'logs')
      mkdirSync(logDir, { recursive: true })

      try {
        await expect(
          startNgrok({
            stateDir: tmpDir,
            logDir,
            relayPort: 8098,
            appPort: 8080,
            ngrokBin: process.execPath,
            argsOverride: ['-e', 'process.exit(1)'],
            ngrokConfig: undefined,
            supervisor,
            pollMs: 10,
            timeoutMs: 2000,
            fetchFn: async () => {
              throw new Error('not responding')
            },
          }),
        ).rejects.toThrow(/ngrok exited unexpectedly/)
      } finally {
        await supervisor.stopAll()
      }
    })
  })
})
