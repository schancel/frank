<template>
  <div class="row">
    <q-toolbar class="q-px-sm">
      <q-btn dense flat icon="unfold_more" :disable="disable">
        <q-menu>
          <q-list style="min-width: 100px">
            <q-item clickable v-close-popup @click="sendFileClicked">
              <q-item-section avatar side>
                <q-icon name="attach_file" />
              </q-item-section>
              <q-item-section>
                {{ $t('chatInput.attachImage') }}
              </q-item-section>
            </q-item>

            <!-- <q-item clickable>
              <q-item-section avatar>
                <q-icon name="insert_emoticon" />
              </q-item-section>
              <q-item-section>
                Insert Emoji
              </q-item-section>
              <q-menu self="center middle">
                <picker
                  v-close-popup
                  :data="emojiIndex"
                  set="twitter"
                  @select="addEmoji"
                  :title="$t('chatInput.emojiPickerTitle')"
                  :show-skin-tones="false"
                />
              </q-menu>
            </q-item>-->
          </q-list>
        </q-menu>
      </q-btn>

      <!-- <q-separator vertical /> -->
      <q-input
        ref="inputBox"
        class="full-width q-pl-md"
        dense
        borderless
        autogrow
        @paste="dp($event)"
        @drop.prevent="dp($event)"
        @blur.capture="focusInput($event)"
        @keydown.enter.exact.prevent
        @keydown.enter.exact="sendMessage"
        @mousedown.self.stop
        v-model="innerMessage"
        :disable="disable"
        :placeholder="$t('chatInput.placeHolder')"
      />
      <q-space />
      <q-btn
        dense
        flat
        round
        icon="local_post_office"
        :aria-label="$t('chatInput.stampPayment')"
        :disable="disable"
      >
        <q-tooltip>{{ stampLabel }}</q-tooltip>
        <q-menu anchor="top middle" self="bottom middle">
          <div class="q-pa-md" style="min-width: 280px">
            <q-input
              v-model="innerStampAmount"
              dense
              autofocus
              type="number"
              :min="minimumStampAmount"
              :suffix="chainUnit"
              :label="$t('chatInput.stampPayment')"
            />
            <q-slider
              v-model="stampMultiplier"
              class="q-mt-md"
              :min="1"
              :max="100"
              :step="1"
              label
              label-always
              :label-value="
                $t('chatInput.stampMultiplierValue', {
                  multiplier: stampMultiplier,
                })
              "
            />
            <div class="text-caption text-grey-7">
              {{ $t('chatInput.stampQuickSelection') }}
            </div>
          </div>
        </q-menu>
      </q-btn>
      <q-btn
        dense
        flat
        icon="send"
        class="q-btn"
        :disable="disable"
        @mousedown.prevent="sendMessage"
      />
    </q-toolbar>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import emoji from 'node-emoji'
import { processInput } from '../../utils/chat'
import { activeChain } from '@frank/wallet/chain'

export default defineComponent({
  props: {
    message: {
      type: String,
      default: () => '',
    },
    stampAmount: {
      type: String,
      default: () => activeChain.toDisplayAmount(activeChain.defaultStampValue),
    },
    disable: {
      type: Boolean,
      default: false,
    },
  },
  emits: [
    'update:message',
    'update:stampAmount',
    'sendMessage',
    'sendFileClicked',
  ],
  methods: {
    // ChatInput drop/paste handler
    async dp(e: ClipboardEvent | DragEvent) {
      const items =
        'clipboardData' in e ? e.clipboardData?.items : e.dataTransfer?.items
      if (!items) {
        console.error('No items found in DP event handler', e)
        return
      }
      const blob = await processInput(items)
      return blob ? this.$emit('sendFileClicked', blob) : null
    },
    focusInput(e: FocusEvent) {
      if (e.type === 'blur') {
        const relatedTarget = e.relatedTarget as Element
        // Prevent the focus if the target isn't related
        if (!relatedTarget || relatedTarget.localName === 'input') {
          return
          // allow focus change to other inputs (e.g. RightPanel)
        }
      }
      const inputBox = this.$refs.inputBox as HTMLElement
      inputBox.focus()
    },
    sendMessage() {
      if (this.disable) {
        return
      }
      this.$emit('sendMessage', this.innerMessage)
    },
    sendFileClicked() {
      this.$emit('sendFileClicked')
    },
    addEmoji(value: { id: string }) {
      // TODO: This needs to be cursor position aware
      this.innerMessage += `:${value.id}:`
    },
  },
  computed: {
    chainUnit() {
      return activeChain.unit
    },
    stampLabel() {
      return `${this.stampAmount} ${activeChain.unit}`
    },
    minimumStampAmount() {
      return activeChain.toDisplayAmount(activeChain.defaultStampValue)
    },
    stampMultiplier: {
      get() {
        const selected = activeChain.fromDisplayAmount(this.stampAmount)
        const multiple = selected / activeChain.defaultStampValue
        return Math.max(1, Math.min(100, Number(multiple)))
      },
      set(value: number) {
        const raw = activeChain.defaultStampValue * BigInt(value)
        this.$emit('update:stampAmount', activeChain.toDisplayAmount(raw))
      },
    },
    innerMessage: {
      get() {
        return this.message
      },
      set(val: string) {
        const replacer = (match: string) => emoji.emojify(match)
        // TODO: Remove emojify
        const emojifiedValue = val.replace(/(:.*:)/g, replacer)
        this.$emit('update:message', emojifiedValue)
      },
    },
    innerStampAmount: {
      get() {
        return this.stampAmount
      },
      set(val: string) {
        this.$emit('update:stampAmount', val)
      },
    },
  },
})
</script>
