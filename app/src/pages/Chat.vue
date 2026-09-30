<template>
  <div>
    <q-page-container>
      <q-page class="chat-page-background column no-wrap">
        <!-- Above the list in normal flow: the banners never cover messages or each other. -->
        <chat-banner-stack :stamp-status="stampPreparationStatus" />
        <div class="col relative-position">
          <q-scroll-area
            ref="chatScroll"
            @scroll="scrollHandler"
            class="q-px-none absolute full-width full-height column"
          >
            <div class="row q-px-lg">
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
                  :ref="msg.payloadDigest"
                  @replyClicked="({ payloadDigest }) => setReply(payloadDigest)"
                  @replyDivClick="scrollToMessage"
                  @sendFollowUp="sendFollowUpItems"
                />
              </template>
            </div>
          </q-scroll-area>
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
import { defineComponent, ref } from 'vue'

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
  activeChain,
  type DirectMessagePreparationProgress,
} from '@frank/wallet/chain'
import { MessageItem } from '@frank/cashweb/types/messages'

import { debounce, QScrollArea } from 'quasar'

import { RouteLocationNormalized } from 'vue-router'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { ChatMessage, useChatStore } from 'src/stores/chats'
import type { OutgoingOutcome } from 'src/stores/chats'

const scrollDuration = 0

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
      messagesToShow: 30,
      replyDigest: null as string | null,
      scrollDigest: null as string | null,
      chatWidth: 0,
      message: '',
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
    }
  },
  emits: ['giveLotusClicked', 'sendFileClicked'],
  mounted() {
    this.scrollBottom()
    // set the chat width
    this.resizeHandler()
    // Adjust the chat width when window resizes
    window.addEventListener('resize', debounce(this.resizeHandler, 50))
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
      // Set this afterwards, incase we were at the bottom already.
      // We want to ensure that we scroll!
      this.bottom =
        details.verticalSize -
          details.verticalPosition -
          details.verticalContainerSize <=
        10
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
      // Move the submitted text into the optimistic outbox bubble immediately. The user should
      // never be editing the contents of a message whose accounts and stamp payments are already
      // being prepared.
      const submittedMessage = message
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
          wallet: useMonadWallet(),
          address: this.address,
          items: [{ type: 'text', text: submittedMessage }],
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
    'messages.length'() {
      // Scroll to bottom if user was already there.
      this.scrollBottom()
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
</style>
