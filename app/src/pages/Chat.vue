<template>
  <div>
    <q-page-container>
      <q-page class="chat-page-background column no-wrap">
        <div class="col relative-position">
          <!-- Announces a message that arrives while this chat is open, once. It starts empty
          and only ever gains the arrivals, so opening a chat does not read out its history.
          The visible list is deliberately not the live region: its bubbles carry their own
          status regions (Sending…, failures) and it is rebuilt when older pages load. -->
          <div
            class="q-sr-only"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            :aria-label="$t('a11y.incomingMessages')"
            data-testid="incoming-message-log"
          >
            <p v-for="arrival in arrivals" :key="arrival.id">
              {{ arrival.text }}
            </p>
          </div>
          <q-scroll-area
            ref="chatScroll"
            @scroll="scrollHandler"
            class="q-px-none absolute full-width full-height column"
          >
            <!-- Clearance tracks the overlay height so a wrapped banner cannot cover the
            oldest bubble. q-py-md is the gap when the overlay is empty. -->
            <div
              class="chat-message-list row q-px-lg q-py-md"
              :style="bannerClearanceStyle"
            >
              <template
                v-for="(msg, index) in chunkedMessages"
                :key="msg.payloadDigest"
              >
                <chat-message-component
                  :index="index"
                  :message="msg"
                  :address="address"
                  :name="getContact(msg.outbound).name ?? 'unknown'"
                  :chat-width="chatWidth"
                  :payload-digest="msg.payloadDigest"
                  :style="messageScrollMarginStyle"
                  :ref="msg.payloadDigest"
                  :focus-after-retry="focusComposerAfterRetry"
                  :focus-failed-after-retry="focusFailedAfterRetry"
                  @replyClicked="({ payloadDigest }) => setReply(payloadDigest)"
                  @replyDivClick="scrollToMessage"
                  @sendFollowUp="sendFollowUpItems"
                />
              </template>
            </div>
          </q-scroll-area>
          <!-- Overlaying the bounded viewport keeps banner changes from resizing the scroll box. -->
          <div
            class="chat-banner-overlay absolute-top full-width no-pointer-events"
            :class="{ 'shadow-2': bannerClearance > 0 }"
          >
            <q-resize-observer @resize="onBannerResize" />
            <chat-banner-stack :stamp-status="stampPreparationStatus" />
          </div>
        </div>
        <q-page-sticky
          position="bottom-right"
          :offset="[18, 18]"
          v-show="!bottom"
        >
          <q-btn
            round
            size="md"
            icon="arrow_downward"
            :aria-label="$t('a11y.scrollToLatest')"
            @mousedown.prevent="buttonScrollBottom"
            color="accent"
          />
        </q-page-sticky>
        <q-inner-loading
          :dark="$q.dark.isActive"
          :showing="!!scrollDigest"
          size="md"
          label="Loading more messages..."
        />
      </q-page>
    </q-page-container>
    <q-footer bordered>
      <div v-if="!!replyDigest" class="q-px-md q-pt-sm" ref="replyBox">
        <!-- Reply box -->
        <div class="row justify-end">
          <div class="col-auto">
            <q-btn
              dense
              flat
              color="accent"
              icon="close"
              :aria-label="$t('a11y.cancelReply')"
              @click="setReply(null)"
            />
          </div>
        </div>
        <div class="row q-px-sm q-pt-sm">
          <div class="col-12">
            <chat-message-reply :payload-digest="replyDigest" />
          </div>
        </div>
      </div>
      <blackjack-unsent-wagers
        :address="address"
        :name="peerName"
        :submit="sendFollowUpWhenIdle"
      />
      <!-- Message box -->
      <chat-input
        @sendFileClicked="toSendFileDialog"
        @giveLotusClicked="$emit('giveLotusClicked')"
        ref="chatInput"
        v-model:message="message"
        v-model:stamp-amount="stampAmount"
        :disable="sendingMessage"
        @sendMessage="sendMessage"
      />
    </q-footer>
  </div>
