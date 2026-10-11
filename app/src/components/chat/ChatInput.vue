<template>
  <div class="row full-width items-center">
    <!-- Pictures held for the next message. Each is referenced in the text where it shows. -->
    <div
      v-if="attachments.length > 0 || attachError || overBudget"
      class="col-12 row items-center q-gutter-xs q-px-md q-pt-sm"
      data-testid="chat-attachments"
    >
      <q-chip
        v-for="att in attachments"
        :key="att.id"
        removable
        dense
        icon="image"
        color="primary"
        text-color="white"
        data-testid="chat-attachment-chip"
        :data-attachment-id="att.id"
        :remove-aria-label="
          $t('chatInput.removeAttachment', { name: att.name })
        "
        @remove="removeAttachment(att.id)"
      >
        <span class="ellipsis" style="max-width: 140px">{{ att.name }}</span>
        <span class="q-ml-xs text-caption"
          >({{ formatAttachmentSize(att.sizeBytes) }})</span
        >
      </q-chip>
      <div
        v-if="overBudget"
        class="col-12 text-negative text-caption"
        role="alert"
        data-testid="chat-message-too-large"
      >
        {{ $t('chatInput.messageTooLarge') }}
      </div>
      <div
        v-if="attachError"
        class="col-12 text-negative text-caption"
        role="alert"
        data-testid="chat-attachment-refused"
      >
        {{ attachError }}
      </div>
    </div>
    <div v-if="stampUnavailable" class="col-12 text-negative text-caption q-px-md" role="alert" data-testid="stamp-unavailable">{{ stampUnavailable }}</div>
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
            <q-item
              clickable
              v-close-popup
              data-testid="attach-image-menu-item"
              @click="pickImages"
            >
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
          @paste="pasted($event)"
          @drop.prevent="dropped($event)"
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
          <!-- What the message will carry, in the compact form: the chip is a tight place. -->
          <span class="chat-stamp-pill-text q-ml-xs">{{ stampPillText }}</span>
          <span
            v-if="stampMultiplier !== '1'"
            class="chat-stamp-pill-multiple q-ml-xs"
            data-testid="stamp-pill-multiple"
            >{{ stampMultiplier }}×</span
          >
          <q-tooltip max-width="280px">
            <div data-testid="stamp-tooltip-amount">{{ stampLabel }}</div>
            <div>{{ $t('chatInput.stampWhat') }}</div>
          </q-tooltip>
          <q-menu anchor="top middle" self="bottom middle">
            <div class="q-pa-md" style="min-width: 320px">
              <div class="row items-center justify-between q-mb-xs">
                <div class="text-subtitle2 text-weight-medium">
                  {{ $t('chatInput.stampPayment') }}
                </div>
              </div>

              <div
                class="text-caption chat-stamp-explanation q-mb-sm"
                data-testid="stamp-explanation"
              >
                <div>{{ $t('chatInput.stampWhat') }}</div>
                <div class="q-mt-xs">{{ $t('chatInput.stampWhy') }}</div>
              </div>

              <q-input
                v-model="innerStampAmount"
                dense
                autofocus
                type="number"
                min="0"
                step="any"
                data-testid="chat-input-stamp-amount"
                :suffix="chainUnit"
                :label="$t('chatInput.stampPayment')"
              />
              <!-- Side room for the first and last marker labels, which are centred on the ends. -->
              <div class="q-mt-sm q-px-md">
                <q-slider
                  v-model="decadeIndex"
                  class="q-mt-md"
                  :min="0"
                  :max="12"
                  :step="1"
                  label
                  label-always
                  :label-value="sliderLabelValue"
                  markers
                  :marker-labels="decadeMarkerLabels"
                  data-testid="chat-input-stamp-slider"
                />
              </div>
              <div class="text-caption text-grey-7 q-mt-sm">
                {{ $t('chatInput.stampQuickSelection') }}
              </div>

              <div
                v-if="!isDefaultStamp"
                class="row items-center justify-between q-mt-sm"
              >
                <div class="text-caption text-grey-7">
                  {{
                    $t('chatInput.defaultStamp', { amount: defaultStampText })
                  }}
                </div>
                <q-btn
                  flat
                  dense
                  size="sm"
                  color="primary"
                  icon="restart_alt"
                  class="q-px-xs"
                  data-testid="chat-input-reset-default"
                  :label="$t('chatInput.resetToDefault')"
                  @click="resetToDefault"
                />
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
        :disable="disable || Boolean(stampUnavailable)"
        :loading="disable"
        @mousedown.prevent="sendMessage"
      />
    </q-toolbar>
    <input
      ref="filePicker"
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      multiple
      style="display: none"
      data-testid="chat-attachment-picker"
      @change="filesPicked"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import emoji from 'node-emoji'
