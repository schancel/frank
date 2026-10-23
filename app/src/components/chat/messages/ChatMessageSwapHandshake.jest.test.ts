/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { sha256 } from '@noble/hashes/sha256'
import { utf8ToBytes } from '@noble/hashes/utils'
import {
  DEFAULT_SWAP_LEASE_DURATION_MS,
  deriveSwapSecrets,
  foldSwapHandshakeState,
  type FoldedSwapHandshakeState,
  type SwapHandshakePayload,
} from '@frank/wallet/message-item-plugins/swap-handshake'
import ChatMessageSwapHandshake from './ChatMessageSwapHandshake.vue'

const quasarStubs = {
  QBadge: {
    template: '<span class="q-badge-stub"><slot /></span>',
  },
  QBtn: {
    props: ['label', 'disable', 'loading'],
    emits: ['click'],
    template:
      '<button type="button" :disabled="disable" @click="!disable && $emit(\'click\', $event)">{{ label }}<slot /></button>',
  },
}

const globalMountConfig = {
  stubs: quasarStubs,
  mocks: {
    $t: (key: string) => key,
  },
}

const masterSeed = sha256(utf8ToBytes('chat-message-swap-handshake-seed-1705'))
const swapSecrets = deriveSwapSecrets({
  masterSeed,
  swapId: 'swap_card_test_1705',
  role: 'maker',
})

function makeBaseProposal(): SwapHandshakePayload {
  return {
    schemaVersion: 1,
    swapId: 'swap_card_test_1705',
    mode: 'atomic_swap',
    action: 'propose',
    sequence: 0,
    executorDeviceId: 'device-phone',
    leaseExpiresAtMs: 1_700_000_000_000 + DEFAULT_SWAP_LEASE_DURATION_MS,
    makerAddress: '0x1111111111111111111111111111111111111111',
    takerAddress: '0x2222222222222222222222222222222222222222',
    giveLeg: {
      chainKey: 'monad',
      assetSymbol: 'MON',
      amountAtomic: '100000000000000000000', // 100 MON
      decimals: 18,
      recipientAddress: '0x2222222222222222222222222222222222222222',
    },
    wantLeg: {
      chainKey: 'solana',
      assetSymbol: 'SOL',
      amountAtomic: '5000000000', // 5 SOL
      decimals: 9,
      recipientAddress: 'So11111111111111111111111111111111111111112',
    },
    hashlockSha256Hex: swapSecrets.hashlockSha256Hex,
    timelockExpiresAtMs: 1_700_003_600_000,
    memo: 'OTC Swap 100 MON for 5 SOL',
  }
}

