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

        <div
          v-if="personaOptionItems.length > 1"
          class="q-mt-sm"
          data-testid="dapp-persona-selector"
        >
          <select
            class="dapp-persona-dropdown full-width q-mb-xs"
            data-testid="dapp-persona-dropdown"
            :aria-label="ui.selectPersonaAriaLabel"
            :value="personaIndex"
            @change="onPersonaDropdownChange"
          >
            <option
              v-for="item in personaOptionItems"
              :key="`opt-${item.index}`"
              :value="item.index"
            >
              {{ item.dropdownLabel }}
            </option>
          </select>
          <div class="row items-center q-gutter-xs">
            <q-btn
              v-for="item in personaOptionItems"
              :key="item.index"
              :unelevated="item.index === personaIndex"
              :outline="item.index !== personaIndex"
              dense
              no-caps
              size="sm"
              :color="item.index === personaIndex ? 'primary' : 'grey-7'"
              :data-testid="item.testId"
              :label="item.label"
              @click="selectPersona(item.index)"
            />
          </div>
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
            :label="syncExtensionBtnLabel"
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
import { computed, defineComponent, onMounted, PropType, ref, watch } from 'vue'
import { formatUnits, getAddress, keccak256, toUtf8Bytes } from 'ethers'
import { activeChain } from '@frank/wallet/chain'
import {
  getExtensionRuntime,
  RuntimeEnvironmentKind,
  sendRuntimeMessage,
} from '../../../src-bex/runtime-adapter'
import { FRANK_PWA_EXTENSION_SYNC_CHANNEL } from '../../../src-bex/content'
import { FRANK_DAPP_BRIDGE_CHANNEL } from '../../../src-bex/inpage'
import { useBalance } from 'src/composables/useBalance'
import { useReactiveOwnCanonicalAddress } from 'src/utils/own-address'

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

export interface DiscoveredPersonaActivity {
  index: number
  address: string
  balanceMon: number
  txCount: number
  used: boolean
}

const FALLBACK_PERSONA_ADDRESSES = [
  '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
  '0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7',
  '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
  '0x78731D3Ca6b7E34aC0F824c42a7cC18A495cabaB',
]

export function deriveAccountPersonaAddress(
  identityAddress: string | null | undefined,
  index: number,
): string {
  const clean = typeof identityAddress === 'string' ? identityAddress.trim() : ''
  if (clean && /^0x[0-9a-fA-F]{40}$/.test(clean)) {
    try {
      if (index === 0) {
        return getAddress(clean)
      }
      const digest = keccak256(
        toUtf8Bytes(`frank-dapp-persona-v1:${clean.toLowerCase()}:${index}`),
      )
      return getAddress('0x' + digest.slice(-40))
    } catch {
      // Fall back below
    }
  }
  return (
    FALLBACK_PERSONA_ADDRESSES[index % FALLBACK_PERSONA_ADDRESSES.length] ??
    FALLBACK_PERSONA_ADDRESSES[0]
  )
}

function shortHexAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function resolveDefaultPersonaRpcUrl(): string {
  const relayBase = (activeChain.relayBaseUrl || 'https://relay.signet.mx').replace(
    /\/+$/,
    '',
  )
  const chainId = activeChain.chainIdentifier || 'monad-testnet'
  return `${relayBase}/chain-rpc/${chainId}/rpc`
}

