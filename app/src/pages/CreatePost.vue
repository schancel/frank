<template>
  <!-- Real bug found live: this page used to wrap itself in its own <q-page-container><q-page>,
  but it's already rendered inside ForumLayout.vue's own <q-page-container><q-page><router-view />
  -- ForumLayout is the actual layout for every route nested under it (see routes.ts: 'forum's
  children include this page, Forum.vue, and ForumPost.vue). Quasar's q-page-container computes
  its content offset from the single shared q-layout instance (the outer MainLayout.vue's), so
  nesting a second one here double-applied that offset calculation -- the visible symptom was the
  whole form rendering shifted right with a large empty gap on the left, worse the narrower the
  actual available width. Neither Forum.vue nor ForumPost.vue (the other two pages under this same
  layout) wrap themselves this way -- this page was the only one that did, confirmed by checking
  both siblings before making this change. -->
  <q-card class="q-ma-none q-pa-sm">
    <div
      v-if="parentDigest && !parentMessage"
      class="q-pa-md"
      role="status"
      aria-live="polite"
      data-test="parent-resolution-status"
    >
      <span v-if="parentLoading">
        {{ $t('stampPreparation.replyParentLoading') }}
      </span>
      <span v-else>
        {{ $t('stampPreparation.replyParentUnavailable') }}
      </span>
      <q-btn
        ref="retryParentButton"
        class="q-ml-sm"
        flat
        dense
        :label="$t('stampPreparation.retryReplyParent')"
        :disable="parentLoading"
        :loading="parentLoading"
        @click="loadParent"
        data-test="retry-parent"
      />
    </div>
    <q-form @submit="post">
      <q-card-section>
        <q-input
          label="Offering"
          v-model="offering"
          data-test="post-offering"
          :suffix="chainUnit"
          :rules="[validateOffering]"
          lazy-rules
        />
        <q-select
          label="Topic"
          data-test="post-topic"
          :disable="!!parentDigest"
          :model-value="topic"
          @update:model-value="setTopic"
          @input-value="markTopicEdited"
          :options="topics"
          @filter="filterTopics"
          use-input
          @new-value="createValue"
          new-value-mode="add-unique"
          input-debounce="0"
          :rules="[
            val =>
              (val && val.length > 0 && /^[a-z0-9.-]+$/.test(val)) ||
              'Only numbers, lowercase, periods and dashes allowed',
            val =>
              !val.split('.').some(val => val.length === 0) ||
              'Topic segments not allowed to be empty',
          ]"
          lazy-rules
        >
          <template #no-option>
            <q-item>
              <q-item-section class="text-grey">No results</q-item-section>
            </q-item>
          </template>
        </q-select>
        <q-input label="Post Title" v-model="title" data-test="post-title" />
        <q-input
          label="URL"
          v-model="url"
          :rules="[val => !val || validateUrl(val) || 'Invalid URL']"
          lazy-rules
        />
        <!-- Ticket feedback (real, direct): the side-by-side Message/Preview split used Quasar's
        row/col grid (col-md / col-md-6), which breakpoints off the *viewport* width, not this
        card's own width -- so it went side-by-side even when the card itself was narrow, squeezing
        both halves uncomfortably. Stacked vertically instead, always, regardless of viewport. -->
        <q-card-section class="col-12 q-pa-none">
          <div
            class="post-editor-toolbar row items-center q-gutter-xs q-pt-sm q-pb-xs"
            role="toolbar"
            :aria-label="$t('forum.editor.toolbar')"
          >
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="format_bold"
              :aria-label="$t('a11y.formatBold')"
              data-test="format-bold"
              @mousedown.prevent
              @click="applyFormat('bold')"
            >
              <q-tooltip>{{ $t('forum.editor.bold') }}</q-tooltip>
            </q-btn>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="format_italic"
              :aria-label="$t('a11y.formatItalic')"
              data-test="format-italic"
              @mousedown.prevent
              @click="applyFormat('italic')"
            >
              <q-tooltip>{{ $t('forum.editor.italic') }}</q-tooltip>
            </q-btn>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="title"
              :aria-label="$t('a11y.formatHeading')"
              data-test="format-heading"
              @mousedown.prevent
              @click="applyFormat('heading')"
            >
              <q-tooltip>{{ $t('forum.editor.heading') }}</q-tooltip>
            </q-btn>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="format_quote"
              :aria-label="$t('a11y.formatQuote')"
              data-test="format-quote"
              @mousedown.prevent
              @click="applyFormat('quote')"
            >
              <q-tooltip>{{ $t('forum.editor.quote') }}</q-tooltip>
            </q-btn>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="code"
              :aria-label="$t('a11y.formatCode')"
              data-test="format-code"
              @mousedown.prevent
              @click="applyFormat('code')"
            >
              <q-tooltip>{{ $t('forum.editor.code') }}</q-tooltip>
            </q-btn>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="format_list_bulleted"
              :aria-label="$t('a11y.formatBullet')"
              data-test="format-bullet"
              @mousedown.prevent
              @click="applyFormat('bullet')"
            >
              <q-tooltip>{{ $t('forum.editor.bullet') }}</q-tooltip>
            </q-btn>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="link"
              :aria-label="$t('a11y.formatLink')"
              data-test="format-link"
              @mousedown.prevent
              @click="applyFormat('link')"
            >
              <q-tooltip>{{ $t('forum.editor.link') }}</q-tooltip>
            </q-btn>
            <q-separator vertical inset class="q-mx-xs" />
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="image"
              :aria-label="$t('a11y.attachPostImage')"
              :loading="attachingImage"
              data-test="attach-post-image"
              @mousedown.prevent
              @click="triggerImageUpload"
            >
              <q-tooltip>{{ $t('forum.editor.attachImage') }}</q-tooltip>
            </q-btn>
            <input
              ref="imageFileInput"
              type="file"
              accept="image/*"
              class="hidden"
              data-test="post-image-input"
              @change="onImageFileSelected"
            />
          </div>
          <div
            v-if="attachments.length > 0"
            class="attachment-chips-bar row items-center q-gutter-xs q-py-xs"
            data-test="attachment-chips-bar"
          >
            <q-chip
              v-for="att in attachments"
              :key="att.id"
              removable
              dense
              outline
              color="primary"
              data-test="attachment-chip"
              :data-attachment-id="att.id"
              @remove="removeAttachment(att.id)"
            >
              <q-avatar size="18px" square class="q-mr-xs">
                <img :src="att.dataUrl" alt="" />
              </q-avatar>
              <span class="ellipsis" style="max-width: 140px">{{
                att.name
              }}</span>
              <span class="text-caption text-grey q-ml-xs"
                >({{ formatAttachmentSize(att.sizeBytes) }})</span
              >
              <q-tooltip>{{ $t('forum.editor.removeAttachment') }}</q-tooltip>
            </q-chip>
          </div>
          <q-input
            ref="messageInput"
            label="Message"
            v-model="message"
            data-test="post-message"
            type="textarea"
            @paste="onMessagePaste"
            @drop.prevent="onMessageDrop"
          />
        </q-card-section>

        <q-card-section class="col-12 q-pa-none q-pt-md" v-show="this.message">
          <div class="text-weight-bold text-caption">Message Preview</div>
          <q-card-section class="q-pa-none q-pt-xs">
            <span class="mdstyle" v-html="markedMessage" />
          </q-card-section>
        </q-card-section>
      </q-card-section>
      <q-card-actions align="right">
        <div
          v-if="preparationStatus"
          class="text-caption q-mr-sm row items-center"
          role="status"
          data-test="post-status"
        >
          <q-spinner-dots size="1.2em" color="primary" class="q-mr-xs" />
          <span>{{ preparationStatus }}</span>
        </div>
        <div
          v-if="outcomeUnknown"
          class="text-caption q-mr-sm"
          role="status"
          data-test="post-outcome-unknown"
        >
          {{ $t('stampPreparation.postOutcomeUnknown') }}
        </div>
        <q-btn
          v-if="outcomeUnknown"
          :label="$t('stampPreparation.refreshStatus')"
          data-test="post-status-refresh"
          :loading="refreshingStatus"
          :disable="refreshingStatus"
          @click="refreshPostStatus"
        />
        <q-btn
          ref="composeFocusTarget"
          @click="back"
          label="back"
          color="negative"
          class="q-ma-sm"
          :disable="posting"
          data-test="compose-focus-target"
        />
        <q-btn
          type="submit"
          data-test="post-submit"
          label="Post"
          color="primary"
          class="q-ma-sm"
          :disable="
            posting || outcomeUnknown || (!!parentDigest && !parentMessage)
          "
          :loading="posting"
        />
      </q-card-actions>
    </q-form>
  </q-card>

  <q-card class="q-ma-sm" v-if="parentMessage">
    <q-card-section>Replying to:</q-card-section>
    <a-message :message="parentMessage" :show-replies="false" :compact="true" />
  </q-card>
