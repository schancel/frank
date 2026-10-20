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
        color="primary"
        text-color="white"
        data-testid="chat-attachment-chip"
        :data-attachment-id="att.id"
        :remove-aria-label="
          $t('chatInput.removeAttachment', { name: att.name })
        "
        @remove="removeAttachment(att.id)"
      >
        <q-avatar
          v-if="att.dataUrl"
          square
          size="20px"
          class="q-mr-xs rounded-borders"
        >
          <img :src="att.dataUrl" alt="" style="object-fit: cover" />
        </q-avatar>
        <q-icon v-else name="image" class="q-mr-xs" />
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
    <div
      v-if="stampUnavailable && !stampUnavailablePending"
      class="col-12 text-negative text-caption q-px-md"
      role="alert"
      data-testid="stamp-unavailable"
    >
      {{ stampUnavailable }}
    </div>
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
        <q-menu
          ref="attachMenu"
          anchor="top left"
          self="bottom left"
          max-height="80vh"
        >
          <q-list dense style="min-width: 220px" class="q-py-xs">
            <q-item
              clickable
              v-close-popup
              data-testid="attach-image-menu-item"
              @click="pickImages"
            >
              <q-item-section avatar side>
                <q-icon name="image" />
              </q-item-section>
              <q-item-section>
                {{ $t('chatInput.attachImage') }}
              </q-item-section>
            </q-item>

            <q-item
              clickable
              v-close-popup
              data-testid="attach-calendar-vcard-menu-item"
              @click="pickImages"
            >
              <q-item-section avatar side>
                <q-icon name="attach_file" />
              </q-item-section>
              <q-item-section>
                {{ $t('chatInput.attachFile') }}
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

            <q-item
              clickable
              v-close-popup
              data-testid="webrtc-call-menu-item"
              @click="emitAndClose('webrtcCallClicked', { withVideo: false })"
            >
              <q-item-section avatar side>
                <q-icon name="call" />
              </q-item-section>
              <q-item-section>
                {{ $t('chatInput.phoneCall') }}
              </q-item-section>
            </q-item>

            <q-item
              clickable
              v-close-popup
              data-testid="webrtc-video-call-menu-item"
              @click="emitAndClose('webrtcCallClicked', { withVideo: true })"
            >
              <q-item-section avatar side>
                <q-icon name="videocam" />
              </q-item-section>
              <q-item-section>
                {{ $t('webrtcCall.mediaMode.video') }}
              </q-item-section>
            </q-item>

            <div class="chat-menu-divider q-my-xs" role="separator" />

            <!-- Submenu: Payments & Docs (Invoices, Swaps, Articles) -->
            <q-item
              clickable
              data-testid="more-actions-submenu-item"
            >
              <q-item-section avatar side>
                <q-icon name="apps" />
              </q-item-section>
              <q-item-section>
                {{ $t('chatInput.moreActionsSubmenu') }}
              </q-item-section>
              <q-item-section side>
                <q-icon name="keyboard_arrow_right" />
              </q-item-section>
              <q-menu anchor="top end" self="top start">
                <q-list dense style="min-width: 210px" class="q-py-xs">
                  <q-item
                    clickable
                    v-close-popup
                    data-testid="invoice-menu-item"
                    @click="closeMenuAndEmit('invoiceClicked')"
                  >
                    <q-item-section avatar side>
                      <q-icon name="receipt_long" />
                    </q-item-section>
                    <q-item-section>
                      {{ $t('chatInput.createInvoice') }}
                    </q-item-section>
                  </q-item>

                  <q-item
                    clickable
                    v-close-popup
                    data-testid="swap-menu-item"
                    @click="closeMenuAndEmit('swapClicked')"
                  >
                    <q-item-section avatar side>
                      <q-icon name="swap_horiz" />
                    </q-item-section>
                    <q-item-section>
                      {{ $t('signedSwap.title') }}
                    </q-item-section>
                  </q-item>

                  <q-item
                    clickable
                    v-close-popup
                    data-testid="article-menu-item"
                    @click="closeMenuAndEmit('articleClicked')"
                  >
                    <q-item-section avatar side>
                      <q-icon name="article" />
                    </q-item-section>
                    <q-item-section>
                      {{ $t('chatInput.writeArticle') }}
                    </q-item-section>
                  </q-item>
                </q-list>
              </q-menu>
            </q-item>

            <!-- Submenu: Games (Blackjack, Satoshi Dice, Rock-Paper-Scissors, Heads-Up Poker) -->
            <q-item
              clickable
              data-testid="games-submenu-item"
            >
              <q-item-section avatar side>
                <q-icon name="sports_esports" />
              </q-item-section>
              <q-item-section>
                {{ $t('chatInput.gamesSubmenu') }}
              </q-item-section>
              <q-item-section side>
                <q-icon name="keyboard_arrow_right" />
              </q-item-section>
              <q-menu anchor="top end" self="top start">
                <q-list dense style="min-width: 220px" class="q-py-xs">
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

                  <q-item
                    clickable
                    v-close-popup
                    data-testid="dice-menu-item"
                    @click="diceClicked"
                  >
                    <q-item-section avatar side>
                      <q-icon name="casino" />
                    </q-item-section>
                    <q-item-section>
                      {{ $t('chatInput.diceChallenge') }}
                    </q-item-section>
                  </q-item>

                  <q-item
                    clickable
                    v-close-popup
                    data-testid="rps-menu-item"
                    @click="rpsClicked"
                  >
                    <q-item-section avatar side>
                      <q-icon name="sports_esports" />
                    </q-item-section>
                    <q-item-section>
                      {{ $t('chatInput.rpsChallenge') }}
                    </q-item-section>
                  </q-item>

                  <q-item
                    clickable
                    v-close-popup
                    data-testid="mental-poker-menu-item"
                    @click="closeMenuAndEmit('mentalPokerClicked')"
                  >
                    <q-item-section avatar side>
                      <q-icon name="style" />
                    </q-item-section>
                    <q-item-section>
                      {{ $t('chatInput.mentalPokerChallenge') }}
                    </q-item-section>
                  </q-item>
                </q-list>
              </q-menu>
            </q-item>
          </q-list>
        </q-menu>
      </q-btn>

      <div
        class="col chat-input-container row no-wrap items-center"
        :class="{ 'chat-input-container--focused': isInputFocused }"
        @focusin="isInputFocused = true"
        @focusout="onContainerFocusout"
      >
        <q-input
          ref="inputBox"
          class="col chat-input-field"
          :class="{ 'chat-input-field--empty': !innerMessage }"
          dense
          borderless
          autogrow
          @focus="isInputFocused = true"
          @blur="isInputFocused = false"
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
            v-if="defaultStampMode && suggestedIncrease"
            class="chat-stamp-pill-increase q-ml-xs text-warning text-weight-bold"
            data-testid="stamp-pill-increase"
            aria-hidden="true"
            >↑</span
          >
          <span
            v-if="stampMultiplier && stampMultiplier !== '1'"
            class="chat-stamp-pill-multiple q-ml-xs"
            data-testid="stamp-pill-multiple"
            >{{ stampMultiplier }}×</span
          >
          <q-tooltip max-width="280px">
            <div data-testid="stamp-tooltip-amount">{{ stampLabel }}</div>
            <div
              v-if="defaultStampMode && suggestedIncrease"
              data-testid="stamp-tooltip-increase"
            >
              {{ $t('chatInput.stampSuggestedIncreaseNotice') }}
            </div>
            <div>{{ $t('chatInput.stampWhat') }}</div>
            <div
              v-if="defaultStampMode && stampBasisNote"
              data-testid="stamp-basis-note"
            >
              {{ stampBasisNote }}
            </div>
          </q-tooltip>
          <q-menu anchor="top middle" self="bottom middle">
            <div class="q-pa-md" style="min-width: 320px">
              <div class="row items-center justify-between q-mb-xs">
                <div class="text-subtitle2 text-weight-medium">
                  {{ $t('chatInput.stampPayment') }}
                </div>
                <q-badge
                  outline
                  :color="isDefaultStamp ? 'primary' : 'amber-8'"
                  data-testid="stamp-mode-status"
                >
                  {{
                    isDefaultStamp
                      ? $t('chatInput.stampSuggestedMode')
                      : $t('chatInput.stampOverriddenMode')
                  }}
                </q-badge>
              </div>

              <div
                v-if="lastPeerStampText"
                class="text-caption text-grey-7 q-mb-xs"
                data-testid="stamp-last-peer-paid"
              >
                {{
                  $t('chatInput.stampPeerLastPaid', {
                    amount: lastPeerStampText,
                  })
                }}
              </div>

              <div
                v-if="isDefaultStamp && suggestedIncrease"
                class="text-caption text-warning text-weight-medium q-mb-xs"
                data-testid="stamp-suggested-increase"
              >
                ↑ {{ $t('chatInput.stampSuggestedIncreaseNotice') }}
              </div>

              <div
                class="text-caption chat-stamp-explanation q-mb-sm"
                data-testid="stamp-explanation"
              >
                <div>{{ $t('chatInput.stampWhat') }}</div>
                <div
                  v-if="defaultStampMode && stampBasisNote"
                  data-testid="stamp-basis-note"
                >
                  {{ stampBasisNote }}
                </div>
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
              <q-btn
                flat
                dense
                no-caps
                color="primary"
                data-testid="chat-input-stamp-free"
                :label="$t('chatInput.stampFree')"
                :disable="disable"
                @click="chooseFreeStamp"
              />
              <!-- Multipliers use the current quote or network static fallback. -->
              <div class="q-mt-sm q-px-md">
                <q-slider
                  v-model="decadeIndex"
                  class="q-mt-md"
                  :min="0"
                  :max="multiplierSteps.length - 1"
                  :disable="disable"
                  :step="1"
                  label
                  label-always
                  :label-value="stampMultiplier ? `${stampMultiplier}×` : ''"
                  markers
                  :marker-labels="decadeMarkerLabels"
                  data-testid="chat-input-stamp-slider"
                />
              </div>
              <div
                class="text-caption q-mt-sm"
                style="overflow-wrap: anywhere"
                data-testid="chat-input-stamp-selection"
              >
                {{ sliderLabelValue }}
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
                  no-caps
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
      accept="image/png,image/jpeg,image/gif,image/webp,.ics,text/calendar,.vcf,text/vcard,text/x-vcard"
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
  parseIcsToCalendarInvite,
  parseVcfToContactCard,
} from '../../utils/calendar-vcard'
import {
  formatAttachmentSize,
  insertImageMarkdown,
  removeAttachmentReferences,
  type PostAttachment,
} from '../../utils/post-editor'
import { activeChain } from '@frank/wallet/chain'
import { defaultStaticStampForChain } from '@frank/wallet/oracle'
import {
  formatCompactAmount,
  formatDisplayAmount,
} from '../../utils/chain-amount'

