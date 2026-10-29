import { execFile } from 'child_process'

import { ensureSolonet } from './monad-regtest'

jest.mock('child_process', () => ({ execFile: jest.fn() }))

const localRpc = 'http://127.0.0.1:48080'
const dockerContext = ['--context', 'colima-frank-solonet']

describe('ensureSolonet retained-chain boundary', () => {
  let vmRunning: boolean
  let container: string
  let readyLocalRpc: boolean
  let commands: { command: string; args: string[] }[]
  let fetchMock: jest.SpyInstance

  beforeEach(() => {
    vmRunning = true
    container = 'running'
    readyLocalRpc = false
    commands = []
    jest.mocked(execFile).mockImplementation((...input: unknown[]) => {
      const [command, args, , callback] = input as [
        string,
        string[],
        unknown,
        (error: Error | null, stdout: string, stderr: string) => void,
      ]
      commands.push({ command, args })
      let code = 0
      let out = ''
      if (command === 'colima' && args[0] === 'version')
        out = 'colima test fixture'
      else if (command === 'colima' && args[0] === 'status')
        code = vmRunning ? 0 : 1
      else if (command === 'colima' && args[0] === 'start') vmRunning = true
      else if (command === 'colima' && args[0] === 'ssh')
        out = 'fixture sysctl applied'
      else if (command === 'docker' && args[2] === 'ps') out = container
      else if (command === 'docker' && args[2] === 'rm') container = ''
      else if (command === 'docker' && args[2] === 'run') container = 'running'
      else
        throw new Error(
          `Unexpected mocked subprocess: ${command} ${args.join(' ')}`,
        )
      callback(
        code
          ? Object.assign(new Error('fixture process failed'), { code })
          : null,
        out,
        '',
      )
      return {} as ReturnType<typeof execFile>
    })
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string }
        if (request.method === 'eth_chainId') {
          return new Response(
            JSON.stringify({ result: readyLocalRpc ? '0x4eaf' : undefined }),
          )
        }
        if (request.method === 'eth_blockNumber')
          return new Response(JSON.stringify({ result: '0x20' }))
        throw new Error(`Unexpected mocked RPC method: ${request.method}`)
      })
  })

  afterEach(() => {
    fetchMock.mockRestore()
    jest.mocked(execFile).mockReset()
  })

  const dockerMutations = () =>
    commands.filter(
      ({ command, args }) =>
        command === 'docker' && ['rm', 'run'].includes(args[2]),
    )

  it.each<[boolean, string]>([
    [true, 'exited'],
    [true, 'created'],
    [true, 'dead'],
    [false, 'exited'],
    [false, 'created'],
    [false, 'dead'],
  ])(
    'preserves a %s-VM existing %s container, including discovery after boot',
    async (running, state) => {
      vmRunning = running
      container = state
      const outcome = await ensureSolonet({}, jest.fn()).then(
        () => undefined,
        (error: unknown) => error,
      )

      // Assert the destructive effect first: the old helper actually reaches rm/run here.
      expect(dockerMutations()).toEqual([])
      expect(container).toBe(state)
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toMatch(/stopped.*retained/i)
      expect(
        commands.some(
          ({ command, args }) => command === 'colima' && args[0] === 'ssh',
        ),
      ).toBe(false)
      expect(
        commands.filter(
          ({ command, args }) => command === 'colima' && args[0] === 'start',
        ),
      ).toHaveLength(running ? 0 : 1)
    },
  )

  it.each([true, false])(
    'creates a chain only when absent (VM running: %s)',
    async running => {
      vmRunning = running
      container = ''

      await expect(ensureSolonet({}, jest.fn())).resolves.toEqual({
        rpcUrl: localRpc,
        wsUrl: 'ws://127.0.0.1:48081',
      })
      expect(dockerMutations()).toEqual([
        {
          command: 'docker',
          args: [
            ...dockerContext,
            'run',
            '-d',
            '--name',
            'frank-solonet',
            '--privileged',
            '--ulimit',
            'nofile=16384:16384',
            '-p',
            '127.0.0.1:48080:8080',
            '-p',
            '127.0.0.1:48081:8081',
            'monadcrypto/monad-solonet',
          ],
        },
      ])
      expect(
        commands.filter(
          ({ command, args }) => command === 'colima' && args[0] === 'ssh',
        ),
      ).toHaveLength(1)
      expect(
        commands.filter(
          ({ command, args }) => command === 'colima' && args[0] === 'start',
        ),
      ).toHaveLength(running ? 0 : 1)
    },
  )

  it.each([true, false])(
    'attaches to a running chain without container mutation (VM running: %s)',
    async running => {
      vmRunning = running
      await expect(ensureSolonet({}, jest.fn())).resolves.toEqual({
        rpcUrl: localRpc,
        wsUrl: 'ws://127.0.0.1:48081',
      })
      expect(dockerMutations()).toEqual([])
      expect(
        commands.some(
          ({ command, args }) => command === 'colima' && args[0] === 'ssh',
        ),
      ).toBe(false)
      expect(
        commands.filter(
          ({ command, args }) => command === 'colima' && args[0] === 'start',
        ),
      ).toHaveLength(running ? 0 : 1)
    },
  )

  it('attaches to an already answering local Solonet without invoking host processes', async () => {
    readyLocalRpc = true
    await expect(ensureSolonet({}, jest.fn())).resolves.toEqual({
      rpcUrl: localRpc,
      wsUrl: 'ws://127.0.0.1:48081',
    })
    expect(commands).toEqual([])
  })

  it('attaches to an explicitly external chain without local host or container mutation', async () => {
    const rpcUrl = 'http://external-solonet.invalid:48080'
    await expect(
      ensureSolonet({ FRANK_SOLONET_RPC_URL: rpcUrl }, jest.fn()),
    ).resolves.toEqual({ rpcUrl })
    expect(commands).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(rpcUrl)
  })
})
