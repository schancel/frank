<template>
  <q-page
    :style-fn="pageStyleFn"
    class="email-thread-page column no-wrap full-height relative-position"
    data-testid="email-thread-view"
  >
    <!-- Thread Header Banner -->
    <div
      class="email-thread-header q-px-lg q-py-md shadow-1"
      style="flex-shrink: 0"
    >
      <div class="row items-center justify-between no-wrap q-mb-xs">
        <div class="row items-center no-wrap ellipsis col">
          <q-icon name="mail" size="24px" color="primary" class="q-mr-sm" />
          <div class="text-h6 text-weight-bold ellipsis" :title="threadSubject">
            {{ threadSubject }}
          </div>
        </div>
        <div class="row items-center q-gutter-xs col-auto">
          <q-badge
            v-if="isVerifiedGateway"
            color="primary"
            outline
            class="q-px-sm q-py-xs text-caption"
            data-testid="email-gateway-badge"
          >
            <q-icon name="verified" size="14px" class="q-mr-xs text-primary" />
            {{ $t('emailThread.gatewayBadge') }}
          </q-badge>
          <q-badge
            v-else
            color="warning"
            outline
            class="q-px-sm q-py-xs text-caption text-weight-medium bg-amber-1 text-amber-10"
            data-testid="unverified-p2p-badge"
          >
            <q-icon name="warning" size="14px" class="q-mr-xs text-warning" />
            {{
              $t(
                'emailThread.unverifiedBadge',
                '⚠️ Direct P2P Email (Unverified)',
              )
            }}
          </q-badge>
          <q-btn
            v-if="!isDraft"
            flat
            dense
            round
            size="sm"
            :icon="allExpanded ? 'unfold_less' : 'unfold_more'"
            :aria-label="
              allExpanded
                ? $t('emailThread.collapseAll')
                : $t('emailThread.expandAll')
            "
            @click="toggleAllExpanded"
          >
            <q-tooltip>{{
              allExpanded
                ? $t('emailThread.collapseAll')
                : $t('emailThread.expandAll')
            }}</q-tooltip>
          </q-btn>
        </div>
      </div>

      <!-- Security Warning Banner for Unverified Peer Email Frames -->
      <q-banner
        v-if="!isVerifiedGateway"
        dense
        class="bg-amber-1 text-amber-10 q-px-md q-py-xs text-caption rounded-borders q-my-sm unverified-email-banner"
        data-testid="unverified-peer-warning-banner"
      >
        <template #avatar>
          <q-icon name="warning" color="warning" size="18px" />
        </template>
        <span>
          ⚠️ Direct Peer Email Frame: This message was sent directly by Frank
          user {{ peerFrankAddress }} (not an Email Gateway). External email
          recipients will not receive replies.
        </span>
      </q-banner>

      <!-- Participants summary -->
      <div
        class="row items-center text-caption text-grey-7 q-gutter-x-sm ellipsis"
        v-if="allParticipants.length > 0"
      >
        <span class="text-weight-medium"
          >{{ $t('emailThread.participants') }}:</span
        >
        <span class="ellipsis">{{ allParticipants.join(', ') }}</span>
        <q-badge color="grey-5" text-color="black" class="text-caption">
          {{ parsedEmails.length }}
          {{
            parsedEmails.length === 1
              ? $t('emailThread.messageSingle')
              : $t('emailThread.messagePlural')
          }}
        </q-badge>
      </div>
    </div>

    <!-- Scrollable Email Message Cards Area -->
    <div class="col relative-position" style="min-height: 0; overflow: hidden">
      <q-scroll-area
        ref="emailScroll"
        class="q-px-none absolute full-width full-height column"
        :content-style="{ padding: '16px 24px 24px 24px' }"
      >
        <div class="email-cards-container">
          <!-- Draft placeholder when there are 0 messages -->
          <div
            v-if="isDraft"
            class="column items-center justify-center q-pa-xl text-grey-6 empty-draft-container"
            data-testid="email-draft-placeholder"
          >
            <q-icon name="drafts" size="48px" class="q-mb-sm text-grey-5" />
            <div class="text-subtitle1 text-weight-medium">
              {{ $t('emailThread.newDraftTitle') }}
            </div>
            <div class="text-caption text-center" style="max-width: 420px">
              {{ $t('emailThread.newDraftSubtitle') }}
            </div>
          </div>

          <template v-for="(card, index) in parsedEmails" :key="card.id">
            <q-card
              flat
              bordered
              class="q-mb-md email-card transition-generic"
              :class="{
                'email-card-expanded': isExpanded(card.id),
                'email-card-outbound': card.isOutbound,
              }"
              :data-testid="`email-card-${index}`"
            >
              <!-- Card Header (Always Visible, Clickable) -->
              <q-item
                clickable
                @click="toggleExpand(card.id)"
                class="q-py-sm email-card-header"
                :class="{
                  'bg-grey-1': !isExpanded(card.id) && !$q.dark.isActive,
                  'bg-grey-9': !isExpanded(card.id) && $q.dark.isActive,
                }"
              >
                <q-item-section avatar top>
                  <q-avatar size="36px" color="primary" text-color="white">
                    <span class="text-weight-bold">{{
                      getInitials(card.fromName || card.fromAddress)
                    }}</span>
                  </q-avatar>
                </q-item-section>

                <q-item-section>
                  <div class="row items-center justify-between no-wrap">
                    <div class="row items-center no-wrap ellipsis col">
                      <span
                        class="text-weight-bold text-body2 q-mr-xs ellipsis"
                      >
                        {{ card.fromName || card.fromAddress }}
                      </span>
                      <span
                        class="text-caption text-grey-6 ellipsis q-mr-xs"
                        v-if="card.fromName"
                      >
                        &lt;{{ card.fromAddress }}&gt;
                      </span>
                      <q-badge
                        v-if="isVerifiedGateway && card.isDkimVerified"
                        color="positive"
                        outline
                        class="text-caption q-px-xs q-ml-xs"
                        data-testid="dkim-badge"
                      >
                        <q-icon
                          name="verified_user"
                          size="12px"
                          class="q-mr-xs text-positive"
                        />
                        DKIM
                      </q-badge>
                    </div>
                    <div class="text-caption text-grey-6 text-no-wrap q-ml-sm">
                      {{ card.formattedDate }}
                    </div>
                  </div>

                  <!-- Collapsed summary preview -->
                  <div
                    class="row items-center justify-between text-caption text-grey-7 no-wrap"
                    v-if="!isExpanded(card.id)"
                  >
                    <span class="ellipsis col text-grey-8">
                      {{ card.snippet }}
                    </span>
                    <span
                      class="col-auto q-ml-sm"
                      v-if="card.attachments && card.attachments.length > 0"
                    >
                      <q-icon name="attach_file" size="14px" />
                      {{ card.attachments.length }}
                    </span>
                  </div>

                  <!-- Expanded Recipient Details -->
                  <div class="text-caption text-grey-6" v-else>
                    <div>
                      <span class="text-weight-medium"
                        >{{ $t('emailThread.to') }}:</span
                      >
                      {{ formatParties(card.to) }}
                    </div>
                    <div v-if="card.cc && card.cc.length > 0">
                      <span class="text-weight-medium"
                        >{{ $t('emailThread.cc') }}:</span
                      >
                      {{ formatParties(card.cc) }}
                    </div>
                  </div>
                </q-item-section>

                <q-item-section side>
                  <q-icon
                    :name="isExpanded(card.id) ? 'expand_less' : 'expand_more'"
                  />
                </q-item-section>
              </q-item>

              <!-- Card Body (Shown when Expanded) -->
              <q-slide-transition>
                <div v-show="isExpanded(card.id)">
                  <q-separator />
                  <q-card-section class="q-py-md email-card-body">
                    <!-- HTML / Plain Text Toggle if htmlBody is present -->
                    <div
                      v-if="card.rawEmail?.htmlBody"
                      class="row items-center justify-end q-mb-sm html-toggle-row"
                    >
                      <q-btn
                        flat
                        dense
                        size="sm"
                        color="primary"
                        :label="
                          isHtmlView(card.id) ? 'Show Plain Text' : 'Show HTML'
                        "
                        :icon="isHtmlView(card.id) ? 'text_fields' : 'html'"
                        data-testid="toggle-html-view"
                        @click="toggleHtmlView(card.id)"
                      />
                    </div>

                    <!-- Render Sandboxed HTML iframe or Plain Text -->
                    <iframe
                      v-if="card.rawEmail?.htmlBody && isHtmlView(card.id)"
                      :srcdoc="sanitizedHtml(card.rawEmail.htmlBody)"
                      sandbox="allow-same-origin"
                      class="email-html-frame"
                    />
                    <div
                      v-else
                      class="email-body-text text-body1"
                      v-html="formatMessageBody(card.textBody)"
                    />

                    <!-- Attachments -->
                    <div
                      v-if="card.attachments && card.attachments.length > 0"
                      class="q-mt-md"
                    >
                      <q-separator class="q-mb-sm" />
                      <div
                        class="text-caption text-weight-bold text-grey-7 q-mb-xs"
                      >
                        {{
                          $t('emailThread.attachmentsCount', {
                            count: card.attachments.length,
                          })
                        }}
                      </div>
                      <div class="row q-gutter-sm items-center">
                        <q-chip
                          v-for="(att, aIdx) in card.attachments"
                          :key="aIdx"
                          icon="attach_file"
                          color="primary"
                          outline
                          clickable
                          class="q-ma-none text-caption"
                        >
                          <span class="text-weight-medium q-mr-xs">{{
                            att.filename
                          }}</span>
                          <span class="text-grey-6"
                            >({{ formatBytes(att.sizeBytes) }})</span
                          >
                        </q-chip>
                      </div>
                    </div>
                  </q-card-section>

                  <!-- Card Action Footer -->
                  <q-separator />
                  <q-card-actions
                    align="right"
                    class="q-px-md q-py-xs bg-grey-1"
                    :class="{ 'bg-grey-10': $q.dark.isActive }"
                  >
                    <q-btn
                      flat
                      dense
                      size="sm"
                      icon="reply"
                      :label="$t('emailThread.reply')"
                      @click.stop="prepareReply(card, 'reply')"
                    />
                    <q-btn
                      flat
                      dense
                      size="sm"
                      icon="reply_all"
                      :label="$t('emailThread.replyAll')"
                      v-if="canReplyAll(card)"
                      @click.stop="prepareReply(card, 'reply_all')"
                    />
                  </q-card-actions>
                </div>
              </q-slide-transition>
            </q-card>
          </template>
        </div>
      </q-scroll-area>
    </div>

    <!-- Docked Email Composer -->
    <div
      class="email-composer-dock shadow-4 q-px-lg q-py-md"
      style="
        flex-shrink: 0;
        max-height: 50vh;
        overflow-y: auto;
        overscroll-behavior: contain;
      "
    >
      <!-- Unverified Peer Composer Warning Notice -->
      <div
        v-if="!isVerifiedGateway"
        class="composer-warning-banner q-mb-sm q-px-sm q-py-xs bg-amber-1 text-amber-10 rounded-borders text-caption row items-center no-wrap"
        data-testid="composer-unverified-warning"
      >
        <q-icon
          name="warning"
          size="16px"
          class="q-mr-xs text-warning col-auto"
        />
        <span class="col">
          <b>P2P Direct Reply:</b> Replies in this thread are delivered directly
          to Frank peer <code>{{ peerFrankAddress }}</code> only. External email
          recipients in To/Cc will not receive replies via MX.
        </span>
      </div>

      <!-- Routing Mode Toggle when peer is unverified -->
      <div
        v-if="!isVerifiedGateway"
        class="row items-center justify-between q-mb-xs q-gutter-x-sm text-caption"
        data-testid="composer-routing-control"
      >
        <div class="row items-center q-gutter-x-xs">
          <span class="text-weight-bold text-grey-7">Route:</span>
          <q-btn-toggle
            v-model="replyRouting"
            dense
            rounded
            toggle-color="warning"
            color="grey-3"
            text-color="grey-8"
            size="xs"
            :options="[
              { label: 'Direct P2P', value: 'peer' },
              { label: 'Bridge via Gateway', value: 'gateway' },
            ]"
            data-testid="composer-routing-toggle"
          />
        </div>
        <div class="text-caption text-grey-7 ellipsis col text-right">
          {{
            replyRouting === 'peer'
              ? 'Delivered to Frank peer only (no external MX dispatch)'
              : 'Routed via Frank Email Gateway to external email addresses'
          }}
        </div>
      </div>

      <!-- Composer Controls Header -->
      <div class="row items-center justify-between q-mb-sm">
        <div class="row items-center q-gutter-x-sm">
          <template v-if="!isDraft">
            <q-btn-toggle
              v-model="replyMode"
              dense
              rounded
              toggle-color="primary"
              color="grey-4"
              text-color="grey-8"
              size="sm"
              :options="replyOptions"
              @update:model-value="onReplyModeChanged"
            />
          </template>
          <span v-else class="text-weight-medium text-caption text-primary">
            {{ $t('emailThread.newEmail') }}
          </span>
          <q-btn
            flat
            dense
            size="sm"
            :label="
              showCc ? $t('emailThread.hideCc') : $t('emailThread.showCc')
            "
            color="primary"
            @click="showCc = !showCc"
          />
          <q-btn
            flat
            dense
            size="sm"
            :label="
              showBcc ? $t('emailThread.hideBcc') : $t('emailThread.showBcc')
            "
            color="primary"
            @click="showBcc = !showBcc"
          />
        </div>
        <div class="text-caption text-grey-6" v-if="stampStatus">
          {{ stampStatus }}
        </div>
      </div>

      <!-- Recipient To Field -->
      <div class="row items-center q-mb-xs">
        <span
          class="col-auto text-caption text-weight-bold text-grey-7 q-mr-sm"
          style="width: 32px"
          >{{ $t('emailThread.to') }}:</span
        >
        <div class="col row items-center q-gutter-xs">
          <q-chip
            v-for="(addr, idx) in toList"
            :key="idx"
            removable
            dense
            size="sm"
            color="primary"
            text-color="white"
            @remove="removeToRecipient(idx)"
          >
            {{ addr }}
          </q-chip>
          <q-input
            ref="toInputRef"
            v-model="newToInput"
            dense
            borderless
            :placeholder="$t('emailThread.addRecipient')"
            class="col text-caption input-inline"
            @keydown.enter.prevent="addToRecipient"
            @keydown="handleRecipientKeydown($event, 'to')"
          />
        </div>
      </div>

      <!-- Recipient Cc Field -->
      <div class="row items-center q-mb-xs" v-if="showCc || ccList.length > 0">
        <span
          class="col-auto text-caption text-weight-bold text-grey-7 q-mr-sm"
          style="width: 32px"
          >{{ $t('emailThread.cc') }}:</span
        >
        <div class="col row items-center q-gutter-xs">
          <q-chip
            v-for="(addr, idx) in ccList"
            :key="idx"
            removable
            dense
            size="sm"
            color="secondary"
            text-color="white"
            @remove="removeCcRecipient(idx)"
          >
            {{ addr }}
          </q-chip>
          <q-input
            ref="ccInputRef"
            v-model="newCcInput"
            dense
            borderless
            :placeholder="$t('emailThread.addCcRecipient')"
            class="col text-caption input-inline"
            @keydown.enter.prevent="addCcRecipient"
            @keydown="handleRecipientKeydown($event, 'cc')"
          />
        </div>
      </div>

      <!-- Recipient Bcc Field -->
      <div
        class="row items-center q-mb-xs"
        v-if="showBcc || bccList.length > 0"
        data-testid="composer-bcc-row"
      >
        <span
          class="col-auto text-caption text-weight-bold text-grey-7 q-mr-sm"
          style="width: 32px"
          >{{ $t('emailThread.bcc') }}:</span
        >
        <div class="col row items-center q-gutter-xs">
          <q-chip
            v-for="(addr, idx) in bccList"
            :key="idx"
            removable
            dense
            size="sm"
            color="deep-purple-7"
            text-color="white"
            @remove="removeBccRecipient(idx)"
          >
            {{ addr }}
          </q-chip>
          <q-input
            ref="bccInputRef"
            v-model="newBccInput"
            dense
            borderless
            :placeholder="$t('emailThread.addBccRecipient')"
            class="col text-caption input-inline"
            @keydown.enter.prevent="addBccRecipient"
            @keydown="handleRecipientKeydown($event, 'bcc')"
          />
        </div>
      </div>

      <!-- Subject Field -->
      <div class="row items-center q-mb-sm">
        <span
          class="col-auto text-caption text-weight-bold text-grey-7 q-mr-sm"
          style="width: 32px"
          >{{ $t('emailThread.subjectLabel') }}</span
        >
        <q-input
          ref="subjectInputRef"
          v-model="subject"
          dense
          outlined
          :placeholder="$t('emailThread.subjectPlaceholder')"
          class="col text-caption"
        />
      </div>

      <!-- Staged Attachments List -->
      <div
        v-if="stagedFiles.length > 0"
        class="row items-center q-gutter-xs q-mb-sm staged-attachments-list"
        data-testid="staged-attachments-container"
      >
        <q-chip
          v-for="(file, sIdx) in stagedFiles"
          :key="sIdx"
          dense
          outline
          color="primary"
          icon="attach_file"
          class="q-ma-none text-caption staged-attachment-chip"
        >
          <span class="text-weight-medium q-mr-xs">{{ file.name }}</span>
          <span class="text-grey-6 q-mr-xs"
            >({{ formatBytes(file.size) }})</span
          >
          <q-btn
            flat
            round
            dense
            size="xs"
            icon="close"
            data-testid="remove-attachment-btn"
            class="q-ml-xs cursor-pointer"
            @click="removeStagedFile(sIdx)"
          />
        </q-chip>
      </div>

      <!-- Formatting Toolbar -->
      <div
        class="row items-center q-gutter-xs q-mb-xs formatting-toolbar"
        role="toolbar"
        :aria-label="$t('a11y.formatting')"
      >
        <q-btn
          flat
          dense
          round
          size="sm"
          icon="format_bold"
          :aria-label="$t('emailThread.formatBold', 'Bold')"
          @mousedown.prevent
          @click="applyFormat('bold')"
        >
          <q-tooltip>{{ $t('emailThread.formatBold', 'Bold') }}</q-tooltip>
        </q-btn>
        <q-btn
          flat
          dense
          round
          size="sm"
          icon="format_italic"
          :aria-label="$t('emailThread.formatItalic', 'Italic')"
          @mousedown.prevent
          @click="applyFormat('italic')"
        >
          <q-tooltip>{{ $t('emailThread.formatItalic', 'Italic') }}</q-tooltip>
        </q-btn>
        <q-btn
          flat
          dense
          round
          size="sm"
          icon="title"
          :aria-label="$t('emailThread.formatHeading', 'Heading')"
          @mousedown.prevent
          @click="applyFormat('heading')"
        >
          <q-tooltip>{{
            $t('emailThread.formatHeading', 'Heading')
          }}</q-tooltip>
        </q-btn>
        <q-btn
          flat
          dense
          round
          size="sm"
          icon="format_quote"
          :aria-label="$t('emailThread.formatQuote', 'Quote')"
          @mousedown.prevent
          @click="applyFormat('quote')"
        >
          <q-tooltip>{{ $t('emailThread.formatQuote', 'Quote') }}</q-tooltip>
        </q-btn>
        <q-btn
          flat
          dense
          round
          size="sm"
          icon="code"
          :aria-label="$t('emailThread.formatCode', 'Code')"
          @mousedown.prevent
          @click="applyFormat('code')"
        >
          <q-tooltip>{{ $t('emailThread.formatCode', 'Code') }}</q-tooltip>
        </q-btn>
        <q-btn
          flat
          dense
          round
          size="sm"
          icon="format_list_bulleted"
          :aria-label="$t('emailThread.formatBullet', 'Bullet list')"
          @mousedown.prevent
          @click="applyFormat('bullet')"
        >
          <q-tooltip>{{
            $t('emailThread.formatBullet', 'Bullet list')
          }}</q-tooltip>
        </q-btn>
        <q-btn
          flat
          dense
          round
          size="sm"
          icon="link"
          :aria-label="$t('emailThread.formatLink', 'Link')"
          @mousedown.prevent
          @click="applyFormat('link')"
        >
          <q-tooltip>{{ $t('emailThread.formatLink', 'Link') }}</q-tooltip>
        </q-btn>
        <q-btn
          v-if="activeReplyCard"
          flat
          dense
          size="xs"
          icon="reply"
          color="primary"
          :label="$t('emailThread.quoteOriginal', 'Quote Original')"
          @click="insertOriginalQuote(activeReplyCard)"
          class="q-px-xs"
        >
          <q-tooltip>{{
            $t('emailThread.quoteOriginal', 'Quote Original')
          }}</q-tooltip>
        </q-btn>
        <q-space />
        <q-btn
          flat
          dense
          size="xs"
          :icon="isPreviewMode ? 'edit' : 'visibility'"
          :label="
            isPreviewMode
              ? $t('emailThread.edit', 'Edit')
              : $t('emailThread.preview', 'Preview')
          "
          color="grey-7"
          @click="isPreviewMode = !isPreviewMode"
        />
      </div>

      <!-- Message Textarea & Send Bar -->
      <div class="row items-end q-col-gutter-sm">
        <div class="col">
          <div
            v-if="isPreviewMode"
            class="email-body-preview q-pa-sm rounded-borders"
            :class="{
              'bg-grey-2': !$q.dark.isActive,
              'bg-grey-9': $q.dark.isActive,
            }"
            v-html="renderedPreviewText"
          />
          <q-input
            v-else
            ref="bodyInputRef"
            v-model="replyText"
            type="textarea"
            autogrow
            :rows="isDraft ? 5 : 3"
            outlined
            dense
            :placeholder="
              isDraft
                ? $t('emailThread.writeMessagePlaceholder')
                : $t('emailThread.writeReplyPlaceholder')
            "
            class="email-textarea"
            :disable="sending"
            @keydown.ctrl.enter="handleSend"
            @keydown.meta.enter="handleSend"
          />
        </div>
        <div class="col-auto row items-center q-gutter-x-xs">
          <!-- Hidden file input -->
          <input
            type="file"
            ref="fileInput"
            multiple
            @change="handleFilesSelected"
            class="hidden"
            style="display: none"
          />
          <!-- Attachment button -->
          <q-btn
            flat
            round
            dense
            color="primary"
            icon="attach_file"
            :disable="sending"
            @click="triggerFileInput"
            data-testid="attach-file-btn"
          >
            <q-tooltip>{{
              $t('emailThread.attachFiles', 'Attach files')
            }}</q-tooltip>
          </q-btn>
          <q-btn
            :color="
              isVerifiedGateway
                ? 'primary'
                : replyRouting === 'gateway'
                ? 'secondary'
                : 'warning'
            "
            icon="send"
            :label="sendButtonLabel"
            :loading="sending"
            :disable="sending || !canSend"
            @click="handleSend"
            class="q-px-md"
            data-testid="send-email-btn"
          >
            <q-tooltip>{{ sendButtonTooltip }}</q-tooltip>
          </q-btn>
        </div>
      </div>
    </div>
  </q-page>