import { fitsOneMessage, prepareChatImage } from '../../utils/chat-attachments'
import {
  formatAttachmentSize,
  insertImageMarkdown,
  removeAttachmentReferences,
  type PostAttachment,
} from '../../utils/post-editor'
import { activeChain } from '@frank/wallet/chain'
import {
  formatCompactAmount,
  formatDisplayAmount,
} from '../../utils/chain-amount'

/** The pictures among pasted or dropped data. */
function imageFiles(data: DataTransfer | null | undefined): File[] {
  return Array.from(data?.files ?? []).filter(f => f.type.startsWith('image/'))
}

export const DECADE_MULTIPLIERS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000,
]

export default defineComponent({
  props: {
    message: {
      type: String,
      default: () => '',
    },
    // The pictures held for the next message; the page owns them beside the text.
    attachments: {
      type: Array as PropType<PostAttachment[]>,
      default: () => [],
    },
    stampAmount: {
      type: String,
      default: () => '',
    },
    /** The smallest stamp the wallet sends right now (`directMessages.minimumStamp`): what the
     * chain charges to move it. The page reads it; until it has, the configured default. */
    minimumStampWei: {
      type: BigInt as unknown as PropType<bigint>,
      default: () => 0n,
    },
    defaultStampWei: { type: BigInt as unknown as PropType<bigint>, default: undefined },
    defaultStampMode: { type: Boolean, default: true },
    stampUnavailable: { type: String, default: '' },
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
  data() {
    return {
      // Why the last picture could not be attached; empty when it could.
      attachError: '',
      // The stamp as the user is typing it; shown while it still means the chosen amount.
      typedStamp: null as string | null,
    }
  },
  emits: [
    'update:message',
    'update:attachments',
    'update:stampAmount',
    'resetStampDefault',
    'sendMessage',
    'blackjackClicked',
    'sendStealthClicked',
  ],
  methods: {
    resetToDefault() {
      this.typedStamp = null
      this.$emit('resetStampDefault')
    },
    /** Public focus target for chat-level focus handoffs. */
    focus() {
      ;(this.$refs.inputBox as { focus?: () => void } | undefined)?.focus?.()
    },
    // A pasted picture becomes an attachment; pasted text is left to the text box.
    pasted(e: ClipboardEvent) {
      const files = imageFiles(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      return this.attachImages(files)
    },
    // The template's `.prevent` already keeps the browser from navigating to a dropped file.
    dropped(e: DragEvent) {
      return this.attachImages(imageFiles(e.dataTransfer))
    },
    pickImages() {
      ;(this.$refs.filePicker as HTMLInputElement | undefined)?.click()
    },
    filesPicked(e: Event) {
      const input = e.target as HTMLInputElement
      const files = Array.from(input.files ?? [])
      // Picking the same file again must fire `change` again.
      input.value = ''
      return this.attachImages(files)
    },
    /**
     * Downscales each picture, holds it for the next message and writes its reference into the
     * text at the cursor. A picture that cannot be sent is refused here, with the reason,
     * before anything is paid.
     */
    async attachImages(files: File[]) {
      // The text box stays editable during a send (#396); nothing is attached to a message
      // that has already left it.
      if (this.disable || files.length === 0) return
      const box = this.textarea()
      let text = this.message
      let start = box?.selectionStart ?? text.length
      let end = box?.selectionEnd ?? text.length
      let attachments = this.attachments
      this.attachError = ''
      for (const file of files) {
        const prepared = await prepareChatImage(file)
        if (!prepared.ok) {
          this.attachError = this.$t('chatInput.imageRefused', {
            name: prepared.name,
            reason: this.$t(`chatImage.${prepared.reasonKey}`),
          })
          continue
        }
        const id = String(
          attachments.reduce((max, a) => Math.max(max, Number(a.id) || 0), 0) +
            1,
        )
        attachments = [
          ...attachments,
          {
            id,
            name: prepared.name,
            dataUrl: prepared.dataUrl,
            sizeBytes: Math.round(
              ((prepared.dataUrl.split(',')[1] || '').length * 3) / 4,
            ),
          },
        ]
        const inserted = insertImageMarkdown(
          text,
          start,
          end,
          prepared.name.replace(/\.[^/.]+$/, ''),
          `attachment:${id}`,
        )
        text = inserted.text
        start = end = inserted.selectionStart
        this.$emit('update:attachments', attachments)
        this.$emit('update:message', text)
      }
      const caret = start
      void this.$nextTick(() => {
        const el = this.textarea()
        el?.focus?.()
        el?.setSelectionRange?.(caret, caret)
      })
    },
    removeAttachment(id: string) {
      this.attachError = ''
      this.$emit(
        'update:attachments',
        this.attachments.filter(a => a.id !== id),
      )
      this.$emit('update:message', removeAttachmentReferences(this.message, id))
    },
    textarea(): HTMLTextAreaElement | null {
      const root = (this.$refs.inputBox as { $el?: Element } | undefined)?.$el
      return root?.querySelector?.('textarea') ?? null
    },
    formatAttachmentSize,
    sendMessage() {
      // A message too large to send is refused here, before anything is paid.
      if (this.disable || this.overBudget || this.stampUnavailable) {
        return
      }
      this.attachError = ''
      this.$emit('sendMessage', this.innerMessage)
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
    overBudget(): boolean {
      return !fitsOneMessage(this.message, this.attachments)
    },
    chainUnit() {
      return activeChain.unit
    },
    decadeMarkerLabels(): Record<number, string> {
      return { 0: '1×', 3: '10×', 6: '100×', 9: '1k×', 12: '10k×' }
    },
    decadeIndex: {
      get(): number {
        let selected: bigint
        try {
          selected = activeChain.fromDisplayAmount(this.stampAmount)
        } catch {
          return 0
        }
        if (selected <= this.minimumStampWei) {
          return 0
        }
        const mult = Number(selected) / Number(this.minimumStampWei)
        let closest = 0
        let minDiff = Infinity
        for (let i = 0; i < DECADE_MULTIPLIERS.length; i++) {
          const diff = Math.abs(
            Math.log(mult) - Math.log(DECADE_MULTIPLIERS[i]),
          )
          if (diff < minDiff) {
            minDiff = diff
            closest = i
          }
        }
        return closest
      },
      set(index: number) {
        const i = Math.max(
          0,
          Math.min(DECADE_MULTIPLIERS.length - 1, Math.round(index)),
        )
        const mult = DECADE_MULTIPLIERS[i]
        const raw = this.minimumStampWei * BigInt(mult)
        this.$emit('update:stampAmount', activeChain.toDisplayAmount(raw))
      },
    },
    sliderLabelValue(): string {
      const mult = DECADE_MULTIPLIERS[this.decadeIndex] ?? 1
      const raw = this.minimumStampWei * BigInt(mult)
      const amountStr = activeChain.toDisplayAmount(raw)
      return this.$t('chatInput.stampMultiplierValue', {
        multiplier: mult,
        amount: `${amountStr} ${this.chainUnit}`,
      })
    },
    stampMultiplier: {
      get(): string {
        let selected: bigint
        try {
          selected = activeChain.fromDisplayAmount(this.stampAmount)
        } catch {
          return '1'
        }
        const multiple = Number(selected) / Number(this.minimumStampWei)
        if (!Number.isFinite(multiple) || multiple <= 1) {
          return '1'
        }
        if (Math.abs(multiple - Math.round(multiple)) < 0.05) {
          return String(Math.round(multiple))
        }
        return multiple.toFixed(1)
      },
      set(value: number) {
        const intVal = Number.isFinite(value) ? Math.round(value) : 1
        const raw = this.minimumStampWei * BigInt(intVal)
        this.$emit('update:stampAmount', activeChain.toDisplayAmount(raw))
      },
    },
    /** The chosen stamp in base units; `undefined` while the field holds no amount. */
    stampWei(): bigint | undefined {
      try {
        return activeChain.fromDisplayAmount(this.stampAmount)
      } catch {
        return undefined
      }
    },
    isDefaultStamp(): boolean {
      return this.defaultStampMode
    },
    defaultStampText(): string {
      return this.defaultStampWei === undefined ? this.$t('chatInput.stampQuoteUnavailable') : formatCompactAmount(activeChain, this.defaultStampWei)
    },
    /** The stamp on the chip: the amount in the chain's unit, compact ("14.14 mMONT"); a
     * message with no stamp reads "Free". */
    stampPillText(): string {
      if (this.stampWei === 0n) return this.$t('chatInput.stampFree')
      try {
        return formatCompactAmount(
          activeChain,
          activeChain.fromDisplayAmount(this.stampAmount),
        )
      } catch {
        // Not a number yet (the field is being typed in): shown as typed.
        return `${this.stampAmount} ${activeChain.unit}`
      }
    },
    /** The chip's hover line: the amount in full and how it compares with the default. */
    stampLabel(): string {
      if (this.stampWei === 0n) return this.$t('chatInput.stampChipFree')
      let amount = `${this.stampAmount} ${activeChain.unit}`
      try {
        amount = formatDisplayAmount(
          activeChain,
          activeChain.fromDisplayAmount(this.stampAmount),
        )
      } catch {
        // Shown as typed.
      }
      return this.stampMultiplier === '1'
        ? this.$t('chatInput.stampChip', { amount })
        : this.$t('chatInput.stampChipMultiple', {
            amount,
            multiplier: this.stampMultiplier,
          })
    },
    minimumStampAmount() {
      return activeChain.toDisplayAmount(this.minimumStampWei)
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
    /** The amount box. It keeps what the user typed for as long as that is the chosen amount
     * (so "0" stays "0" and "1" does not become "1.0" under the caret); any other change of the
     * amount (the slider, a reset, another chat) shows the chosen amount in its shortest form. */
    innerStampAmount: {
      get(): string {
        if (this.typedStamp !== null) {
          try {
            if (
              activeChain.fromDisplayAmount(this.typedStamp) === this.stampWei
            ) {
              return this.typedStamp
            }
          } catch {
            // What is typed is not an amount: the chosen one is shown below.
          }
        }
        return this.stampAmount.includes('.')
          ? this.stampAmount.replace(/\.?0+$/, '')
          : this.stampAmount
      },
      set(val: string | number | null) {
        this.typedStamp = val === null ? '' : String(val)
        this.$emit('update:stampAmount', this.typedStamp)
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
  white-space: nowrap;
}

/* Secondary to the amount; the first thing to go when the composer is narrow. */
.chat-stamp-pill-multiple {
  font-size: 10px;
  opacity: 0.8;
  white-space: nowrap;

  @media (max-width: 480px) {
    display: none;
  }
}

.chat-stamp-explanation {
  opacity: 0.8;
  max-width: 320px;
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