function isCalendarOrVcardFile(f: File): boolean {
  const lower = f.name.toLowerCase()
  return (
    lower.endsWith('.ics') ||
    lower.endsWith('.vcf') ||
    f.type === 'text/calendar' ||
    f.type === 'text/vcard' ||
    f.type === 'text/x-vcard'
  )
}

/** The pictures or calendar/contact files among pasted or dropped data. */
function supportedTransferFiles(data: DataTransfer | null | undefined): File[] {
  return Array.from(data?.files ?? []).filter(
    f => f.type.startsWith('image/') || isCalendarOrVcardFile(f),
  )
}

// Tenths keep fractional presets exact even when the quote exceeds Number's safe range.
export const STAMP_MULTIPLIER_TENTHS = [
  0, 1, 2, 5, 9, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000,
  50000, 100000,
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
    defaultStampWei: {
      type: BigInt as unknown as PropType<bigint>,
      default: undefined,
    },
    suggestedStampWei: {
      type: BigInt as unknown as PropType<bigint>,
      default: undefined,
    },
    lastPeerStampWei: {
      type: BigInt as unknown as PropType<bigint>,
      default: undefined,
    },
    suggestedIncrease: {
      type: Boolean,
      default: false,
    },
    defaultStampMode: { type: Boolean, default: true },
    stampUnavailable: { type: String, default: '' },
    stampUnavailablePending: { type: Boolean, default: false },
    stampBasisNote: { type: String, default: '' },
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
      multiplierSteps: STAMP_MULTIPLIER_TENTHS,
      isInputFocused: false,
    }
  },
  emits: [
    'update:message',
    'update:attachments',
    'update:stampAmount',
    'resetStampDefault',
    'sendMessage',
    'sendFollowUp',
    'blackjackClicked',
    'diceClicked',
    'rpsClicked',
    'mentalPokerClicked',
    'articleClicked',
    'invoiceClicked',
    'webrtcCallClicked',
    'sendStealthClicked',
    'swapClicked',
  ],
  methods: {
    onContainerFocusout(e: FocusEvent) {
      const container = e.currentTarget as HTMLElement | null
      const next = e.relatedTarget as Node | null
      if (container && next && container.contains(next)) {
        return
      }
      this.isInputFocused = false
    },
    closeAttachMenu() {
      const menu = this.$refs.attachMenu as
        | { hide?: () => void }
        | undefined
      menu?.hide?.()
    },
    closeMenuAndEmit(
      event:
        | 'swapClicked'
        | 'invoiceClicked'
        | 'articleClicked'
        | 'mentalPokerClicked',
    ) {
      this.closeAttachMenu()
      this.$emit(event)
    },
    emitAndClose(
      event: 'webrtcCallClicked',
      payload?: { withVideo?: boolean },
    ) {
      this.closeAttachMenu()
      this.$emit(event, payload)
    },
    /** Scale the AVU quote, retaining the adapter floor for paid presets and explicit zero. */
    multipliedStamp(tenths: number): bigint {
      const base = this.effectiveDefaultStampWei
      const raw = (base * BigInt(tenths)) / 10n
      return tenths === 0
        ? 0n
        : raw < this.minimumStampWei
        ? this.minimumStampWei
        : raw
    },
    chooseFreeStamp() {
      if (this.disable) return
      this.typedStamp = '0'
      this.$emit('update:stampAmount', '0')
    },
    resetToDefault() {
      this.typedStamp = null
      this.$emit('resetStampDefault')
    },
    /** Public focus target for chat-level focus handoffs. */
    focus(options?: { forceRefocus?: boolean }) {
      const box = this.$refs.inputBox as
        | { focus?: () => void; nativeEl?: HTMLElement; $el?: HTMLElement }
        | undefined
      const el =
        box?.nativeEl ??
        (box?.$el?.querySelector?.('textarea, input') as
          | HTMLTextAreaElement
          | HTMLInputElement
          | null
          | undefined)
      const fieldEl = box?.$el
      const quasarFieldUnfocused =
        fieldEl instanceof HTMLElement &&
        fieldEl.classList.contains('q-field') &&
        !fieldEl.classList.contains('q-field--focused')
      if (
        el instanceof HTMLElement &&
        document.activeElement === el &&
        (options?.forceRefocus || quasarFieldUnfocused || !this.isInputFocused)
      ) {
        // When a notification is clicked on macOS while the window is in the
        // background (or when the compose <textarea> remained the tab's
        // document.activeElement across a window blur / route reuse),
        // document.activeElement is already `el`, which causes both Quasar's
        // QInput.focus() (`inputRef.value !== document.activeElement`) and
        // native el.focus() to no-op without firing `focusin` or restoring
        // QField's focused/highlighted state. Blurring first forces a clean
        // focus transition.
        el.blur()
      }
      box?.focus?.()
      if (el instanceof HTMLElement && document.activeElement !== el) {
        el.focus({ preventScroll: true })
      }
      if (el instanceof HTMLElement && document.activeElement === el) {
        this.isInputFocused = true
      }
    },
    // A pasted picture becomes an attachment; pasted text is left to the text box.
    pasted(e: ClipboardEvent) {
      const files = supportedTransferFiles(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      return this.attachImages(files)
    },
    // The template's `.prevent` already keeps the browser from navigating to a dropped file.
    dropped(e: DragEvent) {
      return this.attachImages(supportedTransferFiles(e.dataTransfer))
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
     * before anything is paid. Also parses `.ics` and `.vcf` attachments into typed items.
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
        if (isCalendarOrVcardFile(file)) {
          try {
            const rawText = await file.text()
            const lower = file.name.toLowerCase()
            const item =
              lower.endsWith('.vcf') ||
              file.type === 'text/vcard' ||
              file.type === 'text/x-vcard'
                ? parseVcfToContactCard(rawText)
                : parseIcsToCalendarInvite(rawText)
            this.$emit('sendFollowUp', { items: [item] })
          } catch (err) {
            this.attachError = this.$t('calendarInvite.invalidFile', {
              name: file.name,
              reason: err instanceof Error ? err.message : String(err),
            })
          }
          continue
        }
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
      this.typedStamp = null
      this.$emit('sendMessage', this.innerMessage)
    },
    blackjackClicked() {
      this.closeAttachMenu()
      this.$emit('blackjackClicked')
    },
    diceClicked() {
      this.closeAttachMenu()
      this.$emit('diceClicked')
    },
    rpsClicked() {
      this.closeAttachMenu()
      this.$emit('rpsClicked')
    },
    sendStealthClicked() {
      this.closeAttachMenu()
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
      return {
        0: this.$t('chatInput.stampFree'),
        5: '1×',
        8: '10×',
        11: '100×',
        14: '1k×',
        17: '10k×',
      }
    },
    fallbackStaticStampWei(): bigint {
      const fallbackCoin = defaultStaticStampForChain(
        activeChain.chainIdentifier,
      )
      try {
        return activeChain.fromDisplayAmount(fallbackCoin)
      } catch {
        return 0n
      }
    },
    effectiveDefaultStampWei(): bigint {
      return this.defaultStampWei ?? this.fallbackStaticStampWei
    },
    decadeIndex: {
      get(): number {
        if (
          this.effectiveDefaultStampWei === undefined ||
          this.stampWei === undefined
        )
          return 0
        let closest = 0
        let distance: bigint | undefined
        for (let i = 0; i < STAMP_MULTIPLIER_TENTHS.length; i++) {
          const raw =
            (this.effectiveDefaultStampWei *
              BigInt(STAMP_MULTIPLIER_TENTHS[i])) /
            10n
          const delta =
            raw > this.stampWei ? raw - this.stampWei : this.stampWei - raw
          if (distance === undefined || delta < distance) {
            distance = delta
            closest = i
          }
        }
        return closest
      },
      set(index: number) {
        if (
          this.effectiveDefaultStampWei === undefined ||
          !Number.isFinite(index)
        )
          return
        const i = Math.max(
          0,
          Math.min(STAMP_MULTIPLIER_TENTHS.length - 1, Math.round(index)),
        )
        const raw = this.multipliedStamp(STAMP_MULTIPLIER_TENTHS[i])
        this.$emit('update:stampAmount', activeChain.toDisplayAmount(raw))
      },
    },
    sliderLabelValue(): string {
      if (this.stampWei === 0n) return this.$t('chatInput.stampFree')
      if (this.stampWei === undefined)
        return this.$t('chatInput.stampQuoteUnavailable')
      const amount = `${activeChain.toDisplayAmount(this.stampWei)} ${
        this.chainUnit
      }`
      // A typed amount need not equal a preset. The label always describes what will be sent.
      return this.stampMultiplier
        ? this.$t('chatInput.stampMultiplierValue', {
            multiplier: this.stampMultiplier,
            amount,
          })
        : amount
    },
    stampMultiplier(): string {
      const selected = this.stampWei
      const reference = this.effectiveDefaultStampWei
      if (
        selected === undefined ||
        selected === 0n ||
        reference === undefined ||
        reference <= 0n
      )
        return ''
      const scaled = (selected * 10000n + reference / 2n) / reference
      const whole = scaled / 10000n
      const fraction = (scaled % 10000n)
        .toString()
        .padStart(4, '0')
        .replace(/0+$/, '')
      const approximate = (selected * 10000n) % reference !== 0n
      return `${approximate ? '≈' : ''}${whole}${
        fraction ? '.' + fraction : ''
      }`
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
      const stamp = this.suggestedStampWei ?? this.effectiveDefaultStampWei
      return stamp === undefined || stamp <= 0n
        ? this.$t('chatInput.stampQuoteUnavailable')
        : formatCompactAmount(activeChain, stamp)
    },
    lastPeerStampText(): string {
      if (this.lastPeerStampWei === undefined || this.lastPeerStampWei <= 0n) {
        return ''
      }
      return formatCompactAmount(activeChain, this.lastPeerStampWei)
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
      return !this.stampMultiplier || this.stampMultiplier === '1'
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
        if (!val.includes(':')) {
          this.$emit('update:message', val)
          return
        }
        const replacer = (match: string) => emoji.emojify(match)
        // TODO: Remove emojify
        const emojifiedValue = val.replace(/(:[a-zA-Z0-9_+-]+:)/g, replacer)
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

<style lang="scss" scoped>
.chat-input-toolbar {
  display: flex;
  align-items: center;
  min-height: 64px;
  padding: 8px 14px;
  overflow: visible;
  container-type: inline-size;
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

  &:focus-within,
  &.chat-input-container--focused {
    border-color: var(--q-primary);
    box-shadow: 0 0 0 1px var(--q-primary);
  }
}

.chat-input-field {
  flex: 1 1 0%;
  min-width: 84px;
  font-size: 14px;
  line-height: 1.4;

  :deep(.q-field__native) {
    padding: 6px 0;
    max-height: 140px;
  }
}

.chat-input-field--empty {
  :deep(.q-field__native) {
    height: 32px !important;
    min-height: 32px !important;
    max-height: 32px !important;
    overflow: hidden !important;
    white-space: nowrap !important;
    text-overflow: ellipsis !important;
  }
}

.chat-stamp-btn {
  flex-shrink: 0;
  max-width: 48%;
  min-height: 28px;
  height: auto;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
  color: var(--q-primary);
  background-color: var(--q-chat-stamp-bg, rgba(0, 0, 0, 0.05));
  transition: background-color 0.15s ease, opacity 0.15s ease;

  :deep(.q-btn__content) {
    flex-wrap: nowrap !important;
    white-space: nowrap !important;
  }

  &:hover:not(:disabled) {
    background-color: var(--q-chat-stamp-bg-hover, rgba(0, 0, 0, 0.09));
  }
}

.chat-stamp-pill-text {
  font-weight: 600;
  font-size: 11px;
  font-family: inherit;
  opacity: 0.92;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Secondary to the amount; the first thing to go when the composer is narrow. */
.chat-stamp-pill-multiple {
  font-size: 10px;
  font-weight: 600;
  opacity: 0.82;
  white-space: nowrap;
  flex-shrink: 0;

  @media (max-width: 540px) {
    display: none;
  }
}

@container (max-width: 480px) {
  .chat-stamp-pill-multiple {
    display: none;
  }

  .chat-stamp-btn {
    padding: 2px 6px;
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

  :deep(.q-icon) {
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

:global(body.body--dark) {
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

.chat-menu-divider {
  height: 1px;
  background: rgba(128, 128, 128, 0.2);
}
</style>
