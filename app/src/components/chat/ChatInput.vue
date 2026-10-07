<template>
  <div class="row full-width items-center">
    <q-toolbar class="chat-input-toolbar full-width items-center">
      <q-btn
        dense
        flat
        round
        icon="unfold_more"
        class="chat-attach-btn"
        :aria-label="$t('a11y.attachmentOptions')"
        aria-haspopup="menu"
        :disable="disable"
      >
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

            <!-- A blackjack challenge is one more message type, offered in every chat. -->
            <q-item
              clickable
              v-close-popup
              data-testid="blackjack-menu-item"
              @click="blackjackClicked"
            >
              <q-item-section avatar side>
                <q-icon name="casino" />
              </q-item-section>
              <q-item-section>
                {{ $t('chatInput.blackjackChallenge') }}
              </q-item-section>
            </q-item>

            <!-- Send Stealth: encrypted transfer inside direct message payload -->
            <q-item
              clickable
              v-close-popup
              data-testid="send-stealth-menu-item"
              @click="sendStealthClicked"
            >
              <q-item-section avatar side>
                <q-icon name="visibility_off" />
              </q-item-section>
              <q-item-section>
                {{ $t('chatInput.sendStealth') }}
              </q-item-section>
            </q-item>

            <!-- Offer Swap: cross-chain atomic swap offer -->
            <q-item
              clickable
              v-close-popup
              data-testid="offer-swap-menu-item"
              @click="offerSwapClicked"
            >
              <q-item-section avatar side>
                <q-icon name="swap_horiz" />
              </q-item-section>
              <q-item-section>
                {{ $t('chatInput.offerSwap') }}
              </q-item-section>
            </q-item>
          </q-list>
        </q-menu>
      </q-btn>

      <div class="col chat-input-container row no-wrap items-center">
        <q-input
          ref="inputBox"
          class="col chat-input-field"
          dense
          borderless
          autogrow
          @paste="dp($event)"
          @drop.prevent="dp($event)"
          @keydown.enter.exact.prevent
          @keydown.enter.exact="sendMessage"
          @mousedown.self.stop
          v-model="innerMessage"
          :placeholder="$t('chatInput.placeHolder')"
        />

        <q-btn
          dense
          flat
          rounded
          no-caps
          icon="local_post_office"
          class="chat-stamp-btn q-mr-xs"
          :aria-label="$t('a11y.stampPayment')"
          aria-haspopup="menu"
          :disable="disable"
        >
          <span class="chat-stamp-pill-text q-ml-xs"
            >{{ stampMultiplier }}×</span
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
      </div>

      <q-btn
        unelevated
        color="primary"
        icon="send"
        class="chat-send-btn q-btn"
        :aria-label="$t('a11y.sendMessage')"
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
    // A send is in progress. Blocks sending (Enter, the send button) and the toolbar controls,
    // but deliberately NOT the text box itself (#396): disabling a focused textarea drops its
    // focus (seen in Chromium) and ignores keystrokes until the send ends, so the first characters
    // of the next message vanished. The submitted text has already left the box, so typing can
    // continue; Enter during a send is ignored and the text stays.
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
    'blackjackClicked',
    'sendStealthClicked',
    'offerSwapClicked',
  ],
  methods: {
    offerSwapClicked() {
      this.$emit('offerSwapClicked')
    },
    /** Public focus target for chat-level focus handoffs. */
    focus() {
      ;(this.$refs.inputBox as { focus?: () => void } | undefined)?.focus?.()
    },
    // ChatInput drop/paste handler
    async dp(e: ClipboardEvent | DragEvent) {
      // The text box stays editable during a send (#396), so the attachment path must be gated
      // here: no file dialog while a send is in flight. (A drop's default, navigating to the
      // file, is still prevented by the template's `.prevent`.)
      if (this.disable) {
        return
      }
      const items =
        'clipboardData' in e ? e.clipboardData?.items : e.dataTransfer?.items
      if (!items) {
        console.error('No items found in DP event handler', e)
        return
      }
      const blob = await processInput(items)
      return blob ? this.$emit('sendFileClicked', blob) : null
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
    blackjackClicked() {
      this.$emit('blackjackClicked')
    },
    sendStealthClicked() {
      this.$emit('sendStealthClicked')
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
        const intVal = Number.isFinite(value) ? Math.round(value) : 1
        const raw = activeChain.defaultStampValue * BigInt(intVal)
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

<style lang="scss">
.chat-input-toolbar {
  display: flex;
  align-items: center;
  min-height: 64px;
  padding: 8px 14px;
  overflow: visible;
}

.chat-attach-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  min-width: 36px;
  min-height: 36px;
  color: var(--q-color-text-muted, #757575);
  transition: color 0.15s ease, background-color 0.15s ease;

  &:hover:not(:disabled) {
    color: var(--q-primary);
  }
}

.chat-input-container {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 40px;
  margin: 0 8px;
  border-radius: 20px;
  padding: 0 4px 0 14px;
  background-color: var(--q-chat-input-bg, rgba(0, 0, 0, 0.04));
  border: 1px solid var(--q-chat-input-border, rgba(0, 0, 0, 0.12));
  transition: border-color 0.2s ease, box-shadow 0.2s ease,
    background-color 0.2s ease;

  &:focus-within {
    border-color: var(--q-primary);
    box-shadow: 0 0 0 1px var(--q-primary);
  }
}

.chat-input-field {
  font-size: 14px;
  line-height: 1.4;

  .q-field__native {
    padding: 6px 0;
    max-height: 140px;
  }
}

.chat-stamp-btn {
  flex-shrink: 0;
  height: 28px;
  padding: 0 8px;
  border-radius: 14px;
  font-size: 12px;
  color: var(--q-primary);
  background-color: var(--q-chat-stamp-bg, rgba(0, 0, 0, 0.05));
  transition: background-color 0.15s ease, opacity 0.15s ease;

  &:hover:not(:disabled) {
    background-color: var(--q-chat-stamp-bg-hover, rgba(0, 0, 0, 0.09));
  }
}

.chat-stamp-pill-text {
  font-weight: 600;
  font-size: 11px;
  font-family: inherit;
  opacity: 0.9;
}

.chat-send-btn {
  align-self: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  min-width: 38px;
  min-height: 38px;
  padding: 0 !important;
  border-radius: 12px;
  background-color: var(--q-primary) !important;
  color: #ffffff !important;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.16);
  transition: transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease;

  .q-icon {
    font-size: 18px;
  }

  &:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.22);
  }

  &:active:not(:disabled) {
    transform: translateY(0);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.16);
  }

  &:disabled {
    opacity: 0.45 !important;
    box-shadow: none !important;
  }
}

body.body--dark {
  .chat-attach-btn {
    color: rgba(255, 255, 255, 0.6);
  }

  .chat-input-container {
    background-color: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.12);
  }

  .chat-stamp-btn {
    background-color: rgba(255, 255, 255, 0.08);

    &:hover:not(:disabled) {
      background-color: rgba(255, 255, 255, 0.14);
    }
  }

  .chat-send-btn {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);

    &:hover:not(:disabled) {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
    }
  }
}
</style>
