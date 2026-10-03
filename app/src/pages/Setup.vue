<template>
  <div>
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          data-test="setup-header-menu"
          :disable="completionLocked"
          @click="$emit('toggleMyDrawerOpen')"
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          :aria-expanded="myDrawerOpen"
        />
        <q-toolbar-title class="h6">
          {{ $t('setup.welcome') }}
        </q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="q-ma-none q-pa-sm">
        <replace-account-guard
          v-if="guardActive"
          :confirmed="existingConfirmed"
          :has-seed="hasStoredSeed"
          @cancel="$router.push('/')"
          @acknowledge="acknowledgeReplace"
        />
        <q-stepper
          v-else
          v-model="step"
          ref="stepper"
          color="primary"
          contracted
          alternative-labels
        >
          <q-step
            :name="1"
            :title="$t('setup.eula')"
            icon="flaky"
            :done="step > 1"
            :disable="completionLocked && step !== 1"
          >
            <eula-step />
          </q-step>
          <q-step
            :name="2"
            :title="$t('setup.setupWallet')"
            icon="vpn_key"
            :done="step > 2"
            :disable="completionLocked && step !== 2"
          >
            <account-step
              :account-data="accountData"
              :locked="completionLocked"
              :resume="resume"
              :resume-import-acknowledged="resumeReplaceAcknowledged"
              @update:account-data="updateAccountData"
              @resume-import-acknowledged="acknowledgeResumeImport"
            />
          </q-step>
          <q-step
            v-if="isNewAccount"
            :name="3"
            :title="$t('seedConfirm.stepTitle')"
            icon="fact_check"
            :done="step > 3"
            :disable="completionLocked && step !== 3"
          >
            <div
              v-if="challengeError"
              role="alert"
              class="text-negative"
              data-test="challenge-error"
            >
              {{ $t('seedConfirm.unavailable') }}
            </div>
            <seed-confirm-step
              v-else-if="challenge"
              :seed="challenge.seed"
              :positions="challenge.positions"
              :confirmed="isSeedConfirmed"
              @confirmed="onSeedConfirmed"
            />
          </q-step>
          <q-step
            :name="4"
            :title="$t('setup.deposit')"
            icon="attach_money"
            :done="step > 4"
            :disable="completionLocked && step !== 4"
          >
            <deposit-step />
          </q-step>
          <template #navigation>
            <q-stepper-navigation>
              <q-btn
                @click="next()"
                color="primary"
                :label="nextButtonLabel"
                :disable="!forwardEnabled"
              />
              <q-btn
                v-if="step > 1"
                color="primary"
                @click="previous()"
                :label="$t('setup.back')"
                class="q-ml-sm"
                :disable="completionLocked"
              />
            </q-stepper-navigation>
            <q-banner inline-actions class="text-white bg-red">
              {{ $t('setup.seedWarning') }}
            </q-banner>
          </template>
        </q-stepper>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import assert from 'assert'

import { defineComponent } from 'vue'

import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'
import { QStepper } from 'quasar'

import { generateMnemonic } from 'bip39'

import { RegistryHandler } from '@frank/cashweb/registry'
import pop from '@frank/cashweb/pop'
import { getRelayClient } from '../adapters/pinia-relay-adapter'
import {
  defaultRelayUrl,
  defaultAvatars,
  recomendedBalance,
  registrys,
  networkName,
} from '../utils/constants'
import { errorNotify } from '../utils/notifications'
import {
  initializeMonadIdentity,
  setupFinishReloads,
} from '../utils/monad-identity-session'
import { finishSetupAndEnter } from '../utils/setup-persistence'
import {
  accountDigest,
  classifyAccount,
  type AccountState,
  type StoredAccountFacts,
} from '../utils/account-state'
import { withSetupCommitLock } from '../utils/setup-lock'
import { requestPersistentStorageWithin } from '../utils/persistent-storage'
import {
  commitValidatedSetupName,
  commitValidatedSetupSeed,
  ensureConfirmationChallenge,
  initialSetupSeed,
  normalizeSetupMnemonic,
  type SeedConfirmationChallenge,
} from '../utils/setup-account'

