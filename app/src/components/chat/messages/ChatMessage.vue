<template>
  <div style="width: 100%" v-bind="runAttrs">
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

    <!-- A picture shown inside the text, opened by a click on it -->
    <q-dialog v-model="imageDialog">
      <image-dialog :image="openedImage" />
    </q-dialog>

    <template v-if="payloadDigest">
      <q-chat-message
        :sent="message.outbound"
        :size="bubbleSize"
        :bg-color="bgColor"
        :text-color="textColor"
        v-touch-swipe.touch.right="swipeRight"
      >
        <!-- With more than two people in the conversation, a message that is not ours says
        who sent it: the avatar beside the last bubble of a run, the name in the first. -->
        <template v-if="attribution" #avatar>
          <button
            v-if="attribution.showAvatar"
            type="button"
            class="chat-sender-avatar"
            data-testid="chat-sender-avatar"
            :aria-label="
              $t('chatMessage.openSender', { name: attribution.sender.label })
            "
            @click="senderClicked"
          >
            <q-avatar rounded size="32px" :style="senderRingStyle">
              <img :src="senderAvatar" alt="" />
            </q-avatar>
          </button>
          <div
            v-else
            class="chat-sender-avatar chat-sender-avatar--spacer"
            data-testid="chat-sender-avatar-spacer"
            aria-hidden="true"
          />
        </template>
        <!-- Wrap a div around the template to keep all items within 1 QChatMessasge -->
        <div data-testid="chat-message-body" class="chat-message-body">
          <div
            v-if="attribution && attribution.showName"
            class="chat-sender-name"
            data-testid="chat-sender-name"
          >
            <button
              type="button"
              class="chat-sender-name__label"
              :style="senderNameStyle"
              @click="senderClicked"
            >
              {{ attribution.sender.label }}
            </button>
            <span
              v-if="!attribution.sender.inContacts"
              class="chat-sender-name__unknown"
              data-testid="chat-sender-unknown"
              >{{ $t('chatMessage.notInContacts') }}</span
            >
          </div>
          <chat-message-menu
            :address="address"
            :message="message"
            :payload-digest="payloadDigest"
            :index="index"
            @replyClick="replyClicked({ address, payloadDigest })"
            @forwardClick="forwardClicked({ address, payloadDigest })"
            @txClick="transactionDialog = true"
            @deleteClick="deleteDialog = true"
            @resendClick="resend()"
            @discardClick="confirmDiscard()"
          />
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
              :network-tag="item.networkTag"
              :transactions="item.transactions"
              :memo="item.memo"
              :outbound="message.outbound"
            />
            <!-- A picture the text shows where it is referenced is not shown a second time. -->
            <template v-else-if="item.type == 'image'">
              <chat-message-image
                v-if="!inlineImageItems.has(subIndex)"
                :image="item.image"
              />
            </template>
            <chat-message-text
              v-else-if="item.type == 'text'"
              :text="item.text"
              :attachments="shownAttachments"
              @imageClick="openImage"
            />
            <chat-message-blackjack
              v-else-if="item.type == 'blackjack-hand'"
              :item="item"
              :address="address"
              :payload-digest="payloadDigest"
              @sendFollowUp="handleSendFollowUp"
              @retry="resend()"
              @playAgain="$emit('playAgain')"
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
            <chat-message-swap
              v-else-if="item.type == 'swap-offer'"
              :swap-id="item.swapId"
              :offered-chain="item.offeredChain"
              :offered-asset="item.offeredAsset"
              :offered-amount="item.offeredAmount"
              :requested-chain="item.requestedChain"
              :requested-asset="item.requestedAsset"
              :requested-amount="item.requestedAmount"
              :status="item.status"
              :outbound="message.outbound"
              :hash-lock="item.hashLock"
              :preimage="item.preimage"
              :leg-a-tx-hash="item.legATxHash"
              :leg-b-tx-hash="item.legBTxHash"
              :claim-tx-hash="item.claimTxHash"
              :origin-instance-id="item.originInstanceId"
              :recipient-address="address"
              @accept="handleSwapAccept"
              @cancel="handleSwapCancel"
            />
            <chat-message-rps
              v-else-if="item.type == 'rps'"
              :item="item"
              :address="address"
              @sendFollowUp="handleSendFollowUp"
            />
            <chat-message-dice
              v-else-if="item.type == 'dice'"
              :item="item"
              :address="address"
              @sendFollowUp="handleSendFollowUp"
            />
            <chat-message-liars-dice
              v-else-if="item.type == 'liars-dice'"
              :item="item"
              :address="address"
              @sendFollowUp="handleSendFollowUp"
            />
            <chat-message-poker
              v-else-if="item.type == 'poker'"
              :item="item"
              :address="address"
              @sendFollowUp="handleSendFollowUp"
            />
            <chat-message-channel
              v-else-if="item.type == 'channel-update'"
              :item="item"
              :address="address"
              :payload-digest="payloadDigest"
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
            :amount-exact="stampAmountExact"
            :outbound="message.outbound"
            :failure-reason="message.delivery?.failureReason ?? ''"
            :payment-state="paymentState"
            @infoClick="transactionDialog = true"
            @deleteClick="deleteDialog = true"
            @replyClick="replyClicked({ address, payloadDigest })"
            @forwardClick="forwardClicked({ address, payloadDigest })"
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
import ChatMessageSwap from './ChatMessageSwap.vue'
import ChatMessageRps from './ChatMessageRps.vue'
import ChatMessageDice from './ChatMessageDice.vue'
import ChatMessageLiarsDice from './ChatMessageLiarsDice.vue'
import ChatMessagePoker from './ChatMessagePoker.vue'
import ChatMessageChannel from './ChatMessageChannel.vue'
import ChatMessageMenu from '../../context_menus/ChatMessageMenu.vue'
import ChatMessageSuffix from './ChatMessageSuffix.vue'
import DeleteMessageDialog from '../../dialogs/DeleteMessageDialog.vue'
import ImageDialog from '../../dialogs/ImageDialog.vue'
import TransactionDialog from '../../dialogs/TransactionDialog.vue'
import { stampPrice } from '@frank/cashweb/legacy-wallet/helpers'
import { activeChain } from '@frank/wallet/chain'
import {
  formatDisplayAmount,
  formatRawAmount,
} from '../../../utils/chain-amount'
import { Message, MessageItem } from '@frank/cashweb/types/messages'
import { useMonadWallet } from '../../../utils/clients'
import { errorNotify } from '../../../utils/notifications'
import { getMessageItemRenderer } from '../../../utils/message-item-renderers'
import { messageItems } from '../../../utils/message-items'
import { profileAvatar } from '../../../utils/avatar'
import {
  readableKeyColor,
  type BubbleAttribution,
} from '../../../utils/chat-attribution'
import {
  inlinePositions,
  shownAttachments,
} from '../../../utils/chat-attachments'
import type { PostAttachment } from '../../../utils/post-editor'

