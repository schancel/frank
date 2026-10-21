<template>
  <div
    role="region"
    :aria-label="ui.panelAriaLabel"
    class="dapp-bridge-panel q-pa-md column q-gutter-y-md"
    data-testid="dapp-bridge-panel"
  >
    <div class="row items-center justify-between">
      <div class="row items-center q-gutter-x-xs">
        <q-icon :name="plugIcon" size="18px" color="primary" />
        <div class="text-subtitle1 text-weight-bold">
          {{ ui.headerTitle }}
        </div>
      </div>
      <q-badge
        color="primary"
        data-testid="dapp-runtime-mode"
        :label="runtimeBadgeLabel"
      />
    </div>

    <!-- Install Browser Extension Card (shown in Standalone PWA) -->
    <q-card
      v-if="!isExtensionRuntime"
      flat
      bordered
      data-testid="dapp-extension-download-card"
    >
      <q-card-section>
        <div class="row items-center justify-between q-mb-xs">
          <div class="row items-center q-gutter-x-sm">
            <q-icon :name="plugIcon" size="20px" color="primary" />
            <div class="text-subtitle2 text-weight-bold">
              {{ ui.installExtensionTitle }}
            </div>
          </div>
          <q-badge
            outline
            color="primary"
            :label="selectedExtensionInfo.shortLabel"
          />
        </div>
        <div class="text-caption text-grey-7 q-mb-sm">
          {{ ui.installExtensionSubtitle }}
        </div>
        <div class="row items-center q-gutter-sm">
          <q-btn
            v-for="targetItem in allExtensionTargets"
            :key="targetItem.target"
            :unelevated="selectedExtensionTarget === targetItem.target"
            :outline="selectedExtensionTarget !== targetItem.target"
            no-caps
            size="sm"
            icon="download"
            :color="
              selectedExtensionTarget === targetItem.target
                ? 'primary'
                : 'grey-7'
            "
            :label="targetItem.label"
            :href="targetItem.url"
            :download="targetItem.filename"
            :data-testid="`dapp-download-${targetItem.target}-btn`"
            @click="selectExtensionTarget(targetItem.target)"
          />
        </div>
        <div
          class="text-caption text-grey-7 q-mt-sm"
          data-testid="dapp-extension-install-hint"
        >
          {{ selectedExtensionInfo.installHint }}
        </div>
      </q-card-section>
    </q-card>

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

    <!-- dApp requests wait in the extension's approval window, not here -->
    <q-card
      v-if="dappRequestsWaiting > 0"
      flat
      bordered
      data-testid="dapp-requests-waiting"
    >
      <q-card-section class="row items-center q-gutter-x-sm">
        <q-icon name="pending_actions" color="warning" size="20px" />
        <div class="text-body2">
          {{ dappRequestsWaitingText }}
        </div>
      </q-card-section>
    </q-card>

    <!-- WalletConnect pairing approval (#1709) -->
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

        <!-- Per-Site Unlinkable Persona vs Shared Primary Persona choice on Connect -->
        <div
          v-if="isConnectApproval"
          class="q-mt-sm q-pa-sm rounded-borders dapp-connect-persona-box"
          data-testid="dapp-connect-persona-choice"
        >
          <div class="text-caption text-weight-bold q-mb-xs">
            {{ ui.connectPersonaChoiceLabel }}
          </div>
          <div class="row q-gutter-xs q-mb-xs">
            <q-btn
              :unelevated="useBurnerForConnect"
              :outline="!useBurnerForConnect"
              dense
              no-caps
              size="sm"
              :color="useBurnerForConnect ? 'positive' : 'grey-7'"
              data-testid="dapp-connect-mode-burner"
              :label="ui.connectBurnerOptionLabel"
              @click="setConnectBurnerMode(true)"
            />
            <q-btn
              :unelevated="!useBurnerForConnect"
              :outline="useBurnerForConnect"
              dense
              no-caps
              size="sm"
              :color="!useBurnerForConnect ? 'primary' : 'grey-7'"
              data-testid="dapp-connect-mode-primary"
              :label="ui.connectPrimaryOptionLabel"
              @click="setConnectBurnerMode(false)"
            />
          </div>
          <div class="text-caption text-grey-7">
            {{ connectAddressSharedCaption }}
          </div>
          <div
            class="text-caption text-mono text-weight-medium"
            data-testid="dapp-connect-preview-address"
          >
            {{ previewConnectAddress }}
          </div>
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
          v-if="isConnectApproval"
          data-testid="dapp-approve-btn"
          :label="ui.approveBtn"
          @click="approveCurrentRequest"
        />
      </q-card-actions>
    </q-card>

    <!-- Privacy & Provider Visibility + Connected Sites -->
    <q-card flat bordered data-testid="dapp-privacy-card">
      <q-card-section>
        <div class="row items-center justify-between q-mb-xs">
          <div class="text-subtitle2 text-weight-medium">
            {{ ui.privacySectionTitle }}
          </div>
          <q-badge
            :color="announceModeBadgeColor"
            data-testid="dapp-announce-mode-badge"
            :label="announceModeBadgeLabel"
          />
        </div>
        <div class="text-caption text-grey-7 q-mb-sm">
          {{ ui.privacySectionSubtitle }}
        </div>
        <div class="row items-center q-gutter-xs">
          <q-btn
            :unelevated="announceMode === 'always'"
            :outline="announceMode !== 'always'"
            dense
            no-caps
            size="sm"
            :color="announceMode === 'always' ? 'primary' : 'grey-7'"
            data-testid="dapp-announce-mode-always"
            :label="ui.announceAlwaysBtn"
            @click="setAnnounceMode('always')"
          />
          <q-btn
            :unelevated="announceMode === 'connected-only'"
            :outline="announceMode !== 'connected-only'"
            dense
            no-caps
            size="sm"
            :color="announceMode === 'connected-only' ? 'positive' : 'grey-7'"
            data-testid="dapp-announce-mode-connected-only"
            :label="ui.announceConnectedOnlyBtn"
            @click="setAnnounceMode('connected-only')"
          />
          <q-btn
            :unelevated="announceMode === 'stealth'"
            :outline="announceMode !== 'stealth'"
            dense
            no-caps
            size="sm"
            :color="announceMode === 'stealth' ? 'warning' : 'grey-7'"
            data-testid="dapp-announce-mode-stealth"
            :label="ui.announceStealthBtn"
            @click="setAnnounceMode('stealth')"
          />
        </div>

        <q-separator class="q-my-sm" />

        <div class="text-caption text-weight-bold q-mb-xs">
          {{ ui.connectedSitesTitle }}
        </div>
        <div
          v-if="connectedSiteItems.length === 0"
          class="text-caption text-grey-7"
          data-testid="dapp-no-connected-sites"
        >
          {{ ui.noConnectedSitesText }}
        </div>
        <div
          v-else
          class="column q-gutter-y-xs"
          data-testid="dapp-connected-sites-list"
        >
          <div
            v-for="site in connectedSiteItems"
            :key="site.origin"
            class="row items-center justify-between q-pa-xs rounded-borders dapp-connected-site-row"
            data-testid="dapp-connected-site-row"
          >
            <div class="column">
              <div class="row items-center q-gutter-x-xs">
                <span
                  class="text-caption text-weight-bold"
                  data-testid="dapp-connected-site-origin"
                >
                  {{ site.origin }}
                </span>
                <q-badge
                  :color="site.isBurner ? 'positive' : 'primary'"
                  :label="site.badgeLabel"
                />
              </div>
              <div
                class="text-caption text-mono text-grey-7"
                data-testid="dapp-connected-site-address"
              >
                {{ site.address }}
              </div>
            </div>
            <q-btn
              flat
              dense
              no-caps
              size="sm"
              color="negative"
              data-testid="dapp-disconnect-origin-btn"
              :label="ui.disconnectSiteBtn"
              @click="disconnectOrigin(site.origin)"
            />
          </div>
        </div>
      </q-card-section>
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
      </q-card-section>
    </q-card>
  </div>
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  PropType,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { formatUnits, parseUnits, Signature, Transaction } from 'ethers'
import { activeChain } from '@frank/wallet/chain'
import { DAPP_PERSONA_SHARED_BRANCH } from '@frank/wallet/dapp-bridge/persona-keys'
import {
  accountSession,
  accountStatus,
  type DappPersonaSigner,
} from 'src/accounts/session'
import {
  getExtensionRuntime,
  onRuntimeMessage,
  RuntimeEnvironmentKind,
  sendRuntimeMessage,
} from '../../../src-bex/runtime-adapter'
import { isDappApprovalsChangedMessage } from 'src/utils/dapp-approval-surface'
import {
  DappProviderAnnounceMode,
  FRANK_DAPP_BRIDGE_CHANNEL,
} from '../../../src-bex/inpage'
import {
  normalizeBridgeOrigin,
  OriginPersonaBinding,
} from '../../../src-bex/background'
import { useBalance } from 'src/composables/useBalance'
import { useReactiveOwnCanonicalAddress } from 'src/utils/own-address'
import {
  detectPreferredExtensionTarget,
  EXTENSION_DOWNLOAD_TARGETS,
  type ExtensionTargetBrowser,
  FA_PLUG_CIRCLE_PLUS_ICON,
  getExtensionDownloadInfo,
} from 'src/utils/extension-download'

export interface DappApprovalItem {
  id: string
  kind?: 'connect' | 'sign' | 'transaction' | 'permissions'
  origin: string
  method:
    | 'connect'
    | 'eth_requestAccounts'
    | 'wallet_requestPermissions'
    | 'personal_sign'
    | 'eth_signTypedData_v4'
    | 'eth_sendTransaction'
    | string
  params?: unknown
  summary?: string
}

export interface DiscoveredPersonaActivity {
  index: number
  address: string
  balanceMon: number
  txCount: number
  used: boolean
}

function shortHexAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function resolveDefaultPersonaRpcUrl(): string {
  const relayBase = (activeChain.relayBaseUrl || '').replace(/\/+$/, '')
  if (relayBase && !relayBase.includes('relay.signet.mx')) {
    const chainId = activeChain.chainIdentifier || 'monad-testnet'
    return `${relayBase}/chain-rpc/${chainId}/rpc`
  }
  return 'https://testnet-rpc.monad.xyz'
}

/**
 * Scans shared persona slots for on-chain activity. `slotAddresses[i]` is the custody-derived
 * address of slot `i`; the scan covers exactly those slots.
 */
export async function discoverUsedPersonasOnChain(
  slotAddresses: readonly string[],
  options?: {
    rpcUrl?: string
    gapLimit?: number
    knownMaxIndex?: number
    fetchImpl?: typeof fetch
  },
): Promise<DiscoveredPersonaActivity[]> {
  if (
    slotAddresses.length === 0 ||
    !slotAddresses.every(addr => /^0x[0-9a-fA-F]{40}$/.test(addr))
  )
    return []
  const fetchFn =
    options?.fetchImpl ??
    (typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : undefined)
  if (!fetchFn) return []

  const rpcUrl = options?.rpcUrl || resolveDefaultPersonaRpcUrl()
  const maxScan = slotAddresses.length - 1
  const gapLimit = options?.gapLimit ?? 5
  const discovered: DiscoveredPersonaActivity[] = []

  try {
    const batchPayload: Array<{
      jsonrpc: '2.0'
      id: number
      method: string
      params: unknown[]
    }> = []
    for (let i = 0; i <= maxScan; i += 1) {
      const addr = slotAddresses[i]
      batchPayload.push({
        jsonrpc: '2.0',
        id: i * 2 + 2,
        method: 'eth_getBalance',
        params: [addr, 'latest'],
      })
      batchPayload.push({
        jsonrpc: '2.0',
        id: i * 2 + 3,
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
    for (let i = 0; i <= maxScan; i += 1) {
      const balHex = byId.get(i * 2 + 2) ?? '0x0'
      const txHex = byId.get(i * 2 + 3) ?? '0x0'
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
      if (i === 0 || used || i <= (options?.knownMaxIndex ?? 0)) {
        const balanceMon = Number.parseFloat(formatUnits(balWei, 18))
        discovered.push({
          index: i,
          address: slotAddresses[i],
          balanceMon: Number.isFinite(balanceMon) ? balanceMon : 0,
          txCount,
          used,
        })
      }
      if (i > 0) {
        if (used) {
          consecutiveUnused = 0
        } else {
          consecutiveUnused += 1
          if (
            consecutiveUnused >= gapLimit &&
            i >= (options?.knownMaxIndex ?? 0)
          ) {
            break
          }
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
    initialOriginPersonas: {
      type: Object as PropType<Record<string, OriginPersonaBinding>>,
      default: () => ({}),
    },
    initialAnnounceMode: {
      type: String as PropType<DappProviderAnnounceMode>,
      default: 'always',
    },
    runtimeKindOverride: {
      type: String as PropType<RuntimeEnvironmentKind | ''>,
      default: '',
    },
  },
  emits: [
    'create-burner',
    'select-persona',
    'topup-persona',
    'sweep-to-pool',
    'reject-request',
    'disconnect-origin',
    'update-announce-mode',
    'wc-connect',
  ],
  setup(props, { emit }) {
    const { total: liveWalletBalanceWei } = useBalance()
    const ownCanonicalAddress = useReactiveOwnCanonicalAddress()
    // Persona keys stay in custody: this capability yields addresses and signatures only.
    const personaSigner = shallowRef<DappPersonaSigner | null>(null)
    const personaAddressesBySlot = ref<Record<number, string>>({})

    const personaIndex = ref(0)
    const maxPersonaIndex = ref(0)
    const personaBalancesByIndex = ref<Record<number, number>>({
      0: props.initialPersonaBalanceMon,
    })
    const usedPersonasByIndex = ref<Record<number, boolean>>({})

    const useBurnerForConnect = ref(true)
    const announceMode = ref<DappProviderAnnounceMode>(
      props.initialAnnounceMode || 'always',
    )
    const originPersonasMap = ref<Record<string, OriginPersonaBinding>>({
      ...(props.initialOriginPersonas ?? {}),
    })

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
    const dappRequestsWaiting = ref(0)
    const wcUriInput = ref('')
    const pairedWcUri = ref('')

    const resolvedRootAddress = computed(() => ownCanonicalAddress.value || '')

    async function requirePersonaSigner(): Promise<DappPersonaSigner> {
      if (personaSigner.value) return personaSigner.value
      const signer = await accountSession.createDappPersonaSigner()
      personaSigner.value = signer
      return signer
    }

    /** Custody-derived addresses of shared slots 0..maxSlot, cached per account. */
    async function loadSlotAddresses(maxSlot: number): Promise<string[]> {
      const signer = await requirePersonaSigner()
      const missing: number[] = []
      for (let slot = 0; slot <= maxSlot; slot += 1)
        if (!personaAddressesBySlot.value[slot]) missing.push(slot)
      if (missing.length > 0) {
        const derived = await signer.addresses(
          missing.map(slot => ({ kind: 'shared', slot }) as const),
        )
        const next = { ...personaAddressesBySlot.value }
        missing.forEach((slot, i) => {
          next[slot] = derived[i]
        })
        personaAddressesBySlot.value = next
      }
      return Array.from(
        { length: maxSlot + 1 },
        (_, slot) => personaAddressesBySlot.value[slot],
      )
    }

    function slotAddress(slot: number): string {
      return personaAddressesBySlot.value[slot] ?? ''
    }

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
      if (!root || !/^0x[0-9a-fA-F]{40,64}$/.test(root)) return
      restorePersonaMetadata(root)
      let slotAddresses: string[]
      try {
        slotAddresses = await loadSlotAddresses(
          Math.max(10, maxPersonaIndex.value),
        )
      } catch {
        return // No unlocked account: no persona addresses to scan.
      }
      const results = await discoverUsedPersonasOnChain(slotAddresses, {
        knownMaxIndex: maxPersonaIndex.value,
      })
      if (results.length === 0) return
      const nextBalances = { ...personaBalancesByIndex.value }
      const nextUsed = { ...usedPersonasByIndex.value }
      let highestIdx = maxPersonaIndex.value
      for (const item of results) {
        if (item.index === 0 || item.used || item.index <= maxPersonaIndex.value) {
          const prevBal = nextBalances[item.index] ?? 0
          nextBalances[item.index] = Math.max(prevBal, item.balanceMon)
          if (item.used && item.index > 0) {
            nextUsed[item.index] = true
          }
          if (item.index > highestIdx && (item.used || item.index <= maxPersonaIndex.value)) {
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
      for (let i = 0; i <= maxPersonaIndex.value; i += 1) {
        const bal = personaBalancesByIndex.value[i] ?? 0
        const used = Boolean(usedPersonasByIndex.value[i]) || bal > 0
        const addr = slotAddress(i)
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
      installExtensionTitle: 'Install Frank Browser Extension',
      installExtensionSubtitle:
        'Connect Frank to Ethereum, Solana, Bitcoin, eCash, and Lotus v2 web apps with per-site anti-supercookie personas.',
      selectPersonaAriaLabel: 'Select active dApp persona',
      personaBalanceLabel: 'Persona Balance',
      poolBalanceLabel: 'Frank Pool Balance',
      createBurnerBtn: 'Create Burner Persona',
      topUpFromPoolBtn: 'Top Up from Pool',
      sweepBackToPoolBtn: 'Sweep Back to Pool',
      approvalTitle: 'Pending dApp Approval',
      connectPersonaChoiceLabel:
        'Anti-Supercookie Persona Mode for this Site',
      connectBurnerOptionLabel:
        'Per-Site Unlinkable Persona (Recommended — blocks cross-site tracking)',
      connectPrimaryOptionLabel: 'Shared Primary dApp Persona',
      approveBtn: 'Approve',
      rejectBtn: 'Reject',
      privacySectionTitle: 'Privacy & Provider Visibility',
      privacySectionSubtitle:
        'Control EIP-6963 provider discovery and view per-site Persona EOA bindings',
      announceAlwaysBtn: 'Always announce',
      announceConnectedOnlyBtn: 'Connected sites only',
      announceStealthBtn: 'Stealth mode',
      connectedSitesTitle: 'Connected Sites',
      noConnectedSitesText: 'No sites connected yet.',
      disconnectSiteBtn: 'Disconnect',
      pwaSyncTitle: 'Standalone PWA Pairing & Extension Sync',
      wcInputLabel: 'WalletConnect or dApp URI',
      wcInputPlaceholder: 'wc:00e46b69-d0cc-4b3e-b6a2-...',
      wcConnectBtn: 'Pair URI',
    })

    const plugIcon = FA_PLUG_CIRCLE_PLUS_ICON
    const selectedExtensionTarget = ref<ExtensionTargetBrowser>(
      detectPreferredExtensionTarget(),
    )
    const selectedExtensionInfo = computed(() =>
      getExtensionDownloadInfo(selectedExtensionTarget.value),
    )
    const allExtensionTargets = [
      EXTENSION_DOWNLOAD_TARGETS.chrome,
      EXTENSION_DOWNLOAD_TARGETS.firefox,
      EXTENSION_DOWNLOAD_TARGETS.safari,
    ]
    function selectExtensionTarget(target: ExtensionTargetBrowser) {
      selectedExtensionTarget.value = target
    }

    const detectedRuntimeKind = computed<RuntimeEnvironmentKind>(() => {
      if (props.runtimeKindOverride) {
        return props.runtimeKindOverride
      }
      return getExtensionRuntime().kind
    })

    const isExtensionRuntime = computed(
      () => detectedRuntimeKind.value !== 'pwa',
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
      () => `${DAPP_PERSONA_SHARED_BRANCH}/${personaIndex.value}'`,
    )

    const primaryPersonaAddress = computed(() => slotAddress(0))

    const activePersonaAddress = computed(() => slotAddress(personaIndex.value))

    // Keep the selected slots' addresses derived for the open account.
    watch(
      [maxPersonaIndex, () => accountStatus.status],
      ([maxSlot, status]) => {
        if (status !== 'ready') return
        void loadSlotAddresses(maxSlot).catch(() => {})
      },
      { immediate: true },
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

    const isConnectApproval = computed(() => {
      const req = currentApproval.value
      if (!req) return false
      return (
        req.kind === 'connect' ||
        req.kind === 'permissions' ||
        req.method === 'connect' ||
        req.method === 'eth_requestAccounts' ||
        req.method === 'wallet_requestPermissions'
      )
    })

    /** Custody-derived per-site persona address of the request being shown, by origin. */
    const sitePersonaAddresses = ref<Record<string, string>>({})

    async function resolveSitePersonaAddress(origin: string): Promise<string> {
      const known = sitePersonaAddresses.value[origin]
      if (known) return known
      const signer = await requirePersonaSigner()
      const [address] = await signer.addresses([{ kind: 'site', origin }])
      sitePersonaAddresses.value = {
        ...sitePersonaAddresses.value,
        [origin]: address,
      }
      return address
    }

    const previewConnectAddress = computed(() => {
      const req = currentApproval.value
      if (!req || !useBurnerForConnect.value) {
        return primaryPersonaAddress.value
      }
      const normOrigin =
        normalizeBridgeOrigin(req.origin) || req.origin.trim().toLowerCase()
      return sitePersonaAddresses.value[normOrigin] ?? ''
    })

    watch(
      [currentApproval, useBurnerForConnect, () => accountStatus.status],
      ([req, useBurner]) => {
        if (!req || !useBurner) return
        const normOrigin =
          normalizeBridgeOrigin(req.origin) || req.origin.trim().toLowerCase()
        void resolveSitePersonaAddress(normOrigin).catch(() => {})
      },
      { immediate: true },
    )

    const dappRequestsWaitingText = computed(() =>
      dappRequestsWaiting.value === 1
        ? '1 dApp request is waiting in the Frank approval window.'
        : `${dappRequestsWaiting.value} dApp requests are waiting in the Frank approval window.`,
    )

    const connectAddressSharedCaption = computed(() => {
      const req = currentApproval.value
      const originLabel = req?.origin || 'this site'
      return useBurnerForConnect.value
        ? `Unlinkable Burner EOA shared only with ${originLabel}:`
        : `Shared Primary EOA exposed to ${originLabel}:`
    })

    const announceModeBadgeLabel = computed(() => {
      if (announceMode.value === 'connected-only') {
        return 'Connected Sites Only'
      }
      if (announceMode.value === 'stealth') {
        return 'Stealth Mode'
      }
      return 'Always Announce'
    })

    const announceModeBadgeColor = computed(() => {
      if (announceMode.value === 'connected-only') return 'positive'
      if (announceMode.value === 'stealth') return 'warning'
      return 'primary'
    })

    const connectedSiteItems = computed(() =>
      Object.entries(originPersonasMap.value).map(([origin, binding]) => ({
        origin,
        address: binding.address,
        index: binding.index,
        label: binding.label,
        isBurner: binding.isBurner,
        badgeLabel: binding.isBurner
          ? 'Unlinkable Burner'
          : 'Shared Primary',
      })),
    )

    const approvalMethodSummary = computed(() => {
      const req = currentApproval.value
      if (!req) return ''
      return req.summary
        ? `${req.method} — ${req.summary}`
        : `Method: ${req.method}`
    })

    const pairedWcStatusText = computed(
      () => `Paired dApp URI: ${pairedWcUri.value}`,
    )

    function setConnectBurnerMode(useBurner: boolean) {
      useBurnerForConnect.value = useBurner
    }

    async function setAnnounceMode(mode: DappProviderAnnounceMode) {
      announceMode.value = mode
      emit('update-announce-mode', { announceMode: mode })
      if (isExtensionRuntime.value) {
        try {
          await sendRuntimeMessage({
            channel: FRANK_DAPP_BRIDGE_CHANNEL,
            type: 'set-announce-mode',
            announceMode: mode,
          })
        } catch {
          // Ignore in non-extension contexts
        }
      }
    }

    async function disconnectOrigin(origin: string) {
      const norm = normalizeBridgeOrigin(origin) || origin
      const next = { ...originPersonasMap.value }
      delete next[norm]
      delete next[origin]
      originPersonasMap.value = next
      emit('disconnect-origin', { origin: norm })
      if (isExtensionRuntime.value) {
        try {
          await sendRuntimeMessage({
            channel: FRANK_DAPP_BRIDGE_CHANNEL,
            type: 'disconnect-origin',
            origin: norm,
          })
        } catch {
          // Ignore in non-extension contexts
        }
      }
    }

    async function syncActivePersonaToBackground(address: string) {
      if (!isExtensionRuntime.value) return
      try {
        const totalSpendableMon = Math.max(
          0,
          personaBalanceMon.value + poolBalanceMon.value,
        )
        const totalWei = parseUnits(totalSpendableMon.toFixed(6), 18)
        await sendRuntimeMessage({
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'set-active-persona',
          address,
          poolBalanceWeiHex: '0x' + totalWei.toString(16),
          chainIdHex: '0x279f',
        })
      } catch {
        // Ignore in non-extension contexts
      }
    }

    watch(
      [activePersonaAddress, personaBalanceMon, poolBalanceMon],
      ([newAddress]) => {
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

    async function refreshBridgeState() {
      try {
        const res = await sendRuntimeMessage<{
          result?: {
            ok?: boolean
            activePersonaAddress?: string
            announceMode?: DappProviderAnnounceMode
            originPersonas?: Record<string, OriginPersonaBinding>
            pendingApprovals?: Array<{
              id: string
              kind?: 'connect' | 'sign' | 'transaction' | 'permissions'
              origin: string
              method: string
              params?: unknown
            }>
          }
        }>({
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'get-bridge-state',
        })
        if (
          res?.result?.announceMode === 'always' ||
          res?.result?.announceMode === 'connected-only' ||
          res?.result?.announceMode === 'stealth'
        ) {
          announceMode.value = res.result.announceMode
        }
        if (
          res?.result?.originPersonas &&
          typeof res.result.originPersonas === 'object' &&
          Object.keys(props.initialOriginPersonas ?? {}).length === 0
        ) {
          originPersonasMap.value = { ...res.result.originPersonas }
        }
        // dApp requests are answered in the extension's approval window;
        // this panel only says how many wait there.
        const pendingList = res?.result?.pendingApprovals
        dappRequestsWaiting.value = Array.isArray(pendingList)
          ? pendingList.length
          : 0
      } catch {
        // Ignore runtime bridge query failure
      }
    }

    let offApprovalsChanged: (() => void) | undefined
    onMounted(() => {
      if (!isExtensionRuntime.value) return
      offApprovalsChanged = onRuntimeMessage(message => {
        if (isDappApprovalsChangedMessage(message)) void refreshBridgeState()
        return undefined
      })
      void refreshBridgeState()
    })
    onBeforeUnmount(() => offApprovalsChanged?.())

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
      const targetIdx = personaIndex.value
      const targetAddress = activePersonaAddress.value
      // Never fund an address custody has not derived for this account.
      if (amount <= 0 || !targetAddress) return
      poolTransferDeltaMon.value -= amount
      personaBalanceMon.value += amount
      usedPersonasByIndex.value = {
        ...usedPersonasByIndex.value,
        [targetIdx]: true,
      }
      persistPersonaMetadata()
      emit('topup-persona', {
        amountMon: amount,
        personaBalanceMon: personaBalanceMon.value,
        poolBalanceMon: poolBalanceMon.value,
      })
      if (accountStatus.status === 'ready') {
        void (async () => {
          try {
            const wallet = await accountSession.getWallet()
            const valueWei = parseUnits(amount.toFixed(6), 18)
            await activeChain.nativeTransfers?.send?.({
              wallet,
              recipient: { raw: targetAddress },
              value: valueWei,
            })
          } catch {
            // Best-effort on-chain transfer; virtual pool fallback remains active
          }
        })()
      }
    }

    function sweepBackToPool() {
      const swept = personaBalanceMon.value
      if (swept <= 0) return
      const sourceIdx = personaIndex.value
      const sourceAddress = activePersonaAddress.value
      personaBalanceMon.value = 0
      poolTransferDeltaMon.value += swept
      persistPersonaMetadata()
      emit('sweep-to-pool', {
        sweptMon: swept,
        personaBalanceMon: personaBalanceMon.value,
        poolBalanceMon: poolBalanceMon.value,
      })
      if (accountStatus.status === 'ready' && sourceAddress) {
        void (async () => {
          try {
            if (typeof fetch !== 'function') return
            const personas = await requirePersonaSigner()
            const wallet = await accountSession.getWallet()
            const receiveAddr = (await wallet.getReceiveAddress?.())?.raw
            if (!receiveAddr) return
            const rpcUrl = resolveDefaultPersonaRpcUrl()
            const batchRes = await fetch(rpcUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify([
                {
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'eth_getBalance',
                  params: [sourceAddress, 'latest'],
                },
                {
                  jsonrpc: '2.0',
                  id: 2,
                  method: 'eth_getTransactionCount',
                  params: [sourceAddress, 'latest'],
                },
                {
                  jsonrpc: '2.0',
                  id: 3,
                  method: 'eth_gasPrice',
                  params: [],
                },
              ]),
            })
            if (!batchRes.ok) return
            const rpcItems = (await batchRes.json()) as Array<{
              id: number
              result?: string
            }>
            const balHex =
              rpcItems.find(x => x.id === 1)?.result ?? '0x0'
            const nonceHex =
              rpcItems.find(x => x.id === 2)?.result ?? '0x0'
            const gasPriceHex =
              rpcItems.find(x => x.id === 3)?.result ?? '0xba43b7400'
            const balWei = BigInt(balHex)
            const gasLimit = 21_000n
            const gasPrice = BigInt(gasPriceHex)
            const feeWei = gasLimit * gasPrice
            if (balWei <= feeWei) return
            const sweepTx = Transaction.from({
              type: 2,
              chainId: 10143n,
              to: receiveAddr,
              value: balWei - feeWei,
              nonce: Number.parseInt(nonceHex, 16) || 0,
              gasLimit,
              maxFeePerGas: gasPrice,
              maxPriorityFeePerGas:
                gasPrice > 2_000_000_000n ? 2_000_000_000n : gasPrice,
            })
            sweepTx.signature = Signature.from(
              await personas.signDigest(
                { kind: 'shared', slot: sourceIdx },
                sweepTx.unsignedHash,
              ),
            )
            const signedTx = sweepTx.serialized
            await fetch(rpcUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 4,
                method: 'eth_sendRawTransaction',
                params: [signedTx],
              }),
            })
          } catch {
            // Ignore sweep errors when offline or in unit tests
          }
        })()
      }
    }

    /** Only connections can be approved here; Frank has no signer for websites yet. */
    async function approveCurrentRequest() {
      const req = currentApproval.value
      if (!req || !isConnectApproval.value) return
      const normOrigin =
        normalizeBridgeOrigin(req.origin) || req.origin.trim().toLowerCase()
      const chosenUseBurner = useBurnerForConnect.value
      // The connect address is a custody derivation; without one there is nothing to approve.
      let chosenConnectAddr = ''
      try {
        chosenConnectAddr = chosenUseBurner
          ? await resolveSitePersonaAddress(normOrigin)
          : (await loadSlotAddresses(0))[0] ?? ''
      } catch {
        chosenConnectAddr = ''
      }
      if (!chosenConnectAddr || currentApproval.value !== req) return
      approvals.value.shift()

      const nextBurnerIdx = chosenUseBurner
        ? Math.max(
            1,
            ...Object.values(originPersonasMap.value).map(b => b.index + 1),
          )
        : 0
      const binding: OriginPersonaBinding = {
        address: chosenConnectAddr,
        index: nextBurnerIdx,
        label: chosenUseBurner
          ? `${normOrigin} Burner #${nextBurnerIdx}`
          : 'Primary dApp Persona',
        isBurner: chosenUseBurner,
      }
      if (normOrigin) {
        originPersonasMap.value = {
          ...originPersonasMap.value,
          [normOrigin]: binding,
        }
      }
    }

    async function rejectCurrentRequest() {
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
        kind: 'connect',
        origin: 'wc://paired-dapp',
        method: 'connect',
        summary: `Pair session (${trimmed.slice(0, 18)}...)`,
      })
      emit('wc-connect', { uri: trimmed })
      wcUriInput.value = ''
    }

    return {
      ui,
      plugIcon,
      selectedExtensionTarget,
      selectedExtensionInfo,
      allExtensionTargets,
      selectExtensionTarget,
      personaIndex,
      personaOptionItems,
      useBurnerForConnect,
      announceMode,
      announceModeBadgeLabel,
      announceModeBadgeColor,
      connectedSiteItems,
      wcUriInput,
      pairedWcUri,
      isExtensionRuntime,
      runtimeBadgeLabel,
      activeDerivationPath,
      activePersonaAddress,
      personaTitleText,
      formattedPersonaBalance,
      formattedPoolBalance,
      currentApproval,
      isConnectApproval,
      previewConnectAddress,
      dappRequestsWaiting,
      dappRequestsWaitingText,
      connectAddressSharedCaption,
      approvalMethodSummary,
      pairedWcStatusText,
      setConnectBurnerMode,
      setAnnounceMode,
      disconnectOrigin,
      selectPersona,
      onPersonaDropdownChange,
      createBurnerPersona,
      topUpFromPool,
      sweepBackToPool,
      approveCurrentRequest,
      rejectCurrentRequest,
      connectWalletConnectUri,
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
.dapp-connect-persona-box,
.dapp-connected-site-row {
  border: 1px solid rgba(128, 128, 128, 0.25);
  background: rgba(128, 128, 128, 0.05);
}
</style>