</template>

<script lang="ts">
import { defineComponent, type PropType, ref } from 'vue'
import type { Conversation, ChatMessage } from 'src/stores/chats'
import type {
  EmailItem,
  EmailParty,
  EmailAttachment,
  MessageItem,
} from '@frank/cashweb/types/messages'
import { formatConversationTimestamp } from 'src/utils/formatting'
import { defaultEmailGatewayAddress } from 'src/utils/constants'
import { purify, renderMarkdown } from 'src/utils/markdown'
import {
  applyMarkdownFormat,
  type MarkdownFormatAction,
} from 'src/utils/post-editor'
import { useSettingsStore } from 'src/stores/settings'

interface ParsedEmailCard {
  id: string
  fromAddress: string
  fromName?: string
  to: EmailParty[]
  cc?: EmailParty[]
  bcc?: EmailParty[]
  subject: string
  textBody: string
  snippet: string
  formattedDate: string
  timestamp: number
  isOutbound: boolean
  attachments?: EmailAttachment[]
  rawEmail?: EmailItem
  isDkimVerified?: boolean
}

export interface EmailReply {
  conversationId: string
  items: MessageItem[]
  fallbackText: string
  targetAddress?: string
}

export default defineComponent({
  name: 'EmailThreadView',
  props: {
    conversation: {
      type: Object as PropType<Conversation | null>,
      default: null,
    },
    messages: {
      type: Array as PropType<ChatMessage[]>,
      default: () => [],
    },
    sending: {
      type: Boolean,
      default: false,
    },
    stampStatus: {
      type: String as PropType<string | null>,
      default: null,
    },
    recipientAddress: {
      type: String,
      default: '',
    },
  },
  emits: { sendReply: (_payload: EmailReply) => true },
  data() {
    return {
      composerActive: true,
      preparingSend: false,
      replyRouting: 'peer' as 'peer' | 'gateway',
      expandedMap: {} as Record<string, boolean>,
      allExpanded: false,
      replyMode: 'reply_all' as 'reply' | 'reply_all',
      showCc: false,
      showBcc: false,
      toList: [] as string[],
      ccList: [] as string[],
      bccList: [] as string[],
      newToInput: '',
      newCcInput: '',
      newBccInput: '',
      subject: '',
      replyText: '',
      isPreviewMode: false,
      activeReplyCard: null as ParsedEmailCard | null,
      activeInReplyTo: undefined as string | undefined,
      activeReferences: undefined as string[] | undefined,
      htmlViewMap: {} as Record<string, boolean>,
      stagedFiles: [] as File[],
    }
  },
  computed: {
    isVerifiedGateway(): boolean {
      return this.conversation?.verifiedGateway === true
    },
    peerFrankAddress(): string {
      if (this.recipientAddress) return this.recipientAddress
      if (this.conversation?.address) return this.conversation.address
      const inbound = this.messages.find(m => !m.outbound)
      if (inbound?.senderAddress) return inbound.senderAddress
      if (
        this.conversation?.participants &&
        this.conversation.participants.length > 0
      ) {
        return this.conversation.participants[0]
      }
      return ''
    },
    sendButtonLabel(): string {
      if (this.isVerifiedGateway) {
        return 'Send'
      }
      return this.replyRouting === 'gateway'
        ? 'Bridge via Gateway'
        : 'Send to Peer (P2P)'
    },
    sendButtonTooltip(): string {
      if (this.isVerifiedGateway) {
        return 'Send via Frank Email Gateway (Ctrl+Enter)'
      }
      return this.replyRouting === 'gateway'
        ? 'Route through Frank Email Gateway to dispatch to external recipients (Ctrl+Enter)'
        : 'Reply will only be delivered as a Frank direct message to the peer, not dispatched to external email addresses via MX (Ctrl+Enter)'
    },
    emailGatewayAddress(): string {
      try {
        const settingsStore = useSettingsStore()
        return settingsStore.emailGatewayAddress || defaultEmailGatewayAddress
      } catch {
        return defaultEmailGatewayAddress
      }
    },
    parsedEmails(): ParsedEmailCard[] {
      const cards: ParsedEmailCard[] = []
      for (const msg of this.messages) {
        const emailItem = msg.items?.find(it => it.type === 'email') as
          | EmailItem
          | undefined
        const timestamp = msg.serverTime || msg.receivedTime || Date.now()
        const formattedDate = formatConversationTimestamp(timestamp)

        if (emailItem) {
          const fromAddr = emailItem.from?.address || msg.senderAddress
          const fromName = emailItem.from?.name
          const text = emailItem.textBody || ''
          const snippet = text.replace(/\s+/g, ' ').slice(0, 100)

          cards.push({
            id: emailItem.messageId || msg.payloadDigest,
            fromAddress: fromAddr,
            fromName,
            to: emailItem.to || [],
            cc: emailItem.cc || [],
            subject: emailItem.subject || 'No Subject',
            textBody: text,
            snippet,
            formattedDate,
            timestamp,
            isOutbound: msg.outbound,
            attachments: emailItem.attachments,
            rawEmail: emailItem,
            isDkimVerified: Boolean(
              (emailItem as any).dkim || (emailItem as any).dkimVerified,
            ),
          })
        } else {
          // Plain message fallback card
          const textItem = msg.items?.find(it => it.type === 'text') as
            | { text?: string }
            | undefined
          const text = textItem?.text || ''
          const snippet = text.replace(/\s+/g, ' ').slice(0, 100)

          cards.push({
            id: msg.payloadDigest,
            fromAddress: msg.senderAddress,
            to: [{ address: msg.destinationAddress || this.recipientAddress }],
            subject: this.threadSubject,
            textBody: text,
            snippet,
            formattedDate,
            timestamp,
            isOutbound: msg.outbound,
          })
        }
      }

      // Chronological sort
      cards.sort((a, b) => a.timestamp - b.timestamp)
      return cards
    },
    isDraft(): boolean {
      return this.parsedEmails.length === 0
    },
    replyOptions(): Array<{ label: string; value: 'reply' | 'reply_all' }> {
      return [
        { label: this.$t('emailThread.replyAll'), value: 'reply_all' },
        { label: this.$t('emailThread.replySender'), value: 'reply' },
      ]
    },
    threadSubject(): string {
      if (this.subject && this.isDraft) {
        return this.subject
      }
      if (this.conversation?.name) {
        return this.conversation.name
      }
      for (let i = this.parsedEmails.length - 1; i >= 0; i--) {
        const sub = this.parsedEmails[i].subject
        if (sub && sub !== 'No Subject') return sub
      }
      if (this.toList.length > 0) {
        return `Draft to ${this.toList[0]}`
      }
      return this.$t('emailThread.newDraftTitle', 'New Email Thread')
    },
    allParticipants(): string[] {
      const set = new Set<string>()
      for (const email of this.parsedEmails) {
        if (email.fromName) {
          set.add(`${email.fromName} <${email.fromAddress}>`)
        } else if (email.fromAddress) {
          set.add(email.fromAddress)
        }
      }
      if (this.isDraft && this.toList.length > 0) {
        for (const t of this.toList) {
          set.add(t)
        }
      }
      return Array.from(set)
    },
    canSend(): boolean {
      return (
        (this.replyText.trim().length > 0 || this.stagedFiles.length > 0) &&
        (this.toList.length > 0 ||
          this.newToInput.trim().length > 0 ||
          this.bccList.length > 0 ||
          this.newBccInput.trim().length > 0)
      )
    },
    renderedPreviewText(): string {
      if (!this.replyText || this.replyText.trim() === '') {
        return '<span class="text-grey-6 italic">Nothing to preview</span>'
      }
      return purify(renderMarkdown(this.replyText, this.$q.dark.isActive))
    },
    latestEmail(): ParsedEmailCard | undefined {
      return this.parsedEmails[this.parsedEmails.length - 1]
    },
  },
  watch: {
    parsedEmails: {
      immediate: true,
      handler(cards: ParsedEmailCard[]) {
        if (cards.length > 0) {
          // Default latest message to expanded, earlier ones collapsed
          const latestId = cards[cards.length - 1].id
          if (!(latestId in this.expandedMap)) {
            this.expandedMap[latestId] = true
          }
          // Also set initial composer values if composer is untouched
          if (this.toList.length === 0 && !this.replyText) {
            this.setupComposerDefaults(cards[cards.length - 1])
          }
        } else {
          this.setupNewDraftDefaults()
        }
      },
    },
    conversation: {
      immediate: true,
      handler() {
        if (this.isDraft) {
          this.setupNewDraftDefaults()
        }
      },
    },
  },
  beforeUnmount() {
    this.composerActive = false
  },
  mounted() {
    if (this.isDraft) {
      this.setupNewDraftDefaults()
    }
  },
  methods: {
    setupNewDraftDefaults() {
      const recipient =
        this.conversation?.emailRecipient ||
        (this.conversation?.topic?.includes('@')
          ? this.conversation.topic
          : undefined) ||
        (this.conversation?.name?.includes('@')
          ? this.conversation.name
          : undefined)

      if (recipient && !this.toList.includes(recipient)) {
        this.toList = [recipient]
      }

      this.replyMode = 'reply'

      if (
        this.conversation?.name &&
        !this.conversation.name.includes('@') &&
        !this.subject
      ) {
        this.subject = this.conversation.name
      }

      this.$nextTick(() => {
        this.focusDraftCursor()
      })
    },
    focusDraftCursor() {
      if (this.toList.length === 0) {
        this.focusInput(this.$refs.toInputRef)
      } else if (!this.subject) {
        this.focusInput(this.$refs.subjectInputRef)
      } else {
        this.focusInput(this.$refs.bodyInputRef)
      }
    },
    focusInput(inputComp: any) {
      if (!inputComp) return
      if (typeof inputComp.focus === 'function') {
        inputComp.focus()
      } else if (inputComp.$el) {
        const el = inputComp.$el.querySelector('input, textarea')
        el?.focus?.()
      }
    },
    isExpanded(id: string): boolean {
      return !!this.expandedMap[id]
    },
    toggleExpand(id: string) {
      this.expandedMap[id] = !this.expandedMap[id]
    },
    toggleAllExpanded() {
      this.allExpanded = !this.allExpanded
      for (const card of this.parsedEmails) {
        this.expandedMap[card.id] = this.allExpanded
      }
    },
    getInitials(nameOrAddress: string): string {
      if (!nameOrAddress) return '?'
      const clean = nameOrAddress.replace(/<[^>]+>/g, '').trim()
      const parts = clean.split(/\s+/)
      if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase()
      }
      return clean.slice(0, 2).toUpperCase()
    },
    formatParties(parties: EmailParty[]): string {
      return parties
        .map(p => (p.name ? `${p.name} <${p.address}>` : p.address))
        .join(', ')
    },
    formatBytes(bytes: number): string {
      if (!bytes || bytes === 0) return '0 B'
      const k = 1024
      const sizes = ['B', 'KB', 'MB', 'GB']
      const i = Math.floor(Math.log(bytes) / Math.log(k))
      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
    },
    canReplyAll(card: ParsedEmailCard): boolean {
      const recipientCount = (card.to?.length || 0) + (card.cc?.length || 0)
      return recipientCount > 1
    },
    setupComposerDefaults(card: ParsedEmailCard) {
      if (!card) return
      this.activeReplyCard = card
      const hasMultiple = this.canReplyAll(card)
      this.replyMode = hasMultiple ? 'reply_all' : 'reply'
      this.populateRecipientsForCard(card, this.replyMode)

      let subj = card.subject || this.threadSubject
      if (!/^re:/i.test(subj)) {
        subj = `Re: ${subj}`
      }
      this.subject = subj
      this.activeInReplyTo = card.rawEmail?.messageId
      this.activeReferences = card.rawEmail?.references
        ? [...card.rawEmail.references, card.rawEmail.messageId]
        : card.rawEmail?.messageId
        ? [card.rawEmail.messageId]
        : undefined
    },
    populateRecipientsForCard(
      card: ParsedEmailCard,
      mode: 'reply' | 'reply_all',
    ) {
      const fromAddr = card.fromAddress

      if (mode === 'reply') {
        this.toList = [fromAddr]
        this.ccList = []
      } else {
        // Reply All
        this.toList = [fromAddr]
        const ccs: string[] = []

        // Add remaining 'To' recipients (excluding sender)
        if (card.to) {
          for (const t of card.to) {
            if (
              t.address &&
              t.address.toLowerCase() !== fromAddr.toLowerCase()
            ) {
              if (!ccs.includes(t.address)) ccs.push(t.address)
            }
          }
        }
        // Add 'Cc' recipients
        if (card.cc) {
          for (const c of card.cc) {
            if (
              c.address &&
              c.address.toLowerCase() !== fromAddr.toLowerCase()
            ) {
              if (!ccs.includes(c.address)) ccs.push(c.address)
            }
          }
        }
        this.ccList = ccs
        if (ccs.length > 0) this.showCc = true
      }
    },
    onReplyModeChanged(newMode: 'reply' | 'reply_all') {
      const selected = this.activeReplyCard || this.latestEmail
      if (selected) this.populateRecipientsForCard(selected, newMode)
    },
    prepareReply(card: ParsedEmailCard, mode: 'reply' | 'reply_all') {
      this.activeReplyCard = card
      this.replyMode = mode
      this.populateRecipientsForCard(card, mode)

      let subj = card.subject || this.threadSubject
      if (!/^re:/i.test(subj)) {
        subj = `Re: ${subj}`
      }
      this.subject = subj
      this.activeInReplyTo = card.rawEmail?.messageId
      this.activeReferences = card.rawEmail?.references
        ? [...card.rawEmail.references, card.rawEmail.messageId]
        : card.rawEmail?.messageId
        ? [card.rawEmail.messageId]
        : undefined

      // Standard email convention: insert bottom quote with cursor at top
      this.insertOriginalQuote(card)

      // Expand card and scroll to composer
      this.expandedMap[card.id] = true
    },
    pageStyleFn(offset: number, height: number) {
      return {
        height: `${height - offset}px`,
        maxHeight: `${height - offset}px`,
      }
    },
    formatMessageBody(text: string): string {
      if (!text) return ''
      return purify(renderMarkdown(text, this.$q.dark.isActive))
    },
    getTextareaElement(): HTMLTextAreaElement | null {
      const inputComp = this.$refs.bodyInputRef as
        | { $el?: HTMLElement; nativeEl?: HTMLTextAreaElement }
        | undefined
      if (inputComp?.nativeEl) return inputComp.nativeEl
      return (
        (inputComp?.$el?.querySelector('textarea') as HTMLTextAreaElement) ||
        null
      )
    },
    applyFormat(action: MarkdownFormatAction) {
      if (this.isPreviewMode) {
        this.isPreviewMode = false
      }
      const textarea = this.getTextareaElement()
      const start = textarea?.selectionStart ?? this.replyText.length
      const end = textarea?.selectionEnd ?? this.replyText.length
      const res = applyMarkdownFormat(this.replyText, start, end, action)
      this.replyText = res.text
      this.$nextTick(() => {
        if (textarea && typeof textarea.focus === 'function') {
          textarea.focus()
          if (typeof textarea.setSelectionRange === 'function') {
            textarea.setSelectionRange(res.selectionStart, res.selectionEnd)
          }
        }
      })
    },
    insertOriginalQuote(card: ParsedEmailCard) {
      const quoteHeader = `On ${card.formattedDate || 'earlier'}, ${
        card.fromName || card.fromAddress
      } wrote:`
      const quotedBody = (card.textBody || '')
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n')
      const quoteBlock = `\n\n${quoteHeader}\n${quotedBody}\n`

      if (!this.replyText || this.replyText.trim() === '') {
        this.replyText = quoteBlock
        this.$nextTick(() => {
          const textarea = this.getTextareaElement()
          if (textarea && typeof textarea.setSelectionRange === 'function') {
            textarea.focus()
            textarea.setSelectionRange(0, 0)
          }
        })
      } else {
        this.replyText = `${this.replyText.trimEnd()}${quoteBlock}`
      }
    },
    addToRecipient() {
      const val = this.newToInput.trim()
      if (val && !this.toList.includes(val)) {
        this.toList.push(val)
      }
      this.newToInput = ''
    },
    removeToRecipient(index: number) {
      this.toList.splice(index, 1)
    },
    addCcRecipient() {
      const val = this.newCcInput.trim()
      if (val && !this.ccList.includes(val)) {
        this.ccList.push(val)
      }
      this.newCcInput = ''
    },
    removeCcRecipient(index: number) {
      this.ccList.splice(index, 1)
    },
    addBccRecipient() {
      const val = this.newBccInput.trim()
      if (val && !this.bccList.includes(val)) {
        this.bccList.push(val)
      }
      this.newBccInput = ''
    },
    removeBccRecipient(index: number) {
      this.bccList.splice(index, 1)
    },
    handleRecipientKeydown(event: KeyboardEvent, field: 'to' | 'cc' | 'bcc') {
      if (event.key === ',' || event.key === ';' || event.key === ' ') {
        event.preventDefault()
        if (field === 'to') this.addToRecipient()
        else if (field === 'cc') this.addCcRecipient()
        else if (field === 'bcc') this.addBccRecipient()
      }
    },
    isHtmlView(id: string): boolean {
      return !!this.htmlViewMap[id]
    },
    toggleHtmlView(id: string) {
      this.htmlViewMap[id] = !this.htmlViewMap[id]
    },
    sanitizedHtml(html?: string): string {
      if (!html) return ''
      return purify(html)
    },
    triggerFileInput() {
      const input = this.$refs.fileInput as HTMLInputElement | undefined
      input?.click?.()
    },
    handleFilesSelected(event: Event) {
      const target = event.target as HTMLInputElement
      if (target?.files && target.files.length > 0) {
        const files = Array.from(target.files)
        this.stagedFiles.push(...files)
        target.value = ''
      }
    },
    removeStagedFile(index: number) {
      this.stagedFiles.splice(index, 1)
    },
    async readFileAsBase64(file: File): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          resolve(typeof reader.result === 'string' ? reader.result : '')
        }
        reader.onerror = err => reject(err)
        if (typeof reader.readAsDataURL === 'function') {
          reader.readAsDataURL(file)
        } else if (typeof (file as any).arrayBuffer === 'function') {
          ;(file as any)
            .arrayBuffer()
            .then((buf: ArrayBuffer) => {
              let binary = ''
              const bytes = new Uint8Array(buf)
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i])
              }
              resolve(
                `data:${file.type || 'application/octet-stream'};base64,${btoa(
                  binary,
                )}`,
              )
            })
            .catch(reject)
        } else {
          resolve('')
        }
      })
    },
    async handleSend() {
      const conversationId = this.conversation?.id
      if (
        !conversationId ||
        !this.canSend ||
        this.sending ||
        this.preparingSend
      )
        return
      if (this.newToInput.trim()) this.addToRecipient()
      if (this.newCcInput.trim()) this.addCcRecipient()
      if (this.newBccInput.trim()) this.addBccRecipient()

      const emailSubject =
        this.subject || (this.isDraft ? 'No Subject' : this.threadSubject)
      const body = this.replyText
      const emailItem: EmailItem = {
        type: 'email',
        messageId: `<frank_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 9)}@frank.org>`,
        from: { address: 'me' },
        to: this.toList.map(address => ({ address })),
        cc: this.ccList.length
          ? this.ccList.map(address => ({ address }))
          : undefined,
        bcc: this.bccList.length
          ? this.bccList.map(address => ({ address }))
          : undefined,
        subject: emailSubject,
        textBody: body,
        inReplyTo: this.activeInReplyTo,
        references: this.activeReferences
          ? [...this.activeReferences]
          : undefined,
      }
      const isGatewayRoute =
        this.isVerifiedGateway || this.replyRouting === 'gateway'
      const targetAddress =
        !this.isVerifiedGateway && this.replyRouting === 'gateway'
          ? this.emailGatewayAddress
          : undefined
      const fallbackText = isGatewayRoute
        ? `[Email to ${this.toList.join(
            ', ',
          )}]\nSubject: ${emailSubject}\n\n${body}`
        : `[Direct P2P Email to ${this.peerFrankAddress} (external email recipients not notified)]\nSubject: ${emailSubject}\n\n${body}`
      const files = [...this.stagedFiles]
      this.preparingSend = true
      try {
        if (files.length) {
          emailItem.attachments = await Promise.all(
            files.map(async file => ({
              filename: file.name,
              contentType: file.type || 'application/octet-stream',
              size: file.size,
              sizeBytes: file.size,
              dataBase64: await this.readFileAsBase64(file),
            })),
          )
        }
        if (!this.composerActive || this.conversation?.id !== conversationId)
          return
        this.$emit('sendReply', {
          conversationId,
          items: [emailItem, { type: 'text', text: fallbackText }],
          fallbackText,
          targetAddress,
        })
        this.replyText = ''
        this.stagedFiles = []
        this.isPreviewMode = false
      } finally {
        this.preparingSend = false
      }
    },
  },
})
</script>

<style scoped>
.email-thread-page {
  background-color: var(--q-page-background, #f5f6f8);
  height: 100%;
  max-height: 100%;
  overflow: hidden;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
}

.email-thread-header {
  background-color: var(--q-card-background, #ffffff);
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  z-index: 10;
  flex-shrink: 0;
}

.email-card {
  border-radius: 8px;
  background-color: #ffffff;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.body--dark .email-card {
  background-color: #1e1e1e;
}

.email-card-header {
  min-height: 56px;
  user-select: none;
}

.email-body-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}

.email-composer-dock {
  background-color: var(--q-card-background, #ffffff);
  border-top: 1px solid rgba(0, 0, 0, 0.12);
  z-index: 20;
  flex-shrink: 0;
}

.body--dark .email-composer-dock {
  background-color: #181818;
}

.formatting-toolbar {
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  padding-bottom: 4px;
}

.email-body-preview {
  min-height: 80px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid rgba(0, 0, 0, 0.12);
  line-height: 1.5;
}

.input-inline {
  min-width: 120px;
}

.email-html-frame {
  width: 100%;
  min-height: 240px;
  border: none;
  background-color: transparent;
  display: block;
}
</style>
