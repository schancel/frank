<template>
  <q-page class="email-thread-page column no-wrap full-height relative-position" data-testid="email-thread-view">
    <!-- Thread Header Banner -->
    <div class="email-thread-header q-px-lg q-py-md shadow-1">
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
            {{ $t('emailThread.gatewayBadge', '✉️ Email Bridge (via Frank Gateway)') }}
          </q-badge>
          <q-badge
            v-else
            color="warning"
            outline
            class="q-px-sm q-py-xs text-caption text-weight-medium bg-amber-1 text-amber-10"
            data-testid="unverified-p2p-badge"
          >
            <q-icon name="warning" size="14px" class="q-mr-xs text-warning" />
            {{ $t('emailThread.unverifiedBadge', '⚠️ Direct P2P Email (Unverified)') }}
          </q-badge>
          <q-btn
            flat
            dense
            round
            size="sm"
            :icon="allExpanded ? 'unfold_less' : 'unfold_more'"
            :aria-label="allExpanded ? 'Collapse all' : 'Expand all'"
            @click="toggleAllExpanded"
          >
            <q-tooltip>{{ allExpanded ? 'Collapse All' : 'Expand All' }}</q-tooltip>
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
        <template v-slot:avatar>
          <q-icon name="warning" color="warning" size="18px" />
        </template>
        <span>
          ⚠️ Direct Peer Email Frame: This message was sent directly by Frank user {{ peerFrankAddress }} (not an Email Gateway). External email recipients will not receive replies.
        </span>
      </q-banner>

      <!-- Participants summary -->
      <div class="row items-center text-caption text-grey-7 q-gutter-x-sm ellipsis" v-if="allParticipants.length > 0">
        <span class="text-weight-medium">{{ $t('emailThread.participants', 'Participants') }}:</span>
        <span class="ellipsis">{{ allParticipants.join(', ') }}</span>
        <q-badge color="grey-5" text-color="black" class="text-caption">
          {{ parsedEmails.length }} {{ parsedEmails.length === 1 ? 'message' : 'messages' }}
        </q-badge>
      </div>
    </div>

    <!-- Scrollable Email Message Cards Area -->
    <div class="col relative-position">
      <q-scroll-area
        ref="emailScroll"
        class="q-px-none absolute full-width full-height column"
        :content-style="{ padding: '16px 24px 180px 24px' }"
      >
        <div class="email-cards-container">
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
                :class="{ 'bg-grey-1': !isExpanded(card.id) && !$q.dark.isActive, 'bg-grey-9': !isExpanded(card.id) && $q.dark.isActive }"
              >
                <q-item-section avatar top>
                  <q-avatar size="36px" color="primary" text-color="white">
                    <span class="text-weight-bold">{{ getInitials(card.fromName || card.fromAddress) }}</span>
                  </q-avatar>
                </q-item-section>

                <q-item-section>
                  <div class="row items-center justify-between no-wrap">
                    <div class="row items-center no-wrap ellipsis col">
                      <span class="text-weight-bold text-body2 q-mr-xs ellipsis">
                        {{ card.fromName || card.fromAddress }}
                      </span>
                      <span class="text-caption text-grey-6 ellipsis q-mr-xs" v-if="card.fromName">
                        &lt;{{ card.fromAddress }}&gt;
                      </span>
                      <q-badge
                        v-if="isVerifiedGateway && card.isDkimVerified"
                        color="positive"
                        outline
                        class="text-caption q-px-xs q-ml-xs"
                        data-testid="dkim-badge"
                      >
                        <q-icon name="verified_user" size="12px" class="q-mr-xs text-positive" />
                        DKIM
                      </q-badge>
                    </div>
                    <div class="text-caption text-grey-6 text-no-wrap q-ml-sm">
                      {{ card.formattedDate }}
                    </div>
                  </div>

                  <!-- Collapsed summary preview -->
                  <div class="row items-center justify-between text-caption text-grey-7 no-wrap" v-if="!isExpanded(card.id)">
                    <span class="ellipsis col text-grey-8">
                      {{ card.snippet }}
                    </span>
                    <span class="col-auto q-ml-sm" v-if="card.attachments && card.attachments.length > 0">
                      <q-icon name="attach_file" size="14px" />
                      {{ card.attachments.length }}
                    </span>
                  </div>

                  <!-- Expanded Recipient Details -->
                  <div class="text-caption text-grey-6" v-else>
                    <div>
                      <span class="text-weight-medium">To:</span> {{ formatParties(card.to) }}
                    </div>
                    <div v-if="card.cc && card.cc.length > 0">
                      <span class="text-weight-medium">Cc:</span> {{ formatParties(card.cc) }}
                    </div>
                  </div>
                </q-item-section>

                <q-item-section side>
                  <q-icon :name="isExpanded(card.id) ? 'expand_less' : 'expand_more'" />
                </q-item-section>
              </q-item>

              <!-- Card Body (Shown when Expanded) -->
              <q-slide-transition>
                <div v-show="isExpanded(card.id)">
                  <q-separator />
                  <q-card-section class="q-py-md email-card-body">
                    <!-- Text Body -->
                    <div class="email-body-text text-body1">
                      {{ card.textBody }}
                    </div>

                    <!-- Attachments -->
                    <div v-if="card.attachments && card.attachments.length > 0" class="q-mt-md">
                      <q-separator class="q-mb-sm" />
                      <div class="text-caption text-weight-bold text-grey-7 q-mb-xs">
                        Attachments ({{ card.attachments.length }}):
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
                          <span class="text-weight-medium q-mr-xs">{{ att.filename }}</span>
                          <span class="text-grey-6">({{ formatBytes(att.sizeBytes) }})</span>
                        </q-chip>
                      </div>
                    </div>
                  </q-card-section>

                  <!-- Card Action Footer -->
                  <q-separator />
                  <q-card-actions align="right" class="q-px-md q-py-xs bg-grey-1" :class="{ 'bg-grey-10': $q.dark.isActive }">
                    <q-btn
                      flat
                      dense
                      size="sm"
                      icon="reply"
                      label="Reply"
                      @click.stop="prepareReply(card, 'reply')"
                    />
                    <q-btn
                      flat
                      dense
                      size="sm"
                      icon="reply_all"
                      label="Reply All"
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
    <div class="email-composer-dock shadow-4 q-px-lg q-py-md">
      <!-- Unverified Peer Composer Warning Notice -->
      <div
        v-if="!isVerifiedGateway"
        class="composer-warning-banner q-mb-sm q-px-sm q-py-xs bg-amber-1 text-amber-10 rounded-borders text-caption row items-center no-wrap"
        data-testid="composer-unverified-warning"
      >
        <q-icon name="warning" size="16px" class="q-mr-xs text-warning col-auto" />
        <span class="col">
          <b>P2P Direct Reply:</b> Replies in this thread are delivered directly to Frank peer <code>{{ peerFrankAddress }}</code> only. External email recipients in To/Cc will not receive replies via MX.
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
          <q-btn-toggle
            v-model="replyMode"
            dense
            rounded
            toggle-color="primary"
            color="grey-4"
            text-color="grey-8"
            size="sm"
            :options="[
              { label: 'Reply All', value: 'reply_all' },
              { label: 'Reply Sender', value: 'reply' },
            ]"
            @update:model-value="onReplyModeChanged"
          />
          <q-btn
            flat
            dense
            size="sm"
            :label="showCc ? '- Cc' : '+ Cc'"
            color="primary"
            @click="showCc = !showCc"
          />
        </div>
        <div class="text-caption text-grey-6" v-if="stampStatus">
          {{ stampStatus }}
        </div>
      </div>

      <!-- Recipient To Field -->
      <div class="row items-center q-mb-xs">
        <span class="col-auto text-caption text-weight-bold text-grey-7 q-mr-sm" style="width: 32px">To:</span>
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
            v-model="newToInput"
            dense
            borderless
            placeholder="Add recipient..."
            class="col text-caption input-inline"
            @keydown.enter.prevent="addToRecipient"
            @keydown="handleRecipientKeydown($event, 'to')"
          />
        </div>
      </div>

      <!-- Recipient Cc Field -->
      <div class="row items-center q-mb-xs" v-if="showCc || ccList.length > 0">
        <span class="col-auto text-caption text-weight-bold text-grey-7 q-mr-sm" style="width: 32px">Cc:</span>
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
            v-model="newCcInput"
            dense
            borderless
            placeholder="Add Cc recipient..."
            class="col text-caption input-inline"
            @keydown.enter.prevent="addCcRecipient"
            @keydown="handleRecipientKeydown($event, 'cc')"
          />
        </div>
      </div>

      <!-- Subject Field -->
      <div class="row items-center q-mb-sm">
        <span class="col-auto text-caption text-weight-bold text-grey-7 q-mr-sm" style="width: 32px">Sub:</span>
        <q-input
          v-model="subject"
          dense
          outlined
          placeholder="Subject"
          class="col text-caption"
        />
      </div>

      <!-- Message Textarea & Send Bar -->
      <div class="row items-end q-col-gutter-sm">
        <div class="col">
          <q-input
            v-model="replyText"
            type="textarea"
            autogrow
            :rows="3"
            outlined
            dense
            placeholder="Write your email reply..."
            class="email-textarea"
            :disable="sending"
            @keydown.ctrl.enter="handleSend"
            @keydown.meta.enter="handleSend"
          />
        </div>
        <div class="col-auto">
          <q-btn
            :color="isVerifiedGateway ? 'primary' : replyRouting === 'gateway' ? 'secondary' : 'warning'"
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
import type { EmailItem, EmailParty, EmailAttachment, MessageItem } from '@frank/cashweb/types/messages'
import { formatConversationTimestamp } from 'src/utils/formatting'
import { defaultEmailGatewayAddress } from 'src/utils/constants'

