<template>
  <div>
    <q-header>
      <q-toolbar>
        <q-btn
          flat
          dense
          no-caps
          icon="menu"
          :aria-label="$t('accountRecovery.open_navigation')"
          @click="$emit('toggleMyDrawerOpen')"
        />
        <q-toolbar-title>{{ $t('onboard.toolbarTitle') }}</q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="q-pa-md flex flex-center">
        <q-card
          flat
          bordered
          class="onboard-card full-width q-pa-lg"
          data-test="onboard-card"
        >
          <q-card-section class="q-pb-sm">
            <q-badge
              color="primary"
              text-color="white"
              class="q-py-xs q-px-sm q-mb-md text-weight-medium"
              data-test="onboard-header-badge"
            >
              {{ $t('onboard.headerBadge') }}
            </q-badge>
            <h1 class="text-h5 text-weight-bold q-my-none">
              {{ $t('onboard.heading') }}
            </h1>
            <p class="text-body2 text-grey-8 q-mt-sm q-mb-none">
              {{ $t('onboard.keysGeneratedPrefix') }}
              <strong>{{ $t('onboard.keysGeneratedHighlight') }}</strong>
              {{ $t('onboard.keysGeneratedSuffix') }}
              <template v-if="peerDisplayLabel">
                {{ $t('onboard.threadImportPrefix') }}
                <strong data-test="onboard-peer-label">{{
                  peerDisplayLabel
                }}</strong>
                {{ $t('onboard.threadImportSuffix') }}
              </template>
            </p>
          </q-card-section>

          <q-card-section v-if="bearerClaim" class="q-pt-xs">
            <q-banner
              dense
              rounded
              class="bg-grey-2 text-grey-9 q-pa-sm"
              data-test="onboard-bearer-claim-banner"
            >
              <div class="text-caption">
                <strong>{{ bearerClaimUi.senderLabel }}</strong>
                <span data-test="onboard-bearer-claim-sender">{{
                  bearerClaim.senderName ||
                  shortAddress(bearerClaim.senderAddress)
                }}</span>
              </div>
              <div class="text-caption">
                <strong>{{ bearerClaimUi.amountLabel }}</strong>
                <span data-test="onboard-bearer-claim-amount">{{
                  String(bearerClaim.amountAtomic)
                }}</span>
              </div>
              <div class="text-caption">
                <strong>{{ bearerClaimUi.bearerAccountLabel }}</strong>
                <span data-test="onboard-bearer-claim-eoa">{{
                  bearerClaim.bearerAccount.evmAddress
                }}</span>
              </div>
              <div v-if="bearerClaim.note" class="text-caption">
                <strong>{{ bearerClaimUi.noteLabel }}</strong>
                <span data-test="onboard-bearer-claim-note">{{
                  bearerClaim.note
                }}</span>
              </div>
            </q-banner>
          </q-card-section>

          <q-card-section v-if="subjectParam || emailParam" class="q-pt-xs">
            <q-banner
              dense
              rounded
              class="bg-grey-2 text-grey-9 q-pa-sm"
              data-test="onboard-thread-summary"
            >
              <div v-if="subjectParam" class="text-caption">
                <strong>{{ $t('onboard.subjectLabel') }}</strong>
                {{ subjectParam }}
              </div>
              <div v-if="emailParam" class="text-caption">
                <strong>{{ $t('onboard.bridgedEmailLabel') }}</strong>
                {{ emailParam }}
              </div>
            </q-banner>
          </q-card-section>

          <q-card-section v-if="error" class="q-pt-none">
            <p
              role="alert"
              class="text-negative q-my-none"
              data-test="onboard-error"
            >
              {{ error }}
            </p>
          </q-card-section>

          <!-- Case 2: Active Account Already Exists -->
          <template v-if="account.status === 'ready'">
            <q-card-section class="q-pt-sm">
              <p
                class="text-body2 q-mb-md"
                data-test="onboard-existing-account"
              >
                {{ $t('onboard.signedInAs') }}
                <strong>{{
                  account.account?.displayName ||
                  account.account?.descriptor ||
                  $t('onboard.localFrankAccount')
                }}</strong>
              </p>
              <q-btn
                color="primary"
                no-caps
                unelevated
                class="full-width q-py-sm text-weight-bold"
                :label="$t('onboard.importThreadAndOpenChat')"
                data-test="onboard-import-existing"
                :loading="busy"
                :disable="busy"
                @click="importWithExistingAccount"
              />
            </q-card-section>
          </template>

          <!-- Case 1: No Active Account Yet -->
          <template v-else>
            <q-card-section class="q-pt-sm">
              <q-input
                v-model="displayName"
                outlined
                :label="$t('onboard.displayNameLabel')"
                :hint="$t('onboard.displayNameHint')"
                :maxlength="80"
                autocomplete="off"
                data-test="onboard-display-name"
                :disable="busy"
              />
              <q-banner
                v-if="extensionSyncedAddress"
                dense
                rounded
                class="bg-positive text-white q-pa-sm q-mt-sm"
                data-test="onboard-extension-sync-banner"
              >
                <div class="text-caption">
                  {{ extensionSyncBannerText }}
                </div>
              </q-banner>
            </q-card-section>

            <q-card-actions vertical class="q-px-md q-pb-md q-gutter-y-sm">
              <q-btn
                color="primary"
                no-caps
                unelevated
                class="full-width q-py-sm text-weight-bold"
                :label="$t('onboard.createAccountAndOpenChat')"
                data-test="onboard-create-direct"
                :loading="busy"
                :disable="busy || !displayName.trim()"
                @click="createDirectAndOpenChat"
              />
              <q-btn
                v-if="passkeysSupported"
                outline
                color="primary"
                no-caps
                class="full-width q-py-sm text-weight-medium"
                :label="$t('onboard.continueWithPasskey')"
                data-test="onboard-create-passkey"
                :loading="busy"
                :disable="busy"
                @click="createPasskeyAndOpenChat"
              />
              <q-btn
                outline
                color="secondary"
                no-caps
                icon="extension"
                class="full-width q-py-sm text-weight-medium"
                :label="bearerClaimUi.connectExtensionBtn"
                data-test="onboard-connect-extension"
                :loading="busy"
                :disable="busy"
                @click="connectBrowserExtension"
              />
            </q-card-actions>
          </template>
        </q-card>
      </q-page>
    </q-page-container>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTranslate } from '../composables/useTranslate'