describe('ChatMessageSwapHandshake (#1705)', () => {
  it('renders giveLeg <-> wantLeg amounts, chain badges, 4-step progress indicator, and emits accept/cancel actions on the leader device', async () => {
    const state = foldSwapHandshakeState([makeBaseProposal()], {
      localDeviceId: 'device-phone',
      nowMs: 1_700_000_010_000,
    }) as FoldedSwapHandshakeState

    const wrapper = mount(ChatMessageSwapHandshake, {
      props: { state },
      global: globalMountConfig,
    })

    expect(wrapper.find('[data-testid="swap-handshake-card"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="swap-give-leg"]').text()).toContain(
      '100 MON',
    )
    expect(wrapper.find('[data-testid="swap-give-leg"]').text()).toContain(
      'monad',
    )
    expect(wrapper.find('[data-testid="swap-want-leg"]').text()).toContain(
      '5 SOL',
    )
    expect(wrapper.find('[data-testid="swap-want-leg"]').text()).toContain(
      'solana',
    )
    expect(wrapper.find('[data-testid="swap-phase-badge"]').text()).toBe(
      'Proposed',
    )
    expect(
      wrapper.find('[data-testid="swap-progress-steps"]').text(),
    ).toContain('Maker Locked')
    expect(
      wrapper.find('[data-testid="swap-progress-steps"]').text(),
    ).toContain('Both Locked')

    const acceptBtn = wrapper.find('[data-testid="swap-accept-btn"]')
    expect(acceptBtn.exists()).toBe(true)
    expect(acceptBtn.attributes('disabled')).toBeUndefined()
    await acceptBtn.trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual(['accept_and_lock'])

    const cancelBtn = wrapper.find('[data-testid="swap-cancel-btn"]')
    await cancelBtn.trigger('click')
    expect(wrapper.emitted('action')?.[1]).toEqual(['cancel'])
  })

  it('shows "Executing on another device" and disables duplicate broadcast buttons when another device holds an active lease', async () => {
    const state = foldSwapHandshakeState([makeBaseProposal()], {
      localDeviceId: 'device-laptop',
      nowMs: 1_700_000_010_000, // before leaseExpiresAtMs
    }) as FoldedSwapHandshakeState

    const wrapper = mount(ChatMessageSwapHandshake, {
      props: { state },
      global: globalMountConfig,
    })

    const leaseBanner = wrapper.find('[data-testid="swap-device-lease"]')
    expect(leaseBanner.exists()).toBe(true)
    expect(leaseBanner.text()).toContain('Executing on another device')
    expect(wrapper.find('[data-testid="swap-takeover-btn"]').exists()).toBe(
      false,
    )

    const acceptBtn = wrapper.find('[data-testid="swap-accept-btn"]')
    expect(acceptBtn.attributes('disabled')).toBeDefined()
    await acceptBtn.trigger('click')
    expect(wrapper.emitted('action')).toBeUndefined()
  })

  it('renders "Resume on This Device" takeover button when another device lease has expired', async () => {
    const state = foldSwapHandshakeState([makeBaseProposal()], {
      localDeviceId: 'device-laptop',
      nowMs: 1_700_000_000_000 + DEFAULT_SWAP_LEASE_DURATION_MS + 5_000,
    }) as FoldedSwapHandshakeState

    const wrapper = mount(ChatMessageSwapHandshake, {
      props: { state },
      global: globalMountConfig,
    })

    const takeoverBtn = wrapper.find('[data-testid="swap-takeover-btn"]')
    expect(takeoverBtn.exists()).toBe(true)
    expect(takeoverBtn.text()).toContain('Resume on This Device')

    await takeoverBtn.trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual(['lease_heartbeat'])
  })

  it('emits counter_lock, settle_claim, and refund across maker_locked and both_locked phases', async () => {
    const proposal = makeBaseProposal()
    const step1: SwapHandshakePayload = {
      schemaVersion: 1,
      swapId: proposal.swapId,
      mode: 'atomic_swap',
      action: 'accept_and_lock',
      sequence: 1,
      executorDeviceId: 'device-phone',
      leaseExpiresAtMs: 1_700_000_060_000,
      lockTxHash: '0xlock1',
    }

    const makerLockedState = foldSwapHandshakeState([proposal, step1], {
      localDeviceId: 'device-phone',
      nowMs: 1_700_000_010_000,
    }) as FoldedSwapHandshakeState

    const wrapper1 = mount(ChatMessageSwapHandshake, {
      props: { state: makerLockedState },
      global: globalMountConfig,
    })
    expect(wrapper1.find('[data-testid="swap-phase-badge"]').text()).toBe(
      'Maker Locked',
    )
    await wrapper1
      .find('[data-testid="swap-counter-lock-btn"]')
      .trigger('click')
    expect(wrapper1.emitted('action')?.[0]).toEqual(['counter_lock'])

    const step2: SwapHandshakePayload = {
      schemaVersion: 1,
      swapId: proposal.swapId,
      mode: 'atomic_swap',
      action: 'counter_lock',
      sequence: 2,
      executorDeviceId: 'device-phone',
      leaseExpiresAtMs: 1_700_000_060_000,
      counterLockTxHash: '0xlock2',
    }
    const bothLockedState = foldSwapHandshakeState([proposal, step1, step2], {
      localDeviceId: 'device-phone',
      nowMs: 1_700_000_015_000,
    }) as FoldedSwapHandshakeState

    const wrapper2 = mount(ChatMessageSwapHandshake, {
      props: { state: bothLockedState },
      global: globalMountConfig,
    })
    expect(wrapper2.find('[data-testid="swap-phase-badge"]').text()).toBe(
      'Both Locked',
    )
    await wrapper2.find('[data-testid="swap-settle-btn"]').trigger('click')
    await wrapper2.find('[data-testid="swap-refund-btn"]').trigger('click')
    expect(wrapper2.emitted('action')?.[0]).toEqual(['settle_claim'])
    expect(wrapper2.emitted('action')?.[1]).toEqual(['refund'])
  })
})