interface ParsedEmailCard {
  id: string
  fromAddress: string
  fromName?: string
  to: EmailParty[]
  cc?: EmailParty[]
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
  emits: ['sendReply'],
  data() {
    return {
      replyRouting: 'peer' as 'peer' | 'gateway',
      expandedMap: {} as Record<string, boolean>,
      allExpanded: false,
      replyMode: 'reply_all' as 'reply' | 'reply_all',
      showCc: false,
      toList: [] as string[],
      ccList: [] as string[],
      newToInput: '',
      newCcInput: '',
      subject: '',
      replyText: '',
      activeInReplyTo: undefined as string | undefined,
      activeReferences: undefined as string[] | undefined,
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
      return defaultEmailGatewayAddress
    },
    parsedEmails(): ParsedEmailCard[] {
      const cards: ParsedEmailCard[] = []
      for (const msg of this.messages) {
        const emailItem = msg.items?.find(it => it.type === 'email') as EmailItem | undefined
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
          const textItem = msg.items?.find(it => it.type === 'text') as { text?: string } | undefined
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
    threadSubject(): string {
      if (this.conversation?.name) {
        return this.conversation.name
      }
      for (let i = this.parsedEmails.length - 1; i >= 0; i--) {
        const sub = this.parsedEmails[i].subject
        if (sub && sub !== 'No Subject') return sub
      }
      return 'Email Thread'
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
      return Array.from(set)
    },
    canSend(): boolean {
      return this.replyText.trim().length > 0 && this.toList.length > 0
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
        }
      },
    },
  },
  methods: {
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
      const hasMultiple = this.canReplyAll(card)
      this.replyMode = hasMultiple ? 'reply_all' : 'reply'
      this.populateRecipientsForCard(card, this.replyMode)

      let subj = card.subject || this.threadSubject
      if (!/^re:/i.test(subj)) {
        subj = `Re: ${subj}`
      }
      this.subject = subj
      this.activeInReplyTo = card.rawEmail?.messageId || card.id
      this.activeReferences = card.rawEmail?.references
        ? [...card.rawEmail.references, card.rawEmail.messageId]
        : card.rawEmail?.messageId
        ? [card.rawEmail.messageId]
        : undefined
    },
    populateRecipientsForCard(card: ParsedEmailCard, mode: 'reply' | 'reply_all') {
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
            if (t.address && t.address.toLowerCase() !== fromAddr.toLowerCase()) {
              if (!ccs.includes(t.address)) ccs.push(t.address)
            }
          }
        }
        // Add 'Cc' recipients
        if (card.cc) {
          for (const c of card.cc) {
            if (c.address && c.address.toLowerCase() !== fromAddr.toLowerCase()) {
              if (!ccs.includes(c.address)) ccs.push(c.address)
            }
          }
        }
        this.ccList = ccs
        if (ccs.length > 0) this.showCc = true
      }
    },
    onReplyModeChanged(newMode: 'reply' | 'reply_all') {
      if (this.latestEmail) {
        this.populateRecipientsForCard(this.latestEmail, newMode)
      }
    },
    prepareReply(card: ParsedEmailCard, mode: 'reply' | 'reply_all') {
      this.replyMode = mode
      this.populateRecipientsForCard(card, mode)

      let subj = card.subject || this.threadSubject
      if (!/^re:/i.test(subj)) {
        subj = `Re: ${subj}`
      }
      this.subject = subj
      this.activeInReplyTo = card.rawEmail?.messageId || card.id
      this.activeReferences = card.rawEmail?.references
        ? [...card.rawEmail.references, card.rawEmail.messageId]
        : card.rawEmail?.messageId
        ? [card.rawEmail.messageId]
        : undefined

      // Expand card and scroll to composer
      this.expandedMap[card.id] = true
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
    handleRecipientKeydown(event: KeyboardEvent, field: 'to' | 'cc') {
      if (event.key === ',' || event.key === ';' || event.key === ' ') {
        event.preventDefault()
        if (field === 'to') this.addToRecipient()
        else this.addCcRecipient()
      }
    },
    handleSend() {
      if (!this.canSend || this.sending) return

      // Flush any pending text in input fields
      if (this.newToInput.trim()) this.addToRecipient()
      if (this.newCcInput.trim()) this.addCcRecipient()

      const toParties: EmailParty[] = this.toList.map(addr => ({ address: addr }))
      const ccParties: EmailParty[] = this.ccList.map(addr => ({ address: addr }))

      const emailItem: EmailItem = {
        type: 'email',
        messageId: `<frank_${Date.now()}_${Math.random().toString(36).slice(2, 9)}@frank.org>`,
        from: { address: 'me' },
        to: toParties,
        cc: ccParties.length > 0 ? ccParties : undefined,
        subject: this.subject || this.threadSubject,
        textBody: this.replyText,
        inReplyTo: this.activeInReplyTo,
        references: this.activeReferences,
      }

      const isGatewayRoute =
        this.isVerifiedGateway || this.replyRouting === 'gateway'
      const targetAddress =
        !this.isVerifiedGateway && this.replyRouting === 'gateway'
          ? this.emailGatewayAddress
          : undefined

      const fallbackText = isGatewayRoute
        ? `[Email to ${this.toList.join(', ')}]\nSubject: ${this.subject}\n\n${this.replyText}`
        : `[Direct P2P Email to ${this.peerFrankAddress} (external email recipients not notified)]\nSubject: ${this.subject}\n\n${this.replyText}`

      const items: MessageItem[] = [
        emailItem,
        {
          type: 'text',
          text: fallbackText,
        },
      ]

      this.$emit('sendReply', {
        items,
        fallbackText,
        targetAddress,
      })

      // Clear text
      this.replyText = ''
    },
  },
})
</script>

<style scoped>
.email-thread-page {
  background-color: var(--q-page-background, #f5f6f8);
}

.email-thread-header {
  background-color: var(--q-card-background, #ffffff);
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  z-index: 10;
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
}

.body--dark .email-composer-dock {
  background-color: #181818;
}

.input-inline {
  min-width: 120px;
}
</style>
