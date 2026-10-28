/**
 * Tabs of one device tell each other of a claim over the `frank:leader-sync` BroadcastChannel.
 * The message names the account it is about; a tab takes it only when it has that account open.
 *
 * Each "tab" is its own copy of the active-device module, with its own channel and store, as two
 * browser tabs are. Plain `node` environment: Node's BroadcastChannel delivers between the
 * channels of one process, and there is no shared localStorage, so each tab has its own instance
 * ID as the tabs of a device with storage blocked would.
 */
import type * as LeaderModule from './leader'
import type * as PiniaModule from 'pinia'

const ME = '0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a'
const OTHER = '0x3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c'

type Leader = ReturnType<typeof LeaderModule.useLeaderStore>

const open: Leader[] = []

function openTab(accountKey: string): Leader {
  let leader: Leader | undefined
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pinia = require('pinia') as typeof PiniaModule
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require('./leader') as typeof LeaderModule
    pinia.setActivePinia(pinia.createPinia())
    leader = module.useLeaderStore()
  })
  leader!.selectAccount(accountKey)
  leader!.initSyncChannel()
  open.push(leader!)
  return leader!
}

/** Lets the channel deliver what was posted. */
async function delivered(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

afterEach(() => {
  // Closes each tab's channel, so the test exits.
  for (const leader of open.splice(0)) leader.resetForTesting()
})

describe("a claim told to the device's other tabs", () => {
  it('is taken by a tab with the same account open', async () => {
    const claiming = openTab(ME)
    const listening = openTab(ME.toUpperCase().replace('0X', '0x'))
    expect(listening.isActiveMaster).toBe(true)

    claiming.claimMasterRole()
    await delivered()

    expect(listening.masterInstanceId).toBe(claiming.myInstanceId)
    expect(listening.masterClaimedAt).toBe(claiming.masterClaimedAt)
    expect(listening.isActiveMaster).toBe(false)
  })

  it('is ignored by a tab with another account open', async () => {
    const claiming = openTab(ME)
    const listening = openTab(OTHER)

    claiming.claimMasterRole()
    await delivered()

    expect(listening.masterInstanceId).toBeNull()
    expect(listening.masterClaimedAt).toBe(0)
    expect(listening.isActiveMaster).toBe(true)

    // The same tab still takes a claim about its own account.
    const sameAccount = openTab(OTHER)
    sameAccount.claimMasterRole()
    await delivered()
    expect(listening.masterInstanceId).toBe(sameAccount.myInstanceId)
  })

  it('ignores a message that names no account, or not as a string', async () => {
    const listening = openTab(ME)
    const tab = new BroadcastChannel('frank:leader-sync')
    try {
      for (const accountKey of [undefined, null, 7]) {
        tab.postMessage({
          type: 'leader-claim',
          accountKey,
          instanceId: 'a-tab-of-unknown-account',
          claimedAt: Date.now(),
        })
      }
      await delivered()
    } finally {
      tab.close()
    }
    expect(listening.masterInstanceId).toBeNull()
    expect(listening.isActiveMaster).toBe(true)
  })

  it('is ignored by a tab that has since switched to another account', async () => {
    const claiming = openTab(ME)
    const listening = openTab(ME)
    listening.selectAccount(OTHER)

    claiming.claimMasterRole()
    await delivered()

    expect(listening.accountKey).toBe(OTHER)
    expect(listening.masterInstanceId).toBeNull()
    expect(listening.isActiveMaster).toBe(true)
  })
})
