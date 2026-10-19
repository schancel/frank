<template>
  <div
    role="region"
    :aria-label="ui.panelAriaLabel"
    class="dapp-bridge-panel q-pa-md column q-gutter-y-md"
    data-testid="dapp-bridge-panel"
  >
    <div class="row items-center justify-between">
      <div class="text-subtitle1 text-weight-bold">
        {{ ui.headerTitle }}
      </div>
      <q-badge
        color="primary"
        data-testid="dapp-runtime-mode"
        :label="runtimeBadgeLabel"
      />
    </div>

    <!-- Active dApp Persona EOA Card (#1708) -->
    <q-card flat bordered data-testid="dapp-persona-card">
      <q-card-section class="q-pb-xs">
        <div class="row items-center justify-between">
          <div class="text-subtitle2 text-weight-medium">
            {{ personaTitleText }}
          </div>
          <div class="text-caption text-grey-7" data-testid="dapp-persona-path">
            {{ activeDerivationPath }}
          </div>
        </div>
        <div
          class="text-caption text-mono q-mt-xs"
          data-testid="dapp-persona-address"
        >
          {{ activePersonaAddress }}
        </div>
      </q-card-section>

      <q-card-section class="row q-col-gutter-sm q-pt-xs">
        <div class="col-6">
          <div class="text-caption text-grey-7">
            {{ ui.personaBalanceLabel }}
          </div>
          <div
            class="text-body2 text-weight-bold"
            data-testid="dapp-persona-balance"
          >
            {{ formattedPersonaBalance }}
          </div>
        </div>
        <div class="col-6">
          <div class="text-caption text-grey-7">
            {{ ui.poolBalanceLabel }}
          </div>
          <div
            class="text-body2 text-weight-bold"
            data-testid="dapp-pool-balance"
          >
            {{ formattedPoolBalance }}
          </div>
        </div>
      </q-card-section>

      <q-card-actions align="between" class="q-px-md q-pb-md">
        <q-btn
          flat
          dense
          color="secondary"
          data-testid="dapp-create-burner-btn"
          :label="ui.createBurnerBtn"
          @click="createBurnerPersona"
        />
        <q-btn
          flat
          dense
          color="primary"
          data-testid="dapp-topup-persona-btn"
          :label="ui.topUpFromPoolBtn"
          @click="topUpFromPool"
        />
        <q-btn
          flat
          dense
          color="warning"
          data-testid="dapp-sweep-back-btn"
          :label="ui.sweepBackToPoolBtn"
          @click="sweepBackToPool"
        />
      </q-card-actions>
    </q-card>

    <!-- Inline dApp Approval Queue (#1709) -->
    <q-card
      v-if="currentApproval"
      flat
      bordered
      data-testid="dapp-approval-card"
    >
      <q-card-section>
        <div class="row items-center justify-between">
          <div class="text-subtitle2 text-weight-bold">
            {{ ui.approvalTitle }}
          </div>
          <q-badge
            color="positive"
            data-testid="dapp-approval-origin"
            :label="currentApproval.origin"
          />
        </div>

        <div class="q-mt-sm text-body2" data-testid="dapp-approval-method">
          {{ approvalMethodSummary }}
        </div>

        <div
          v-if="currentApprovalShortfall > 0"
          class="q-mt-xs text-caption text-warning"
          data-testid="dapp-jit-sweep-notice"
        >
          {{ jitSweepNoticeText }}
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn
          flat
          color="negative"
          data-testid="dapp-reject-btn"
          :label="ui.rejectBtn"
          @click="rejectCurrentRequest"
        />
        <q-btn
          unelevated
          color="positive"
          data-testid="dapp-approve-btn"
          :label="ui.approveBtn"
          @click="approveCurrentRequest"
        />
      </q-card-actions>
    </q-card>

    <!-- Standalone PWA Pairing & Extension Sync Section (#1710) -->
    <q-card flat bordered data-testid="dapp-pwa-sync-section">
      <q-card-section>
        <div class="text-subtitle2 text-weight-medium">
          {{ ui.pwaSyncTitle }}
        </div>

        <div class="row items-center q-col-gutter-sm q-mt-xs">
          <div class="col">
            <q-input
              v-model="wcUriInput"
              dense
              outlined
              data-testid="dapp-wc-uri-input"
              :label="ui.wcInputLabel"
              :placeholder="ui.wcInputPlaceholder"
            />
          </div>
          <div class="col-auto">
            <q-btn
              unelevated
              color="primary"
              data-testid="dapp-wc-connect-btn"
              :label="ui.wcConnectBtn"
              @click="connectWalletConnectUri"
            />
          </div>
        </div>

        <div
          v-if="pairedWcUri"
          class="text-caption text-positive q-mt-xs"
          data-testid="dapp-wc-paired-status"
        >
          {{ pairedWcStatusText }}
        </div>

        <q-separator class="q-my-md" />

        <div class="row items-center justify-between">
          <q-btn
            outline
            color="primary"
            data-testid="dapp-extension-sync-btn"
            :label="ui.syncExtensionBtn"
            @click="triggerExtensionSync"
          />
          <div
            class="text-subtitle2 text-weight-bold"
            data-testid="dapp-sync-sas-code"
          >
            {{ sasDisplayText }}
          </div>
        </div>
      </q-card-section>
    </q-card>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, PropType, ref } from 'vue'
import {
  getExtensionRuntime,
  RuntimeEnvironmentKind,
} from '../../../src-bex/runtime-adapter'
import { FRANK_PWA_EXTENSION_SYNC_CHANNEL } from '../../../src-bex/content'

export interface DappApprovalItem {
  id: string
  origin: string
  method:
    | 'connect'
    | 'eth_requestAccounts'
    | 'personal_sign'
    | 'eth_signTypedData_v4'
    | 'eth_sendTransaction'
    | string
  requiredAmountMon?: number
  summary?: string
}

const PERSONA_ADDRESSES = [
  '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
  '0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7',
  '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
  '0x78731D3Ca6b7E34aC0F824c42a7cC18A495cabaB',
]

export default defineComponent({
  name: 'DappBridgePanel',
  props: {
    initialPersonaBalanceMon: {
      type: Number,
      default: 5,
    },
    initialPoolBalanceMon: {
      type: Number,
      default: 120,
    },
    initialApprovals: {
      type: Array as PropType<DappApprovalItem[]>,
      default: () => [
        {
          id: 'req-default-1',
          origin: 'https://app.uniswap.org',
          method: 'eth_sendTransaction',
          requiredAmountMon: 15,
          summary: 'Swap 15 MON for USDC',
        },
      ],
    },
    runtimeKindOverride: {
      type: String as PropType<RuntimeEnvironmentKind | ''>,
      default: '',
    },
    initialSasCode: {
      type: String,
      default: '482910',
    },
  },
  emits: [
    'create-burner',
    'topup-persona',
    'sweep-to-pool',
    'approve-request',
    'reject-request',
    'wc-connect',
    'extension-sync',
  ],
  setup(props, { emit }) {
    const personaIndex = ref(0)
    const personaBalanceMon = ref(props.initialPersonaBalanceMon)
    const poolBalanceMon = ref(props.initialPoolBalanceMon)
    const approvals = ref<DappApprovalItem[]>([...props.initialApprovals])
    const wcUriInput = ref('')
    const pairedWcUri = ref('')
    const sasCode = ref(props.initialSasCode)
    const syncTriggered = ref(false)

    const ui = Object.freeze({
      panelAriaLabel: 'Frank dApp Bridge Companion Panel',
      headerTitle: 'dApp Bridge & Persona Companion',
      personaBalanceLabel: 'Persona Balance',
      poolBalanceLabel: 'Frank Pool Balance',
      createBurnerBtn: 'Create Burner Persona',
      topUpFromPoolBtn: 'Top Up from Pool',
      sweepBackToPoolBtn: 'Sweep Back to Pool',
      approvalTitle: 'Pending dApp Approval',
      approveBtn: 'Approve',
      rejectBtn: 'Reject',
      pwaSyncTitle: 'Standalone PWA Pairing & Extension Sync',
      wcInputLabel: 'WalletConnect or dApp URI',
      wcInputPlaceholder: 'wc:00e46b69-d0cc-4b3e-b6a2-...',
      wcConnectBtn: 'Pair URI',
      syncExtensionBtn: 'Sync with Browser Extension',
    })

    const detectedRuntimeKind = computed<RuntimeEnvironmentKind>(() => {
      if (props.runtimeKindOverride) {
        return props.runtimeKindOverride
      }
      return getExtensionRuntime().kind
    })

    const runtimeBadgeLabel = computed(() => {
      switch (detectedRuntimeKind.value) {
        case 'chrome-extension':
          return 'Browser Extension (Chrome Side Panel)'
        case 'firefox-extension':
          return 'Browser Extension (Firefox Sidebar)'
        case 'safari-extension':
          return 'Browser Extension (Safari Popup)'
        default:
          return 'Standalone PWA (signet.mx)'
      }
    })

    const activeDerivationPath = computed(
      () => `m/44'/60'/1'/0/${personaIndex.value}`,
    )

    const activePersonaAddress = computed(
      () =>
        PERSONA_ADDRESSES[personaIndex.value % PERSONA_ADDRESSES.length] ??
        PERSONA_ADDRESSES[0],
    )

    const personaTitleText = computed(() =>
      personaIndex.value === 0
        ? 'Default dApp Persona EOA'
        : `Burner Persona #${personaIndex.value}`,
    )

    const formattedPersonaBalance = computed(
      () => `${personaBalanceMon.value.toFixed(2)} MON`,
    )
    const formattedPoolBalance = computed(
      () => `${poolBalanceMon.value.toFixed(2)} MON`,
    )

    const currentApproval = computed<DappApprovalItem | null>(
      () => approvals.value[0] ?? null,
    )

    const currentApprovalShortfall = computed(() => {
      const req = currentApproval.value
      if (!req || !req.requiredAmountMon) return 0
      return Math.max(0, req.requiredAmountMon - personaBalanceMon.value)
    })

    const approvalMethodSummary = computed(() => {
      const req = currentApproval.value
      if (!req) return ''
      return req.summary
        ? `${req.method} — ${req.summary}`
        : `Method: ${req.method}`
    })

    const jitSweepNoticeText = computed(
      () =>
        `JIT Pool Sweep required: +${currentApprovalShortfall.value.toFixed(
          2,
        )} MON from Frank Pool`,
    )

    const pairedWcStatusText = computed(
      () => `Paired dApp URI: ${pairedWcUri.value}`,
    )

    const sasDisplayText = computed(() =>
      syncTriggered.value
        ? `SAS Code: ${sasCode.value} (Synced)`
        : `SAS Code: ${sasCode.value}`,
    )

    function createBurnerPersona() {
      personaIndex.value += 1
      personaBalanceMon.value = 0
      const payload = {
        index: personaIndex.value,
        path: activeDerivationPath.value,
        address: activePersonaAddress.value,
      }
      emit('create-burner', payload)
    }

    function topUpFromPool() {
      const amount = Math.min(10, poolBalanceMon.value)
      if (amount <= 0) return
      poolBalanceMon.value -= amount
      personaBalanceMon.value += amount
      emit('topup-persona', {
        amountMon: amount,
        personaBalanceMon: personaBalanceMon.value,
        poolBalanceMon: poolBalanceMon.value,
      })
    }

    function sweepBackToPool() {
      const swept = personaBalanceMon.value
      if (swept <= 0) return
      personaBalanceMon.value = 0
      poolBalanceMon.value += swept
      emit('sweep-to-pool', {
        sweptMon: swept,
        personaBalanceMon: personaBalanceMon.value,
        poolBalanceMon: poolBalanceMon.value,
      })
    }

    function approveCurrentRequest() {
      const req = currentApproval.value
      if (!req) return
      const shortfall = currentApprovalShortfall.value
      if (shortfall > 0 && poolBalanceMon.value >= shortfall) {
        poolBalanceMon.value -= shortfall
        personaBalanceMon.value += shortfall
      }
      if (req.requiredAmountMon && personaBalanceMon.value >= req.requiredAmountMon) {
        personaBalanceMon.value -= req.requiredAmountMon
      }
      approvals.value.shift()
      emit('approve-request', {
        request: req,
        jitSweptMon: shortfall,
      })
    }

    function rejectCurrentRequest() {
      const req = currentApproval.value
      if (!req) return
      approvals.value.shift()
      emit('reject-request', {
        request: req,
      })
    }

    function connectWalletConnectUri() {
      const trimmed = wcUriInput.value.trim()
      if (!trimmed) return
      pairedWcUri.value = trimmed
      approvals.value.unshift({
        id: `wc-${Date.now()}`,
        origin: 'wc://paired-dapp',
        method: 'connect',
        summary: `Pair session (${trimmed.slice(0, 18)}...)`,
      })
      emit('wc-connect', { uri: trimmed })
      wcUriInput.value = ''
    }

    function triggerExtensionSync() {
      syncTriggered.value = true
      const syncPayload = {
        sasCode: sasCode.value,
        deviceSyncBundle: {
          version: 1,
          activePersonaPath: activeDerivationPath.value,
          activePersonaAddress: activePersonaAddress.value,
        },
      }
      if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
        window.postMessage(
          {
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            direction: 'to-extension',
            type: 'pwa-sync-handshake',
            id: `sync-${Date.now()}`,
            payload: syncPayload,
          },
          '*',
        )
      }
      emit('extension-sync', syncPayload)
    }

    return {
      ui,
      wcUriInput,
      pairedWcUri,
      runtimeBadgeLabel,
      activeDerivationPath,
      activePersonaAddress,
      personaTitleText,
      formattedPersonaBalance,
      formattedPoolBalance,
      currentApproval,
      currentApprovalShortfall,
      approvalMethodSummary,
      jitSweepNoticeText,
      pairedWcStatusText,
      sasDisplayText,
      createBurnerPersona,
      topUpFromPool,
      sweepBackToPool,
      approveCurrentRequest,
      rejectCurrentRequest,
      connectWalletConnectUri,
      triggerExtensionSync,
    }
  },
})
</script>
