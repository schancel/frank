<template>
  <q-menu touch-position context-menu>
    <q-list dense style="min-width: 140px">
      <q-item
        v-if="canReply"
        clickable
        v-close-popup
        @click="$emit('replyClick')"
      >
        <q-item-section avatar>
          <q-icon name="reply" size="xs" />
        </q-item-section>
        <q-item-section>{{ $t('chatMessageMenu.reply') }}</q-item-section>
      </q-item>
      <q-item
        v-if="canForward"
        clickable
        v-close-popup
        @click="$emit('forwardClick')"
      >
        <q-item-section avatar>
          <q-icon name="forward" size="xs" />
        </q-item-section>
        <q-item-section>{{ $t('chatMessageMenu.forward') }}</q-item-section>
      </q-item>
      <q-item v-if="canCopy" clickable v-close-popup @click="copyMessage">
        <q-item-section avatar>
          <q-icon name="content_copy" size="xs" />
        </q-item-section>
        <q-item-section>{{ $t('chatMessageMenu.copy') }}</q-item-section>
      </q-item>
      <q-separator v-if="hasStamp || isError" />
      <q-item v-if="hasStamp" clickable v-close-popup @click="$emit('txClick')">
        <q-item-section avatar>
          <q-icon name="receipt_long" size="xs" />
        </q-item-section>
        <q-item-section>{{
          $t('chatMessageMenu.stampTransaction')
        }}</q-item-section>
      </q-item>
      <q-item
        v-if="isError"
        clickable
        v-close-popup
        @click="$emit('resendClick')"
      >
        <q-item-section avatar>
          <q-icon name="replay" size="xs" />
        </q-item-section>
        <q-item-section>{{ $t('chatMessageMenu.resend') }}</q-item-section>
      </q-item>
      <q-separator />
      <q-item
        v-if="canDiscard"
        clickable
        v-close-popup
        @click="$emit('discardClick')"
        class="text-negative"
      >
        <q-item-section avatar>
          <q-icon name="delete" size="xs" color="negative" />
        </q-item-section>
        <q-item-section>{{ $t('chatMessageMenu.delete') }}</q-item-section>
      </q-item>
      <q-item
        v-else
        clickable
        v-close-popup
        @click="$emit('deleteClick')"
        class="text-negative"
      >
        <q-item-section avatar>
          <q-icon name="delete" size="xs" color="negative" />
        </q-item-section>
        <q-item-section>{{ $t('chatMessageMenu.delete') }}</q-item-section>
      </q-item>
    </q-list>
  </q-menu>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import { copyToClipboard } from 'quasar'
import type { Message } from '@frank/cashweb/types/messages'
import { infoNotify } from 'src/utils/notifications'

export default defineComponent({
  name: 'ChatMessageMenu',
  props: {
    address: {
      type: String,
      required: true,
    },
    message: {
      type: Object as PropType<Message>,
      required: true,
    },
    payloadDigest: {
      type: String,
      required: true,
    },
    index: {
      type: [Number, String],
      required: false,
      default: () => 0,
    },
  },
  emits: [
    'deleteClick',
    'replyClick',
    'txClick',
    'forwardClick',
    'resendClick',
    'discardClick',
  ],
  computed: {
    canReply(): boolean {
      return this.message.status === 'confirmed' && Boolean(this.payloadDigest)
    },
    canForward(): boolean {
      return (
        this.message.status === 'confirmed' &&
        Array.isArray(this.message.items) &&
        this.message.items.length > 0
      )
    },
    canCopy(): boolean {
      return (
        Array.isArray(this.message.items) &&
        this.message.items.some(
          it =>
            it.type === 'text' ||
            it.type === 'stealth' ||
            it.type === 'swap-offer',
        )
      )
    },
    hasStamp(): boolean {
      return (
        (Array.isArray(this.message.stampPayments) &&
          this.message.stampPayments.length > 0) ||
        (Array.isArray(this.message.outpoints) &&
          this.message.outpoints.length > 0)
      )
    },
    isError(): boolean {
      return this.message.status === 'error' && Boolean(this.message.outbound)
    },
    canDiscard(): boolean {
      return (
        Boolean(this.message.outbound) &&
        (this.message.status === 'error' ||
          this.message.status === 'payment-pending' ||
          this.message.status === 'pending')
      )
    },
  },
  methods: {
    copyMessage() {
      let text = ''
      if (Array.isArray(this.message.items)) {
        const textItem = this.message.items.find(el => el.type === 'text')
        if (
          textItem &&
          'text' in textItem &&
          typeof textItem.text === 'string'
        ) {
          text = textItem.text
        } else {
          const stealthItem = this.message.items.find(
            el => el.type === 'stealth',
          )
          if (stealthItem && 'memo' in stealthItem && stealthItem.memo) {
            text = String(stealthItem.memo)
          }
        }
      }
      if (!text && this.payloadDigest) {
        text = this.payloadDigest
      }
      if (text) {
        copyToClipboard(text)
          .then(() => {
            infoNotify(this.$t('chatMessageMenu.messageCopied'))
          })
          .catch(() => {
            // copy failed
          })
      }
    },
  },
})
</script>
