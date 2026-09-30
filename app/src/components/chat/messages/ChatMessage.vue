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
        <div>
          <template v-for="(item, subIndex) in message.items" :key="subIndex">
            <chat-message-reply
              v-if="item.type == 'reply'"
              :payload-digest="item.payloadDigest"
              @replyDivClick="handleReplyDivClick"
            />
            <chat-message-stealth
              v-else-if="item.type == 'stealth'"
              :amount="item.amount"
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
              v-else-if="item.type == 'blackjack-move'"
              :item="item"
              :address="address"
              @sendFollowUp="handleSendFollowUp"
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
        </div>
        <template #stamp>
          <chat-message-suffix
            :status="message.status"
            :stamp="shortTimestamp"
            :amount="stampAmount"
            :outbound="message.outbound"
            @infoClick="transactionDialog = true"
            @deleteClick="deleteDialog = true"
            @replyClick="replyClicked({ address, payloadDigest })"
            @resendClick="resend()"
          />
        </template>
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
  },
  methods: {
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
    }) {
      this.$emit('sendFollowUp', payload)
    },
    swipeRight() {
      this.replyClicked({
        address: this.address,
        payloadDigest: this.payloadDigest,
      })
    },
    async resend() {
      await this.deleteMessage({
        address: this.address,
        payloadDigest: this.payloadDigest,
      })

      if (this.message.stampValueWei !== undefined) {
        try {
          await this.sendDirectMessage({
            wallet: useMonadWallet(),
            address: this.address,
            items: this.message.items,
            stampValue: this.message.stampValueWei,
          })
        } catch (error) {
          errorNotify(error instanceof Error ? error : new Error(String(error)))
        }
        return
      }

      // Compatibility path for legacy Lotus messages.
      const stampAmount = this.getStampAmount(this.address)
      return this.$relayClient.sendMessageImpl({
        address: this.address,
        items: this.message.items,
        stampAmount,
      })
    },
    replyClicked(args: { address: string; payloadDigest: string }) {
      this.$emit('replyClicked', args)
    },
  },
  computed: {
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
          return 'sending...'
        case 'error':
          return ''
      }
      return 'N/A'
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
