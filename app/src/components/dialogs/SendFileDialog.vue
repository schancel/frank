<template>
  <q-card class="q-px-sm q-pb-md dialog-medium" data-testid="send-file-dialog">
    <q-card-section class="row items-center q-pb-none">
      <div class="text-h6">
        {{ $t('sendFileDialog.sendFile') }}
      </div>
      <q-space />
      <q-btn
        flat
        round
        icon="attach_file"
        :aria-label="$t('a11y.chooseFile')"
        color="primary"
        @click="$refs.filePicker.$el.click()"
      />
    </q-card-section>
    <q-card-section>
      <q-file
        ref="filePicker"
        v-model="filePath"
        filled
        accept="image/png,image/jpeg,image/gif,image/webp"
        style="display: none"
      />
      <q-img v-if="sendable" :src="image" spinner-color="white" />
      <!-- A picture this message cannot carry is said so here, before anything is paid. -->
      <div
        v-else-if="refusalKey"
        class="text-negative text-body2"
        role="alert"
        data-testid="send-file-refused"
      >
        {{
          $t('sendFileDialog.cannotSend', {
            reason: $t(`chatImage.${refusalKey}`),
          })
        }}
      </div>
    </q-card-section>
    <q-card-section>
      <q-input
        class="text-bold text-h6"
        v-model="caption"
        filled
        dense
        :maxlength="maxCaptionLength"
        :hint="$t('sendFileDialog.captionHint')"
        :placeholder="$t('sendFileDialog.captionPlaceholder')"
      />
    </q-card-section>
    <q-card-actions align="right">
      <q-btn
        flat
        :label="$t('sendFileDialog.cancelBtnLabel')"
        color="primary"
        v-close-popup
      />
      <q-btn
        flat
        :label="$t('sendFileDialog.sendBtnLabel')"
        color="primary"
        v-close-popup
        :disable="!sendable"
        data-testid="send-file-confirm"
        @click="send"
      />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

import {
  IMAGE_REASON_KEYS,
  MAX_SENT_CAPTION_LENGTH,
  SENT_IMAGE_LIMITS,
  inspectImageDataUri,
} from 'src/utils/image-data-uri'

// Picks one picture and an optional caption. It sends nothing itself: the chat page sends the
// result as an image item through the same paid path as text.
export default defineComponent({
  props: {
    file: {
      type: File,
      default: null,
    },
  },
  emits: ['send'],
  data() {
    return {
      caption: '',
      filePath: null as File | null,
      image: '',
      // Why the chosen file cannot be sent, as a `chatImage.*` key; empty when it can.
      refusalKey: '',
      maxCaptionLength: MAX_SENT_CAPTION_LENGTH,
    }
  },
  computed: {
    sendable(): boolean {
      return this.image !== '' && this.refusalKey === ''
    },
  },
  created() {
    if (this.file) {
      this.filePath = this.file
    }
  },
  methods: {
    send() {
      if (!this.sendable) return
      this.$emit('send', { image: this.image, caption: this.caption.trim() })
    },
    /** Accepts the read file only if a recipient's app would show it and a message can hold it. */
    accept(uri: unknown) {
      const check = inspectImageDataUri(uri, SENT_IMAGE_LIMITS)
      this.image = check.ok ? (uri as string) : ''
      this.refusalKey = check.ok
        ? ''
        : IMAGE_REASON_KEYS[check.reason] ?? 'reasonNotAnImage'
    },
  },
  watch: {
    filePath(val: File | null) {
      this.image = ''
      this.refusalKey = ''
      if (val == null) {
        return
      }
      const reader = new FileReader()
      reader.onload = evt => this.accept(evt.target?.result)
      reader.onerror = () => this.accept(undefined)
      reader.readAsDataURL(val)
    },
  },
})
</script>