export default defineComponent({
  name: 'ChatMessage',
  components: {
    ChatMessageMenu,
    ChatMessageReply,
    ChatMessageText,
    ChatMessageBlackjack,
    ChatMessageDigitalGoods,
    ChatMessageRaffle,
    ChatMessageSwap,
    ChatMessageRps,
    ChatMessageDice,
    ChatMessageLiarsDice,
    ChatMessagePoker,
    ChatMessageChannel,
    ChatMessageImage,
    ChatMessageStealth,
    ChatMessageSuffix,
    TransactionDialog,
    DeleteMessageDialog,
    ImageDialog,
  },
  emits: [
    'replyClicked',
    'forwardClicked',
    'replyDivClick',
    'sendFollowUp',
    'playAgain',
    'senderClicked',
  ],
  data() {
    return {
      transactionDialog: false,
      deleteDialog: false,
      imageDialog: false,
      openedImage: '',
    }
  },
  setup() {
    const chats = useChatStore()
    return {
      deleteMessage: chats.deleteMessage,
      sendDirectMessage: chats.sendMessage,
      retryOutgoing: chats.retryOutgoing,
      getMessageItemPreview: (item: MessageItem) =>
        messageItems.previewText(item),
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
    /** Who sent this message, given only in a conversation with more than two people and only
     * for a message that is not ours. Without it the bubble is drawn as in a two-person chat. */
    attribution: {
      type: Object as PropType<BubbleAttribution>,
      required: false,
      default: undefined,
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
  },
  methods: {
    openImage(image: string) {
      this.openedImage = image
      this.imageDialog = true
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
    handleSwapAccept(swapId: string) {
      this.$emit('sendFollowUp', {
        items: [
          {
            type: 'text',
            text: `/swap accept ${swapId}`,
          },
        ],
      })
    },
    handleSwapCancel(swapId: string) {
      this.$emit('sendFollowUp', {
        items: [
          {
            type: 'text',
            text: `/swap cancel ${swapId}`,
          },
        ],
      })
    },
    /** Manual Retry of a failed message. It never deletes the message first: the store asks
     * the wallet whether the earlier payment is still live and re-sends the same bytes if so
     * (see `stores/chats.ts`, `sendMessage`); a new payment happens only if the earlier one can
     * no longer be delivered. */
    async resend(confirmed = false) {
      // The Retry button unmounts as soon as the state changes; keep focus on this message.
      ;(
        this.$refs.suffix as { focusStatus?: () => void } | undefined
      )?.focusStatus?.()
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
    },
    confirmDiscard() {
      const doDelete = async () => {
        try {
          await this.deleteMessage({
            address: this.address,
            payloadDigest: this.payloadDigest,
            ...(this.message.delivery?.attemptDigest
              ? { attemptDigest: this.message.delivery.attemptDigest }
              : {}),
          })
        } catch (error) {
          console.error('Failed to discard message:', error)
          errorNotify(error instanceof Error ? error : new Error(String(error)))
        }
      }

      if (typeof this.$q?.dialog !== 'function') {
        void doDelete()
        return
      }

      const message =
        this.message.status === 'error'
          ? this.$t('outgoing.discardFailedConfirmMessage')
          : this.$t('outgoing.discardConfirmMessage')

      this.$q
        .dialog({
          title: this.$t('outgoing.discardConfirmTitle'),
          message,
          ok: { label: this.$t('outgoing.discard'), color: 'negative' },
          cancel: true,
          persistent: true,
        })
        .onOk(doDelete)
    },
    replyClicked(args: { address: string; payloadDigest: string }) {
      this.$emit('replyClicked', args)
    },
    senderClicked() {
      if (this.attribution)
        this.$emit('senderClicked', this.attribution.sender.address)
    },
    forwardClicked(args: { address: string; payloadDigest: string }) {
      this.$emit('forwardClicked', args)
    },
  },
  computed: {
    /** Not the last bubble of its sender's run: it sits closer to the next one. Nothing at
     * all in a two-person chat, so that markup stays as it was. */
    runAttrs(): { class?: string } {
      return this.attribution && !this.attribution.showAvatar
        ? { class: 'chat-message--in-run' }
        : {}
    },
    senderAvatar(): string {
      const sender = this.attribution?.sender
      return sender ? profileAvatar(sender.avatar, sender.address) : ''
    },
    // The same key colour, in the same two places (ring and name), as the chat header and the
    // contact list. No key known, no colour.
    senderRingStyle(): Record<string, string> {
      const color = this.attribution?.sender.color
      return color ? { boxShadow: `0 0 0 2px ${color}` } : {}
    },
    // As text the key colour keeps its hue but is shaded until it reads on the bubble.
    senderNameStyle(): Record<string, string> {
      const color = this.attribution?.sender.color
      return color
        ? { color: readableKeyColor(color, this.$q?.dark?.isActive === true) }
        : {}
    },
    // This message's pictures that passed vetting, by position among its image items.
    shownAttachments(): PostAttachment[] {
      return shownAttachments(this.message.items)
    },
    // Indexes into `message.items` of the pictures the text shows inline.
    inlineImageItems(): Set<number> {
      const inline = inlinePositions(this.message.items, this.shownAttachments)
      const indexes = new Set<number>()
      let position = 0
      this.message.items.forEach((item, index) => {
        if (item.type !== 'image') return
        position += 1
        if (inline.has(position)) indexes.add(index)
      })
      return indexes
    },
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
        return formatDisplayAmount(activeChain, this.message.stampValueWei)
      }
      if (!this.message || !this.message.outpoints) {
        return `0 ${activeChain.unit}`
      }
      const amount = stampPrice(this.message.outpoints)
      return Number(amount / 1000000).toFixed(2) + ' XPI'
    },
    /** Every digit of the stamp, shown on hover; the bubble shows the shortened amount. */
    stampAmountExact(): string {
      return this.message.stampValueWei !== undefined
        ? formatRawAmount(activeChain, this.message.stampValueWei)
        : ''
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