</template>

<script lang="ts">
import { defineComponent, markRaw, ref } from 'vue'

import ChatMessageComponent from '../components/chat/messages/ChatMessage.vue'
import ChatBannerStack from '../components/chat/ChatBannerStack.vue'
import ChatInput from '../components/chat/ChatInput.vue'
import BlackjackUnsentWagers from '../components/chat/BlackjackUnsentWagers.vue'
import ChatMessageReply from '../components/chat/messages/ChatMessageReply.vue'
import type { BlackjackChatContext } from '../components/chat/messages/ChatMessageBlackjack.vue'

import { errorNotify, insufficientStampNotify } from '../utils/notifications'
import { defaultAcceptancePrice, defaultStampAmount } from '../utils/constants'
import { deliverBetWhenReady } from '../utils/blackjack-bet'
import { useMonadWallet } from '../utils/clients'
import {
  sendErrorNotifyOptions,
  sendRefusalReason,
} from '../utils/send-refusal'
import {
  activeChain,
  type DirectMessagePreparationProgress,
} from '@frank/wallet/chain'
import { MessageItem } from '@frank/cashweb/types/messages'
import { getMessageItemPreview } from '@frank/wallet/message-item-plugins'

import { debounce, QScrollArea } from 'quasar'

import { RouteLocationNormalized } from 'vue-router'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { ChatMessage, useChatStore } from 'src/stores/chats'
import type { OutgoingOutcome } from 'src/stores/chats'

const scrollDuration = 0

// At most this many arrivals of one batch are read out; the rest are in the list itself.
const ARRIVALS_ANNOUNCED_MAX = 5
const ARRIVAL_PREVIEW_MAX_CHARS = 300

function arrivalPreview(message: ChatMessage): string {
  try {
    return message.items
      .map(item => getMessageItemPreview(item))
      .join(' ')
      .slice(0, ARRIVAL_PREVIEW_MAX_CHARS)
  } catch {
    return ''
  }
}

// A refusal carries its own translated reason; anything else stays the generic message, since
// provider and relay text is never shown to the user.
function notifySendError(err: unknown) {
  errorNotify(
    err instanceof Error ? err : new Error(String(err)),
    sendErrorNotifyOptions(err),
  )
}

