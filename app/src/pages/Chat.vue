<template>
  <div>
    <q-page-container>
      <q-page>
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
              />
            </template>
          </div>
        </q-scroll-area>
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
      <div
        v-if="stampPreparationStatus"
        class="text-caption text-center q-pb-sm text-accent"
        role="status"
      >
        {{ stampPreparationStatus }}
      </div>
    </q-footer>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue'

import ChatMessageComponent from '../components/chat/messages/ChatMessage.vue'
import ChatInput from '../components/chat/ChatInput.vue'
import ChatMessageReply from '../components/chat/messages/ChatMessageReply.vue'

import { errorNotify, insufficientStampNotify } from '../utils/notifications'
import { defaultAcceptancePrice, defaultStampAmount } from '../utils/constants'
import { useMonadWallet } from '../utils/clients'
import { MonadStampRecoveredAttemptError } from '@frank/wallet/monad-stamp-client'
import {
  activeChain,
  type DirectMessagePreparationProgress,
} from '@frank/wallet/chain'

import { debounce, QScrollArea } from 'quasar'

import { RouteLocationNormalized } from 'vue-router'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { ChatMessage, useChatStore } from 'src/stores/chats'

const scrollDuration = 0

export default defineComponent({
  components: {
    ChatMessageComponent,
    ChatMessageReply,
    ChatInput,
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
      recoveredDraftAwaitingConfirmation: null as string | null,
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
    confirmRecoveredDraft(message: string) {
      this.$q
        .dialog({
          title: 'Previous message recovered',
          message:
            'A previously pending message was delivered. Send this draft as a separate new message?',
          ok: { label: 'Send as new' },
          cancel: true,
          persistent: true,
        })
        .onOk(() => {
          this.recoveredDraftAwaitingConfirmation = null
          void this.sendMessage(message)
        })
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
      if (this.recoveredDraftAwaitingConfirmation === message) {
        this.confirmRecoveredDraft(message)
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
        this.stampPreparationStatus = 'Checking private stamp accounts…'
        await this.sendDirectMessage({
          wallet: useMonadWallet(),
          address: this.address,
          items: [{ type: 'text', text: submittedMessage }],
          stampValue,
          onPreparationProgress: (
            progress: DirectMessagePreparationProgress,
          ) => {
            if (progress.stage === 'checking') {
              this.stampPreparationStatus = 'Checking private stamp accounts…'
            } else if (progress.stage === 'funding') {
              const feeReserve = activeChain.toDisplayAmount(
                progress.feeReserveWei,
              )
              this.stampPreparationStatus =
                `Preparing private stamp accounts (${progress.completed}/${progress.total} on-chain transactions; ` +
                `up to ${feeReserve} ${activeChain.unit} fee reserve each)…`
            } else {
              this.stampPreparationStatus =
                'Private stamp accounts ready; sending message…'
            }
          },
        })
      } catch (err) {
        if (err instanceof MonadStampRecoveredAttemptError) {
          // Recovery completed an older, already-authorized exact payment set. The current draft
          // may or may not describe that same message, so neither silently discard it nor send it
          // on the next ordinary click. Require an explicit second authorization.
          this.recoveredDraftAwaitingConfirmation = submittedMessage
          this.confirmRecoveredDraft(submittedMessage)
          return
        }
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
    stampPreparationStatus() {
      // The footer grows/shrinks as this status caption appears/disappears/changes text, which
      // Quasar's q-layout accounts for by shrinking the scroll-area's own viewport live -- but
      // that alone doesn't move scrollTop, so a pending message sitting right at the old bottom
      // edge ends up hidden underneath the now-taller footer until the user scrolls manually.
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