</template>

<script lang="ts">
import { navigateBack } from 'src/utils/navigate-back'
import { defineComponent, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'

import { renderMarkdown } from '../utils/markdown'
import {
  applyMarkdownFormat,
  compressPostImage,
  insertImageMarkdown,
  expandAttachmentTokens,
  removeAttachmentReferences,
  tokenizeAttachmentDataUrls,
  formatAttachmentSize,
  type MarkdownFormatAction,
  type PostAttachment,
} from 'src/utils/post-editor'
import { useForumStore } from 'src/stores/forum'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { activeChain } from '@frank/wallet/chain'
import type { WalletHandle } from '@frank/wallet/chain'
import { displayToRawAmount } from 'src/utils/chain-amount'
import { accountStatus } from '../accounts/session'
import type { ForumPostReservationStatus } from 'src/stores/forum'

import { useTopicStore } from 'src/stores/topics'
import { topicOptions } from 'src/utils/topic-options'
import AMessage from '../components/forum/ForumMessage.vue'
import { errorNotify, infoNotify } from 'src/utils/notifications'
import { submitPost } from 'src/utils/submit-post'
import { stampPreparationStatus } from 'src/utils/stamp-preparation-status'

export default defineComponent({
  setup() {
    const forum = useForumStore()
    const walletRevision = ref(0)
    watch(
      () => [accountStatus.revision, accountStatus.status],
      () => {
        walletRevision.value += 1
      },
    )
    const { topics, getMessage, selectedTopic } = storeToRefs(forum)
    return {
      topicStore: useTopicStore(),
      getMessage: getMessage,
      availableTopics: topics,
      selectedTopic,
      walletRevision,
      pushNewTopic: forum.pushNewTopic,
      postMessage: forum.putMessage,
      fetchMessage: forum.fetchMessage,
      getPostReservationId: forum.getPostReservationId,
      reservePostSubmission: forum.reservePostSubmission,
      releasePostSubmission: forum.releasePostSubmission,
      markPostSubmissionOutcomeUnknown: forum.markPostSubmissionOutcomeUnknown,
      getPostReservationStatus: forum.getPostReservationStatus,
    }
  },
  components: {
    AMessage,
  },
  emits: ['setTopic'],
  props: {},
  data() {
    const forum = useForumStore()
    const parentDigest = this.$route.params.parentDigest as string
    const topLevelTopic = forum.selectedTopic
    return {
      offering: activeChain.toDisplayAmount(activeChain.defaultTopicVoteValue),
      topic: parentDigest
        ? forum.getMessage(parentDigest)?.topic ?? ''
        : topLevelTopic,
      topLevelTopic,
      topLevelTopicWasEdited: false,
      topics: [] as string[],
      title: '',
      url: null,
      message: '',
      parentDigest,
      chainUnit: activeChain.unit,
      posting: false,
      attachingImage: false,
      outcomeUnknown: false,
      refreshingStatus: false,
      preparationStatus: null as string | null,
      activeSubmissionId: null as number | null,
      componentMounted: false,
      routeEpoch: 0,
      parentRouteEpoch: 0,
      parentLoading: false,
      nextParentRequestId: 0,
      activeParentRequestId: null as number | null,
      nextParentFocusHandoffId: 0,
      parentFocusHandoffId: null as number | null,
      activeWallet: null as WalletHandle | null,
      attachments: [] as PostAttachment[],
    }
  },
  mounted() {
    this.componentMounted = true
    if (this.parentDigest && !this.parentMessage) {
      void this.loadParent()
    } else {
      void this.syncSubmissionUi(this.parentDigest)
    }
  },
  beforeUnmount() {
    this.componentMounted = false
    this.routeEpoch += 1
    this.parentRouteEpoch += 1
    this.activeSubmissionId = null
    this.refreshingStatus = false
    this.parentFocusHandoffId = null
  },
  computed: {
    currentReservationStatus(): ForumPostReservationStatus | undefined {
      if (!this.activeWallet) return undefined
      return this.getPostReservationStatus({
        wallet: this.activeWallet,
        destination: this.submissionDestination(this.parentDigest),
      })
    },
    // Topics seen in posts, plus the default and relay-discovered ones the topic store tracks.
    knownTopics(): string[] {
      return [...this.availableTopics, ...this.topicStore.getTopics]
    },
    markedMessage() {
      const text: string = expandAttachmentTokens(
        this.message,
        this.attachments,
      )
      return renderMarkdown(text, this.$q.dark.isActive)
    },
    parentMessage() {
      return this.parentDigest ? this.getMessage(this.parentDigest) : undefined
    },
    currentReservationId() {
      if (!this.activeWallet) return undefined
      return this.getPostReservationId({
        wallet: this.activeWallet,
        destination: this.submissionDestination(this.parentDigest),
      })
    },
  },
  watch: {
    '$route.params.parentDigest'(nextParentDigest: unknown) {
      this.syncParentDigest(
        typeof nextParentDigest === 'string' ? nextParentDigest : undefined,
      )
    },
    'parentMessage'(nextParent: { topic: string } | undefined) {
      if (this.parentDigest && nextParent) {
        const retryButton = this.$refs.retryParentButton as
          | { $el?: HTMLElement }
          | HTMLElement
          | undefined
        const retryElement =
          retryButton instanceof HTMLElement ? retryButton : retryButton?.$el
        const retryOwnedFocus = retryElement?.contains(document.activeElement)
        const handoffId = retryOwnedFocus
          ? ++this.nextParentFocusHandoffId
          : null
        const handoff =
          handoffId !== null
            ? {
                parentDigest: this.parentDigest,
                parentRouteEpoch: this.parentRouteEpoch,
                handoffId,
              }
            : null
        // A valid parent makes every in-flight request for this route redundant. Revoke its
        // completion authority before either the request that populated the shared store or a
        // newer retry can settle and interfere with the resolved-parent UI.
        this.activeParentRequestId = null
        this.parentFocusHandoffId = handoff?.handoffId ?? null
        this.parentLoading = false
        this.topic = nextParent.topic
        void this.syncSubmissionUi(this.parentDigest)
        if (handoff) void this.handoffResolvedParentFocus(handoff)
      }
    },
    'currentReservationId'(nextReservationId: number | undefined) {
      if (nextReservationId === undefined) {
        this.posting = false
        this.outcomeUnknown = false
        this.preparationStatus = null
      } else if (this.activeSubmissionId !== nextReservationId) {
        // A reservation this instance does not own is live for this destination
        // (remount, duplicate attempt, or a sibling instance). Render its state.
        this.syncCurrentReservationUi()
      }
    },
    'currentReservationStatus'(nextStatus) {
      // A reservation this instance does not own can flip from in-flight to
      // outcome-unknown while this page is mounted (the owner instance settles
      // elsewhere). Re-render the destination's truthful state.
      if (
        nextStatus !== undefined &&
        this.activeSubmissionId !== this.currentReservationId
      ) {
        this.syncCurrentReservationUi()
      }
    },
    'selectedTopic'(nextTopic: string) {
      if (!this.parentDigest && !this.topLevelTopicWasEdited) {
        this.topLevelTopic = nextTopic
        this.topic = nextTopic
      }
    },
    'walletRevision'() {
      this.refreshingStatus = false
      this.routeEpoch += 1
      this.activeSubmissionId = null
      this.activeWallet = null
      this.posting = false
      this.outcomeUnknown = false
      this.preparationStatus = null
      if (!this.parentDigest || this.parentMessage) {
        void this.syncSubmissionUi(this.parentDigest)
      }
    },
  },
  methods: {
    async refreshPostStatus() {
      if (this.refreshingStatus) return
      const routeEpoch = this.routeEpoch
      const revision = this.walletRevision
      const current = () =>
        this.componentMounted &&
        this.routeEpoch === routeEpoch &&
        this.walletRevision === revision
      this.refreshingStatus = true
      try {
        const wallet = await useActiveWallet()
        if (!current()) return
        await useForumStore().refreshOperationStatus({ wallet })
        // Reconciliation does not prove which session reservation completed; retain unknown
        // ownership until an exact operation result can identify it.
      } catch (error) {
        if (current()) errorNotify(error)
      } finally {
        if (current()) this.refreshingStatus = false
      }
    },
    validateOffering(value: string) {
      try {
        const amount = displayToRawAmount(activeChain, String(value))
        return (
          (amount > 0n && amount <= 9223372036854775807n) || 'Invalid amount'
        )
      } catch {
        return 'Invalid amount'
      }
    },
    submissionDestination(parentDigest: string | undefined) {
      return parentDigest ? `reply:${parentDigest}` : 'top-level'
    },
    syncCurrentReservationUi() {
      const reservationId = this.currentReservationId
      const outcomeUnknown =
        reservationId !== undefined &&
        this.currentReservationStatus === 'outcome-unknown'
      this.posting = reservationId !== undefined && !outcomeUnknown
      this.outcomeUnknown = outcomeUnknown
      this.preparationStatus = this.posting
        ? this.$t('stampPreparation.posting')
        : null
    },
    async syncSubmissionUi(parentDigest: string | undefined) {
      const requestedDestination = this.submissionDestination(parentDigest)
      const requestedEpoch = this.routeEpoch
      const requestedWalletRevision = this.walletRevision
      let walletPromise: ReturnType<typeof useActiveWallet>
      try {
        walletPromise = useActiveWallet()
        const wallet = await walletPromise
        if (
          !this.componentMounted ||
          this.routeEpoch !== requestedEpoch ||
          this.walletRevision !== requestedWalletRevision ||
          this.submissionDestination(this.parentDigest) !== requestedDestination
        ) {
          return
        }
        this.activeWallet = wallet
        this.syncCurrentReservationUi()
      } catch {
        if (
          this.componentMounted &&
          this.routeEpoch === requestedEpoch &&
          this.walletRevision === requestedWalletRevision &&
          this.submissionDestination(this.parentDigest) === requestedDestination
        ) {
          this.activeWallet = null
          this.syncCurrentReservationUi()
        }
      }
    },
    syncParentDigest(parentDigest: string | undefined) {
      this.refreshingStatus = false
      this.routeEpoch += 1
      this.parentRouteEpoch += 1
      this.parentFocusHandoffId = null
      this.parentDigest = parentDigest
      if (parentDigest) {
        this.topic = this.getMessage(parentDigest)?.topic ?? ''
      } else {
        if (!this.topLevelTopicWasEdited) {
          this.topLevelTopic = this.selectedTopic
        }
        this.topic = this.topLevelTopic
      }
      if (parentDigest && !this.parentMessage) {
        this.activeWallet = null
        this.posting = false
        this.outcomeUnknown = false
        this.preparationStatus = null
        void this.loadParent()
      } else {
        this.parentLoading = false
        void this.syncSubmissionUi(parentDigest)
      }
    },
    async loadParent() {
      const requestedParent = this.parentDigest
      if (!requestedParent || this.getMessage(requestedParent)) return
      const requestedParentRouteEpoch = this.parentRouteEpoch
      const requestId = ++this.nextParentRequestId
      this.parentFocusHandoffId = null
      this.activeParentRequestId = requestId
      const retryButton = this.$refs.retryParentButton as
        | { $el?: HTMLElement }
        | HTMLElement
        | undefined
      const retryElement =
        retryButton instanceof HTMLElement ? retryButton : retryButton?.$el
      const retryOwnedFocus = retryElement?.contains(document.activeElement)
      this.parentLoading = true
      try {
        await this.fetchMessage({
          payloadDigest: requestedParent,
          isCurrent: () =>
            this.componentMounted &&
            this.parentRouteEpoch === requestedParentRouteEpoch &&
            this.parentDigest === requestedParent &&
            this.activeParentRequestId === requestId,
        })
      } catch {
        // The visible terminal state supplies the retry path.
      } finally {
        const ownsParentRequest = () =>
          this.componentMounted &&
          this.parentRouteEpoch === requestedParentRouteEpoch &&
          this.parentDigest === requestedParent &&
          this.activeParentRequestId === requestId
        if (ownsParentRequest()) {
          this.parentLoading = false
          if (retryOwnedFocus) {
            await this.$nextTick()
            if (ownsParentRequest()) {
              const activeElement = document.activeElement
              const hasConnectedFocus =
                activeElement instanceof Element &&
                activeElement !== document.body &&
                activeElement.isConnected
              if (!hasConnectedFocus) {
                const focusTarget = this.parentMessage
                  ? this.$refs.composeFocusTarget
                  : this.$refs.retryParentButton
                const targetElement =
                  focusTarget instanceof HTMLElement
                    ? focusTarget
                    : (focusTarget as { $el?: HTMLElement } | undefined)?.$el
                targetElement?.focus()
              }
            }
          }
          if (ownsParentRequest()) this.activeParentRequestId = null
        }
      }
    },
    async handoffResolvedParentFocus(handoff: {
      parentDigest: string
      parentRouteEpoch: number
      handoffId: number
    }) {
      await this.$nextTick()
      if (this.parentFocusHandoffId !== handoff.handoffId) return
      this.parentFocusHandoffId = null
      if (
        !this.componentMounted ||
        this.parentRouteEpoch !== handoff.parentRouteEpoch ||
        this.parentDigest !== handoff.parentDigest ||
        !this.parentMessage
      ) {
        return
      }
      const activeElement = document.activeElement
      const hasConnectedFocus =
        activeElement instanceof Element &&
        activeElement !== document.body &&
        activeElement.isConnected
      if (!hasConnectedFocus) {
        const focusTarget = this.$refs.composeFocusTarget as
          | { $el?: HTMLElement }
          | HTMLElement
          | undefined
        const targetElement =
          focusTarget instanceof HTMLElement ? focusTarget : focusTarget?.$el
        targetElement?.focus()
      }
    },
    setTopic(topic: string | null) {
      if (this.parentDigest) return
      this.topLevelTopicWasEdited = true
      this.topLevelTopic = topic ?? ''
      this.topic = this.topLevelTopic
    },
    markTopicEdited() {
      if (!this.parentDigest) {
        this.topLevelTopicWasEdited = true
      }
    },
    sameWalletIdentity(left: WalletHandle | null, right: WalletHandle) {
      return (
        left?.identity.address.raw.toLowerCase() ===
        right.identity.address.raw.toLowerCase()
      )
    },
    filterTopics(inputTopic: string, update: (arg: () => void) => void) {
      update(() => {
        this.topics = topicOptions(inputTopic, this.knownTopics)
      })
    },
    createValue(
      val: string,
      done: (val: string, newValueMode: string) => void,
    ) {
      // Calling done(var) when newValueMode is "add-unique", or done(var, "add-unique")
      // adds "var" content to the model only if is not already set
      // and it resets the input textbox to empty string
      // https://quasar.dev/vue-components/select#example--filtering-and-adding-to-menu
      if (val.length > 0) {
        if (!this.availableTopics.includes(val)) {
          this.pushNewTopic(val)
        }
        done(val, 'add-unique')
      }
    },
    async post() {
      if (this.parentDigest && !this.parentMessage) return

      const submittedTopic = this.topic
      const submittedParentDigest = this.parentDigest
      let submittedOffering: bigint
      try {
        submittedOffering = displayToRawAmount(
          activeChain,
          this.offering.toString(),
        )
      } catch (err) {
        errorNotify(err as Error)
        return
      }
      const submittedDestination = this.submissionDestination(
        submittedParentDigest,
      )
      const submissionEpoch = this.routeEpoch
      const submissionWalletRevision = this.walletRevision
      const entry = {
        kind: 'post' as const,
        title: this.title,
        url: this.url ? this.url : undefined,
        message: expandAttachmentTokens(this.message, this.attachments),
      }
      let walletPromise: ReturnType<typeof useActiveWallet>
      let wallet: WalletHandle
      try {
        walletPromise = useActiveWallet()
        wallet = await walletPromise
      } catch (err) {
        errorNotify(err as Error)
        return
      }
      const ownsCurrentUi = () => {
        return (
          this.componentMounted &&
          this.routeEpoch === submissionEpoch &&
          this.walletRevision === submissionWalletRevision &&
          this.submissionDestination(this.parentDigest) === submittedDestination
        )
      }
      if (ownsCurrentUi()) {
        this.activeWallet = wallet
      }
      const submissionId = this.reservePostSubmission({
        wallet,
        destination: submittedDestination,
      })
      if (submissionId === undefined) {
        if (ownsCurrentUi()) this.syncCurrentReservationUi()
        return
      }
      const postingStatus = this.$t('stampPreparation.posting')
      if (ownsCurrentUi()) {
        this.activeSubmissionId = submissionId
        this.posting = true
        this.preparationStatus = postingStatus
      }
      console.log('posting message', entry)
      let retainReservation = false
      try {
        const outcome = await submitPost({
          submit: async () => {
            await this.postMessage({
              wallet,
              entry,
              satoshis: submittedOffering,
              topic: submittedTopic,
              parentDigest: submittedParentDigest,
              onPreparationProgress: progress => {
                if (
                  !this.componentMounted ||
                  this.activeSubmissionId !== submissionId ||
                  this.routeEpoch !== submissionEpoch
                ) {
                  return
                }
                const status = stampPreparationStatus(
                  progress,
                  (key, params) => this.$t(key, params ?? {}),
                  {
                    format: raw => activeChain.toDisplayAmount(raw),
                    unit: activeChain.unit,
                  },
                )
                this.preparationStatus = status
              },
            })
          },
          errorNotify,
          infoNotify,
          onOutcome: outcome => {
            retainReservation = outcome === 'unknown-outcome'
            if (outcome === 'unknown-outcome') {
              // The paid call may have landed: keep the reservation but mark it
              // so every mounted instance of this destination renders the
              // terminal unknown state instead of a false ongoing post.
              this.markPostSubmissionOutcomeUnknown({
                wallet,
                destination: submittedDestination,
                reservationId: submissionId,
              })
            }
          },
          navigateBack: () => {
            if (
              this.componentMounted &&
              this.activeSubmissionId === submissionId &&
              this.routeEpoch === submissionEpoch &&
              this.sameWalletIdentity(this.activeWallet, wallet) &&
              this.submissionDestination(this.parentDigest) ===
                submittedDestination
            ) {
              this.back()
            }
          },
          messages: {
            created: this.$t('stampPreparation.postCreated', {
              topic: submittedTopic,
            }),
            refreshFailed: this.$t('stampPreparation.postedRefreshFailed'),
          },
        })
        retainReservation = outcome === 'unknown-outcome'
      } finally {
        if (!retainReservation) {
          this.releasePostSubmission({
            wallet,
            destination: submittedDestination,
            reservationId: submissionId,
          })
        }
        if (
          ownsCurrentUi() &&
          this.activeSubmissionId === submissionId &&
          this.sameWalletIdentity(this.activeWallet, wallet)
        ) {
          this.activeSubmissionId = null
          this.syncCurrentReservationUi()
        }
      }
    },
    getTextareaElement(): HTMLTextAreaElement | HTMLInputElement | null {
      const comp = this.$refs.messageInput as
        | {
            $el?: HTMLElement
            nativeEl?: HTMLTextAreaElement | HTMLInputElement
          }
        | HTMLTextAreaElement
        | HTMLInputElement
        | undefined
      if (!comp) return null
      if (
        comp instanceof HTMLTextAreaElement ||
        comp instanceof HTMLInputElement
      ) {
        return comp
      }
      if (comp.nativeEl) return comp.nativeEl
      if (comp.$el && typeof comp.$el.querySelector === 'function') {
        return comp.$el.querySelector('textarea, input')
      }
      return null
    },
    applyFormat(action: MarkdownFormatAction) {
      const textarea = this.getTextareaElement()
      const start = textarea?.selectionStart ?? this.message.length
      const end = textarea?.selectionEnd ?? this.message.length
      const res = applyMarkdownFormat(this.message, start, end, action)
      this.message = res.text
      this.$nextTick(() => {
        if (textarea && typeof textarea.focus === 'function') {
          textarea.focus()
          if (typeof textarea.setSelectionRange === 'function') {
            textarea.setSelectionRange(res.selectionStart, res.selectionEnd)
          }
        }
      })
    },
    triggerImageUpload() {
      const input = this.$refs.imageFileInput as HTMLInputElement | undefined
      if (input) {
        input.value = ''
        input.click()
      }
    },
    async onImageFileSelected(event: Event) {
      const target = event.target as HTMLInputElement
      const file = target?.files?.[0]
      if (file) {
        await this.attachImageFile(file)
      }
    },
    async onMessagePaste(event: ClipboardEvent) {
      const items = event.clipboardData?.items
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile()
            if (file) {
              event.preventDefault()
              await this.attachImageFile(file)
              return
            }
          }
        }
      }

      const text =
        typeof event.clipboardData?.getData === 'function'
          ? event.clipboardData.getData('text/plain')
          : undefined
      if (text && text.includes('data:image/')) {
        const tokenized = tokenizeAttachmentDataUrls(text, this.attachments)
        if (tokenized.attachments.length > this.attachments.length) {
          event.preventDefault()
          this.attachments = tokenized.attachments
          const textarea = this.getTextareaElement()
          const start = textarea?.selectionStart ?? this.message.length
          const end = textarea?.selectionEnd ?? this.message.length
          const before = this.message.slice(0, start)
          const after = this.message.slice(end)
          this.message = before + tokenized.text + after
          const newPos = start + tokenized.text.length
          this.$nextTick(() => {
            if (textarea && typeof textarea.focus === 'function') {
              textarea.focus()
              if (typeof textarea.setSelectionRange === 'function') {
                textarea.setSelectionRange(newPos, newPos)
              }
            }
          })
        }
      }
    },
    async onMessageDrop(event: DragEvent) {
      const files = event.dataTransfer?.files
      if (!files || files.length === 0) return
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        if (file.type.startsWith('image/')) {
          event.preventDefault()
          await this.attachImageFile(file)
          return
        }
      }
    },
    async attachImageFile(file: File) {
      if (!file.type.startsWith('image/')) {
        errorNotify(this.$t('forum.editor.invalidImageType'))
        return
      }
      this.attachingImage = true
      try {
        const compressed = await compressPostImage(file)
        const textarea = this.getTextareaElement()
        const start = textarea?.selectionStart ?? this.message.length
        const end = textarea?.selectionEnd ?? this.message.length
        const alt = file.name ? file.name.replace(/\.[^/.]+$/, '') : 'image'

        let maxId = 0
        for (const att of this.attachments) {
          const n = parseInt(att.id, 10)
          if (!isNaN(n) && n > maxId) maxId = n
        }
        const nextId = String(maxId + 1)
        const attachment: PostAttachment = {
          id: nextId,
          name: file.name || `image-${nextId}`,
          dataUrl: compressed.dataUrl,
          sizeBytes:
            compressed.bytes ??
            Math.round(
              ((compressed.dataUrl.split(',')[1] || '').length * 3) / 4,
            ),
        }
        this.attachments.push(attachment)

        const res = insertImageMarkdown(
          this.message,
          start,
          end,
          alt,
          `attachment:${nextId}`,
        )
        this.message = res.text
        this.$nextTick(() => {
          if (textarea && typeof textarea.focus === 'function') {
            textarea.focus()
            if (typeof textarea.setSelectionRange === 'function') {
              textarea.setSelectionRange(res.selectionStart, res.selectionEnd)
            }
          }
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('exceeds')) {
          errorNotify(this.$t('forum.editor.imageTooLarge'))
        } else {
          errorNotify(this.$t('forum.editor.imageError'))
        }
      } finally {
        this.attachingImage = false
      }
    },
    removeAttachment(id: string) {
      this.attachments = this.attachments.filter(a => a.id !== id)
      this.message = removeAttachmentReferences(this.message, id)
    },
    formatAttachmentSize(bytes: number) {
      return formatAttachmentSize(bytes)
    },
    back() {
      navigateBack(this.$router)
    },
    validateUrl(val: string) {
      try {
        const url = new URL(val)
        return !!url
      } catch (err) {
        console.log(err)
        return false
      }
    },
  },
})
</script>

<style scoped>
:deep() .mdstyle img {
  max-width: 100%;
  max-height: 448px;
}
:deep() .mdstyle pre code {
  /*overflow-wrap: break-word;*/
  max-width: 100%;
  white-space: pre-wrap;
}
:deep() .mdstyle table {
  /*overflow-wrap: break-word;*/
  max-width: 100%;
  white-space: pre-wrap;
}
:deep() .mdstyle p {
  max-width: 100%;
  word-break: break-word;
}
:deep() .mdstyle h1 {
  font-size: 120%;
  font-weight: bold;
  line-height: inherit;
}
:deep() .mdstyle h2 {
  font-size: 120%;
  font-weight: bold;
  line-height: inherit;
}
:deep() .mdstyle h3 {
  font-size: 120%;
  font-weight: bold;
  line-height: inherit;
}
:deep() .mdstyle h4 {
  font-size: 120%;
  font-weight: bold;
  line-height: inherit;
}
</style>