export default defineComponent({
  components: {
    ChatMessageComponent,
    ChatMessageReply,
    ChatInput,
    BlackjackUnsentWagers,
    ChatBannerStack,
  },
  beforeRouteUpdate(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized,
    next: () => void,
  ) {
    this.address = to.params.address as string
    this.messagesToShow = 30
    next()
  },
  // What the dealer's bubbles need to place a bet from inside a message (#395): the same awaited,
  // idle-waiting delivery the unsent-wager banner retries with, and the stamp this chat will pay.
  provide() {
    const blackjackChat: BlackjackChatContext = {
      submit: payload => this.sendFollowUpWhenIdle(payload),
      stampWei: () => {
        try {
          return activeChain.fromDisplayAmount(this.stampAmount)
        } catch {
          return null
        }
      },
    }
    return { blackjackChat }
  },
  beforeUnmount() {
    window.removeEventListener('resize', this.resizeHandler)
  },
  data() {
    return {
      address: this.$route.params.address as string,
      bottom: true as boolean,
      // Overlay height plus the 16px q-py-md gap. Zero keeps the stylesheet pad
      // when no banner is showing.
      bannerClearance: 0,
      // While a clearance change settles, stay pinned instead of flashing jump-to-bottom.
      keepBottomForBanner: false,
      messagesToShow: 30,
      replyDigest: null as string | null,
      scrollDigest: null as string | null,
      chatWidth: 0,
      message: '',
      // Messages that arrived while this chat was open, for the screen-reader log.
      arrivals: [] as Array<{ id: string; text: string }>,
      stampPreparationStatus: null as string | null,
      sendingMessage: false,
    }
  },
  setup() {
    const chats = useChatStore()
    const contacts = useContactStore()
    const myProfile = useProfileStore()

    return {
      getAcceptancePrice: contacts.getAcceptancePrice,
      getStampAmount: chats.getStampAmount,
      setStampAmount: chats.setStampAmount,
      getContactVuex: contacts.getContact,
      getProfile: myProfile,
      getMessageByPayload: chats.getMessageByPayload,
      sendDirectMessage: chats.sendMessage,
      chats: chats.chats,
      chatScroll: ref<QScrollArea | null>(null),
      // Plain bookkeeping for the arrivals log: which list was last looked at, and what was in it.
      arrivalBaseline: markRaw({
        source: null as unknown,
        seen: new Set<string>(),
      }),
    }
  },
  emits: ['giveLotusClicked', 'sendFileClicked'],
  mounted() {
    this.scrollBottom()
    // set the chat width
    this.resizeHandler()
    // Adjust the chat width when window resizes
    window.addEventListener('resize', debounce(this.resizeHandler, 50))
    this.focusComposeOnOpen()
    // Everything already here is history, not an arrival.
    this.announceArrivals()
  },
  updated() {
    this.$nextTick(() => {
      if (!this.scrollDigest) {
        return
      }
      this.scrollToMessage(this.scrollDigest)
    })
  },
  methods: {
    // Opening a chat (mount or a reused route) places the caret (#411). On this
    // turn, before MainLayout's narrow-overlay restore (one tick later) treats a
    // still-unfocused page as focus lost and moves focus to the opener (#277).
    // One later attempt covers an overlay that is still inert on this turn.
    focusComposeOnOpen() {
      if (this.focusComposeNow()) return
      const root = this.$el as HTMLElement | undefined
      if (!root?.isConnected || root.closest('[inert]')) {
        void this.$nextTick(() => {
          this.focusComposeNow()
        })
      }
    },
    focusComposeNow() {
      if (!this.composeAutofocusAllowed()) return false
      ;(this.$refs.chatInput as { focus?: () => void } | undefined)?.focus?.()
      const active = document.activeElement
      return (
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement
      )
    },
    finePointer() {
      return (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: fine)').matches
      )
    },
    composeAutofocusAllowed() {
      if (!this.finePointer()) return false
      if (document.querySelector('.q-dialog, .q-menu')) return false
      const root = this.$el as HTMLElement | undefined
      if (!root?.isConnected || root.closest('[inert]')) return false
      const active = document.activeElement
      if (!(active instanceof HTMLElement)) return true
      if (
        active === document.body ||
        active === document.documentElement ||
        active.classList.contains('q-layout') ||
        active.classList.contains('q-page-container') ||
        active.closest('.q-drawer') !== null
      ) {
        return true
      }
      // A control already chosen in this chat stays put, except the composer.
      if (root.contains(active)) {
        return active.tagName === 'TEXTAREA' || active.tagName === 'INPUT'
      }
      return false
    },
    focusComposerAfterRetry() {
      void this.$nextTick(() => {
        // A connected control chosen while Retry was pending is still the user's focus.
        if (!this.retryFocusLost()) return
        ;(this.$refs.chatInput as { focus?: () => void } | undefined)?.focus?.()
      })
    },
    focusFailedAfterRetry() {
      void this.$nextTick(() => {
        if (!this.retryFocusLost()) return
        const failed = [...this.messages]
          .reverse()
          .find(message => message.outbound && message.status === 'error')
        if (!failed) return
        this.focusMessageStatus(failed.payloadDigest)
      })
    },
    /** True when keyed removal left focus on the viewport, not on a live control. */
    retryFocusLost() {
      const active = document.activeElement
      if (
        active == null ||
        active === document.body ||
        active === document.documentElement
      ) {
        return true
      }
      return !active.isConnected
    },
    focusMessageStatus(digest: string) {
      const raw = this.$refs[digest] as
        | { focusRetryStatus?: () => void }
        | Array<{ focusRetryStatus?: () => void }>
        | undefined
      const message = Array.isArray(raw) ? raw[0] : raw
      message?.focusRetryStatus?.()
    },
    toSendFileDialog(args: unknown) {
      this.$emit('sendFileClicked', args)
    },
    resizeHandler() {
      const chatScroll = this.chatScroll
      if (!chatScroll || !chatScroll.$el) {
        return
      }
      this.chatWidth = chatScroll.$el.scrollWidth
    },
    scrollHandler(details: {
      verticalSize: number
      verticalContainerSize: number
      verticalPosition: number
    }) {
      if (
        // Ten pixels from top
        details.verticalPosition <= 10
      ) {
        this.messagesToShow += 30
        return
      }
      const gap =
        details.verticalSize -
        details.verticalPosition -
        details.verticalContainerSize
      // Banner clearance grows the content above the viewport. Re-pin once so
      // the jump button does not flash while that height settles.
      if (this.keepBottomForBanner && gap > 10) {
        this.keepBottomForBanner = false
        this.bottom = true
        this.pinScrollToBottom()
        return
      }
      this.keepBottomForBanner = false
      // Set this afterwards, incase we were at the bottom already.
      // We want to ensure that we scroll!
      this.bottom = gap <= 10
    },
    onBannerResize({ height }: { height: number }) {
      const next = height > 0 ? Math.ceil(height) + 16 : 0
      if (next === this.bannerClearance) return
      // Inline clearance replaces q-py-md's 16px. The visible shift is the
      // change in that used padding, not the raw clearance value.
      const prevPad = this.bannerClearance > 0 ? this.bannerClearance : 16
      const nextPad = next > 0 ? next : 16
      const delta = nextPad - prevPad
      const target = this.chatScroll?.getScrollTarget?.()
      const prevTop = target ? target.scrollTop : 0
      const pinBottom = this.bottom
      this.keepBottomForBanner = pinBottom
      this.bannerClearance = next
      this.$nextTick(() => {
        if (pinBottom) {
          this.pinScrollToBottom()
          return
        }
        // Reading history: grow the top pad without shifting the visible bubbles.
        if (target && prevTop > 10) target.scrollTop = prevTop + delta
      })
    },
    pinScrollToBottom() {
      const scrollArea = this.chatScroll
      const target = scrollArea?.getScrollTarget?.()
      if (!scrollArea || !target) return
      scrollArea.setScrollPosition('vertical', target.scrollHeight, 0)
      this.bottom = true
    },
    // Used by sticky QButton to scroll to bottom
    buttonScrollBottom() {
      const scrollArea = this.chatScroll
      if (!scrollArea) {
        // Not mounted yet
        return
      }
      const scrollTarget = scrollArea.getScrollTarget()
      this.$nextTick(() => {
        scrollArea.setScrollPosition(
          'vertical',
          scrollTarget.scrollHeight,
          scrollDuration,
        )
      })
    },
    scrollBottom() {
      const scrollArea = this.chatScroll
      if (!scrollArea) {
        // Not mounted yet
        return
      }
      const scrollTarget = scrollArea.getScrollTarget()
      // If we're not at the bottom, and we're not at the top, leave the scroll
      // alone.
      if (!this.bottom && scrollTarget.scrollTop >= 10) {
        return
      }
      this.$nextTick(() => {
        scrollArea.setScrollPosition(
          'vertical',
          scrollTarget.scrollHeight,
          scrollDuration,
        )
      })
    },
    scrollToMessage(digest: string) {
      return debounce(() => {
        console.log('scrollToMessage', digest)
        // if no digest, it means message was deleted or otherwise can't be found
        if (!digest) {
          return
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const message = (this.$refs[digest] as (typeof ChatMessageComponent)[])
          .slice()
          .shift()

        if (
          !message &&
          !this.messages.some(message => message.payloadDigest === digest)
        ) {
          console.log('Reply was not found in messages')
          this.scrollDigest = null
          return
        }

        // if no message, load more, then try again
        if (!message) {
          this.scrollDigest = digest
          this.messagesToShow += 30
          return
        }
        // Scroll the message into view
        this.scrollDigest = null
        this.$nextTick(() => message.$el.scrollIntoView({ behavior: 'smooth' }))
      }, 50)()
    },
    async sendMessage(message: string) {
      if (this.sendingMessage) {
        return
      }
      const stampValue = activeChain.fromDisplayAmount(this.stampAmount)
      const acceptancePrice =
        this.getAcceptancePrice(this.address) ?? defaultAcceptancePrice
      if (stampValue < BigInt(acceptancePrice)) {
        insufficientStampNotify()
      }
      if (!message) {
        return
      }
      // Messaging not ready is known before anything is created: say why and leave the typed
      // text where it is.
      let wallet: ReturnType<typeof useMonadWallet>
      try {
        wallet = useMonadWallet()
      } catch (err) {
        notifySendError(err)
        return
      }
      // Move the submitted text into the optimistic outbox bubble immediately. The user should
      // never be editing the contents of a message whose accounts and stamp payments are already
      // being prepared.
      const submittedMessage = message
      const submittedReply = this.replyDigest
      this.sendingMessage = true
      this.message = ''
      this.replyDigest = null
      // Was calling the old Lotus `$relayClient.sendMessage` directly, completely bypassing
      // `stores/chats.ts`'s `sendMessage` (ticket #42's real, tested `activeChain.directMessages.send`
      // wiring) -- that store action always existed and worked, but nothing in the actual UI ever
      // called it. Explicitly flagged as ticket #44's job in `utils/clients.ts`'s own doc comment
      // ("any UI wiring to it") and missed there too. Found live tonight (autonomous overnight
      // session, 2026-09-27) by actually clicking Send in a real browser and finding the message
      // never left the input box.
      try {
        this.stampPreparationStatus = this.$t('chat.stampPreparationChecking')
        await this.sendDirectMessage({
          wallet,
          address: this.address,
          items: [{ type: 'text', text: submittedMessage }],
          stampValue,
          onPreparationProgress: this.showStampPreparation,
        })
      } catch (err) {
        // Send failures do not throw: the message stays in the conversation, marked failed with a
        // Retry and Discard (#269/#270). Only a precondition failure (e.g. an invalid recipient)
        // or a failure to store an already delivered message arrives here.
        if (sendRefusalReason(err) !== undefined) {
          // Refused before any message was created (e.g. too long): nothing holds the text but
          // the composer, so give it back, ahead of anything typed meanwhile.
          this.message = submittedMessage + this.message
          this.replyDigest = this.replyDigest ?? submittedReply
        }
        notifySendError(err)
        return
      } finally {
        this.stampPreparationStatus = null
        this.sendingMessage = false
      }
      // After message send, scroll to bottom if not already there
      if (!this.bottom) {
        this.$nextTick(this.buttonScrollBottom)
      }
    },
    // Shows the preparation stage of a send (checking / funding / ready) in the composer status
    // line, translated -- one place for every way a send can prepare its stamp accounts.
    showStampPreparation(progress: DirectMessagePreparationProgress) {
      if (progress.stage === 'checking') {
        this.stampPreparationStatus = this.$t('chat.stampPreparationChecking')
      } else if (progress.stage === 'funding') {
        this.stampPreparationStatus = this.$t('chat.stampPreparationFunding', {
          completed: progress.completed,
          total: progress.total,
          feeReserve: activeChain.toDisplayAmount(progress.feeReserveWei),
          unit: activeChain.unit,
        })
      } else {
        this.stampPreparationStatus = this.$t('chat.stampPreparationReady')
      }
    },
    // Handles a plugin renderer's `sendFollowUp` emit (see ChatMessage.vue's own relay of it --
    // e.g. blackjack's Hit/Stand buttons, or the vendor-bot catalog's own Buy buttons) by feeding
    // arbitrary items through the exact same prepare-and-send pipeline `sendMessage` uses for free
    // text: same sendingMessage/stampPreparationStatus UX, same error handling. Deliberately
    // simpler than `sendMessage` in one respect -- no recovered-draft-confirmation flow, since a
    // button click isn't a resendable "draft" the way typed text is; a recovered-attempt error
    // here just surfaces as a plain notification instead.
    //
    // `stampValueWei` is an optional override of the user's own configured default stamp amount --
    // needed for a digital-goods purchase, where the price paid *is* the message's stamp value
    // (see `DigitalGoodsItem`'s own header on `@frank/cashweb/types/messages`), which is very
    // unlikely to equal whatever this user happens to have their own default stamp set to.
    async sendFollowUpItems({
      items,
      stampValueWei,
      settled,
    }: {
      items: MessageItem[]
      stampValueWei?: bigint
      /** Called exactly once with whether the message was sent, so a renderer that spent money
       * on the click (a purchase) can hold its own in-flight guard until then. */
      settled?: (sent: boolean) => void
    }): Promise<boolean> {
      let sent = false
      try {
        sent = await this.sendFollowUpItemsUnsettled({ items, stampValueWei })
        return sent
      } finally {
        // Exactly once, even if the send throws (a throw counts as not sent).
        settled?.(sent)
      }
    },
    async sendFollowUpItemsUnsettled({
      items,
      stampValueWei,
    }: {
      items: MessageItem[]
      stampValueWei?: bigint
    }): Promise<boolean> {
      if (this.sendingMessage) {
        return false
      }
      const stampValue =
        stampValueWei ?? activeChain.fromDisplayAmount(this.stampAmount)
      this.sendingMessage = true
      let outcome: OutgoingOutcome
      try {
        this.stampPreparationStatus = this.$t('chat.stampPreparationChecking')
        outcome = await this.sendDirectMessage({
          wallet: useMonadWallet(),
          address: this.address,
          items,
          stampValue,
          onPreparationProgress: this.showStampPreparation,
        })
      } catch (err) {
        notifySendError(err)
        return false
      } finally {
        this.stampPreparationStatus = null
        this.sendingMessage = false
      }
      if (!this.bottom) {
        this.$nextTick(this.buttonScrollBottom)
      }
      // A failed send no longer throws (the message stays in the chat as failed, with Retry), so
      // the caller's "was it sent" answer must come from the outcome: only a delivered message,
      // or one whose payment is safely pending and will deliver on its own, counts. A failed one
      // is "not sent", which keeps a bet's unsent-wager record and a purchase's guard honest.
      return outcome.state === 'sent' || outcome.state === 'payment-pending'
    },
    // For value-bearing follow-ups whose payment is already on its way (the first blackjack bet:
    // its wager transfer takes seconds): `sendFollowUpItems` drops a call made while another send
    // is in flight, which would strand the wager, so wait for the chat to go idle first.
    async sendFollowUpWhenIdle(payload: {
      items: MessageItem[]
      stampValueWei?: bigint
      address: string
    }) {
      await deliverBetWhenReady({
        betAddress: payload.address,
        currentAddress: () => this.address,
        isBusy: () => this.sendingMessage,
        send: () =>
          this.sendFollowUpItems({
            items: payload.items,
            stampValueWei: payload.stampValueWei,
          }),
      })
    },
    // Fills the screen-reader log with the incoming messages added since the last look. A
    // different list (another chat, or the store reloaded) is taken as the new baseline without
    // announcing anything: that is history.
    announceArrivals() {
      const baseline = this.arrivalBaseline
      const list = this.messages
      if (baseline.source !== list) {
        baseline.source = list
        baseline.seen = new Set(list.map(message => message.payloadDigest))
        this.arrivals = []
        return
      }
      const fresh: ChatMessage[] = []
      for (const message of list) {
        if (baseline.seen.has(message.payloadDigest)) continue
        baseline.seen.add(message.payloadDigest)
        // Own messages already announce their sending state on the bubble.
        if (!message.outbound) fresh.push(message)
      }
      if (fresh.length === 0) return
      const name = this.peerName || this.address
      this.arrivals = fresh.slice(-ARRIVALS_ANNOUNCED_MAX).map(message => ({
        id: message.payloadDigest,
        text: this.$t('a11y.incomingMessage', {
          name,
          text: arrivalPreview(message),
        }),
      }))
    },
    getContact(outbound: boolean) {
      if (outbound) {
        return this.getProfile.profile
      } else {
        return this.getContactVuex(this.address)?.profile
      }
    },
    setReply(payloadDigest: string | null) {
      console.log('setting reply')
      this.replyDigest = payloadDigest
    },
  },
  computed: {
    bannerClearanceStyle(): { paddingTop: string } | undefined {
      return this.bannerClearance > 0
        ? { paddingTop: `${this.bannerClearance}px` }
        : undefined
    },
    messageScrollMarginStyle(): { scrollMarginTop: string } | undefined {
      return this.bannerClearance > 0
        ? { scrollMarginTop: `${this.bannerClearance}px` }
        : undefined
    },
    peerName(): string {
      return this.getContactVuex(this.address)?.profile?.name ?? ''
    },
    messages(): ChatMessage[] {
      const activeChat = this.chats[this.address]
      return activeChat ? activeChat.messages : []
    },
    chunkedMessages() {
      // TODO: Improve stacking logic e.g. long durations between messages prevent stacking
      // TODO: Optimize this by progressively constructing it
      if (!this.messages) {
        return []
      }

      const length = Math.min(this.messages.length, this.messagesToShow)
      const start = this.messages.length - length
      const end = this.messages.length

      return this.messages.slice(start, end)
    },
    stampAmount: {
      set(stampAmount: string | undefined) {
        let rawAmount: bigint
        try {
          rawAmount = activeChain.fromDisplayAmount(stampAmount ?? '')
        } catch {
          return
        }
        rawAmount =
          rawAmount < activeChain.defaultStampValue
            ? activeChain.defaultStampValue
            : rawAmount
        this.setStampAmount({
          address: this.address,
          stampAmount: Number(rawAmount),
        })
      },
      get() {
        const stored = this.getStampAmount(this.address)
        const storedRaw = BigInt(stored)
        // Values persisted by the old Lotus-denominated control (and the earlier Monad preview)
        // are not meaningful wei defaults. Upgrade them in-place at display/send time.
        const raw =
          stored === defaultStampAmount ||
          storedRaw < activeChain.defaultStampValue
            ? activeChain.defaultStampValue
            : storedRaw
        return activeChain.toDisplayAmount(raw)
      },
    },
  },
  watch: {
    'address'() {
      this.focusComposeOnOpen()
      this.announceArrivals()
    },
    'messages.length'() {
      // Scroll to bottom if user was already there.
      this.scrollBottom()
      this.announceArrivals()
    },
    'active'(newActive) {
      if (!newActive) {
        return
      }
      // Scroll to bottom only if the view was effectively in it's initial state.
      this.scrollBottom()
      // TODO: Scroll to last unread
    },
  },
})
</script>

<style lang="scss" scoped>
:deep() .message-color {
  background-color: var(--q-message-color);
}
:deep() .message-color-sent {
  background-color: var(--q-message-color-sent);
}
.chat-banner-overlay {
  z-index: 1;
}
</style>