import AccountStep from '../components/setup/AccountStep.vue'
import DepositStep from '../components/setup/DepositStep.vue'
import EulaStep from '../components/setup/EULAStep.vue'
import SeedConfirmStep from '../components/setup/SeedConfirmStep.vue'
import ReplaceAccountGuard from '../components/setup/ReplaceAccountGuard.vue'

import { useRelayClientStore } from 'src/stores/relay-client'
import { useWalletStore } from 'src/stores/wallet'
import { useChatStore } from 'src/stores/chats'
import { useAppearanceStore } from 'src/stores/appearance'
import { useProfileStore } from 'src/stores/my-profile'
import { defaultRelayData, useContactStore } from 'src/stores/contacts'
import { storeToRefs } from 'pinia'

// How long signup waits for the browser's answer to the persistent-storage request (ticket #370).
const PERSIST_REQUEST_WAIT_MS = 3000

type CompletionPhase =
  | 'editing'
  | 'wallet-persistence'
  | 'profile-persistence'
  | 'entering'
  | 'completed'
  | 'terminal'

interface AccountSubmission {
  readonly seed: string
  readonly name: string
  readonly nameRequired: boolean
  readonly confirmedAt: number
}

export default defineComponent({
  components: {
    AccountStep,
    DepositStep,
    EulaStep,
    SeedConfirmStep,
    ReplaceAccountGuard,
  },
  setup() {
    const myDrawerOpen = useMyDrawerOpen()
    const relayClient = useRelayClientStore()
    const chats = useChatStore()
    const wallet = useWalletStore()
    const { balance, seedPhrase } = storeToRefs(wallet)
    const appearance = useAppearanceStore()
    const myProfile = useProfileStore()
    const contacts = useContactStore()
    const { updateInterval } = storeToRefs(contacts)

    return {
      myDrawerOpen,
      setRelayToken: relayClient.setToken,
      resetChats: chats.reset,
      darkMode: appearance.setDarkMode,
      updateInterval: updateInterval,
      setUpdateInterval: contacts.setUpdateInterval,
      seedPhrase: seedPhrase,
      setRelayData: myProfile.setRelayData,
      resetWallet: wallet.reset,
      setXPrivKey: wallet.setXPrivKey,
      setSeedPhrase: (seed: string, confirmedAt: number | null = null) =>
        wallet.setSeedPhrase(seed, confirmedAt),
      balance: balance,
    }
  },
  data() {
    const wallet = useWalletStore()
    const contacts = useContactStore()
    const storedSeed = wallet.seedPhrase
    // #284 resume mode: a stored seed with no display name (the old #267 bug). The stored phrase
    // is confirmed and named in place. Importing a different phrase (#387) waits for the same
    // typed acknowledgement as the replace-seed guard, and that acknowledgement writes nothing.
    const initialFacts: StoredAccountFacts = {
      seedPhrase: storedSeed,
      name: useProfileStore().profile?.name,
      seedConfirmedAt: wallet.seedConfirmedAt,
    }
    const accountState = classifyAccount(initialFacts)
    const initialDigest = accountDigest(initialFacts)
    const resume = accountState === 'needs-recovery'
    // #304: a finished account (seed and name) already lives on this device.
    // #308: a legacy profile (name-only) is also an existing account.
    // Replacing it needs an explicit, typed acknowledgement; until then the onboarding steps
    // are not shown and nothing can be committed.
    const existingAccount =
      accountState === 'completed-unconfirmed' ||
      accountState === 'confirmed' ||
      accountState === 'name-only'
    const hasStoredSeed = accountState !== 'name-only'

    return {
      resume,
      existingAccount,
      existingConfirmed: accountState === 'confirmed',
      hasStoredSeed,
      currentAccountDigest: initialDigest,
      acknowledgedAccountDigest: null as string | null,
      replaceAcknowledged: false,
      resumeReplaceAcknowledged: false,
      completionPending: false,
      completionPhase: 'editing' as CompletionPhase,
      accountSubmission: null as Readonly<AccountSubmission> | null,
      // Set only around the internally authorized completion push (see finishSetup()): the one
      // departure beforeRouteLeave allows while the wizard is locked.
      completionNavigationAuthorized: false,
      storedSeed: resume ? storedSeed : null,
      step: 1,
      accountData: {
        name: '',
        valid: false,
        nameRequired: false,
        // In-memory draft only: persisted by commitValidatedSetupSeed() on completion (#267).
        seed: initialSetupSeed(wallet.seedPhrase, generateMnemonic),
      },
      // Confirmation challenge for the New Account phrase (positions asked for), bound to the
      // phrase it was drawn for; in memory only.
      challenge: null as SeedConfirmationChallenge | null,
      // The (normalized) phrase the user has proven they hold. Never persisted by itself: the
      // durable seedConfirmedAt marker is written only together with the seed at commit.
      confirmedSeed: null as string | null,
      challengeError: false,
      relayData: defaultRelayData,
      relayUrl: defaultRelayUrl,
      avatar: '',
      seed: '',
      settings: {
        networking: {
          updateInterval: contacts.updateInterval / 1_000,
        },
      },
    }
  },
  emits: ['setupCompleted', 'toggleMyDrawerOpen', 'setupNavigationLocked'],
  watch: {
    // Positions are drawn on entering the confirmation step and are reused while the phrase
    // is unchanged; going back and changing the phrase draws new ones.
    step(step: number) {
      if (step === 3) this.prepareChallenge()
    },
    // #387: while the account step is locked (pending persistence, terminal, or entry retry),
    // no layout-owned navigation may leave Setup. The drawer lives in MainLayout, which can
    // only know about this lock through this event.
    completionLocked(locked: boolean) {
      this.$emit('setupNavigationLocked', locked)
    },
  },
  beforeRouteLeave() {
    // Layout-wide lock (#387): AccountStep, Back and the inactive QStepper headers are frozen
    // while the account step is locked, but the header menu and MainLayout's drawer would
    // still route away, unmounting this page and dropping its frozen submission/phase state.
    // Block every departure except the internally authorized completion push (finishSetup
    // marks the navigation around the router.push call). Safe (pre-lock) states -- e.g.
    // editing step 1 -- keep navigating as before.
    if (this.completionNavigationAuthorized) return true
    return !this.completionLocked
  },
  methods: {
    prepareChallenge() {
      try {
        this.challenge = ensureConfirmationChallenge(
          this.challenge,
          this.accountData.seed,
        )
        this.challengeError = false
      } catch {
        // No secure random source: never fall back to a weaker one. Show a message instead of an
        // empty step; Back still works and re-entering the step tries again.
        this.challenge = null
        this.challengeError = true
      }
    },
    acknowledgeReplace() {
      this.acknowledgedAccountDigest = this.currentAccountDigest
      this.replaceAcknowledged = true
      // The default draft is the STORED phrase; a replacement must start from a fresh one
      // (or an import), never silently keep the old one under a new profile.
      this.accountData.seed = generateMnemonic()
      this.step = 1
    },
    acknowledgeResumeImport() {
      // Unlocks an in-memory import draft only. The stored seed stays until import finishes.
      if (!this.resume) return
      this.resumeReplaceAcknowledged = true
    },
    updateAccountData(accountData: typeof this.accountData) {
      if (this.completionLocked) return
      this.accountData = accountData
    },
    onSeedConfirmed() {
      if (this.challenge) this.confirmedSeed = this.challenge.seed
    },
    /**
     * Persist the seed and name, then start the Monad identity in this page.
     * `confirmedAt` is the durable proof-of-backup marker stored with the seed.
     */
    async finishSetup() {
      return finishSetupAndEnter({
        finishReloads: setupFinishReloads(),
        location: this.setupFinishLocation(),
        initialize: () => initializeMonadIdentity(),
        navigate: (path: string) => {
          // The only departure beforeRouteLeave allows: the completion push after everything
          // is durable. The flag wraps the whole push (settling it either way), so a
          // concurrent unauthorized navigation can never slip through an open window.
          this.completionNavigationAuthorized = true
          return Promise.resolve(this.$router.push(path)).finally(() => {
            this.completionNavigationAuthorized = false
          })
        },
      })
    },
    setupFinishLocation() {
      return window.location
    },
    async rehydrateStores(): Promise<void> {
      await Promise.all([
        useWalletStore().rehydrate?.(),
        useProfileStore().rehydrate?.(),
      ])
    },
    async syncPersistedAccountState(): Promise<AccountState> {
      await this.rehydrateStores()
      const wallet = useWalletStore()
      const profile = useProfileStore()
      const facts: StoredAccountFacts = {
        seedPhrase: wallet.seedPhrase,
        name: profile.profile?.name,
        seedConfirmedAt: wallet.seedConfirmedAt,
      }
      const accountState = classifyAccount(facts)
      const digest = accountDigest(facts)
      this.currentAccountDigest = digest

      if (
        accountState === 'completed-unconfirmed' ||
        accountState === 'confirmed' ||
        accountState === 'name-only'
      ) {
        this.existingAccount = true
        this.existingConfirmed = accountState === 'confirmed'
        this.hasStoredSeed = accountState !== 'name-only'
        this.storedSeed = wallet.seedPhrase
      } else {
        this.existingAccount = false
        this.existingConfirmed = false
        this.hasStoredSeed = false
      }
      if (accountState === 'needs-recovery') {
        this.resume = true
        this.storedSeed = wallet.seedPhrase
      }

      if (
        this.replaceAcknowledged &&
        this.acknowledgedAccountDigest !== digest
      ) {
        // Target account changed since replacement was acknowledged (#308)
        this.replaceAcknowledged = false
        this.acknowledgedAccountDigest = null
      }
      return accountState
    },
    captureAccountSubmission(confirmedAt: number): Readonly<AccountSubmission> {
      if (
        this.existingAccount &&
        (!this.replaceAcknowledged ||
          this.acknowledgedAccountDigest !== this.currentAccountDigest)
      ) {
        // Independent of the UI: an existing account is never replaced, and its profile never
        // overwritten, without the typed acknowledgement bound to this exact target account.
        this.replaceAcknowledged = false
        this.acknowledgedAccountDigest = null
        throw new Error(this.$t('setup.replaceNotAcknowledged'))
      }
      if (
        this.resume &&
        !this.resumeReplaceAcknowledged &&
        normalizeSetupMnemonic(this.accountData.seed) !==
          normalizeSetupMnemonic(this.storedSeed ?? '')
      ) {
        // Without the typed acknowledgement, resume mode may only re-store the SAME phrase.
        throw new Error(this.$t('setup.storedSeedMismatch'))
      }

      // Validate and canonicalize the whole identity synchronously, before avatar loading or any
      // persistence await opens a window for the editable draft to diverge from durable state.
      // Validate name before seed (#308).
      const name = commitValidatedSetupName(
        this.accountData.name,
        this.accountData.nameRequired,
        () => undefined,
      )
      const seed = commitValidatedSetupSeed(
        this.accountData.seed,
        () => undefined,
        confirmedAt,
      )
      const submission = Object.freeze({
        seed,
        name,
        nameRequired: this.accountData.nameRequired,
        confirmedAt,
      })
      this.accountData.seed = seed
      this.accountData.name = name
      this.accountData.nameRequired = submission.nameRequired
      return submission
    },
    async completeAccountStep(submission: Readonly<AccountSubmission>) {
      if (this.completionPhase === 'entering') {
        await this.finishSetup()
        this.completionPhase = 'completed'
        return
      }
      if (!this.avatar) {
        this.avatar = await this.selectRandomAvatar()
      }
      await withSetupCommitLock(async () => {
        // Re-read and synchronize durable account facts right inside the critical section (#308)
        await this.syncPersistedAccountState()
        if (
          this.existingAccount &&
          (!this.replaceAcknowledged ||
            this.acknowledgedAccountDigest !== this.currentAccountDigest)
        ) {
          this.replaceAcknowledged = false
          this.acknowledgedAccountDigest = null
          this.accountSubmission = null
          throw new Error(this.$t('setup.replaceNotAcknowledged'))
        }
        if (
          this.resume &&
          !this.resumeReplaceAcknowledged &&
          normalizeSetupMnemonic(submission.seed) !==
            normalizeSetupMnemonic(this.storedSeed ?? '')
        ) {
          throw new Error(this.$t('setup.storedSeedMismatch'))
        }

        this.completionPhase = 'wallet-persistence'
        this.setSeedPhrase(submission.seed, submission.confirmedAt)
        // Ticket #370: ask the browser to keep the just-stored seed while we still hold the user's
        // click. The helper is bounded and best-effort, and never blocks signup for long.
        await requestPersistentStorageWithin(PERSIST_REQUEST_WAIT_MS)
        // Never create a new profile until the matching wallet seed is known durable. A poisoned
        // production barrier drains its latest physical write before rejecting; the terminal page
        // then deliberately neither reloads nor proceeds.
        await useWalletStore().flushPersistence()
        this.completionPhase = 'profile-persistence'
        this.setRelayData({
          profile: {
            name: submission.name,
            bio: '',
            avatar: this.avatar,
          },
          inbox: defaultRelayData.inbox,
        })
        await useProfileStore().flushPersistence()
        this.currentAccountDigest = accountDigest({
          seedPhrase: submission.seed,
          name: submission.name,
          seedConfirmedAt: submission.confirmedAt,
        })
        this.completionPhase = 'entering'
      })
      await this.finishSetup()
      this.completionPhase = 'completed'
    },
    async submitAccountStep(confirmedAt: number) {
      if (this.completionBlocked) return
      this.completionPending = true
      try {
        if (!this.accountSubmission) {
          this.accountSubmission = this.captureAccountSubmission(confirmedAt)
        }
        await this.completeAccountStep(this.accountSubmission)
      } catch (error) {
        const completionError =
          error instanceof Error ? error : new Error(String(error))
        if (
          this.completionPhase === 'wallet-persistence' ||
          this.completionPhase === 'profile-persistence'
        ) {
          this.completionPhase = 'terminal'
        }
        errorNotify(completionError)
        throw completionError
      } finally {
        this.completionPending = false
      }
    },
    selectRandomAvatar(): Promise<string> {
      const avatarName =
        defaultAvatars[Math.floor(Math.random() * defaultAvatars.length)]
      return new Promise((resolve, reject) => {
        const img = new Image()
        img.crossOrigin = 'Anonymous'
        img.onload = function () {
          const canvas = document.createElement('canvas')
          const ctx = canvas.getContext('2d')
          canvas.height = img.naturalHeight
          canvas.width = img.naturalWidth
          ctx?.drawImage(img, 0, 0)
          const dataURL = canvas.toDataURL()
          resolve(dataURL)
        }
        img.onerror = () => reject(new Error('Unable to load default avatar'))
        // See Profile.vue's identical fix: ticket #51's Vite migration missed this webpack-only
        // dynamic `require()` for a resolved asset URL -- `new URL(..., import.meta.url)` is
        // Vite's native replacement.
        img.src = new URL(
          `../assets/avatars/${avatarName}`,
          import.meta.url,
        ).href
      })
    },
    newWallet() {
      this.resetWallet()
      this.$wallet.clearUtxos()

      this.$q.loading.show({
        delay: 100,
        message: this.$t('setup.generatingWallet'),
      })
      return new Promise<void>((resolve, reject) => {
        // Setup worker
        // TODO: What was the point of doing this in a worker?
        // Vite's native worker import (replaced webpack's `worker-loader!` prefix, ticket #51 --
        // the Vite migration) -- `new URL(..., import.meta.url)` + `{ type: 'module' }` is Vite's
        // documented way to construct a Web Worker from a TS/JS file without a special loader.
        const worker = new Worker(
          new URL('../workers/xpriv_generate.ts', import.meta.url),
          { type: 'module' },
        )
        worker.onmessage = async event => {
          try {
            // Prepare wallet
            const xPrivKey = event.data
            // TODO: We should not have to update two places.
            this.setXPrivKey(xPrivKey)
            this.$wallet.setXPrivKey(xPrivKey)

            this.$q.loading.hide()
            resolve()
          } catch (err) {
            reject(err)
          }
        }
        assert(
          this.accountData.seed,
          'Missing seed phrase? State ordering issue?',
        )
        this.seed = this.accountData.seed
        this.setSeedPhrase(this.seed)
        worker.postMessage(this.seed)
      })
    },
    async setupRelayData() {
      // Set profile
      const ksHandler = new RegistryHandler({
        wallet: this.$wallet,
        registrys: registrys,
        networkName,
      })
      const idAddress = this.$wallet.displayAddress ?? ''

      // Check for existing metadata
      this.$q.loading.show({
        delay: 100,
        message: this.$t('setup.searchingExistingMetaData'),
      })

      // Try find relay URL on registry
      try {
        const foundRelayUrl = await ksHandler.getRelayUrl(idAddress)
        this.relayUrl = foundRelayUrl ?? defaultRelayUrl
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        // No URL found
        if (err.response && err.response.status === 404) {
          this.relayUrl = defaultRelayUrl
          const stepper = this.$refs.stepper as QStepper
          stepper.next()
        } else {
          errorNotify(err, { fallbackKey: 'setup.errorContactRegistry' })
        }
      } finally {
        this.$q.loading.hide()
      }

      // Check for existing metadata
      this.$q.loading.show({
        delay: 100,
        message: this.$t('setup.searchingRelay'),
      })
      // Get profile from relay server
      // We do this first to prevent uploading broken URL to registry
      const { client: relayClient } = await getRelayClient({
        relayUrl: this.relayUrl,
        wallet: this.$wallet,
      })
      try {
        this.relayData = await relayClient.getRelayData(idAddress)
        return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        this.relayData = {
          ...defaultRelayData,
          profile: {
            ...defaultRelayData.profile,
            name: this.accountData.name || 'Stamp User',
            avatar: this.avatar,
          },
        }
        if (!err.response) {
          this.$q.loading.hide()
          // Relay URL malformed
          errorNotify(err, { fallbackKey: 'setup.networkErrorRelayDied' })
          throw err
        }
      } finally {
        this.$q.loading.hide()
      }
    },
    async setUpRegistry() {
      // Set profile
      const ksHandler = new RegistryHandler({
        wallet: this.$wallet,
        networkName,
        registrys: registrys,
      })

      try {
        this.$q.loading.show({
          delay: 100,
          message: this.$t('setup.uploadingMetaData'),
        })
        const idPrivKey = this.$wallet.identityPrivKey

        assert(idPrivKey, 'Wallet not initialized')

        console.log('Updating registry metadata')
        await ksHandler.updateKeyMetadata(this.relayUrl, idPrivKey)
        console.log('Metadata updated')

        this.$q.loading.hide()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        errorNotify(err)
        throw err
      } finally {
        this.$q.loading.hide()
      }
    },
    async setupRelay() {
      const { client: relayClient } = await getRelayClient({
        relayUrl: this.relayUrl,
        wallet: this.$wallet,
      })

      // Set filter
      this.$q.loading.show({
        delay: 100,
        message: this.$t('setup.requestingPayment'),
      })

      const idAddress = this.$wallet.myAddress
      assert(idAddress, 'idAddress should be defined at this point')

      // We might have spent our only UTXO above, so this will possibly take a few tries.
      let triesLeft = 3
      while (triesLeft > 0) {
        try {
          const relayPaymentRequest = await relayClient.profilePaymentRequest(
            this.$wallet.displayAddress,
          )
          assert(
            relayPaymentRequest,
            'relayPaymentRequest should be defined at this point',
          )
          // Send payment
          this.$q.loading.show({
            delay: 100,
            message: this.$t('setup.sendingPayment'),
          })

          console.log('Constructing relay payment transaction')
          // Get token from relay server
          const { paymentUrl, payment, usedUtxos } =
            await pop.constructPaymentTransaction(
              this.$wallet,
              relayPaymentRequest.paymentDetails,
            )

          const paymentUrlFull = new URL(paymentUrl, this.relayUrl)
          console.log('Sending relay profile payment to', paymentUrlFull.href)
          try {
            const { token } = await pop.sendPayment(
              paymentUrlFull.href,
              payment,
            )
            relayClient.setToken(token)
            this.setRelayToken(token)
            this.$relayClient.setToken(token)
          } catch (err) {
            console.log('Relay payment failed')
            this.$wallet.fixUtxos(usedUtxos)
            throw err
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          // TODO: errors should not be stringly typed. Fix this
          // later. Also retry here should be more explicit. This is
          // basically so that things work when the person only had one UTXO to begin with.
          if (err.message === 'insufficient funds') {
            console.log('insufficient funds')
            triesLeft--
            await new Promise<void>(resolve => {
              setTimeout(() => resolve(), 1000)
            })
            continue
          }
          console.log(err)
          throw err
        } finally {
          this.$q.loading.hide()
        }
        // We succeeded
        break
      }

      // Create metadata
      const idPrivKey = this.$wallet.identityPrivKey
      assert(idPrivKey, 'idPrivKey should be defined at this point')

      const acceptancePrice = this.relayData.inbox.acceptancePrice

      this.$q.loading.show({
        delay: 100,
        message: this.$t('setup.openingInbox'),
      })

      try {
        await this.$relayClient.updateProfile(
          idPrivKey,
          this.relayData.profile,
          acceptancePrice,
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        console.error(err)
        this.$q.loading.hide()
        // TODO: ProfileDialog uses different localization for no particular reason.
        // TODO: move specialization down to errorNotify
        if (err.response?.status === 413) {
          errorNotify(err, { fallbackKey: 'setup.profileImageLargeError' })
          throw err
        }
        errorNotify(err, { fallbackKey: 'setup.networkErrorRelayUnexpected' })
        throw err
      } finally {
        this.$q.loading.hide()
      }
      // Apply locally
      this.setRelayData(this.relayData)
      this.setSeedPhrase(this.seed)
    },
    async setupSettings() {
      // Reset all messaging
      await this.resetChats()
      await this.setUpRegistry()
      await this.setupRelay()
      await this.setUpdateInterval(
        this.settings.networking.updateInterval * 1_000,
      )
      await this.$emit('setupCompleted')
    },
    async next() {
      if (this.completionBlocked) return
      const stepper = this.$refs.stepper as QStepper

      switch (this.step) {
        case 1:
          stepper.next()
          break
        case 2:
          // Ticket #47 (real signup bug, found live 2026-09-27: this wizard permanently blocked
          // every fresh user -- see forwardEnabled()'s comment): this used to chain into
          // newWallet()/setupRelayData(), both entirely Lotus-registry-specific (deriving a Lotus
          // HDPrivateKey via a worker, then looking an existing profile up on a live Lotus
          // registry/relay) that this Monad-only deployment has no working backend for, and that
          // Monad messaging/identity doesn't need at all. Finish commits the seed and name, then
          // initializeMonadIdentity (the same session boot starts) registers and polls in place
          // (#389) instead of reloading. Deposit stays unreachable dead UI (#47).
          // Only an explicit, valid New or Import choice may proceed. In the initial (no choice
          // yet) state accountData.valid is false, so the never-shown generated draft can
          // neither be committed nor stamped as confirmed.
          if (!this.accountData.valid) break
          if (this.isNewAccount) {
            // New Account: the phrase is NOT committed here. The user must first confirm it
            // on the next step.
            this.step = 3
            break
          }
          // Import (explicit: valid and nameRequired === false): the user already holds this
          // phrase, so it counts as confirmed.
          await this.submitAccountStep(Date.now())
          break
        case 3:
          // Second, independent guard: never commit a New Account phrase unless the user
          // confirmed exactly this phrase (forwardEnabled is only the UI half).
          if (!this.isSeedConfirmed) break
          await this.submitAccountStep(Date.now())
          break
        case 4:
          this.setupSettings()
            .then(() => this.$router.push('/'))
            .catch(err => errorNotify(err))
          break
      }
    },
    previous() {
      if (this.completionLocked) return
      const stepper = this.$refs.stepper as QStepper
      stepper.previous()
    },
  },
  computed: {
    completionLocked(): boolean {
      return (
        this.completionPending ||
        this.accountSubmission !== null ||
        this.completionPhase !== 'editing'
      )
    },
    completionBlocked(): boolean {
      return (
        this.completionPending ||
        this.completionPhase === 'terminal' ||
        this.completionPhase === 'completed'
      )
    },
    forwardEnabled() {
      if (this.completionBlocked) return false
      // Ticket #47 (real signup bug): this used to hard-block every step, including the EULA's own
      // "Agree" button, on `this.$indexer.connected` -- a live Lotus chronik indexer this Monad-only
      // deployment never stands up, so this was permanently false and no fresh user could ever get
      // past step 1. Chronik/indexer connectivity has nothing to do with agreeing to terms or
      // generating a seed phrase; dropped entirely. `next()`'s case 2 no longer reaches step 3 (see
      // its own comment), so `isRelayValid`/`isWalletSufficient` (both real-Lotus-balance/relay
      // checks a Monad-only user could never satisfy) are no longer gates on this path either.
      switch (this.step) {
        case 2:
          return this.isWalletValid
        case 3:
          return this.isSeedConfirmed
        default:
          return true
      }
    },
    guardActive(): boolean {
      return this.existingAccount && !this.replaceAcknowledged
    },
    isNewAccount(): boolean {
      return this.accountData.nameRequired !== false
    },
    isSeedConfirmed(): boolean {
      return (
        this.confirmedSeed !== null &&
        this.confirmedSeed === normalizeSetupMnemonic(this.accountData.seed)
      )
    },
    isWalletValid(): boolean {
      return this.accountData.valid
    },
    isRelayValid(): boolean {
      console.log('name', this.relayData.profile.name)
      console.log('avatar', !!this.relayData.profile.avatar)
      console.log('price', this.relayData.inbox.acceptancePrice)
      return !!(
        this.relayData.profile.name &&
        this.relayData.profile.avatar &&
        this.relayData.inbox.acceptancePrice
      )
    },
    isWalletSufficient() {
      return !!this.balance && this.balance >= recomendedBalance
    },
    nextButtonLabel(): string {
      switch (this.step) {
        case 1:
          return this.$t('agree')
        case 2:
          return this.$t('setup.accountSetupNext')
        case 3:
          return this.$t('setup.finish')
        case 4:
          return this.$t('setup.depositStepNext')
        default:
          return 'Unknown'
      }
    },
  },
  mounted() {
    void this.selectRandomAvatar().then(avatar => {
      this.avatar = avatar
    })
  },
})
</script>

function useApperanceStore() { throw new Error('Function not implemented.') }
function useApperanceStore() { throw new Error('Function not implemented.') }