import { accountSession, accountStatus as account } from '../accounts/session'
import {
  createAccountCeremony,
  recoveryErrorMessage,
} from '../accounts/ceremony'
import {
  MeraAccountError,
  supportsMeraPasskeys,
} from '../accounts/mera-passkey'
import { usePersistentStorageStore } from '../stores/persistent-storage'
import { pendingRelayData, useContactStore } from '../stores/contacts'
import {
  hasConversationIdSalt,
  setConversationIdSalt,
  useChatStore,
  type ChatMessage,
} from '../stores/chats'
import { useSettingsStore } from '../stores/settings'
import {
  ensureConversationIdSalt,
  nameOwnProfile,
} from '../utils/identity-session'
import { isChainAddress, toChainDisplayAddress } from '../utils/chain-address'
import { shortAddress } from '../utils/short-address'
import { getOwnCanonicalAddress } from '../utils/own-address'
import { setCustomRelayBaseUrl } from '@frank/wallet/chain'
import {
  deriveClaimBearerAccount,
  parseClaimLink,
  type ParsedClaimLink,
} from '../../../packages/wallet/claim-link'
import { FRANK_PWA_EXTENSION_SYNC_CHANNEL } from '../../src-bex/content'

defineProps<{ myDrawerOpen?: boolean }>()
const emit = defineEmits(['toggleMyDrawerOpen', 'setupCompleted'])

