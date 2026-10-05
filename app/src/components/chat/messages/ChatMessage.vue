<template>
  <div style="width: 100%">
    <!-- Transaction Dialog -->
    <q-dialog v-model="transactionDialog">
      <!-- Switch to outpoints -->
      <transaction-dialog
        :title="$t('transactionDialog.backingTransactions')"
        :outpoints="message.outpoints"
        :stamp-payments="message.stampPayments"
      />
    </q-dialog>

    <!-- Delete Dialog -->
    <q-dialog v-model="deleteDialog">
      <delete-message-dialog
        :address="address"
        :payload-digest="payloadDigest"
        :index="index"
      />
    </q-dialog>

    <template v-if="payloadDigest">
      <q-chat-message
        :sent="message.outbound"
        :size="bubbleSize"
        :bg-color="bgColor"
        :text-color="textColor"
        v-touch-swipe.touch.right="swipeRight"
      >
        <!-- Wrap a div around the template to keep all items within 1 QChatMessasge -->
        <div data-testid="chat-message-body" class="chat-message-body">
          <template v-for="(item, subIndex) in message.items" :key="subIndex">
            <chat-message-reply
              v-if="item.type == 'reply'"
              :payload-digest="item.payloadDigest"
              @replyDivClick="handleReplyDivClick"
            />
            <chat-message-stealth
              v-else-if="item.type == 'stealth'"
              :amount="item.amount"
              :chain-id="item.chainId"
            />
            <chat-message-image
              v-else-if="item.type == 'image'"
              :image="item.image"
            />
            <chat-message-text
              v-else-if="item.type == 'text'"
              :text="item.text"
            />
            <chat-message-blackjack
              v-else-if="item.type == 'blackjack-hand'"
              :item="item"
              :address="address"
              :payload-digest="payloadDigest"
              @sendFollowUp="handleSendFollowUp"
              @retry="resend()"
            />
            <chat-message-digital-goods
              v-else-if="item.type == 'digital-goods'"
              :item="item"
              :address="address"
              :recipient-name="name"
              @sendFollowUp="handleSendFollowUp"
            />
            <chat-message-raffle
              v-else-if="item.type == 'raffle'"
              :item="item"
              :address="address"
              @sendFollowUp="handleSendFollowUp"
            />
            <!-- Previously silently unrendered (no branch existed at all for this or any other
            unhandled type) -- a real preview string instead, via the same registry `chats.ts` now
            uses for the sidebar/notifications, so this can never silently go blank again as new
            types get added. -->
            <span v-else class="text-caption text-italic">
              {{ getMessageItemPreview(item) }}
            </span>
          </template>
          <!-- Keep one suffix instance mounted across status changes. Its inline
               mode shares the last text line; error and payment-pending render
               their own row without replacing the live region or focus target. -->
          <chat-message-suffix
            ref="suffix"
            :inline="usesInlineFooter"
            :status="message.status"
            :stamp="shortTimestamp"
            :stamp-datetime="stampDatetime"
            :amount="stampAmount"
            :outbound="message.outbound"
            :failure-reason="message.delivery?.failureReason ?? ''"
            :payment-state="paymentState"
            @infoClick="transactionDialog = true"
            @deleteClick="deleteDialog = true"
            @replyClick="replyClicked({ address, payloadDigest })"
            @resendClick="resend()"
            @discardClick="confirmDiscard()"
          />
        </div>
      </q-chat-message>
    </template>
    <div class="col" v-else-if="!payloadDigest">
      {{ $t('chatMessage.noPayloadFound') }}
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

import { useChatStore } from '../../../stores/chats'

import moment from 'moment'
import ChatMessageReply from './ChatMessageReply.vue'
import ChatMessageText from './ChatMessageText.vue'
import ChatMessageImage from './ChatMessageImage.vue'
import ChatMessageStealth from './ChatMessageStealth.vue'
import ChatMessageBlackjack from './ChatMessageBlackjack.vue'
import ChatMessageDigitalGoods from './ChatMessageDigitalGoods.vue'
import ChatMessageRaffle from './ChatMessageRaffle.vue'
import ChatMessageSuffix from './ChatMessageSuffix.vue'
import DeleteMessageDialog from '../../dialogs/DeleteMessageDialog.vue'
import TransactionDialog from '../../dialogs/TransactionDialog.vue'
import { stampPrice } from '@frank/cashweb/legacy-wallet/helpers'
import { activeChain } from '@frank/wallet/chain'
import { getMessageItemPreview } from '@frank/wallet/message-item-plugins'
import '@frank/wallet/message-item-plugins/built-in'
import '@frank/wallet/message-item-plugins/blackjack/plugin'
import '@frank/wallet/message-item-plugins/digital-goods/plugin'
import '@frank/wallet/message-item-plugins/raffle/plugin'
import { Message, MessageItem } from '@frank/cashweb/types/messages'
import { useMonadWallet } from '../../../utils/clients'
import { errorNotify } from '../../../utils/notifications'
import { getMessageItemRenderer } from '../../../utils/message-item-renderers'

