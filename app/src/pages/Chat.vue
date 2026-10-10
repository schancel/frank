<template>
  <div>
    <q-page-container>
      <email-thread-view
        v-if="isEmailThread"
        :key="conversation?.id"
        :conversation="conversation"
        :messages="messages"
        :sending="sendingMessage"
        :stamp-status="stampPreparationStatus"
        :recipient-address="recipientAddress"
        @sendReply="sendEmailReply"
      />
      <q-page v-else class="chat-page-background column no-wrap">
        <div class="col relative-position">
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
              <!-- A bubble can grow after it arrived (a blackjack hand renders its result a
              moment later); a view that was following the newest message stays on it. -->
              <q-resize-observer @resize="onMessageListResize" />
              <template
                v-for="(msg, index) in chunkedMessages"
                :key="msg.payloadDigest"
              >
                <chat-message-component
                  :index="index"
                  :message="msg"
                  :address="recipientAddress"
                  :name="messageSenderName(msg, index)"
                  :attribution="attributions[index]"
                  :chat-width="chatWidth"
                  :payload-digest="msg.payloadDigest"
                  :style="messageScrollMarginStyle"
                  :ref="msg.payloadDigest"
                  :focus-after-retry="focusComposerAfterRetry"
                  @replyClicked="({ payloadDigest }) => setReply(payloadDigest)"
                  @forwardClicked="handleForwardClicked"
                  @replyDivClick="scrollToMessage"
                  @sendFollowUp="sendFollowUpItems"
                  @playAgain="blackjackDialog = true"
                  @senderClicked="openSenderProfile"
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
    <q-footer
      v-if="!isEmailThread"
      bordered
      :height-hint="64"
      class="chat-footer chat-input-bar"
    >
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
      <!-- Others have posted into this conversation, but what is sent from here still goes to
      its one peer. Say so, so a reply is not taken for a message to everyone. -->
      <div
        v-if="isGroup"
        class="q-px-md q-pt-xs text-caption chat-group-recipient"
        data-testid="chat-group-recipient"
        role="note"
      >
        <q-icon name="info" size="14px" class="q-mr-xs" />{{
          recipientIsSelf
            ? $t('chat.groupRecipientNoticeSelf')
            : $t('chat.groupRecipientNotice', { name: recipientName })
        }}
      </div>
      <!-- Message box -->
      <chat-input
        @giveLotusClicked="$emit('giveLotusClicked')"
        @blackjackClicked="blackjackDialog = true"
        @sendStealthClicked="stealthDialog = true"
        ref="chatInput"
        v-model:message="message"
        v-model:attachments="attachments"
        v-model:stamp-amount="stampAmount"
        @sendMessage="sendMessage"
      />
    </q-footer>
    <!-- A blackjack challenge from the composer's message-type menu: any chat, any contact. -->
    <q-dialog v-model="blackjackDialog">
      <q-card v-if="blackjackDialog" data-testid="blackjack-dialog">
        <blackjack-challenge-form
          :busy="sendingMessage"
          @submit="sendBlackjackChallenge"
        />
      </q-card>
    </q-dialog>
    <!-- Send Stealth dialog: multi-chain encrypted stealth payment -->
    <q-dialog v-model="stealthDialog">
      <send-stealth-dialog
        v-if="stealthDialog"
        :contact="contact"
        :address="recipientAddress"
        :busy="sendingMessage"
        @send="sendStealthPayment"
      />
    </q-dialog>
    <!-- Offer Swap dialog: cross-chain atomic swap offer -->
    <q-dialog v-model="swapDialog">
      <offer-swap-dialog
        v-if="swapDialog"
        :contact="contact"
        :address="recipientAddress"
        :busy="sendingMessage"
        @offer="sendSwapOffer"
      />
    </q-dialog>
    <!-- Forward message dialog -->
    <q-dialog v-model="forwardDialogOpen">
      <forward-message-dialog
        v-if="messageToForward"
        :message="messageToForward"
        @forward="handleForwardToContact"
      />
    </q-dialog>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue'