const route = useRoute()
const router = useRouter()
const t = useTranslate()
const ceremony = createAccountCeremony()
const passkeysSupported = supportsMeraPasskeys()

const bearerClaimUi = {
  senderLabel: 'From: ',
  amountLabel: 'Gift Amount (wei): ',
  bearerAccountLabel: 'Bearer EOA: ',
  noteLabel: 'Welcome Note: ',
  connectExtensionBtn: 'Connect Browser Extension',
}

const windowHash = ref(typeof window !== 'undefined' ? window.location.hash : '')
const redeemedClaimIds = ref<string[]>([])
const extensionSyncedAddress = ref('')
const extensionSyncedSasCode = ref('')

const extensionSyncBannerText = computed(() =>
  extensionSyncedSasCode.value
    ? `Synced from Frank Extension: ${extensionSyncedAddress.value} (SAS: ${extensionSyncedSasCode.value})`
    : `Synced from Frank Extension: ${extensionSyncedAddress.value}`,
)

function onWindowHashChange() {
  if (typeof window !== 'undefined') {
    windowHash.value = window.location.hash
  }
}

async function handleIncomingExtensionBundle(
  bundle: Record<string, any> | undefined,
  sasCode?: string,
) {
  if (!bundle || typeof bundle !== 'object') return
  const addr = String(
    bundle.accountAddress || bundle.activePersonaAddress || '',
  ).trim()
  if (addr) {
    extensionSyncedAddress.value = addr
  }
  if (sasCode) {
    extensionSyncedSasCode.value = String(sasCode)
  }
  if (bundle.displayName && typeof bundle.displayName === 'string') {
    displayName.value = bundle.displayName
  }
  const shares = Array.isArray(bundle.backupShares)
    ? bundle.backupShares.filter((s: unknown) => typeof s === 'string' && s.trim())
    : []
  if (
    shares.length >= 2 &&
    account.status !== 'ready' &&
    typeof (ceremony as any).beginRestore === 'function' &&
    typeof (ceremony as any).confirm === 'function'
  ) {
    await runOnboardAction(async () => {
      await (ceremony as any).beginRestore()
      const outcome = await (ceremony as any).confirm(
        shares,
        displayName.value.trim() || 'Frank User',
      )
      if (!alive) return
      await activateStagedAndMigrate(outcome)
    })
  }
}

function onExtensionBridgeMessage(event: MessageEvent) {
  const data = event?.data
  if (!data || typeof data !== 'object') return
  if (
    data.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
    data.direction === 'to-pwa' &&
    (data.type === 'extension-sync-push' || data.type === 'sync-response')
  ) {
    const payload = data.payload ?? data.result?.syncedState ?? data.result
    const bundle = payload?.deviceSyncBundle
    const sas = payload?.sasCode
    void handleIncomingExtensionBundle(bundle, sas)
  }
}

function connectBrowserExtension() {
  if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
    window.postMessage(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        direction: 'to-extension',
        type: 'pwa-request-sync',
        id: `onboard-sync-${Date.now()}`,
      },
      '*',
    )
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    windowHash.value = window.location.hash
    window.addEventListener('hashchange', onWindowHashChange)
    window.addEventListener('message', onExtensionBridgeMessage)
  }
})