export default defineComponent({
  name: 'ChatMessage',
  components: {
    // ChatMessageMenu,
    ChatMessageReply,
    ChatMessageText,
    ChatMessageBlackjack,
    ChatMessageDigitalGoods,
    ChatMessageRaffle,
    ChatMessageImage,
    ChatMessageStealth,
    ChatMessageSuffix,
    TransactionDialog,
    DeleteMessageDialog,
  },
  emits: ['replyClicked', 'replyDivClick', 'sendFollowUp'],
  data() {
    return {
      transactionDialog: false,
      deleteDialog: false,
    }
  },
  setup() {
    const chats = useChatStore()
    return {
      deleteMessage: chats.deleteMessage,
      getStampAmount: chats.getStampAmount,
      sendDirectMessage: chats.sendMessage,
      retryOutgoing: chats.retryOutgoing,
      getMessageItemPreview,
    }
  },
  props: {
    address: {
      type: String,
      required: true,
    },
    message: {
      type: Object as PropType<Message>,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    chatWidth: {
      type: Number,
      required: true,
    },
    // Payload digest and index are not passed when nested in a reply
    payloadDigest: {
      type: String,
      required: false,
      default: () => '',
    },
    index: {
      type: Number,
      required: false,
      default: () => -1,
    },
    /** Stable parent callback: a successful retry may unmount this keyed component before its
     * awaited action returns, so a component event is no longer deliverable at that point. */
    focusAfterRetry: {
      type: Function as PropType<() => void>,
      required: false,
      default: undefined,
    },
    /** Legacy failure replaces the deleted bubble; the parent focuses that error row. */
    focusFailedAfterRetry: {
      type: Function as PropType<() => void>,
      required: false,
      default: undefined,
    },
  },
  methods: {
    focusRetryStatus() {
      ;(
        this.$refs.suffix as { focusStatus?: () => void } | undefined
      )?.focusStatus?.()
    },
    handleReplyDivClick(args: string) {
      this.$emit('replyDivClick', args)
    },
    // Relayed up to Chat.vue the same way replyClicked/replyDivClick already are -- a plugin
    // renderer (e.g. blackjack's Hit/Stand buttons) emits this to request a new message be sent
    // as this conversation's natural next turn, without needing its own parallel send pipeline
    // (stamp-prep status, error handling, disabled-while-sending -- all free-text sends already
    // get this via Chat.vue's own sendMessage, this reuses it rather than duplicating it).
    handleSendFollowUp(payload: {
      items: MessageItem[]
      stampValueWei?: bigint
      settled?: (sent: boolean) => void
    }) {
      this.$emit('sendFollowUp', payload)
    },
    swipeRight() {
      this.replyClicked({
        address: this.address,
        payloadDigest: this.payloadDigest,
      })
    },
    /** Manual Retry of a failed message. For a Monad message this never deletes it first: the
     * store asks the wallet whether the earlier payment is still live and re-sends the same bytes
     * if so (see `stores/chats.ts`, `sendMessage`); a new payment happens only if the earlier one
     * can no longer be delivered. */
    async resend(confirmed = false) {
      // The Retry button unmounts as soon as the state changes; keep focus on this message.
      ;(
        this.$refs.suffix as { focusStatus?: () => void } | undefined
      )?.focusStatus?.()
      if (this.message.stampValueWei !== undefined) {
        try {
          const outcome = await this.retryOutgoing({
            wallet: useMonadWallet(),
            address: this.address,
            payloadDigest: this.payloadDigest,
            confirmed,
          })
          if (outcome.state === 'needs-confirmation') {
            this.$q
              .dialog({
                title: this.$t('outgoing.sendAgainTitle'),
                message:
                  outcome.reason === 'recovered'
                    ? this.$t('outgoing.sendAgainRecovered')
                    : this.$t('outgoing.sendAgainUnverified'),
                ok: { label: this.$t('outgoing.sendAgain') },
                cancel: true,
                persistent: true,
              })
              .onOk(() => void this.resend(true))
          } else if (outcome.state === 'sent') {
            // The store rekeys this bubble from its optimistic id to the final payload digest.
            // Ask the stable Chat parent to take focus after this component unmounts.
            this.focusAfterRetry?.()
          }
        } catch (error) {
          errorNotify(error instanceof Error ? error : new Error(String(error)))
        }
        return
      }

      // Compatibility path for legacy Lotus messages. Construction can emit messageSendError
      // and fulfill undefined; that is not delivery. Rejection after delete has no bubble left.
      try {
        await this.deleteMessage({
          address: this.address,
          payloadDigest: this.payloadDigest,
        })
        const stampAmount = this.getStampAmount(this.address)
        const outcome = await this.$relayClient.sendMessageImpl({
          address: this.address,
          items: this.message.items,
          stampAmount,
        })
        if (outcome === undefined || outcome === null) {
          this.focusFailedAfterRetry?.()
          return outcome
        }
        this.focusAfterRetry?.()
        return outcome
      } catch (error) {
        this.focusFailedAfterRetry?.()
        errorNotify(error instanceof Error ? error : new Error(String(error)))
      }
    },
    confirmDiscard() {
      this.$q
        .dialog({
          title: this.$t('outgoing.discardConfirmTitle'),
          message: this.$t('outgoing.discardConfirmMessage'),
          ok: { label: this.$t('outgoing.discard'), color: 'negative' },
          cancel: true,
          persistent: true,
        })
        .onOk(() => {
          void this.deleteMessage({
            address: this.address,
            payloadDigest: this.payloadDigest,
          })
        })
    },
    replyClicked(args: { address: string; payloadDigest: string }) {
      this.$emit('replyClicked', args)
    },
  },
  computed: {
    paymentState(): string {
      const delivery = this.message.delivery
      if (delivery?.attemptDigest === undefined) return 'queued'
      return delivery.live === true ? 'live' : 'checking'
    },
    bubbleSize() {
      // Default chatbubble size; assume small screen
      let base = 9
      let textLen = 50
      // Reduce base chatbubble size as chat width increases
      if (this.chatWidth > 720 && this.chatWidth <= 1080) {
        base = 6
      } else if (this.chatWidth > 1080 && this.chatWidth <= 1440) {
        base = 4
        textLen = 70
      } else if (this.chatWidth > 1440) {
        base = 3
        textLen = 70
      }
      // Was two more hand-written per-type checks (text-length-or-image, else reply) before the
      // renderer registry existed -- `some()` over every item preserves the exact original
      // precedence (large always wins over small, never nets out to a no-op when a message somehow
      // has both).
      const wantsLarge = this.message.items.some(item =>
        getMessageItemRenderer(item.type)?.wantsLargeBubble?.(item, {
          textLen,
        }),
      )
      const wantsSmall = this.message.items.some(item =>
        getMessageItemRenderer(item.type)?.wantsSmallBubble?.(item),
      )
      if (wantsLarge) {
        base += 1
      } else if (wantsSmall) {
        base -= 1
      }
      return String(base)
    },
    shortTimestamp() {
      switch (this.message.status) {
        case 'confirmed': {
          const timestamp = this.message.serverTime
          // return moment(timestamp).fromNow(true)
          const howLongAgo = moment(timestamp)
          return howLongAgo.calendar(null, {
            sameDay: 'HH:mm:ss',
            nextDay: '[Tomorrow] HH:mm:ss',
            nextWeek: '[Next] ddd',
            lastDay: '[Yest.] HH:mm',
            lastWeek: 'ddd HH:mm',
            sameElse: 'DD/MM/YYYY',
          })
        }
        case 'pending':
        case 'payment-pending':
        case 'error':
          // The stamp is the time. Status text lives in ChatMessageSuffix once (#393).
          return ''
      }
      return 'N/A'
    },
    usesInlineFooter(): boolean {
      // Confirmed and the fresh-send line are one cluster on the last text
      // line. Failed and payment-pending keep the row under the text.
      return (
        this.message.status === 'confirmed' || this.message.status === 'pending'
      )
    },
    stampDatetime(): string {
      const timestamp = this.message.serverTime
      if (timestamp === undefined || timestamp === null) return ''
      const parsed = new Date(timestamp)
      return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
    },
    stampAmount() {
      if (this.message.stampValueWei !== undefined) {
        return `${activeChain.toDisplayAmount(this.message.stampValueWei)} ${
          activeChain.unit
        }`
      }
      if (!this.message || !this.message.outpoints) {
        return `0 ${activeChain.unit}`
      }
      const amount = stampPrice(this.message.outpoints)
      return Number(amount / 1000000).toFixed(2) + ' XPI'
    },
    // Named hooks into `--q-message-color-sent`/`--q-message-color` (app.scss's own header on
    // these classes explains the currentColor mechanism) -- was hardcoded to fixed Quasar palette
    // swatches ('deep-purple'/'blue-grey-8') that never actually reflected this app's own brand
    // colors, and couldn't be tuned per light/dark mode independently of those swatches.
    bgColor() {
      return this.message.outbound ? 'message-sent' : 'message-received'
    },
    // Sent bubbles are always a bold, filled brand color in both light and dark mode, so their
    // text is always white; received bubbles are a neutral surface that itself flips with the
    // mode, so their text follows suit.
    textColor() {
      return this.message.outbound
        ? 'message-sent-text'
        : 'message-received-text'
    },
  },
})
</script>