import ChatMessageComponent from '../components/chat/messages/ChatMessage.vue'
import EmailThreadView, {
  type EmailReply,
} from '../components/chat/email/EmailThreadView.vue'
import ChatBannerStack from '../components/chat/ChatBannerStack.vue'
import ChatInput from '../components/chat/ChatInput.vue'
import BlackjackChallengeForm from '../components/chat/BlackjackChallengeForm.vue'
import SendStealthDialog from '../components/dialogs/SendStealthDialog.vue'
import OfferSwapDialog from '../components/dialogs/OfferSwapDialog.vue'
import ForwardMessageDialog from '../components/dialogs/ForwardMessageDialog.vue'
import ChatMessageReply from '../components/chat/messages/ChatMessageReply.vue'
import { openChat, openContactProfile } from '../utils/routes'
import {
  attributeMessages,
  conversationSenders,
  isGroupConversation,
  senderOf,
  type BubbleAttribution,
  type SenderIdentity,
} from '../utils/chat-attribution'
import { shortAddress } from '../utils/short-address'
import { isChainAddress, toChainDisplayAddress } from '../utils/chain-address'

import { errorNotify, insufficientStampNotify } from '../utils/notifications'
import {
  defaultAcceptancePrice,
  defaultEmailGatewayAddress,
} from '../utils/constants'
import { useSettingsStore } from '../stores/settings'
import {
  automaticDealerSteps,
  handItemStillNext,
  HAND_FEE_RESERVE_WEI,
  storedOutgoingMessages,
  resumeHandMessages,
  type HandResumeStore,
  newGameId,
  newSeed,
  saveSeed,
} from '../utils/blackjack-hand'
import {
  getOwnCanonicalAddress,
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
} from '../utils/own-address'
import {
  buildChallenge,
  soleHandItem,
  type HandRole,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import { useMonadWallet } from '../utils/clients'
import {
  activeChain,
  type DirectMessagePreparationProgress,
} from '@frank/wallet/chain'
import { useActiveWallet } from '../composables/useActiveWallet'
import { formatDisplayNumber } from '../utils/chain-amount'
import { nextFollowBottom } from '../utils/follow-bottom'
import { composeChatItems, fitsOneMessage } from '../utils/chat-attachments'
import type { PostAttachment } from '../utils/post-editor'
import type { MessageItem, EmailItem } from '@frank/cashweb/types/messages'

import { debounce, QScrollArea } from 'quasar'

import { RouteLocationNormalized } from 'vue-router'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { ChatMessage, type Conversation, useChatStore } from 'src/stores/chats'
import type { OutgoingOutcome } from 'src/stores/chats'
import { useBalance } from 'src/composables/useBalance'

const scrollDuration = 0

export default defineComponent({
  components: {
    ChatMessageComponent,
    EmailThreadView,
    ChatMessageReply,
    ChatInput,
    BlackjackChallengeForm,
    SendStealthDialog,
    OfferSwapDialog,
    ForwardMessageDialog,
    ChatBannerStack,
  },
  beforeRouteUpdate(to: RouteLocationNormalized) {
    const nextAddress = (to?.params?.address as string) || ''
    this.messagesToShow = 30
    if (this.address !== nextAddress) {
      this.address = nextAddress
    }
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
      // Whether the view follows the newest message; see `nextFollowBottom`.
      followBottom: true,
      lastScrollPosition: 0,
      messagesToShow: 30,
      replyDigest: null as string | null,
      scrollDigest: null as string | null,
      chatWidth: 0,
      message: '',
      // Pictures held by the composer for the next message (see utils/chat-attachments.ts).
      attachments: [] as PostAttachment[],
      stampPreparationStatus: null as string | null,
      sendingMessage: false,
      activeSendCount: 0,
      blackjackDialog: false,
      stealthDialog: false,
      swapDialog: false,
      forwardDialogOpen: false,
      messageToForward: null as ChatMessage | null,
      // Automatic dealer steps already attempted in this page session.
      blackjackAttempted: new Set<string>(),
      // An own undelivered hand message is being resumed; no automatic step meanwhile.
      resumingHand: false,
    }
  },
  setup() {
    const chats = useChatStore()
    const contacts = useContactStore()
    const myProfile = useProfileStore()
    const { refresh: refreshBalance } = useBalance()

    return {
      refreshBalance,
      getAcceptancePrice: contacts.getAcceptancePrice,
      getContactVuex: contacts.getContact,
      contactStore: contacts,
      ownAddress: useReactiveOwnCanonicalAddress(),
      getProfile: myProfile,
      getMessageByPayload: chats.getMessageByPayload,
      sendDirectMessage: chats.sendMessage,
      chatStore: chats,
      chatScroll: ref<QScrollArea | null>(null),
    }
  },
  emits: ['giveLotusClicked'],
  mounted() {
    if (
      this.address &&
      typeof this.chatStore?.setActiveConversation === 'function'
    ) {
      this.chatStore.setActiveConversation(this.address)
    }
    this.scrollBottom()
    // set the chat width
    this.resizeHandler()
    // Adjust the chat width when window resizes
    window.addEventListener('resize', debounce(this.resizeHandler, 50))
    this.focusComposeOnOpen()
    void this.runBlackjackDealer()
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
      this.followBottom = nextFollowBottom(
        this.followBottom,
        this.lastScrollPosition,
        details.verticalPosition,
        details.verticalSize -
          details.verticalPosition -
          details.verticalContainerSize,
      )
      this.lastScrollPosition = details.verticalPosition
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
    onMessageListResize() {
      if (this.followBottom) this.pinScrollToBottom()
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
      const recipient = this.recipientAddress || this.address
      const stampValue = activeChain.fromDisplayAmount(this.stampAmount)
      const rawPrice = this.getAcceptancePrice(recipient)
      const acceptancePrice =
        typeof rawPrice === 'number' && Number.isFinite(rawPrice)
          ? BigInt(Math.trunc(rawPrice))
          : typeof rawPrice === 'bigint'
          ? rawPrice
          : BigInt(defaultAcceptancePrice)
      if (stampValue < acceptancePrice) {
        insufficientStampNotify()
      }
      const attachmentsToSend = this.attachments
      if (!message.trim() && attachmentsToSend.length === 0) {
        return
      }
      // The text and its pictures must fit one message. Refused here, before anything is paid:
      // the wallet would refuse an oversized message only after funding it.
      if (!fitsOneMessage(message, attachmentsToSend)) {
        errorNotify(new Error(this.$t('chatInput.messageTooLarge')))
        return
      }
      // Move the submitted text into the optimistic outbox bubble immediately. The user should
      // never be editing the contents of a message whose accounts and stamp payments are already
      // being prepared.
      const submittedMessage = message
      const replyDigestToSend = this.replyDigest
      this.activeSendCount = (this.activeSendCount || 0) + 1
      this.sendingMessage = true
      this.message = ''
      this.attachments = []
      this.replyDigest = null

      // The reply, the text, then the pictures the text refers to by position.
      const items = composeChatItems(
        submittedMessage,
        attachmentsToSend,
        replyDigestToSend,
      )

      try {
        await this.sendDirectMessage({
          wallet: useMonadWallet(),
          address: recipient,
          conversationId: this.conversation?.id,
          items,
          stampValue,
          onPreparationProgress: this.showStampPreparation,
        })
      } catch (err) {
        // Send failures do not throw: the message stays in the conversation, marked failed with a
        // Retry and Discard (#269/#270). Only a precondition failure (e.g. an invalid recipient)
        // or a failure to store an already delivered message arrives here.
        errorNotify(err instanceof Error ? err : new Error(String(err)))
        return
      } finally {
        this.activeSendCount = Math.max(0, (this.activeSendCount || 1) - 1)
        if (this.activeSendCount === 0) {
          this.stampPreparationStatus = null
          this.sendingMessage = false
        }
      }
      // After message send, scroll to bottom if not already there
      if (!this.bottom) {
        this.$nextTick(this.buttonScrollBottom)
      }
    },
    async sendEmailReply(payload: EmailReply) {
      if (this.sendingMessage) {
        return
      }
      const conversation = this.chatStore.conversations[payload.conversationId]
      if (
        !conversation ||
        conversation.deletedAt ||
        this.conversation?.id !== conversation.id
      ) {
        errorNotify(
          new Error('The selected email conversation is no longer available'),
        )
        return
      }
      const originalName = conversation.name
      const recipient =
        payload.targetAddress || this.recipientAddress || this.address
      const stampValue = activeChain.fromDisplayAmount(this.stampAmount)
      this.sendingMessage = true
      try {
        await this.sendDirectMessage({
          wallet: useMonadWallet(),
          address: recipient,
          conversationId: conversation.id,
          items: payload.items,
          stampValue,
          onPreparationProgress: this.showStampPreparation,
        })
        const emailItem = payload.items.find(it => it.type === 'email') as
          | EmailItem
          | undefined
        const owner = this.chatStore.conversations[conversation.id]
        if (
          owner === conversation &&
          !owner.deletedAt &&
          owner.name === originalName &&
          emailItem?.subject?.trim() &&
          (!originalName ||
            originalName.includes('@') ||
            originalName === 'New Email' ||
            originalName.startsWith('Draft to'))
        ) {
          this.chatStore.renameConversation(conversation.id, emailItem.subject)
        }
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.stampPreparationStatus = null
        this.sendingMessage = false
      }
    },
    /** A payment to this contact. The wallet signs and saves the transfer (nothing is broadcast)
     * and returns the item; the message carrying it goes through the conversation's ordinary
     * send, so it has its outgoing bubble, its pending state and its Retry like any message.
     * The wallet broadcasts the transfer when the relay has stored that message. The stamp is the
     * message's price; the amount is the payment's own. */
    async sendStealthPayment({
      value,
      memo,
    }: {
      value: bigint
      memo?: string
    }) {
      const stampValue = activeChain.fromDisplayAmount(this.stampAmount)
      this.sendingMessage = true
      const recipient = this.recipientAddress || this.address
      try {
        let prepared
        try {
          const wallet = await useActiveWallet()
          if (!wallet.prepareContactPayment)
            throw new Error(
              'Payments to a contact are not available on this chain',
            )
          prepared = await wallet.prepareContactPayment({
            recipient: { raw: recipient },
            value,
            memo: memo || undefined,
            stampValue,
          })
        } catch (err) {
          // Refused before anything was signed: nothing was sent.
          errorNotify(err, { fallbackKey: 'sendStealthDialog.notSent' })
          return
        }
        try {
          await this.sendDirectMessage({
            wallet: useMonadWallet(),
            address: recipient,
            conversationId: this.conversation?.id,
            items: [prepared.item],
            stampValue,
            onPreparationProgress: this.showStampPreparation,
          })
        } catch (err) {
          // The payment is signed and saved by now. Whatever stopped the message, this is not
          // "nothing was sent": the wallet releases the payment if no byte of it left, and
          // finishes it otherwise.
          errorNotify(err, { fallbackKey: 'sendStealthDialog.messageEnded' })
        }
      } finally {
        this.stampPreparationStatus = null
        this.sendingMessage = false
      }
      if (!this.bottom) {
        this.$nextTick(this.buttonScrollBottom)
      }
    },
    async sendSwapOffer(item: MessageItem) {
      const stampValue = activeChain.fromDisplayAmount(this.stampAmount)
      const items: MessageItem[] = [item]
      this.sendingMessage = true
      const recipient = this.recipientAddress || this.address
      try {
        await this.sendDirectMessage({
          wallet: useMonadWallet(),
          address: recipient,
          conversationId: this.conversation?.id,
          items,
          stampValue,
          onPreparationProgress: this.showStampPreparation,
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.stampPreparationStatus = null
        this.sendingMessage = false
      }
      if (!this.bottom) {
        this.$nextTick(this.buttonScrollBottom)
      }
    },
    // Shows the preparation stage of a send in the composer status line, translated --
    // only when a background on-chain funding transaction is genuinely in-flight.
    showStampPreparation(progress: DirectMessagePreparationProgress) {
      if (progress.stage === 'funding') {
        this.stampPreparationStatus = this.$t('chat.stampPreparationFunding', {
          completed: progress.completed,
          total: progress.total,
          feeReserve: formatDisplayNumber(activeChain, progress.feeReserveWei),
          unit: activeChain.unit,
        })
      } else {
        this.stampPreparationStatus = null
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
      // A blackjack message is sent only while it is still the hand's next message, judged on
      // the messages saved on this device too, so a payout, refund, bet or deal that another
      // tab already sent (or is still sending) is not sent a second time from this one.
      const peer = this.recipientAddress || this.address
      const handItem = soleHandItem(items)
      if (handItem) {
        this.sendingMessage = true
        let stillNext = false
        try {
          const own = await getOwnCanonicalAddress()
          stillNext =
            !!own &&
            (await handItemStillNext({
              item: handItem,
              stampWei: stampValue,
              own,
              peer,
              memory: this.peerMessages,
              stored: () => storedOutgoingMessages(peer),
            }))
        } finally {
          this.sendingMessage = false
        }
        if (!stillNext) {
          errorNotify(new Error(this.$t('blackjackP2p.notNext')))
          return false
        }
      }
      this.sendingMessage = true
      let outcome: OutgoingOutcome
      try {
        outcome = await this.sendDirectMessage({
          wallet: useMonadWallet(),
          address: peer,
          conversationId: this.conversation?.id,
          items,
          stampValue,
          onPreparationProgress: this.showStampPreparation,
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
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
    // The challenge form's submit: build the challenge against this wallet's spendable balance
    // and send it as an ordinary message. A dealer's seed is kept on this device before its
    // commitment leaves it.
    async sendBlackjackChallenge({
      role,
      maxBetWei,
    }: {
      role: HandRole
      maxBetWei: bigint
    }) {
      const own = await getOwnCanonicalAddress()
      if (role === 'dealer' && !own) {
        errorNotify(new Error(this.$t('blackjackP2p.challengeRefused')))
        return
      }
      const gameId = newGameId()
      const seed =
        role === 'dealer' ? newSeed(gameId, own ?? undefined) : undefined
      let spendableWei: bigint
      try {
        spendableWei = await activeChain.nativeTransfers.getBalance({
          wallet: useMonadWallet(),
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
        return
      }
      const built = buildChallenge({
        gameId,
        role,
        maxBetWei,
        spendableWei,
        reserveWei: HAND_FEE_RESERVE_WEI,
        seed,
      })
      if ('error' in built) {
        errorNotify(new Error(this.$t('blackjackP2p.challengeRefused')))
        return
      }
      if (seed && own) {
        // The seed is kept under this account's own name before its commitment leaves.
        const peer = this.recipientAddress || this.address
        saveSeed(own, peer, gameId, seed)
      }
      this.blackjackDialog = false
      await this.sendFollowUpItems({ items: [built.item] })
    },
    // Dealer steps that involve no choice and pay nothing (deal, card, a reveal that owes
    // nothing) are sent without asking. Each position of a hand is attempted once per page
    // session; a failed send stays in the chat with its Retry.
    async runBlackjackDealer() {
      if (this.sendingMessage || this.resumingHand) return
      if (
        !this.peerMessages.some(m =>
          m.items?.some(it => it.type === 'blackjack-hand'),
        )
      ) {
        return
      }
      const own = await getOwnCanonicalAddress()
      if (!own || this.sendingMessage || this.resumingHand) return
      // First finish what this user already decided: a hand message that was cut off (the
      // window closed mid-send) or failed counts as sent in the hand, so nothing else can
      // happen until it is delivered. Free steps are sent again; money is only settled.
      // While that is awaited no other trigger (watchers, a finished send) may pick a step.
      let wallet: ReturnType<typeof useMonadWallet>
      try {
        wallet = useMonadWallet()
      } catch {
        return
      }
      const peer = this.recipientAddress || this.address
      this.resumingHand = true
      let resumed: number
      try {
        resumed = await resumeHandMessages({
          store: this.chatStore as unknown as HandResumeStore,
          wallet,
          address: peer,
          own,
          messages: this.peerMessages,
          attempted: this.blackjackAttempted,
          ordinaryStampWei: activeChain.fromDisplayAmount(this.stampAmount),
        })
      } finally {
        this.resumingHand = false
      }
      if (resumed > 0) {
        void this.runBlackjackDealer()
        return
      }
      const step = automaticDealerSteps(this.peerMessages, own, peer).find(
        candidate => !this.blackjackAttempted.has(candidate.key),
      )
      if (!step || this.sendingMessage || this.resumingHand) return
      this.blackjackAttempted.add(step.key)
      await this.sendFollowUpItems({ items: [step.item] })
    },
    /** The name of whoever sent this message: this user, or the message's own sender. */
    messageSenderName(msg: ChatMessage, index: number): string {
      if (msg.outbound) return this.getProfile.profile?.name ?? 'unknown'
      return (
        this.attributions[index]?.sender.label ??
        this.getContactVuex(msg.senderAddress)?.profile?.name ??
        'unknown'
      )
    },
    openSenderProfile(address: string) {
      if (this.$router) void openContactProfile(this.$router, address)
    },
    setReply(payloadDigest: string | null) {
      this.replyDigest = payloadDigest
      if (payloadDigest) {
        this.$nextTick(() => {
          ;(
            this.$refs.chatInput as { focus?: () => void } | undefined
          )?.focus?.()
        })
      }
    },
    handleForwardClicked({
      payloadDigest,
    }: {
      address: string
      payloadDigest: string
    }) {
      const msg =
        this.messages.find(m => m.payloadDigest === payloadDigest) ||
        this.chatStore.messages[payloadDigest]
      if (msg) {
        this.messageToForward = msg
        this.forwardDialogOpen = true
      }
    },
    async handleForwardToContact(targetAddress: string) {
      this.forwardDialogOpen = false
      if (!this.messageToForward) {
        return
      }
      const itemsToSend = this.messageToForward.items
        .filter(item => item.type !== 'reply')
        .map(item => ({ ...item }))
      if (itemsToSend.length === 0) {
        return
      }
      this.sendingMessage = true
      try {
        const stampValue = this.chatStore.getStampWei(targetAddress)
        await this.sendDirectMessage({
          wallet: useMonadWallet(),
          address: targetAddress,
          items: itemsToSend,
          stampValue,
          onPreparationProgress: this.showStampPreparation,
        })
        const peer = this.recipientAddress || this.address
        if (targetAddress !== peer) {
          await openChat(this.$router, targetAddress)
        }
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.stampPreparationStatus = null
        this.sendingMessage = false
        this.messageToForward = null
      }
      if (!this.bottom) {
        this.$nextTick(this.buttonScrollBottom)
      }
    },
  },
  computed: {
    isEmailThread(): boolean {
      if (this.conversation?.kind === 'email') {
        return true
      }
      // An email item makes this an email thread only when we or the peer sent it.
      return this.peerMessages.some(m => m.items?.some(i => i.type === 'email'))
    },
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
    conversation(): Conversation | null {
      return (
        this.chatStore.conversations[this.address] ??
        (isChainAddress(this.address)
          ? this.chatStore.chats[toChainDisplayAddress(this.address)]
          : null) ??
        null
      )
    },
    recipientAddress(): string {
      if (this.conversation?.address) {
        return this.conversation.address
      }
      if (
        this.conversation?.participants &&
        this.conversation.participants.length > 0
      ) {
        return this.conversation.participants[0]
      }
      if (this.isEmailThread) {
        try {
          const settingsStore = useSettingsStore()
          return settingsStore.emailGatewayAddress || defaultEmailGatewayAddress
        } catch {
          return defaultEmailGatewayAddress
        }
      }
      return this.address
    },
    contact() {
      return this.getContactVuex(this.recipientAddress)
    },
    peerName(): string {
      if (this.conversation?.name) {
        return this.conversation.name
      }
      return this.getContactVuex(this.recipientAddress)?.profile?.name ?? ''
    },
    messages(): ChatMessage[] {
      return this.conversation?.messages ?? []
    },
    /** What this user and the conversation's peer sent. A game is between those two; what
     * anyone else posted into the conversation is not one of its moves. */
    peerMessages(): ChatMessage[] {
      const peer = this.recipientAddress || this.address
      return this.messages.filter(
        message =>
          message.outbound || sameCanonicalAddress(message.senderAddress, peer),
      )
    },
    /** More than two people are in this conversation, so each message must say who sent it. */
    isGroup(): boolean {
      return isGroupConversation(
        this.conversation?.participants,
        this.ownAddress,
        this.conversation?.address,
      )
    },
    senders(): Map<string, SenderIdentity> {
      if (!this.isGroup) return new Map()
      return conversationSenders(
        this.conversation,
        this.ownAddress,
        this.contactStore,
        this.chunkedMessages,
      )
    },
    /** One entry per shown message; all empty in a two-person chat. */
    attributions(): Array<BubbleAttribution | undefined> {
      if (!this.isGroup) return []
      return attributeMessages(this.chunkedMessages, this.senders)
    },
    /** These are this user's own notes: what is sent from here goes to nobody else. */
    recipientIsSelf(): boolean {
      return sameCanonicalAddress(this.recipientAddress, this.ownAddress)
    },
    /** Who a message sent from here goes to. */
    recipientName(): string {
      return (
        senderOf(this.senders, this.recipientAddress)?.label ??
        shortAddress(this.recipientAddress)
      )
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
    /** The stamp the next message carries, in the chain's display unit. It is the user's own
     * choice for this conversation (zero is a free message), else the chain's default. */
    stampAmount: {
      set(stampAmount: string | number | null | undefined) {
        // An empty box or half-typed text is not an amount: the last valid one stands.
        const text = String(stampAmount ?? '').trim()
        if (!text) return
        let rawAmount: bigint
        try {
          rawAmount = activeChain.fromDisplayAmount(text)
        } catch {
          return
        }
        if (rawAmount < 0n) return
        const target = this.conversation?.id || this.recipientAddress
        if (!target) return
        this.chatStore.setStampWei({
          address: target,
          stampWei:
            rawAmount === activeChain.defaultStampValue ? undefined : rawAmount,
        })
      },
      get(): string {
        const target = this.conversation?.id || this.recipientAddress
        return activeChain.toDisplayAmount(
          target
            ? this.chatStore.getStampWei(target)
            : activeChain.defaultStampValue,
        )
      },
    },
  },
  watch: {
    'address'(newAddr: string) {
      if (
        newAddr &&
        typeof this.chatStore?.setActiveConversation === 'function'
      ) {
        this.chatStore.setActiveConversation(newAddr)
      }
      // Another conversation opens on its newest message, wherever the last one was left.
      this.followBottom = true
      this.$nextTick(() => this.pinScrollToBottom())
      this.focusComposeOnOpen()
      void this.runBlackjackDealer()
    },
    'messages.length'(newLen: number, oldLen: number) {
      // Scroll to bottom if user was already there.
      this.scrollBottom()
      void this.runBlackjackDealer()
      if (newLen && oldLen !== undefined && newLen > oldLen) {
        const newMsgs = this.messages.slice(oldLen)
        const hasIncomingConfirmedStamps = newMsgs.some(
          msg =>
            !msg.outbound &&
            msg.status === 'confirmed' &&
            ((msg.stampValueWei !== undefined && msg.stampValueWei > 0n) ||
              (msg.stampPayments !== undefined &&
                msg.stampPayments.length > 0)),
        )
        if (hasIncomingConfirmedStamps) {
          void this.refreshBalance?.()
        }
      }
    },
    'sendingMessage'(sending: boolean) {
      if (!sending) void this.runBlackjackDealer()
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

.chat-group-recipient {
  display: flex;
  align-items: center;
  opacity: 0.85;
}

.chat-footer,
.chat-input-bar {
  min-height: 64px;
  box-sizing: border-box;
}

:deep(.chat-input-toolbar) {
  min-height: 64px;
  padding: 8px 14px;
  align-items: center;
  overflow: visible;
}

:deep(.chat-send-btn) {
  align-self: center;
}

:deep() .q-message-text--sent {
  border-radius: 18px 18px 4px 18px !important;
}

:deep() .q-message-text--received {
  border-radius: 18px 18px 18px 4px !important;
}
</style>