export async function discoverUsedPersonasOnChain(
  rootAddress: string,
  options?: {
    rpcUrl?: string
    maxScan?: number
    gapLimit?: number
    knownMaxIndex?: number
    fetchImpl?: typeof fetch
  },
): Promise<DiscoveredPersonaActivity[]> {
  const clean = typeof rootAddress === 'string' ? rootAddress.trim() : ''
  if (!/^0x[0-9a-fA-F]{40}$/.test(clean)) return []
  const fetchFn =
    options?.fetchImpl ??
    (typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : undefined)
  if (!fetchFn) return []

  const rpcUrl = options?.rpcUrl || resolveDefaultPersonaRpcUrl()
  const maxScan = Math.max(options?.maxScan ?? 10, options?.knownMaxIndex ?? 0)
  const gapLimit = options?.gapLimit ?? 5
  const discovered: DiscoveredPersonaActivity[] = []

  try {
    const batchPayload: Array<{
      jsonrpc: '2.0'
      id: number
      method: string
      params: unknown[]
    }> = []
    for (let i = 1; i <= maxScan; i += 1) {
      const addr = deriveAccountPersonaAddress(clean, i)
      batchPayload.push({
        jsonrpc: '2.0',
        id: i * 2,
        method: 'eth_getBalance',
        params: [addr, 'latest'],
      })
      batchPayload.push({
        jsonrpc: '2.0',
        id: i * 2 + 1,
        method: 'eth_getTransactionCount',
        params: [addr, 'latest'],
      })
    }

    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batchPayload),
    })
    if (!res.ok) return []
    const json = await res.json()
    if (!Array.isArray(json)) return []

    const byId = new Map<number, string>()
    for (const entry of json) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.id === 'number' &&
        typeof entry.result === 'string'
      ) {
        byId.set(entry.id, entry.result)
      }
    }

    let consecutiveUnused = 0
    for (let i = 1; i <= maxScan; i += 1) {
      const balHex = byId.get(i * 2) ?? '0x0'
      const txHex = byId.get(i * 2 + 1) ?? '0x0'
      let balWei = 0n
      let txCount = 0
      try {
        balWei = BigInt(balHex)
      } catch {
        balWei = 0n
      }
      try {
        txCount = Number.parseInt(txHex, 16) || 0
      } catch {
        txCount = 0
      }
      const used = balWei > 0n || txCount > 0
      if (used || i <= (options?.knownMaxIndex ?? 0)) {
        const balanceMon = Number.parseFloat(formatUnits(balWei, 18))
        discovered.push({
          index: i,
          address: deriveAccountPersonaAddress(clean, i),
          balanceMon: Number.isFinite(balanceMon) ? balanceMon : 0,
          txCount,
          used,
        })
      }
      if (used) {
        consecutiveUnused = 0
      } else {
        consecutiveUnused += 1
        if (consecutiveUnused >= gapLimit && i >= (options?.knownMaxIndex ?? 0)) {
          break
        }
      }
    }
  } catch {
    // Ignore transient RPC discovery errors
  }

  return discovered
}