function extractBearerClaimFromCandidate(
  candidate?: string | null,
): ParsedClaimLink | null {
  if (!candidate || typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  if (!trimmed) return null
  const direct = parseClaimLink(trimmed)
  if (direct) {
    return {
      ...direct,
      bearerAccount:
        direct.bearerAccount ?? deriveClaimBearerAccount(direct.seedBytes),
    }
  }
  const match = /(?:^|[#&])claim=([A-Za-z0-9\-_]+)/.exec(trimmed)
  if (match?.[1]) {
    const parsed = parseClaimLink(`#claim=${match[1]}`)
    if (parsed) {
      return {
        ...parsed,
        bearerAccount:
          parsed.bearerAccount ?? deriveClaimBearerAccount(parsed.seedBytes),
      }
    }
  }
  return null
}

const bearerClaim = computed<ParsedClaimLink | null>(() => {
  const routeHash = (route as { hash?: string }).hash
  const fullPathHash =
    typeof route.fullPath === 'string' && route.fullPath.includes('#')
      ? route.fullPath.slice(route.fullPath.indexOf('#'))
      : ''
  const liveWindowHash =
    typeof window !== 'undefined' ? window.location.hash : ''

  return (
    extractBearerClaimFromCandidate(routeHash) ??
    extractBearerClaimFromCandidate(fullPathHash) ??
    extractBearerClaimFromCandidate(windowHash.value) ??
    extractBearerClaimFromCandidate(liveWindowHash)
  )
})

function recordRedeemedClaimId(claimIdHex: string) {
  if (!claimIdHex) return
  if (!redeemedClaimIds.value.includes(claimIdHex)) {
    redeemedClaimIds.value.push(claimIdHex)
  }
  try {
    if (typeof localStorage !== 'undefined') {
      const existingRaw = localStorage.getItem('frank:redeemed-claim-ids')
      const existing = existingRaw ? (JSON.parse(existingRaw) as string[]) : []
      const merged = Array.from(
        new Set([...(Array.isArray(existing) ? existing : []), claimIdHex]),
      )
      localStorage.setItem('frank:redeemed-claim-ids', JSON.stringify(merged))
    }
  } catch {
    // ignore storage failures in restricted contexts
  }
}

function firstQueryString(val: unknown): string {
  if (typeof val === 'string') return val.trim()
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0].trim()
  return ''
}

function deriveDefaultDisplayName(
  nameQuery: string,
  emailQuery: string,
): string {
  if (nameQuery) return nameQuery
  if (emailQuery) {
    const atIndex = emailQuery.indexOf('@')
    const localPart = (
      atIndex > 0 ? emailQuery.slice(0, atIndex) : emailQuery
    ).trim()
    if (localPart) return localPart
  }
  return 'Frank User'
}

const peerParam = computed(() => firstQueryString(route.query.peer))
const peerNameParam = computed(() => firstQueryString(route.query.peerName))
const emailParam = computed(() => firstQueryString(route.query.email))
const nameParam = computed(() => firstQueryString(route.query.name))
const conversationIdParam = computed(() =>
  firstQueryString(route.query.conversationId),
)
const subjectParam = computed(() => firstQueryString(route.query.subject))
const textBodyParam = computed(() =>
  firstQueryString(route.query.textBody ?? route.query.text),
)
const claimParam = computed(() => firstQueryString(route.query.claim))
const gatewayParam = computed(() => firstQueryString(route.query.gateway))

const displayName = ref(
  deriveDefaultDisplayName(nameParam.value, emailParam.value),
)

watch([nameParam, emailParam], ([newName, newEmail]) => {
  if (!displayName.value || displayName.value === 'Frank User') {
    displayName.value = deriveDefaultDisplayName(newName, newEmail)
  }
})

const peerDisplayLabel = computed(() => {
  if (peerNameParam.value) return peerNameParam.value
  if (bearerClaim.value?.senderName) return bearerClaim.value.senderName
  if (peerParam.value) return shortAddress(peerParam.value)
  if (bearerClaim.value?.senderAddress) {
    return shortAddress(bearerClaim.value.senderAddress)
  }
  return ''
})

const gatewayBaseUrl = computed(() => {
  if (gatewayParam.value) {
    return gatewayParam.value.replace(/\/+$/, '')
  }
  try {
    const settingsStore = useSettingsStore()
    const domain = settingsStore.acceptedEmailGateway?.domain || 'signet.mx'
    return `https://${domain}`
  } catch {
    return 'https://signet.mx'
  }
})

const busy = ref(false)
const error = ref('')
let alive = true

interface OnboardClaimPayload {
  peer?: string
  peerAddress?: string
  peerName?: string
  email?: string
  senderEmail?: string
  recipientEmail?: string
  conversationId?: string
  subject?: string
  textBody?: string
  text?: string
  messageId?: string
  payloadDigest?: string
  timestamp?: number
  direction?: 'inbound' | 'outbound'
}

async function fetchClaimTokenPayload(
  token: string,
): Promise<OnboardClaimPayload | null> {
  if (!token || typeof fetch !== 'function') return null
  try {
    const url = `${gatewayBaseUrl.value}/onboard/claim/${encodeURIComponent(
      token,
    )}`
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return null
    const data = (await response.json()) as unknown
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as OnboardClaimPayload
    }
    return null
  } catch {
    return null
  }
}

async function completeOnboardingMigration() {
  const activeBearerClaim = bearerClaim.value
  const claimData = claimParam.value
    ? await fetchClaimTokenPayload(claimParam.value)
    : null

  const resolvedPeer = (
    claimData?.peer ||
    claimData?.peerAddress ||
    peerParam.value ||
    activeBearerClaim?.senderAddress ||
    ''
  ).trim()
  const resolvedPeerName = (
    claimData?.peerName ||
    peerNameParam.value ||
    activeBearerClaim?.senderName ||
    ''
  ).trim()
  const resolvedSubject = (
    claimData?.subject ||
    subjectParam.value ||
    ''
  ).trim()
  const resolvedTextBody = (
    claimData?.textBody ||
    claimData?.text ||
    textBodyParam.value ||
    activeBearerClaim?.note ||
    ''
  ).trim()
  const resolvedConvId = (
    claimData?.conversationId ||
    conversationIdParam.value ||
    ''
  ).trim()

  if (activeBearerClaim) {
    recordRedeemedClaimId(activeBearerClaim.bearerAccount.claimIdHex)
  }

  if (resolvedPeer && isChainAddress(resolvedPeer)) {
    const canonicalPeer = toChainDisplayAddress(resolvedPeer)
    const contactsStore = useContactStore()
    await contactsStore
      .fetchAndAddContact({
        address: canonicalPeer,
        contact: resolvedPeerName
          ? {
              ...pendingRelayData,
              profile: {
                ...pendingRelayData.profile,
                name: resolvedPeerName,
                pubKey: null,
              },
            }
          : {},
      })
      .catch(() => undefined)

    if (!hasConversationIdSalt()) {
      await ensureConversationIdSalt().catch(() => undefined)
      if (!hasConversationIdSalt()) {
        setConversationIdSalt(new Uint8Array(16).fill(1))
      }
    }

    const chatStore = useChatStore()
    chatStore.setActiveChat(canonicalPeer)
    const conv =
      chatStore.conversations[canonicalPeer] ??
      chatStore.chats?.[canonicalPeer] ??
      chatStore.activeConversation ??
      chatStore.openDirectConversation?.(canonicalPeer)

    if (conv) {
      if (resolvedSubject && !conv.name) {
        conv.name = resolvedSubject
      }
      const bodyText = resolvedTextBody || resolvedSubject
      if (bodyText) {
        const digest = (
          claimData?.payloadDigest ||
          claimData?.messageId ||
          (activeBearerClaim
            ? `onboard-bearer-claim-${activeBearerClaim.bearerAccount.claimIdHex}`
            : claimParam.value
              ? `onboard-claim-${claimParam.value}`
              : `onboard-import-${resolvedConvId || canonicalPeer.toLowerCase()}`)
        ).trim()

        const alreadyExists =
          conv.messages.some(m => m.payloadDigest === digest) ||
          Boolean(chatStore.messages && digest in chatStore.messages)

        if (!alreadyExists) {
          const now =
            typeof claimData?.timestamp === 'number' &&
            Number.isFinite(claimData.timestamp)
              ? claimData.timestamp
              : typeof activeBearerClaim?.createdAtMs === 'number' &&
                  Number.isFinite(activeBearerClaim.createdAtMs)
                ? activeBearerClaim.createdAtMs
                : Date.now()
          const ownAddress = await getOwnCanonicalAddress().catch(() => null)
          const isOutbound = claimData?.direction === 'inbound'
          const importedMessage: ChatMessage = {
            outbound: isOutbound,
            status: 'confirmed',
            receivedTime: now,
            serverTime: now,
            items: [
              {
                type: 'text',
                text: bodyText,
              },
            ],
            outpoints: [],
            senderAddress: isOutbound
              ? ownAddress || canonicalPeer
              : canonicalPeer,
            destinationAddress: isOutbound
              ? canonicalPeer
              : ownAddress || undefined,
            payloadDigest: digest,
            conversationId: resolvedConvId || conv.id,
            localTime: true,
          }
          conv.messages.push(importedMessage)
          if (chatStore.messages && typeof chatStore.messages === 'object') {
            chatStore.messages[digest] = importedMessage
          }
          conv.lastReceived = Math.max(conv.lastReceived || 0, now)
        }
      }
    }

    emit('setupCompleted')
    await router.push('/chat/' + encodeURIComponent(canonicalPeer))
    return
  }

  emit('setupCompleted')
  await router.push('/forum')
}

async function activateStagedAndMigrate(outcome?: {
  readonly attemptId?: string
  readonly discoveredRelayUrl?: string
}) {
  if (outcome?.discoveredRelayUrl) {
    setCustomRelayBaseUrl(outcome.discoveredRelayUrl)
  }
  const pending = account.pending
  const operationId =
    pending?.account.receipt.operationId ??
    outcome?.attemptId ??
    'onboard-attempt'
  const expectedActive = pending?.expectedActive ?? {
    revision: account.revision,
    accountId: account.account?.receipt.context.accountId ?? null,
  }
  const identityAddress = account.pendingIdentityAddress

  await accountSession.activatePending(operationId, expectedActive)
  if (!alive || account.status !== 'ready') return

  void usePersistentStorageStore().afterActivation()
  const chosenName =
    displayName.value.trim() || pending?.account.displayName || ''
  if (chosenName) {
    void nameOwnProfile(chosenName, identityAddress ?? undefined).catch(
      () => undefined,
    )
  }

  await completeOnboardingMigration()
}

async function runOnboardAction(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (failure) {
    ceremony.cancel()
    if (alive) {
      error.value =
        failure instanceof MeraAccountError
          ? t(`accountRecovery.mera_${failure.code}`)
          : recoveryErrorMessage(failure)
    }
  } finally {
    if (alive) busy.value = false
  }
}

function createDirectAndOpenChat() {
  return runOnboardAction(async () => {
    const name = displayName.value.trim() || 'Frank User'
    const outcome = await ceremony.createDirect(name)
    if (!alive) return
    await activateStagedAndMigrate(outcome)
  })
}

function createPasskeyAndOpenChat() {
  return runOnboardAction(async () => {
    const outcome = await ceremony.beginPasskey('create')
    if (!alive) return
    await activateStagedAndMigrate(outcome)
  })
}

function importWithExistingAccount() {
  return runOnboardAction(async () => {
    await completeOnboardingMigration()
  })
}

onBeforeUnmount(() => {
  alive = false
  if (typeof window !== 'undefined') {
    window.removeEventListener('hashchange', onWindowHashChange)
    window.removeEventListener('message', onExtensionBridgeMessage)
  }
  ceremony.cancel()
})

defineExpose({
  bearerClaim,
  redeemedClaimIds,
  extensionSyncedAddress,
})
</script>

<style scoped>
.onboard-card {
  max-width: 36rem;
}
</style>