export default defineComponent({
  name: 'DappBridgePanel',
  props: {
    initialPersonaBalanceMon: {
      type: Number,
      default: 0,
    },
    initialPoolBalanceMon: {
      type: Number as PropType<number | undefined>,
      default: undefined,
    },
    initialApprovals: {
      type: Array as PropType<DappApprovalItem[]>,
      default: () => [],
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
    'select-persona',
    'topup-persona',
    'sweep-to-pool',
    'approve-request',
    'reject-request',
    'wc-connect',
    'extension-sync',
  ],
  setup(props, { emit }) {
    const { total: liveWalletBalanceWei } = useBalance()
    const ownCanonicalAddress = useReactiveOwnCanonicalAddress()
    const bridgeDefaultAddress = ref('')

    const personaIndex = ref(0)
    const maxPersonaIndex = ref(0)
    const personaBalancesByIndex = ref<Record<number, number>>({
      0: props.initialPersonaBalanceMon,
    })
    const usedPersonasByIndex = ref<Record<number, boolean>>({})

    const personaBalanceMon = computed({
      get: () => personaBalancesByIndex.value[personaIndex.value] ?? 0,
      set: (val: number) => {
        personaBalancesByIndex.value = {
          ...personaBalancesByIndex.value,
          [personaIndex.value]: Math.max(0, val),
        }
      },
    })

    const explicitPoolBalanceMon = ref<number | undefined>(
      props.initialPoolBalanceMon,
    )
    const poolTransferDeltaMon = ref(0)
    const approvals = ref<DappApprovalItem[]>([...props.initialApprovals])
    const wcUriInput = ref('')
    const pairedWcUri = ref('')
    const sasCode = ref(props.initialSasCode)
    const syncTriggered = ref(false)

    const resolvedRootAddress = computed(
      () => ownCanonicalAddress.value || bridgeDefaultAddress.value || '',
    )

    function personaStorageKey(rootAddr: string): string {
      return `frank:dapp-personas:${rootAddr.toLowerCase()}`
    }

    function persistPersonaMetadata() {
      const root = resolvedRootAddress.value
      if (!root || typeof window === 'undefined' || !window.localStorage) return
      try {
        window.localStorage.setItem(
          personaStorageKey(root),
          JSON.stringify({
            maxPersonaIndex: maxPersonaIndex.value,
            selectedIndex: personaIndex.value,
            usedByIndex: usedPersonasByIndex.value,
          }),
        )
      } catch {
        // Ignore storage errors
      }
    }

    function restorePersonaMetadata(root: string) {
      if (!root || typeof window === 'undefined' || !window.localStorage) return
      try {
        const raw = window.localStorage.getItem(personaStorageKey(root))
        if (!raw) return
        const parsed = JSON.parse(raw)
        if (
          typeof parsed?.maxPersonaIndex === 'number' &&
          parsed.maxPersonaIndex > maxPersonaIndex.value
        ) {
          maxPersonaIndex.value = parsed.maxPersonaIndex
        }
        if (
          typeof parsed?.selectedIndex === 'number' &&
          parsed.selectedIndex >= 0 &&
          parsed.selectedIndex <= maxPersonaIndex.value
        ) {
          personaIndex.value = parsed.selectedIndex
        }
        if (parsed?.usedByIndex && typeof parsed.usedByIndex === 'object') {
          usedPersonasByIndex.value = {
            ...usedPersonasByIndex.value,
            ...parsed.usedByIndex,
          }
        }
      } catch {
        // Ignore storage errors
      }
    }

    async function runAutomaticPersonaDiscovery(root: string) {
      if (!root || !/^0x[0-9a-fA-F]{40}$/.test(root)) return
      restorePersonaMetadata(root)
      const results = await discoverUsedPersonasOnChain(root, {
        knownMaxIndex: maxPersonaIndex.value,
      })
      if (results.length === 0) return
      const nextBalances = { ...personaBalancesByIndex.value }
      const nextUsed = { ...usedPersonasByIndex.value }
      let highestIdx = maxPersonaIndex.value
      for (const item of results) {
        if (item.used || item.index <= maxPersonaIndex.value) {
          nextBalances[item.index] = item.balanceMon
          if (item.used) {
            nextUsed[item.index] = true
          }
          if (item.index > highestIdx) {
            highestIdx = item.index
          }
        }
      }
      personaBalancesByIndex.value = nextBalances
      usedPersonasByIndex.value = nextUsed
      if (highestIdx > maxPersonaIndex.value) {
        maxPersonaIndex.value = highestIdx
      }
      persistPersonaMetadata()
    }

    const poolBalanceMon = computed(() => {
      if (explicitPoolBalanceMon.value !== undefined) {
        return Math.max(
          0,
          explicitPoolBalanceMon.value + poolTransferDeltaMon.value,
        )
      }
      const wei = liveWalletBalanceWei.value ?? 0n
      const liveMon = Number.parseFloat(formatUnits(wei, 18))
      const base = Number.isFinite(liveMon) ? liveMon : 0
      return Math.max(0, base + poolTransferDeltaMon.value)
    })

    const personaOptionItems = computed(() => {
      const items: Array<{
        index: number
        label: string
        dropdownLabel: string
        testId: string
      }> = []
      const root = resolvedRootAddress.value
      for (let i = 0; i <= maxPersonaIndex.value; i += 1) {
        const bal = personaBalancesByIndex.value[i] ?? 0
        const used = Boolean(usedPersonasByIndex.value[i]) || bal > 0
        const addr = deriveAccountPersonaAddress(root, i)
        const name = i === 0 ? 'Default #0' : `Burner #${i}`
        const label =
          bal > 0
            ? `${name} (${bal.toFixed(2)} MON)`
            : i > 0 && used
            ? `${name} (used)`
            : name
        const statusSuffix =
          i === 0
            ? `${bal.toFixed(2)} MON`
            : used
            ? `${bal.toFixed(2)} MON · used`
            : `${bal.toFixed(2)} MON`
        const dropdownLabel = `${name} — ${shortHexAddress(addr)} (${statusSuffix})`
        items.push({
          index: i,
          label,
          dropdownLabel,
          testId: `dapp-select-persona-${i}`,
        })
      }
      return items
    })

    const ui = Object.freeze({
      panelAriaLabel: 'Frank dApp Bridge Companion Panel',
      headerTitle: 'dApp Bridge & Persona Companion',
      selectPersonaAriaLabel: 'Select active dApp persona',
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
      syncToWebTabBtn: 'Sync Account to signet.mx Tab',
    })

    const detectedRuntimeKind = computed<RuntimeEnvironmentKind>(() => {
      if (props.runtimeKindOverride) {
        return props.runtimeKindOverride
      }
      return getExtensionRuntime().kind
    })

    const isExtensionRuntime = computed(
      () => detectedRuntimeKind.value !== 'pwa',
    )

    const syncExtensionBtnLabel = computed(() =>
      isExtensionRuntime.value ? ui.syncToWebTabBtn : ui.syncExtensionBtn,
    )

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

    const activePersonaAddress = computed(() =>
      deriveAccountPersonaAddress(
        resolvedRootAddress.value,
        personaIndex.value,
      ),
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

    async function syncActivePersonaToBackground(address: string) {
      if (!isExtensionRuntime.value) return
      try {
        await sendRuntimeMessage({
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'set-active-persona',
          address,
        })
      } catch {
        // Ignore in non-extension contexts
      }
    }

    watch(
      activePersonaAddress,
      newAddress => {
        if (newAddress) {
          void syncActivePersonaToBackground(newAddress)
        }
      },
      { immediate: true },
    )

    watch(
      resolvedRootAddress,
      newRoot => {
        if (newRoot) {
          void runAutomaticPersonaDiscovery(newRoot)
        }
      },
      { immediate: true },
    )

    onMounted(async () => {
      if (!isExtensionRuntime.value) return
      try {
        const res = await sendRuntimeMessage<{
          result?: {
            ok?: boolean
            activePersonaAddress?: string
            pendingApprovals?: Array<{
              id: string
              origin: string
              method: string
              params?: unknown
            }>
          }
        }>({
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'get-bridge-state',
        })
        const bgAddr = res?.result?.activePersonaAddress
        if (
          typeof bgAddr === 'string' &&
          /^0x[0-9a-fA-F]{40}$/.test(bgAddr) &&
          bgAddr.toLowerCase() !== FALLBACK_PERSONA_ADDRESSES[0].toLowerCase()
        ) {
          bridgeDefaultAddress.value = bgAddr
        }
        const pendingList = res?.result?.pendingApprovals
        if (
          Array.isArray(pendingList) &&
          pendingList.length > 0 &&
          props.initialApprovals.length === 0
        ) {
          approvals.value = pendingList.map(item => ({
            id: item.id,
            origin: item.origin,
            method: item.method,
          }))
        }
      } catch {
        // Ignore runtime bridge query failure
      }
    })

    function selectPersona(index: number) {
      if (index < 0 || index > maxPersonaIndex.value) return
      personaIndex.value = index
      persistPersonaMetadata()
      emit('select-persona', {
        index: personaIndex.value,
        path: activeDerivationPath.value,
        address: activePersonaAddress.value,
      })
    }

    function onPersonaDropdownChange(event: Event) {
      const target = event.target as HTMLSelectElement | null
      const parsed = Number.parseInt(target?.value ?? '0', 10)
      if (!Number.isNaN(parsed)) {
        selectPersona(parsed)
      }
    }

    function createBurnerPersona() {
      const nextIndex = maxPersonaIndex.value + 1
      maxPersonaIndex.value = nextIndex
      if (personaBalancesByIndex.value[nextIndex] === undefined) {
        personaBalancesByIndex.value = {
          ...personaBalancesByIndex.value,
          [nextIndex]: 0,
        }
      }
      personaIndex.value = nextIndex
      persistPersonaMetadata()
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
      poolTransferDeltaMon.value -= amount
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
      poolTransferDeltaMon.value += swept
      emit('sweep-to-pool', {
        sweptMon: swept,
        personaBalanceMon: personaBalanceMon.value,
        poolBalanceMon: poolBalanceMon.value,
      })
    }

    async function approveCurrentRequest() {
      const req = currentApproval.value
      if (!req) return
      const shortfall = currentApprovalShortfall.value
      if (shortfall > 0 && poolBalanceMon.value >= shortfall) {
        poolTransferDeltaMon.value -= shortfall
        personaBalanceMon.value += shortfall
      }
      if (req.requiredAmountMon && personaBalanceMon.value >= req.requiredAmountMon) {
        personaBalanceMon.value -= req.requiredAmountMon
      }
      approvals.value.shift()
      if (isExtensionRuntime.value) {
        void sendRuntimeMessage({
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'companion-resolve-approval',
          requestId: req.id,
          approved: true,
        }).catch(() => {})
      }
      emit('approve-request', {
        request: req,
        jitSweptMon: shortfall,
      })
    }

    async function rejectCurrentRequest() {
      const req = currentApproval.value
      if (!req) return
      approvals.value.shift()
      if (isExtensionRuntime.value) {
        void sendRuntimeMessage({
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'companion-resolve-approval',
          requestId: req.id,
          approved: false,
        }).catch(() => {})
      }
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

    async function triggerExtensionSync() {
      syncTriggered.value = true
      const syncPayload = {
        sasCode: sasCode.value,
        deviceSyncBundle: {
          version: 1,
          activePersonaPath: activeDerivationPath.value,
          activePersonaAddress: activePersonaAddress.value,
        },
      }
      if (isExtensionRuntime.value) {
        await sendRuntimeMessage({
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          type: 'extension-push-sync-to-tab',
          origin: 'frank-extension',
          payload: syncPayload,
        })
      }
      if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
        window.postMessage(
          {
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            direction: 'to-extension',
            type: 'pwa-sync-handshake',
            id: `sync-${Date.now()}`,
            idempotencyKey: `sync-${Date.now()}`,
            payload: syncPayload,
          },
          '*',
        )
      }
      emit('extension-sync', syncPayload)
    }

    return {
      ui,
      personaIndex,
      personaOptionItems,
      wcUriInput,
      pairedWcUri,
      isExtensionRuntime,
      syncExtensionBtnLabel,
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
      selectPersona,
      onPersonaDropdownChange,
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

<style scoped>
.dapp-persona-dropdown {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  background: rgba(128, 128, 128, 0.08);
  color: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
</style>

