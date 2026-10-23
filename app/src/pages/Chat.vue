<template>
  <div class="chat-container column full-height overflow-hidden">
    <q-banner
      v-if="
        conversation?.kind === 'group' &&
        conversation.membershipStatus === 'invited'
      "
      class="q-pa-md"
      data-testid="group-invite-banner"
    >
      {{ $t('groupChat.inviteBannerTitle', { name: conversation.name }) }}
      <div class="text-caption">
        {{
          $t('groupChat.inviteBannerSubtitle', {
            epoch: conversation.groupState?.epoch ?? 0,
            relay:
              conversation.groupState?.homeRelay ?? conversation.groupRelayUrl,
          })
        }}
      </div>
      <template #action>
        <q-btn
          color="primary"
          :label="$t('groupChat.acceptInviteBtn')"
          data-testid="accept-group-invite"
          @click="decideGroupInvite(true)"
        />
        <q-btn
          flat
          :label="$t('groupChat.declineInviteBtn')"
          data-testid="decline-group-invite"
          @click="decideGroupInvite(false)"
        />
      </template>
    </q-banner>
    <q-banner
      v-if="
        conversation?.kind === 'group' &&
        conversation.membershipStatus === 'joined' &&
        (conversation.groupState?.syncFailed ||
          conversation.groupState?.pendingEpoch)
      "
      class="q-pa-sm"
      data-testid="group-sync-failure"
      role="status"
    >
      {{
        conversation.groupState?.pendingEpoch
          ? $t('groupChat.epochPending')
          : $t('groupChat.syncFailed')
      }}
      <template #action
        ><q-btn
          flat
          :label="$t('groupChat.retryUpdates')"
          data-testid="retry-group-updates"
          @click="retryGroupUpdates"
      /></template>
    </q-banner>
    <q-banner
      v-if="
        conversation?.kind === 'group' &&
        conversation.membershipStatus === 'joined' &&
        conversation.groupState?.supersededMemberChange
      "
      class="q-pa-sm"
      data-testid="group-member-change-superseded"
      role="alert"
    >
      {{
        $t(
          conversation.groupState.supersededMemberChange.action === 'add-member'
            ? 'groupChat.memberAddSuperseded'
            : 'groupChat.memberRemoveSuperseded',
          {
            member: shortAddress(
              conversation.groupState.supersededMemberChange.address,
            ),
          },
        )
      }}
      <template #action
        ><q-btn
          flat
          :label="$t('groupChat.retryMemberChange')"
          data-testid="retry-group-member-change"
          @click="retrySupersededMemberChange" /><q-btn
          flat
          :label="$t('groupChat.dismissMemberChange')"
          data-testid="dismiss-group-member-change"
          @click="dismissSupersededMemberChange"
      /></template>
    </q-banner>
    <q-banner
      v-for="request in participantRequests"
      :key="request.senderAddress"
      data-testid="participant-request-banner"
      class="q-pa-sm"
    >
      {{
        $t('groupChat.participantRequest', {
          address: shortAddress(request.senderAddress),
        })
      }}
      <template #action>
        <q-btn
          flat
          :label="$t('groupChat.viewDirect')"
          data-testid="participant-request-view"
          @click="viewParticipantRequest(request.senderConversationId)"
        />
        <q-btn
          flat
          :label="$t('groupChat.createGroupBtn')"
          data-testid="participant-request-group"
          @click="createGroupFromRequest(request.senderAddress)"
        />
        <q-btn
          flat
          :label="$t('groupChat.dismissRequest')"
          data-testid="participant-request-dismiss"
          @click="
            chatStore.dismissPendingParticipantRequest(
              conversation.id,
              request.senderAddress,
            )
          "
        />
      </template>
    </q-banner>
    <!-- Tollbooth Screener Triage Banner for Inbound Paid-Stranger Requests -->
    <div
      v-if="isScreenerThread"
      class="screener-triage-banner q-px-md q-py-sm row items-center justify-between q-gutter-xs"
      data-test="screener-triage-banner"
      data-testid="screener-triage-banner"
    >
      <div class="row items-center no-wrap col">
        <span
          class="text-caption text-weight-medium"
          data-test="screener-stamp-summary"
        >
          {{
            $t('chatList.screenerBannerTitle', {
              value: screenerStampSummary.combinedDisplay,
            })
          }}
        </span>
      </div>
      <div class="row items-center q-gutter-xs col-auto">
        <q-btn
          dense
          unelevated
          no-caps
          size="sm"
          color="positive"
          :label="$t('chatList.screenerApprove')"
          data-test="screener-approve"
          data-testid="screener-approve"
          @click="approveScreenerThread"
        />
        <q-btn
          dense
          outline
          no-caps
          size="sm"
          color="primary"
          :label="$t('chatList.screenerReplyOnce')"
          data-test="screener-reply"
          data-testid="screener-reply"
          @click="replyOnceScreenerThread"
        />
        <q-btn
          dense
          flat
          no-caps
          size="sm"
          color="negative"
          :label="$t('chatList.screenerDismissKeepStamp')"
          data-test="screener-dismiss"
          data-testid="screener-dismiss"
          @click="dismissScreenerThread"
        />
      </div>
    </div>
    <q-page-container class="col full-height overflow-hidden">
      <email-thread-view
        v-if="isEmailThread"
        ref="emailThreadView"
        :key="conversation?.id"
        :conversation="conversation"
        :messages="messages"
        :sending="sendingMessage"
        :stamp-status="stampPreparationStatus"
        :recipient-address="recipientAddress"
        v-model:stamp-amount="stampAmount"
        :minimum-stamp-wei="minimumStampWei"
        :default-stamp-wei="defaultStampWei"
        :available-balance-wei="availableBalanceWei"
        :stamp-basis-note="defaultStampBasisNote"
        :default-stamp-mode="isDefaultStampMode"
        :stamp-unavailable="stampUnavailable"
        @resetStampDefault="resetStampDefault"
        @sendReply="sendEmailReply"
        @navigateThread="navigateEmailThread"
        @archiveThread="archiveCurrentThread"
      />
      <article-reader-pane
        v-else-if="activeReaderArticle"
        :article="activeReaderArticle"
        @close="closeArticleReader"
      />
      <q-page v-else class="chat-page-background column no-wrap">
        <div class="col relative-position">
          <q-scroll-area
            ref="chatScroll"
            @scroll="scrollHandler"
            class="q-px-none absolute full-width full-height column"
          >
            <!-- Clearance tracks the overlay height so a wrapped banner cannot cover the
            oldest bubble. q-py-md is the gap when the overlay is empty. -->
            <div
              class="chat-message-list row q-px-lg q-py-md"
              :style="bannerClearanceStyle"
            >
              <!-- A bubble can grow after it arrived (a blackjack hand renders its result a
              moment later); a view that was following the newest message stays on it. -->
              <q-resize-observer @resize="onMessageListResize" />
              <template
                v-for="(msg, index) in chunkedMessages"
                :key="msg.payloadDigest"
              >
                <chat-message-component
                  :index="index"
                  :message="msg"
                  :address="recipientAddress"
                  :name="messageSenderName(msg, index)"
                  :attribution="attributions[index]"
                  :chat-width="chatWidth"
                  :payload-digest="msg.payloadDigest"
                  :style="messageScrollMarginStyle"
                  :ref="msg.payloadDigest"
                  :focus-after-retry="focusComposerAfterRetry"
                  @replyClicked="({ payloadDigest }) => setReply(payloadDigest)"
                  @forwardClicked="handleForwardClicked"
                  @replyDivClick="scrollToMessage"
                  @sendFollowUp="sendFollowUpItems"
                  @openReader="openArticleReader"
                  @playAgain="blackjackDialog = true"
                  @senderClicked="openSenderProfile"
                />
              </template>
            </div>
          </q-scroll-area>
          <!-- Overlaying the bounded viewport keeps banner changes from resizing the scroll box. -->
          <div
            class="chat-banner-overlay absolute-top full-width no-pointer-events"
            :class="{ 'shadow-2': bannerClearance > 0 }"
          >
            <q-resize-observer @resize="onBannerResize" />
            <chat-banner-stack :stamp-status="stampPreparationStatus" />
          </div>
          <div
            v-if="detachedActiveCallController"
            class="chat-floating-webrtc-call"
            data-testid="chat-floating-webrtc-call"
          >
            <chat-message-web-rtc-call
              :controller="detachedActiveCallController"
              :address="detachedActiveCallController.getRemotePeerId()"
              :cleanup-on-unmount="false"
              @sendFollowUp="sendDetachedCallFollowUp"
            />
          </div>
        </div>
        <q-page-sticky
          position="bottom-right"
          :offset="[18, 18]"
          v-show="!bottom"
        >
          <q-btn
            round
            size="md"
            icon="arrow_downward"
            :aria-label="$t('a11y.scrollToLatest')"
            @mousedown.prevent="buttonScrollBottom"
            color="accent"
          />
        </q-page-sticky>
        <q-inner-loading
          :dark="$q.dark.isActive"
          :showing="!!scrollDigest"
          size="md"
          label="Loading more messages..."
        />
      </q-page>
    </q-page-container>
    <q-footer
      v-if="
        !isEmailThread &&
        !activeReaderArticle &&
        (conversation?.kind !== 'group' ||
          conversation.membershipStatus === 'joined')
      "
      bordered
      :height-hint="64"
      class="chat-footer chat-input-bar"
    >
      <div v-if="!!replyDigest" class="q-px-md q-pt-sm" ref="replyBox">
        <!-- Reply box -->
        <div class="row justify-end">
          <div class="col-auto">
            <q-btn
              dense
              flat
              color="accent"
              icon="close"
              :aria-label="$t('a11y.cancelReply')"
              @click="setReply(null)"
            />
          </div>
        </div>
        <div class="row q-px-sm q-pt-sm">
          <div class="col-12">
            <chat-message-reply :payload-digest="replyDigest" />
          </div>
        </div>
      </div>
      <!-- Others have posted into this conversation, but what is sent from here still goes to
      its one peer. Say so, so a reply is not taken for a message to everyone. -->
      <div
        v-if="isGroup && conversation?.kind !== 'group'"
        class="q-px-md q-pt-xs text-caption chat-group-recipient"
        data-testid="chat-group-recipient"
        role="note"
      >
        <q-icon name="info" size="14px" class="q-mr-xs" />{{
          recipientIsSelf
            ? $t('chat.groupRecipientNoticeSelf')
            : $t('chat.groupRecipientNotice', { name: recipientName })
        }}
      </div>
      <!-- Inline expandable composer/action sheet (replaces modal dialogs) -->
      <div
        v-if="
          blackjackDialog ||
          rpsDialog ||
          articleDialog ||
          invoiceDialog ||
          stealthDialog ||
          swapDialog ||
          (forwardDialogOpen && messageToForward)
        "
        class="chat-inline-sheet q-pa-sm"
        data-testid="chat-inline-sheet"
      >
        <q-card
          v-if="blackjackDialog"
          data-testid="blackjack-dialog"
          class="chat-inline-sheet-card"
        >
          <blackjack-challenge-form
            :busy="sendingMessage || blackjackPreparing"
            @submit="sendBlackjackChallenge"
            @cancel="cancelBlackjackPreparation"
          />
        </q-card>
        <q-card
          v-if="rpsDialog"
          data-testid="rps-dialog"
          class="chat-inline-sheet-card"
        >
          <rps-challenge-form
            :busy="sendingMessage"
            @submit="sendRpsChallenge"
            @cancel="rpsDialog = false"
          />
        </q-card>
        <article-compose-form
          v-if="articleDialog"
          :initial-author-name="getProfile.profile?.name || ''"
          @send="sendArticle"
          @cancel="articleDialog = false"
        />
        <q-card
          v-if="invoiceDialog"
          data-testid="invoice-dialog"
          class="chat-inline-sheet-card"
        >
          <invoice-compose-form
            :payee-identity="ownAddress"
            :receive-address="ownAddress"
            :chain-key="activeChainKey"
            :network-id="activeNetworkId"
            :native-symbol="activeNativeSymbol"
            :native-decimals="activeNativeDecimals"
            :busy="sendingMessage"
            @submit="sendInvoice"
            @cancel="invoiceDialog = false"
          />
        </q-card>
        <send-stealth-dialog
          v-if="stealthDialog"
          :contact="contact"
          :address="recipientAddress"
          :busy="sendingMessage"
          :options="stealthAssets"
          :quote="stealthQuote"
          @review="reviewStealthPayment"
          @send="sendStealthPayment"
          @cancel="stealthDialog = false"
        />
        <offer-swap-dialog
          v-if="swapDialog"
          :contact="contact"
          :address="recipientAddress"
          :conversation-id="conversation?.id || ''"
          :conversation-name="conversation?.name || conversation?.topic || ''"
          :swap-id="swapId"
          :stamp-value="swapStampValue"
          :stamp-unavailable="stampUnavailable"
          @newOffer="swapId = newSwapId()"
          @close="swapDialog = false"
        />
        <forward-message-dialog
          v-if="forwardDialogOpen && messageToForward"
          :message="messageToForward"
          @forward="handleForwardToContact"
          @close="forwardDialogOpen = false"
        />
      </div>
      <!-- Message box -->
      <chat-input
        :group-mode="conversation?.kind === 'group'"
        @giveLotusClicked="$emit('giveLotusClicked')"
        @blackjackClicked="blackjackDialog = true"
        @mentalPokerClicked="sendMentalPokerChallenge"
        @diceClicked="sendDiceChallenge"
        @rpsClicked="rpsDialog = true"
        @articleClicked="articleDialog = true"
        @invoiceClicked="invoiceDialog = true"
        @sendStealthClicked="openStealthDialog"
        @swapClicked="openSwapDialog"
        @webrtcCallClicked="sendWebRtcCallInvite"
        ref="chatInput"
        v-model:message="message"
        v-model:attachments="attachments"
        v-model:stamp-amount="stampAmount"
        :minimum-stamp-wei="minimumStampWei"
        :default-stamp-wei="defaultStampWei"
        :suggested-stamp-wei="suggestedStampWei"
        :last-peer-stamp-wei="lastPeerStampWei"
        :suggested-increase="isSuggestedIncrease"
        :stamp-basis-note="defaultStampBasisNote"
        :default-stamp-mode="isDefaultStampMode"
        :stamp-unavailable="stampUnavailable"
        :stamp-unavailable-pending="isStampUnavailablePending"
        @resetStampDefault="resetStampDefault"
        @sendMessage="sendMessage"
        @sendFollowUp="sendFollowUpItems"
      />
    </q-footer>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onUnmounted, markRaw } from 'vue'
import { accountStatus } from '../accounts/session'
import { messagingState } from '../utils/messaging-state'
import { useSafeOracleStore } from '../stores/oracle'

import ChatMessageComponent from '../components/chat/messages/ChatMessage.vue'
import EmailThreadView, {
  type EmailReply,
} from '../components/chat/email/EmailThreadView.vue'
import ChatBannerStack from '../components/chat/ChatBannerStack.vue'
import ChatInput from '../components/chat/ChatInput.vue'
import BlackjackChallengeForm from '../components/chat/BlackjackChallengeForm.vue'
import RpsChallengeForm from '../components/chat/RpsChallengeForm.vue'
import ArticleReaderPane from '../components/chat/ArticleReaderPane.vue'
import ArticleComposeForm from '../components/chat/ArticleComposeForm.vue'
import InvoiceComposeForm from '../components/chat/InvoiceComposeForm.vue'
import SendStealthDialog from '../components/dialogs/SendStealthDialog.vue'
import {
  configuredStealthAssets,
  nativeDecimals,
} from '../stealth-payments/configured-assets'
import {
  reviewStealthPayment,
  sendReviewedStealthPayment,
  type CapturedStealthReview,
} from '../stealth-payments/review-payment'
import {
  sameStealthRequest,
  type StealthAssetOption,
  type StealthDialogQuoteState,
  type StealthDialogRequest,
  type ReviewedStealthDialogIntent,
} from '../stealth-payments/options'

import OfferSwapDialog from '../components/dialogs/OfferSwapDialog.vue'
import ForwardMessageDialog from '../components/dialogs/ForwardMessageDialog.vue'
import ChatMessageReply from '../components/chat/messages/ChatMessageReply.vue'
import { openChat, openContactProfile } from '../utils/routes'
import {
  attributeMessages,
  conversationSenders,
  isGroupConversation,
  senderOf,
  type BubbleAttribution,
  type SenderIdentity,
} from '../utils/chat-attribution'
import { shortAddress } from '../utils/short-address'
import { isChainAddress, toChainDisplayAddress } from '../utils/chain-address'

import { errorNotify, insufficientStampNotify } from '../utils/notifications'
import { defaultAcceptancePrice } from '../utils/constants'
import { useSettingsStore } from '../stores/settings'
import {
  automaticDealerSteps,
  handItemStillNext,
  HAND_FEE_RESERVE_WEI,
  storedOutgoingMessages,
  resumeHandMessages,
  type HandResumeStore,
  newGameId,
  newSeed,
  saveSeed,
} from '../utils/blackjack-hand'
import {
  automaticP2pGameSteps,
  buildDiceChallenge,
  buildRpsChallenge,
} from '../utils/p2p-games'
import {
  automaticMentalPokerSteps,
  buildMentalPokerChallenge,
} from '../utils/p2p-mental-poker'
import type { RpsMove } from '@frank/wallet/message-item-plugins/rps/fair'
import {
  toArticleApplicationItem,
  type ArticlePayload,
} from '@frank/wallet/message-item-plugins/article'
import { MENTAL_POKER_PLUGIN_ID } from '@frank/wallet/message-item-plugins/mental-poker'
import { extractWebRtcCallPayload } from '@frank/wallet/message-item-plugins/webrtc-call'
import ChatMessageWebRtcCall from '../components/chat/messages/ChatMessageWebRtcCall.vue'
import {
  WebRtcCallSessionController,
  getActiveCallSessionControllers,
  registerCallSessionController,
  subscribeActiveCallControllers,
  unregisterCallSessionController,
} from '../utils/webrtc-call-controller'
import {
  getOwnCanonicalAddress,
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
} from '../utils/own-address'
import {
  buildChallenge,
  soleHandItem,
  type HandRole,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import { useMonadWallet } from '../utils/clients'
import {
  activeChain,
  type DirectMessagePreparationProgress,
} from '@frank/wallet/chain'
import { getChainConfig } from '@frank/wallet/chain/chains-registry'
import { formatDisplayNumber } from '../utils/chain-amount'
import { nextFollowBottom } from '../utils/follow-bottom'
import { composeChatItems, fitsOneMessage } from '../utils/chat-attachments'
import type { PostAttachment } from '../utils/post-editor'
import {
  clearChatDraft,
  loadChatDraft,
  saveChatDraft,
} from '../utils/draft-storage'
import type {
  ApplicationMessageItem,
  MessageItem,
  EmailItem,
} from '@frank/cashweb/types/messages'

import { debounce, QScrollArea } from 'quasar'

import { RouteLocationNormalized } from 'vue-router'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { ChatMessage, type Conversation, useChatStore } from 'src/stores/chats'
import type { OutgoingOutcome } from 'src/stores/chats'
import { useBalance } from 'src/composables/useBalance'
import {
  approveScreenerConversation,
  dismissScreenerConversation,
  formatScreenerStampValue,
  getPendingScreenerStampValueWei,
  isScreenerConversation,
  type FormattedScreenerStamp,
} from '../utils/screener-triage'
import {
  computePeerStampSuggestion,
  type PeerStampSuggestionResult,
} from '@frank/wallet/stamp-suggestion'

const scrollDuration = 0

export default defineComponent({
  components: {
    ChatMessageComponent,
    ChatMessageWebRtcCall,
    EmailThreadView,
    ChatMessageReply,
    ChatInput,
    BlackjackChallengeForm,
    RpsChallengeForm,
    ArticleReaderPane,
    ArticleComposeForm,
    InvoiceComposeForm,
    SendStealthDialog,
    OfferSwapDialog,
    ForwardMessageDialog,
    ChatBannerStack,
  },
  inject: {
    registerWebRtcCallHandler: {
      default: null,
    },
  },
  beforeRouteUpdate(to: RouteLocationNormalized) {
    const nextAddress = (to?.params?.address as string) || ''
    this.messagesToShow = 30
    if (this.address !== nextAddress) {
      this.address = nextAddress
    }
  },
  beforeUnmount() {
    if (
      typeof (
        this as unknown as {
          registerWebRtcCallHandler?: ((fn: null) => void) | null
        }
      ).registerWebRtcCallHandler === 'function'
    ) {
      ;(
        this as unknown as { registerWebRtcCallHandler: (fn: null) => void }
      ).registerWebRtcCallHandler(null)
    }
    this.unsubscribeActiveCalls?.()
    this.unsubscribeActiveCalls = null
    this.cancelBlackjackPreparation()
    window.removeEventListener('resize', this.resizeHandler)
    window.visualViewport?.removeEventListener(
      'resize',
      this.onVisualViewportResize,
    )
    window.removeEventListener('focus', this.onWindowFocus)
    window.removeEventListener('frank:blind-wakeup-sync', this.onWindowFocus)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('keydown', this.handleTriageKeydown)
    this.clearComposeFocusTimers()
    if (this.stampQuoteTimer) clearInterval(this.stampQuoteTimer)
    this.stampQuoteSequence++
  },
  data() {
    const initialAddress = (this.$route.params.address as string) || ''
    const initialDraft = loadChatDraft(initialAddress)
    return {
      address: initialAddress,
      restoringDraft: false,
      lastHandledFocusNonce: 0,
      composeFocusTimers: [] as ReturnType<typeof setTimeout>[],
      expectingWindowFocusUntil: 0,
      bottom: true as boolean,
      // Overlay height plus the 16px q-py-md gap. Zero keeps the stylesheet pad
      // when no banner is showing.
      bannerClearance: 0,
      // While a clearance change settles, stay pinned instead of flashing jump-to-bottom.
      keepBottomForBanner: false,
      // Whether the view follows the newest message; see `nextFollowBottom`.
      followBottom: true,
      lastScrollPosition: 0,
      messagesToShow: 30,
      replyDigest: (initialDraft?.replyDigest ?? null) as string | null,
      scrollDigest: null as string | null,
      chatWidth: 0,
      message: initialDraft?.message ?? '',
      // Pictures held by the composer for the next message (see utils/chat-attachments.ts).
      attachments: (initialDraft?.attachments ?? []) as PostAttachment[],
      stampPreparationStatus: null as string | null,
      // The smallest stamp the wallet sends right now, read from it (`refreshMinimumStamp`).
      // Until a fresh quote arrives, the default remains unavailable.
      minimumStampWei: 0n as bigint,
      defaultStampWei: undefined as bigint | undefined,
      defaultStampFailure: '' as string,
      defaultStampBasisNote: '',
      stampQuoteSequence: 0,
      stampQuoteTimer: undefined as ReturnType<typeof setInterval> | undefined,
      sendingMessage: false,
      activeSendCount: 0,
      blackjackDialog: false,
      blackjackPreparing: false,
      blackjackPreparationSequence: 0,
      rpsDialog: false,
      articleDialog: false,
      invoiceDialog: false,
      activeReaderArticle: null as ArticlePayload | null,
      savedScrollPositionBeforeReader: 0,
      stealthDialog: false,
      stealthAssets: [] as StealthAssetOption[],
      stealthQuote: { status: 'idle' } as StealthDialogQuoteState,
      stealthReview: null as CapturedStealthReview | null,
      stealthReviewedRequest: null as StealthDialogRequest | null,
      stealthReviewSequence: 0,
      swapDialog: false,
      swapId: crypto.getRandomValues(new Uint8Array(32)),
      forwardDialogOpen: false,
      messageToForward: null as ChatMessage | null,
      // Automatic dealer steps already attempted in this page session.
      blackjackAttempted: new Set<string>(),
      // An own undelivered hand message is being resumed; no automatic step meanwhile.
      resumingHand: false,
      screenerReplyOnceIds: new Set<string>(),
      activeCallRegistryTick: 0,
      unsubscribeActiveCalls: null as (() => void) | null,
    }
  },
  setup() {
    const oracle = useSafeOracleStore()
    const releaseOracle = oracle.acquire()
    onUnmounted(releaseOracle)
    const chats = useChatStore()
    const contacts = useContactStore()
    const myProfile = useProfileStore()
    const { refresh: refreshBalance, balance: activeWalletBalance } =
      useBalance()

    return {
      oracle,
      accountStatus,
      messagingState,
      refreshBalance,
      activeWalletBalance,
      getAcceptancePrice: contacts.getAcceptancePrice,
      getContactVuex: contacts.getContact,
      contactStore: contacts,
      ownAddress: useReactiveOwnCanonicalAddress(),
      getProfile: myProfile,
      getMessageByPayload: chats.getMessageByPayload,
      sendDirectMessage: chats.sendMessage,
      chatStore: chats,
      chatScroll: ref<QScrollArea | null>(null),
    }
  },
  emits: ['giveLotusClicked'],
  mounted() {
    if (
      typeof (
        this as unknown as {
          registerWebRtcCallHandler?:
            | ((fn: (options: { withVideo: boolean }) => void) => void)
            | null
        }
      ).registerWebRtcCallHandler === 'function'
    ) {
      ;(
        this as unknown as {
          registerWebRtcCallHandler: (
            fn: (options: { withVideo: boolean }) => void,
          ) => void
        }
      ).registerWebRtcCallHandler((options: { withVideo: boolean }) => {
        void this.sendWebRtcCallInvite(options)
      })
    }
    this.unsubscribeActiveCalls = subscribeActiveCallControllers(() => {
      this.activeCallRegistryTick += 1
    })
    void this.refreshMinimumStamp()
    this.stampQuoteTimer = setInterval(
      () => void this.refreshMinimumStamp(),
      60_000,
    )
    if (
      this.address &&
      typeof this.chatStore?.setActiveConversation === 'function'
    ) {
      if (
        isChainAddress(this.address) &&
        typeof this.chatStore?.setActiveChat === 'function'
      ) {
        this.chatStore.setActiveChat(this.address)
      } else {
        this.chatStore.setActiveConversation(this.address)
      }
    }
    this.scrollBottom()
    // set the chat width
    this.resizeHandler()
    // Adjust the chat width when window resizes
    window.addEventListener('resize', debounce(this.resizeHandler, 50))
    window.visualViewport?.addEventListener(
      'resize',
      this.onVisualViewportResize,
      { passive: true },
    )
    window.addEventListener('focus', this.onWindowFocus)
    window.addEventListener('frank:blind-wakeup-sync', this.onWindowFocus)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('keydown', this.handleTriageKeydown)
    const req = this.chatStore?.composeFocusRequest
    if (
      req &&
      req.nonce > this.lastHandledFocusNonce &&
      this.matchesConversation(req.conversationId)
    ) {
      this.lastHandledFocusNonce = req.nonce
      this.focusComposeOnOpen(true)
    } else {
      this.focusComposeOnOpen()
    }
    void this.runBlackjackDealer()
  },
  updated() {
    this.$nextTick(() => {
      if (!this.scrollDigest) {
        return
      }
      this.scrollToMessage(this.scrollDigest)
    })
  },
  methods: {
    shortAddress,
    viewParticipantRequest(conversationId: string) {
      const target = this.chatStore.conversations[conversationId]
      if (target) openChat(this.$router, target.id)
    },
    createGroupFromRequest(senderAddress: string) {
      void this.$router.push({
        path: '/new-group',
        query: {
          member: [this.conversation!.address, senderAddress],
          from: this.$route.fullPath,
        },
      })
    },
    // Opening a chat (mount or a reused route) places the caret (#411). On this
    // turn, before MainLayout's narrow-overlay restore (one tick later) treats a
    // still-unfocused page as focus lost and moves focus to the opener (#277).
    // One later attempt covers an overlay that is still inert on this turn.
    onWindowFocus() {
      const req = this.chatStore?.composeFocusRequest
      if (
        req &&
        req.nonce > this.lastHandledFocusNonce &&
        this.matchesConversation(req.conversationId)
      ) {
        this.lastHandledFocusNonce = req.nonce
        this.scheduleComposeFocus(true)
        return
      }
      if (Date.now() < this.expectingWindowFocusUntil) {
        this.scheduleComposeFocus(true)
      }
    },
    onVisibilityChange() {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible'
      ) {
        this.onWindowFocus()
      }
    },
    matchesConversation(idOrAddress: string | null | undefined): boolean {
      if (!idOrAddress) return true
      if (this.address && this.address === idOrAddress) return true
      if (this.conversation?.id && this.conversation.id === idOrAddress)
        return true
      const storeConv =
        this.chatStore?.conversations?.[idOrAddress] ??
        (isChainAddress(idOrAddress)
          ? this.chatStore?.chats?.[toChainDisplayAddress(idOrAddress)]
          : null)
      if (storeConv) {
        if (this.conversation?.id && storeConv.id === this.conversation.id)
          return true
        if (
          this.conversation?.id &&
          storeConv.id &&
          storeConv.id !== this.conversation.id
        )
          return false
        if (
          storeConv.address &&
          storeConv.address !== idOrAddress &&
          this.matchesConversation(storeConv.address)
        )
          return true
      }
      if (this.recipientAddress && this.recipientAddress === idOrAddress)
        return true
      if (
        isChainAddress(idOrAddress) &&
        ((this.address &&
          isChainAddress(this.address) &&
          sameCanonicalAddress(this.address, idOrAddress)) ||
          (this.recipientAddress &&
            isChainAddress(this.recipientAddress) &&
            sameCanonicalAddress(this.recipientAddress, idOrAddress)) ||
          (this.conversation?.address &&
            isChainAddress(this.conversation.address) &&
            sameCanonicalAddress(this.conversation.address, idOrAddress)))
      ) {
        return true
      }
      return false
    },
    clearComposeFocusTimers() {
      for (const timer of this.composeFocusTimers) {
        clearTimeout(timer)
      }
      this.composeFocusTimers = []
    },
    hasComposeFocus() {
      const active = document.activeElement
      const root = this.$el as HTMLElement | undefined
      return (
        (active instanceof HTMLTextAreaElement ||
          active instanceof HTMLInputElement) &&
        (root ? root.contains(active) : true)
      )
    },
    hasActiveComposeHighlight() {
      if (!this.hasComposeFocus()) return false
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
        return false
      }
      const active = document.activeElement
      const qField = active?.closest?.('.q-field')
      if (qField && !qField.classList.contains('q-field--focused')) {
        return false
      }
      return true
    },
    // Opening a chat (mount or a reused route) places the caret (#411). On this
    // turn, before MainLayout's narrow-overlay restore (one tick later) treats a
    // still-unfocused page as focus lost and moves focus to the opener (#277).
    // One later attempt covers an overlay that is still inert on this turn.
    focusComposeOnOpen(force = false) {
      this.scheduleComposeFocus(force)
    },
    scheduleComposeFocus(force = false) {
      this.clearComposeFocusTimers()
      if (force) {
        this.expectingWindowFocusUntil = Date.now() + 2000
      }
      const effectiveForce =
        force || Date.now() < this.expectingWindowFocusUntil
      const immediateFocused = this.focusComposeNow(effectiveForce)
      if (immediateFocused && !effectiveForce) {
        return
      }
      void this.$nextTick(() => {
        if (
          effectiveForce
            ? !this.hasActiveComposeHighlight()
            : !this.hasComposeFocus()
        ) {
          this.focusComposeNow(effectiveForce)
        }
      })
      for (const delayMs of [50, 150, 350]) {
        const timer = setTimeout(() => {
          if (
            effectiveForce
              ? !this.hasActiveComposeHighlight()
              : !this.hasComposeFocus()
          ) {
            this.focusComposeNow(effectiveForce)
          }
        }, delayMs)
        this.composeFocusTimers.push(timer)
      }
    },
    focusComposeNow(force = false) {
      if (!this.composeAutofocusAllowed(force)) return false
      if (this.isEmailThread) {
        const emailView = this.$refs.emailThreadView as
          | { focusReply?: () => void }
          | undefined
        emailView?.focusReply?.()
        return this.hasComposeFocus()
      }
      ;(
        this.$refs.chatInput as
          | { focus?: (options?: { forceRefocus?: boolean }) => void }
          | undefined
      )?.focus?.({ forceRefocus: force })
      return this.hasComposeFocus()
    },
    finePointer() {
      return (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: fine)').matches
      )
    },
    composeAutofocusAllowed(force = false) {
      if (!this.finePointer()) return false
      if (document.querySelector('.q-dialog, .q-menu')) return false
      const root = this.$el as HTMLElement | undefined
      if (!root?.isConnected || root.closest('[inert]')) return false
      if (force) return true
      const active = document.activeElement
      if (!(active instanceof HTMLElement)) return true
      if (
        active === document.body ||
        active === document.documentElement ||
        active.classList.contains('q-layout') ||
        active.classList.contains('q-page-container') ||
        active.closest('.q-drawer') !== null
      ) {
        return true
      }
      // A control already chosen in this chat stays put, except the composer.
      if (root.contains(active)) {
        return active.tagName === 'TEXTAREA' || active.tagName === 'INPUT'
      }
      return false
    },
    focusComposerAfterRetry() {
      void this.$nextTick(() => {
        // A connected control chosen while Retry was pending is still the user's focus.
        if (!this.retryFocusLost()) return
        ;(this.$refs.chatInput as { focus?: () => void } | undefined)?.focus?.()
      })
    },
    /** True when keyed removal left focus on the viewport, not on a live control. */
    retryFocusLost() {
      const active = document.activeElement
      if (
        active == null ||
        active === document.body ||
        active === document.documentElement
      ) {
        return true
      }
      return !active.isConnected
    },
    resizeHandler() {
      const chatScroll = this.chatScroll
      if (!chatScroll || !chatScroll.$el) {
        return
      }
      this.chatWidth = chatScroll.$el.scrollWidth
    },
    onVisualViewportResize() {
      this.resizeHandler()
      if (this.bottom || this.followBottom || this.hasComposeFocus()) {
        this.pinScrollToBottom()
        this.$nextTick(() => {
          this.pinScrollToBottom()
        })
      }
    },
    scrollHandler(details: {
      verticalSize: number
      verticalContainerSize: number
      verticalPosition: number
    }) {
      this.followBottom = nextFollowBottom(
        this.followBottom,
        this.lastScrollPosition,
        details.verticalPosition,
        details.verticalSize -
          details.verticalPosition -
          details.verticalContainerSize,
      )
      this.lastScrollPosition = details.verticalPosition
      const gap =
        details.verticalSize -
        details.verticalPosition -
        details.verticalContainerSize
      this.bottom = gap <= 10
      if (
        // Ten pixels from top
        details.verticalPosition <= 10 &&
        this.messagesToShow < this.messages.length
      ) {
        this.messagesToShow += 30
        return
      }
      // Banner clearance grows the content above the viewport. Re-pin once so
      // the jump button does not flash while that height settles.
      if (this.keepBottomForBanner && gap > 10) {
        this.keepBottomForBanner = false
        this.bottom = true
        this.pinScrollToBottom()
        return
      }
      this.keepBottomForBanner = false
      // Set this afterwards, incase we were at the bottom already.
      // We want to ensure that we scroll!
      this.bottom = gap <= 10
    },
    onBannerResize({ height }: { height: number }) {
      const next = height > 0 ? Math.ceil(height) + 16 : 0
      if (next === this.bannerClearance) return
      // Inline clearance replaces q-py-md's 16px. The visible shift is the
      // change in that used padding, not the raw clearance value.
      const prevPad = this.bannerClearance > 0 ? this.bannerClearance : 16
      const nextPad = next > 0 ? next : 16
      const delta = nextPad - prevPad
      const target = this.chatScroll?.getScrollTarget?.()
      const prevTop = target ? target.scrollTop : 0
      const pinBottom = this.bottom
      this.keepBottomForBanner = pinBottom
      this.bannerClearance = next
      this.$nextTick(() => {
        if (pinBottom) {
          this.pinScrollToBottom()
          return
        }
        // Reading history: grow the top pad without shifting the visible bubbles.
        if (target && prevTop > 10) target.scrollTop = prevTop + delta
      })
    },
    onMessageListResize() {
      if (this.followBottom) this.pinScrollToBottom()
    },
    pinScrollToBottom() {
      const scrollArea = this.chatScroll
      const target = scrollArea?.getScrollTarget?.()
      if (!scrollArea || !target) return
      scrollArea.setScrollPosition('vertical', target.scrollHeight, 0)
      this.bottom = true
    },
    // Used by sticky QButton to scroll to bottom
    buttonScrollBottom() {
      const scrollArea = this.chatScroll
      if (!scrollArea) {
        // Not mounted yet
        return
      }
      const scrollTarget = scrollArea.getScrollTarget()
      this.$nextTick(() => {
        scrollArea.setScrollPosition(
          'vertical',
          scrollTarget.scrollHeight,
          scrollDuration,
        )
      })
    },
    scrollBottom() {
      const scrollArea = this.chatScroll
      if (!scrollArea) {
        // Not mounted yet
        return
      }
      const scrollTarget = scrollArea.getScrollTarget()
      // A new message must not pull someone out of history reading, including
      // when they are at the very top and the scroll position is zero.
      if (!this.bottom) return
      this.$nextTick(() => {
        scrollArea.setScrollPosition(
          'vertical',
          scrollTarget.scrollHeight,
          scrollDuration,
        )
      })
    },
    scrollToMessage(digest: string) {
      return debounce(() => {
        console.log('scrollToMessage', digest)
        // if no digest, it means message was deleted or otherwise can't be found
        if (!digest) {
          return
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const message = (this.$refs[digest] as (typeof ChatMessageComponent)[])
          .slice()
          .shift()

        if (
          !message &&
          !this.messages.some(message => message.payloadDigest === digest)
        ) {
          console.log('Reply was not found in messages')
          this.scrollDigest = null
          return
        }

        // if no message, load more, then try again
        if (!message) {
          this.scrollDigest = digest
          this.messagesToShow += 30
          return
        }
        // Scroll the message into view
        this.scrollDigest = null
        this.$nextTick(() => message.$el.scrollIntoView({ behavior: 'smooth' }))
      }, 50)()
    },
    /** Refresh the shared AVU default and its live adapter floor for this messaging session. */
    async refreshMinimumStamp() {
      const sequence = ++this.stampQuoteSequence
      const client = activeChain.directMessages
      const chainIdentifier = activeChain.chainIdentifier
      const revision = accountStatus.revision
      this.defaultStampWei = undefined
      this.defaultStampBasisNote = ''
      let wallet: ReturnType<typeof useMonadWallet> | undefined
      try {
        wallet = useMonadWallet()
        const quote = await client.defaultStampQuote?.({ wallet })
        if (
          sequence !== this.stampQuoteSequence ||
          revision !== accountStatus.revision ||
          client !== activeChain.directMessages ||
          chainIdentifier !== activeChain.chainIdentifier ||
          wallet !== useMonadWallet()
        )
          return
        if (quote?.status === 'available') {
          this.minimumStampWei = quote.minimumStamp
          this.defaultStampWei = quote.amount
          this.defaultStampFailure = ''
          if (quote.pricingBasis === 'configured-fallback') {
            this.defaultStampBasisNote = this.$t(
              'chatInput.fixedStampFallback',
              {
                amount: activeChain.toDisplayAmount(quote.amount),
                unit: activeChain.unit,
              },
            )
          } else {
            this.defaultStampBasisNote =
              quote.rateFeeCoverage && quote.rateFeeCoverage !== 'included'
                ? this.$t('walletPanel.avuFeesExcluded')
                : ''
          }
        } else {
          this.defaultStampWei = undefined
          this.defaultStampFailure = quote?.reason ?? 'unsupported'
        }
      } catch {
        if (
          sequence !== this.stampQuoteSequence ||
          revision !== accountStatus.revision ||
          client !== activeChain.directMessages ||
          chainIdentifier !== activeChain.chainIdentifier
        )
          return
        if (wallet && messagingState.status === 'ready') {
          try {
            if (wallet !== useMonadWallet()) return
          } catch {
            return
          }
        }
        this.defaultStampWei = undefined
        this.defaultStampFailure =
          messagingState.status === 'ready'
            ? 'missing-fee'
            : 'messaging-pending'
      }
    },
    resetStampDefault() {
      const target = this.conversation?.id || this.recipientAddress
      if (target)
        this.chatStore?.setStampWei?.({ address: target, stampWei: undefined })
    },
    sanitizeStaleEmailStampOverride() {
      if (!this.isEmailThread) return
      const target = this.conversation?.id || this.recipientAddress
      const explicit = target
        ? this.chatStore?.getStampWei?.(target)
        : undefined
      if (explicit === undefined || explicit <= 0n) return
      const available = this.availableBalanceWei
      const base = this.defaultStampWei ?? 0n
      if (
        available !== undefined &&
        explicit > available &&
        explicit > base * 10n
      ) {
        this.resetStampDefault?.()
      }
    },
    async sendMessage(message: string) {
      if (this.stampUnavailable) {
        errorNotify(new Error(this.stampUnavailable))
        return
      }
      const wallet = useMonadWallet()
      const recipient = this.recipientAddress || this.address
      const stampValue =
        this.conversation?.kind === 'group'
          ? 0n
          : activeChain.fromDisplayAmount(this.stampAmount)
      if (
        this.availableBalanceWei !== undefined &&
        stampValue > 0n &&
        stampValue > this.availableBalanceWei
      ) {
        errorNotify(
          new Error(
            `Not enough ${activeChain.unit}: need ${activeChain.toDisplayAmount(
              stampValue,
            )} ${activeChain.unit}, have ${activeChain.toDisplayAmount(
              this.availableBalanceWei,
            )} ${activeChain.unit}`,
          ),
        )
        return
      }
      const rawPrice = this.getAcceptancePrice(recipient)
      const acceptancePrice =
        typeof rawPrice === 'number' && Number.isFinite(rawPrice)
          ? BigInt(Math.trunc(rawPrice))
          : typeof rawPrice === 'bigint'
          ? rawPrice
          : BigInt(defaultAcceptancePrice)
      // A message deliberately sent free is not a stamp that fell short: nothing is said.
      if (stampValue > 0n && stampValue < acceptancePrice) {
        insufficientStampNotify()
      }
      const attachmentsToSend = this.attachments
      if (!message.trim() && attachmentsToSend.length === 0) {
        return
      }
      // The text and its pictures must fit one message. Refused here, before anything is paid:
      // the wallet would refuse an oversized message only after funding it.
      if (!fitsOneMessage(message, attachmentsToSend)) {
        errorNotify(new Error(this.$t('chatInput.messageTooLarge')))
        return
      }
      // Move the submitted text into the optimistic outbox bubble immediately. The user should
      // never be editing the contents of a message whose accounts and stamp payments are already
      // being prepared.
      const submittedMessage = message
      const replyDigestToSend = this.replyDigest
      this.activeSendCount = (this.activeSendCount || 0) + 1
      this.sendingMessage = true
      let releasedSending = false
      const releaseSending = () => {
        if (releasedSending) return
        releasedSending = true
        this.activeSendCount = Math.max(0, (this.activeSendCount || 1) - 1)
        if (this.activeSendCount === 0) {
          this.sendingMessage = false
        }
      }
      this.restoringDraft = true
      this.message = ''
      this.attachments = []
      this.replyDigest = null
      this.restoringDraft = false
      clearChatDraft(this.address)
      if (this.conversation?.id && this.conversation.id !== this.address) {
        clearChatDraft(this.conversation.id)
      }
      if (!this.isDefaultStampMode) {
        this.resetStampDefault?.()
      }

      // The reply, the text, then the pictures the text refers to by position.
      const items = composeChatItems(
        submittedMessage,
        attachmentsToSend,
        replyDigestToSend,
      )

      try {
        await this.sendDirectMessage({
          wallet,
          address: recipient,
          conversationId: this.conversation?.id,
          items,
          stampValue,
          onPreparationProgress: (
            progress: DirectMessagePreparationProgress,
          ) => {
            this.showStampPreparation(progress)
            if (
              progress.stage === 'waiting-for-chain' ||
              progress.stage === 'waiting-for-payment'
            ) {
              releaseSending()
            }
          },
        })
      } catch (err) {
        // Send failures do not throw: the message stays in the conversation, marked failed with a
        // Retry and Discard (#269/#270). Only a precondition failure (e.g. an invalid recipient)
        // or a failure to store an already delivered message arrives here.
        errorNotify(err instanceof Error ? err : new Error(String(err)))
        return
      } finally {
        releaseSending()
        if (this.activeSendCount === 0) {
          this.stampPreparationStatus = null
          this.sendingMessage = false
        }
      }
      // After message send, scroll to bottom if not already there
      if (!this.bottom) {
        this.$nextTick(this.buttonScrollBottom)
      }
    },
    async sendEmailReply(payload: EmailReply) {
      if (this.sendingMessage) {
        return
      }
      const conversation = this.chatStore.conversations[payload.conversationId]
      if (
        !conversation ||
        conversation.deletedAt ||
        this.conversation?.id !== conversation.id
      ) {
        errorNotify(
          new Error('The selected email conversation is no longer available'),
        )
        return
      }
      const originalName = conversation.name
      const recipient =
        payload.targetAddress || this.recipientAddress || this.address
      if (
        (conversation.verifiedGateway === true || payload.targetAddress) &&
        (!useSettingsStore().emailGatewayAddress ||
          !sameCanonicalAddress(
            recipient,
            useSettingsStore().emailGatewayAddress,
          ))
      ) {
        errorNotify(
          new Error(
            'This relay email gateway is unavailable or has changed. Review its address in Settings before sending.',
          ),
        )
        return
      }
      if (this.stampUnavailable) {
        errorNotify(new Error(this.stampUnavailable))
        return
      }
      const stampValue = activeChain.fromDisplayAmount(this.stampAmount)
      if (
        this.availableBalanceWei !== undefined &&
        stampValue > 0n &&
        stampValue > this.availableBalanceWei
      ) {
        errorNotify(
          new Error(
            `Not enough ${activeChain.unit}: need ${activeChain.toDisplayAmount(
              stampValue,
            )} ${activeChain.unit}, have ${activeChain.toDisplayAmount(
              this.availableBalanceWei,
            )} ${activeChain.unit}`,
          ),
        )
        return
      }
      this.activeSendCount = (this.activeSendCount || 0) + 1
      this.sendingMessage = true
      let releasedSending = false
      const releaseSending = () => {
        if (releasedSending) return
        releasedSending = true
        this.activeSendCount = Math.max(0, (this.activeSendCount || 1) - 1)
        if (this.activeSendCount === 0) {
          this.sendingMessage = false
        }
      }
      if (!this.isDefaultStampMode) {
        this.resetStampDefault?.()
      }
      let renamedDraft = false
      const applyDraftSubjectRename = () => {
        if (renamedDraft) return
        const emailItem = payload.items.find(it => it.type === 'email') as
          | EmailItem
          | undefined
        const owner = this.chatStore.conversations[conversation.id]
        if (
          owner === conversation &&
          !owner.deletedAt &&
          owner.name === originalName &&
          emailItem?.subject?.trim() &&
          (!originalName ||
            originalName.includes('@') ||
            originalName === 'New Email' ||
            originalName.startsWith('Draft to'))
        ) {
          renamedDraft = true
          this.chatStore.renameConversation(conversation.id, emailItem.subject)
        }
      }
      try {
        const wallet = useMonadWallet()
        const outcome = await this.sendDirectMessage({
          wallet,
          address: recipient,
          conversationId: conversation.id,
          items: payload.items,
          stampValue,
          onPreparationProgress: (
            progress: DirectMessagePreparationProgress,
          ) => {
            this.showStampPreparation(progress)
            if (
              progress.stage === 'waiting-for-chain' ||
              progress.stage === 'waiting-for-payment'
            ) {
              applyDraftSubjectRename()
              releaseSending()
            }
          },
        })
        if (outcome && (outcome as any).state === 'failed') {
          const reason = (outcome as any).reason
          errorNotify(
            new Error(
              reason === 'insufficient-funds'
                ? `Not enough ${activeChain.unit} to cover the stamp fee`
                : reason === 'stamp-below-fee'
                ? 'Stamp amount is below the minimum relay fee'
                : 'Failed to send email',
            ),
          )
        } else {
          applyDraftSubjectRename()
        }
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        releaseSending()
        if (this.activeSendCount === 0) {
          this.stampPreparationStatus = null
          this.sendingMessage = false
        }
      }
    },
    async openStealthDialog() {
      this.stealthReviewSequence += 1
      const sequence = this.stealthReviewSequence
      this.stealthReview = null
      this.stealthReviewedRequest = null
      this.stealthQuote = { status: 'pending' }
      this.stealthDialog = true
      try {
        const { options, unavailable } = await configuredStealthAssets({
          activeBalance: this.activeWalletBalance ?? undefined,
        })
        if (!this.stealthDialog || sequence !== this.stealthReviewSequence)
          return
        this.stealthAssets = options
        this.stealthQuote =
          options.length > 0
            ? { status: 'idle' }
            : {
                status: 'error',
                message: String(
                  unavailable[0]?.error || this.$t('sendStealthDialog.notSent'),
                ),
              }
      } catch (error) {
        if (sequence === this.stealthReviewSequence)
          this.stealthQuote = { status: 'error', message: String(error) }
      }
    },
    async reviewStealthPayment(request: StealthDialogRequest) {
      const sequence = ++this.stealthReviewSequence
      const recipient = this.recipientAddress || this.address
      const conversationId = this.conversation?.id
      this.stealthReview = null
      this.stealthReviewedRequest = null
      this.stealthQuote = { status: 'pending' }
      try {
        if (request.address !== recipient || this.stampUnavailable)
          throw new Error(
            this.stampUnavailable || this.$t('chat.sendContextChanged'),
          )
        let stampValue = 0n
        try {
          stampValue = activeChain.fromDisplayAmount(this.stampAmount || '0')
        } catch {
          stampValue = this.defaultStampWei ?? 0n
        }
        const contactKey = this.contact?.profile?.pubKey?.toBuffer?.()
        const effectiveRequest: StealthDialogRequest = {
          ...request,
          recipientSpendPublicKey:
            request.recipientSpendPublicKey ?? contactKey,
        }
        const captured = await reviewStealthPayment({
          request: effectiveRequest,
          stampValue,
          isCurrent: () =>
            sequence === this.stealthReviewSequence &&
            recipient === (this.recipientAddress || this.address) &&
            conversationId === this.conversation?.id,
        })
        if (!this.stealthDialog || sequence !== this.stealthReviewSequence)
          return
        this.stealthReview = markRaw(captured)
        this.stealthReviewedRequest = {
          ...request,
          asset: { ...request.asset },
        }
        this.stealthQuote = {
          status: 'ready',
          request: this.stealthReviewedRequest,
          payment: captured.quote,
          maxNativeFeeAtomic: captured.maxNativeFeeAtomic,
          stampValueAtomic: captured.stampValue,
          stampFeeAtomic: captured.stampFeeAtomic,
          stampUnit: activeChain.unit,
          stampDecimals: nativeDecimals(value =>
            activeChain.fromDisplayAmount(value),
          ),
        }
      } catch (error) {
        if (sequence === this.stealthReviewSequence)
          this.stealthQuote = { status: 'error', message: String(error) }
      }
    },
    /** The financial owner saves the original signed payment; the message owner then binds
     * its complete sealed envelope before delivery and submits that same authorized operation. */
    async sendStealthPayment(
      intentOrRequest: ReviewedStealthDialogIntent | StealthDialogRequest,
    ) {
      if (this.sendingMessage) return
      let intent: ReviewedStealthDialogIntent
      if (!('quote' in intentOrRequest)) {
        this.sendingMessage = true
        try {
          await this.reviewStealthPayment(intentOrRequest)
        } finally {
          this.sendingMessage = false
        }
        const capturedFromReview = this.stealthReview
        const reviewedReq = this.stealthReviewedRequest
        if (
          !capturedFromReview ||
          !reviewedReq ||
          this.stealthQuote.status !== 'ready'
        ) {
          if (this.stealthQuote.status === 'error') {
            errorNotify(new Error(this.stealthQuote.message), {
              fallbackKey: 'sendStealthDialog.notSent',
            })
          }
          return
        }
        intent = {
          ...reviewedReq,
          quote: capturedFromReview.quote,
          maxNativeFeeAtomic: capturedFromReview.maxNativeFeeAtomic,
          stampValue: capturedFromReview.stampValue,
        }
      } else {
        intent = intentOrRequest
      }
      const captured = this.stealthReview
      if (this.sendingMessage || !captured || !this.stealthReviewedRequest)
        return
      if (
        !sameStealthRequest(intent, this.stealthReviewedRequest) ||
        intent.quote.operationId !== captured.quote.operationId ||
        intent.maxNativeFeeAtomic !== captured.maxNativeFeeAtomic ||
        intent.stampValue !== captured.stampValue
      )
        return
      this.sendingMessage = true
      const recipient = this.recipientAddress || this.address
      const conversationId = this.conversation?.id
      try {
        await sendReviewedStealthPayment(
          captured,
          intent.memo || undefined,
          async (prepared, item) => {
            this.stealthDialog = false
            return this.sendDirectMessage({
              wallet: captured.messagingWallet,
              address: recipient,
              conversationId,
              items: [item],
              stampValue: captured.stampValue,
              financialOperations: [
                {
                  chainIdentifier: prepared.chainIdentifier,
                  operationId: prepared.operationId,
                },
              ],
              onPreparationProgress: this.showStampPreparation,
            })
          },
        )
      } catch (error) {
        errorNotify(error, { fallbackKey: 'sendStealthDialog.messageEnded' })
      } finally {
        this.stealthReview = null
        this.stealthReviewedRequest = null
        this.stealthQuote = { status: 'idle' }
        this.stampPreparationStatus = null
        this.sendingMessage = false
      }
      if (!this.bottom) this.$nextTick(this.buttonScrollBottom)
    },
    newSwapId(): Uint8Array {
      return crypto.getRandomValues(new Uint8Array(32))
    },
    openSwapDialog() {
      this.swapDialog = true
    },
    // Shows the preparation stage of a send in the composer status line, translated --
    // only when a background on-chain funding transaction is genuinely in-flight.
    showStampPreparation(progress: DirectMessagePreparationProgress) {
      if (progress.stage === 'funding') {
        this.stampPreparationStatus = this.$t('chat.stampPreparationFunding', {
          completed: progress.completed,
          total: progress.total,
          feeReserve: formatDisplayNumber(activeChain, progress.feeReserveWei),
          unit: activeChain.unit,
        })
      } else if (progress.stage === 'waiting-for-chain') {
        // The chain's node cannot be reached: a visible warning, and the send is queued.
        this.stampPreparationStatus = this.$t('chat.chainUnreachable')
      } else {
        this.stampPreparationStatus = null
      }
    },
    // Handles a plugin renderer's `sendFollowUp` emit (see ChatMessage.vue's own relay of it --
    // e.g. blackjack's Hit/Stand buttons, or the vendor-bot catalog's own Buy buttons) by feeding
    // arbitrary items through the exact same prepare-and-send pipeline `sendMessage` uses for free
    // text: same sendingMessage/stampPreparationStatus UX, same error handling. Deliberately
    // simpler than `sendMessage` in one respect -- no recovered-draft-confirmation flow, since a
    // button click isn't a resendable "draft" the way typed text is; a recovered-attempt error
    // here just surfaces as a plain notification instead.
    //
    // `stampValueWei` is an optional override of the user's own configured default stamp amount --
    // needed for a digital-goods purchase, where the price paid *is* the message's stamp value
    // (see `DigitalGoodsItem`'s own header on `@frank/cashweb/types/messages`), which is very
    // unlikely to equal whatever this user happens to have their own default stamp set to.
    async sendFollowUpItems({
      items,
      stampValueWei,
      settled,
    }: {
      items: MessageItem[]
      stampValueWei?: bigint
      /** Called exactly once with whether the message was sent, so a renderer that spent money
       * on the click (a purchase) can hold its own in-flight guard until then. */
      settled?: (sent: boolean) => void
    }): Promise<boolean> {
      let sent = false
      try {
        sent = await this.sendFollowUpItemsUnsettled({ items, stampValueWei })
        return sent
      } finally {
        // Exactly once, even if the send throws (a throw counts as not sent).
        settled?.(sent)
      }
    },
    async sendFollowUpItemsUnsettled({
      items,
      stampValueWei,
    }: {
      items: MessageItem[]
      stampValueWei?: bigint
    }): Promise<boolean> {
      if (this.sendingMessage) {
        return false
      }
      this.sendingMessage = true
      let outcome: OutgoingOutcome
      try {
        // Capture the displayed decision and its session before hand validation opens storage.
        if (stampValueWei === undefined && this.stampUnavailable)
          throw new Error(this.stampUnavailable)
        const wallet = useMonadWallet()
        const chainIdentifier = activeChain.chainIdentifier
        const client = activeChain.directMessages
        const revision = accountStatus.revision
        const peer = this.recipientAddress || this.address
        const conversationId = this.conversation?.id
        // A group message carries no stamp. A follow-up whose meaning is a payment (a purchase
        // priced as its stamp) is refused rather than silently sent for free.
        const groupConversation = this.conversation?.kind === 'group'
        if (groupConversation && (stampValueWei ?? 0n) !== 0n)
          throw new Error('Group payments are unsupported')
        const stampValue = groupConversation
          ? 0n
          : stampValueWei ?? activeChain.fromDisplayAmount(this.stampAmount)
        const capturedItems = items.slice()
        const contextCurrent = () =>
          revision === accountStatus.revision &&
          chainIdentifier === activeChain.chainIdentifier &&
          client === activeChain.directMessages &&
          wallet === useMonadWallet() &&
          peer === (this.recipientAddress || this.address) &&
          conversationId === this.conversation?.id
        const requireCurrentContext = () => {
          if (!contextCurrent())
            throw new Error(this.$t('chat.sendContextChanged'))
        }
        // Only the next saved hand action may leave this session. A changed session must
        // review the action again rather than choose another wallet after these awaits.
        const handItem = soleHandItem(capturedItems)
        if (handItem) {
          const memory = this.peerMessages
          const own = await getOwnCanonicalAddress()
          requireCurrentContext()
          const stillNext =
            !!own &&
            (await handItemStillNext({
              item: handItem,
              stampWei: stampValue,
              own,
              peer,
              memory,
              stored: () => storedOutgoingMessages(peer),
            }))
          requireCurrentContext()
          if (!stillNext) {
            errorNotify(new Error(this.$t('blackjackP2p.notNext')))
            return false
          }
        }
        requireCurrentContext()
        outcome = await this.sendDirectMessage({
          wallet,
          address: peer,
          conversationId,
          items: capturedItems,
          stampValue,
          onPreparationProgress: this.showStampPreparation,
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
        return false
      } finally {
        this.stampPreparationStatus = null
        this.sendingMessage = false
      }
      if (!this.bottom) {
        this.$nextTick(this.buttonScrollBottom)
      }
      // A failed send no longer throws (the message stays in the chat as failed, with Retry), so
      // the caller's "was it sent" answer must come from the outcome: only a delivered message,
      // or one whose payment is safely pending and will deliver on its own, counts. A failed one
      // is "not sent", which keeps a bet's unsent-wager record and a purchase's guard honest.
      return outcome.state === 'sent' || outcome.state === 'payment-pending'
    },
    // The challenge form's submit: build the challenge against this wallet's spendable balance
    // and send it as an ordinary message. A dealer's seed is kept on this device before its
    // commitment leaves it.
    cancelBlackjackPreparation() {
      this.blackjackPreparationSequence++
      this.blackjackPreparing = false
      this.blackjackDialog = false
    },
    async sendBlackjackChallenge({
      role,
      maxBetWei,
    }: {
      role: HandRole
      maxBetWei: bigint
    }) {
      if (
        this.blackjackPreparing ||
        this.sendingMessage ||
        !this.blackjackDialog
      )
        return
      const sequence = ++this.blackjackPreparationSequence
      this.blackjackPreparing = true
      const revision = accountStatus.revision
      const status = accountStatus.status
      const peer = this.recipientAddress || this.address
      const conversationId = this.conversation?.id
      const chain = activeChain
      const current = () =>
        sequence === this.blackjackPreparationSequence &&
        this.blackjackDialog &&
        revision === accountStatus.revision &&
        status === accountStatus.status &&
        chain === activeChain &&
        peer === (this.recipientAddress || this.address) &&
        conversationId === this.conversation?.id
      try {
        const wallet = useMonadWallet()
        const own = await getOwnCanonicalAddress()
        if (!current() || wallet !== useMonadWallet()) return
        if (role === 'dealer' && !own) {
          errorNotify(new Error(this.$t('blackjackP2p.challengeRefused')))
          return
        }
        const spendableWei = await chain.nativeTransfers.getBalance({ wallet })
        if (!current() || wallet !== useMonadWallet()) return
        const gameId = newGameId()
        const seed =
          role === 'dealer' ? newSeed(gameId, own ?? undefined) : undefined
        const built = buildChallenge({
          gameId,
          role,
          maxBetWei,
          spendableWei,
          reserveWei: HAND_FEE_RESERVE_WEI,
          seed,
        })
        if ('error' in built) {
          errorNotify(new Error(this.$t('blackjackP2p.challengeRefused')))
          return
        }
        if (seed && own) saveSeed(own, peer, gameId, seed)
        // Stop preparation before closing: dialog hide may cancel preparation, never a message
        // already handed to the normal captured-context send/reconciliation pipeline.
        this.blackjackPreparing = false
        this.blackjackDialog = false
        await this.sendFollowUpItems({ items: [built.item] })
      } catch (err) {
        if (current())
          errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        if (sequence === this.blackjackPreparationSequence)
          this.blackjackPreparing = false
      }
    },
    async sendDiceChallenge() {
      if (this.sendingMessage) return
      const peer = this.recipientAddress || this.address
      const own = (await getOwnCanonicalAddress()) ?? 'self'
      if (
        this.sendingMessage ||
        peer !== (this.recipientAddress || this.address)
      )
        return
      const built = buildDiceChallenge(own, peer)
      await this.sendFollowUpItems({ items: [built.item] })
    },
    async sendMentalPokerChallenge() {
      if (this.sendingMessage) return
      const peer = this.recipientAddress || this.address
      const own = (await getOwnCanonicalAddress()) ?? 'self'
      if (
        this.sendingMessage ||
        peer !== (this.recipientAddress || this.address)
      )
        return
      const built = buildMentalPokerChallenge({ own, peer, stakeWei: 0n })
      await this.sendFollowUpItems({ items: [built.item] })
    },
    async sendWebRtcCallInvite(options?: { withVideo?: boolean }) {
      if (this.sendingMessage) return
      const peer = this.recipientAddress || this.address
      const own = (await getOwnCanonicalAddress()) ?? 'self'
      if (
        this.sendingMessage ||
        peer !== (this.recipientAddress || this.address)
      )
        return
      const controller = new WebRtcCallSessionController({
        localPeerId: own,
        remotePeerId: peer,
      })
      let registeredCallId: string | null = null
      try {
        const { item, payload } = await controller.startOutgoingCall({
          withVideo: Boolean(options?.withVideo),
        })
        registeredCallId = payload.callId
        registerCallSessionController(payload.callId, controller)
        await this.sendFollowUpItems({ items: [item] })
      } catch (err) {
        if (registeredCallId) {
          unregisterCallSessionController(registeredCallId, controller)
        }
        controller.cleanup()
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      }
    },
    async sendDetachedCallFollowUp({
      items,
      stampValueWei,
    }: {
      items: MessageItem[]
      stampValueWei?: bigint
    }) {
      const ctrl = this.detachedActiveCallController
      const peer =
        ctrl?.getRemotePeerId() || this.recipientAddress || this.address
      if (!peer || !items.length) return
      if (sameCanonicalAddress(peer, this.recipientAddress || this.address)) {
        await this.sendFollowUpItems({ items, stampValueWei })
        return
      }
      try {
        const wallet = useMonadWallet()
        await this.sendDirectMessage({
          wallet,
          address: peer,
          items,
          stampValue: stampValueWei ?? this.minimumStampWei ?? 0n,
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      }
    },
    async sendRpsChallenge({
      move,
      wagerWei,
    }: {
      move: RpsMove
      wagerWei?: bigint
    }) {
      if (this.sendingMessage || !this.rpsDialog) return
      const peer = this.recipientAddress || this.address
      const own = (await getOwnCanonicalAddress()) ?? 'self'
      if (
        this.sendingMessage ||
        !this.rpsDialog ||
        peer !== (this.recipientAddress || this.address)
      )
        return
      const built = buildRpsChallenge(
        own,
        peer,
        move,
        undefined,
        wagerWei ?? 0n,
      )
      this.rpsDialog = false
      await this.sendFollowUpItems({ items: [built.item] })
    },
    async sendArticle(payload: ArticlePayload) {
      if (this.sendingMessage || !this.articleDialog) return
      const item = toArticleApplicationItem(payload)
      this.articleDialog = false
      await this.sendFollowUpItems({ items: [item] })
    },
    async sendInvoice({ item }: { item: ApplicationMessageItem }) {
      if (this.sendingMessage || !this.invoiceDialog) return
      this.invoiceDialog = false
      await this.sendFollowUpItems({ items: [item] })
    },
    openArticleReader(payload: ArticlePayload) {
      this.savedScrollPositionBeforeReader = this.lastScrollPosition
      this.activeReaderArticle = payload
    },
    closeArticleReader() {
      const savedScroll = this.savedScrollPositionBeforeReader
      this.activeReaderArticle = null
      void this.$nextTick(() => {
        const scrollArea = this.chatScroll
        if (scrollArea && savedScroll > 0) {
          scrollArea.setScrollPosition('vertical', savedScroll, 0)
        }
      })
    },
    // Dealer steps that involve no choice and pay nothing (deal, card, a reveal that owes
    // nothing) are sent without asking. Each position of a hand is attempted once per page
    // session; a failed send stays in the chat with its Retry.
    async runBlackjackDealer() {
      if (this.sendingMessage || this.resumingHand) return
      const hasBlackjack = this.peerMessages.some(m =>
        m.items?.some(it => it.type === 'blackjack-hand'),
      )
      const hasP2pGame = this.peerMessages.some(m =>
        m.items?.some(it => it.type === 'dice' || it.type === 'rps'),
      )
      const hasMentalPoker = this.peerMessages.some(m =>
        m.items?.some(
          it =>
            it.type === 'application' && it.itemType === MENTAL_POKER_PLUGIN_ID,
        ),
      )
      if (!hasBlackjack && !hasP2pGame && !hasMentalPoker) {
        return
      }
      const own = await getOwnCanonicalAddress()
      if (!own || this.sendingMessage || this.resumingHand) return
      const peer = this.recipientAddress || this.address
      if (hasBlackjack) {
        // First finish what this user already decided: a hand message that was cut off (the
        // window closed mid-send) or failed counts as sent in the hand, so nothing else can
        // happen until it is delivered. Free steps are sent again; money is only settled.
        // While that is awaited no other trigger (watchers, a finished send) may pick a step.
        let wallet: ReturnType<typeof useMonadWallet>
        try {
          wallet = useMonadWallet()
        } catch {
          return
        }
        this.resumingHand = true
        let resumed: number
        try {
          resumed = await resumeHandMessages({
            store: this.chatStore as unknown as HandResumeStore,
            wallet,
            address: peer,
            own,
            messages: this.peerMessages,
            attempted: this.blackjackAttempted,
            // Without a quote, every positive stamp is money: settle its original attempt.
            // Free recovery still proceeds; no new default is invented.
            ordinaryStampWei: this.stampUnavailable
              ? 0n
              : activeChain.fromDisplayAmount(this.stampAmount),
          })
        } finally {
          this.resumingHand = false
        }
        if (resumed > 0) {
          void this.runBlackjackDealer()
          return
        }
      }
      const step = [
        ...(hasBlackjack
          ? automaticDealerSteps(this.peerMessages, own, peer)
          : []),
        ...(hasP2pGame
          ? automaticP2pGameSteps(this.peerMessages, own, peer)
          : []),
        ...(hasMentalPoker
          ? automaticMentalPokerSteps(this.peerMessages, own, peer)
          : []),
      ].find(candidate => !this.blackjackAttempted.has(candidate.key))
      if (!step || this.sendingMessage || this.resumingHand) return
      this.blackjackAttempted.add(step.key)
      await this.sendFollowUpItems({ items: [step.item] })
    },
    /** The name of whoever sent this message: this user, or the message's own sender. */
    messageSenderName(msg: ChatMessage, index: number): string {
      if (this.chunkedMessages[index] === msg) {
        return this.chunkedMessageSenderNames[index] ?? 'unknown'
      }
      if (msg.outbound) return this.getProfile.profile?.name ?? 'unknown'
      return (
        this.attributions[index]?.sender.label ??
        this.getContactVuex(msg.senderAddress)?.profile?.name ??
        'unknown'
      )
    },
    openSenderProfile(address: string) {
      if (this.$router) void openContactProfile(this.$router, address)
    },
    setReply(payloadDigest: string | null) {
      this.replyDigest = payloadDigest
      if (payloadDigest) {
        this.$nextTick(() => {
          ;(
            this.$refs.chatInput as { focus?: () => void } | undefined
          )?.focus?.()
        })
      }
    },
    handleForwardClicked({
      payloadDigest,
    }: {
      address: string
      payloadDigest: string
    }) {
      const msg =
        this.messages.find(m => m.payloadDigest === payloadDigest) ||
        this.chatStore.messages[payloadDigest]
      if (msg) {
        this.messageToForward = msg
        this.forwardDialogOpen = true
      }
    },
    async handleForwardToContact(targetAddress: string) {
      this.forwardDialogOpen = false
      if (!this.messageToForward) {
        return
      }
      const itemsToSend = this.messageToForward.items
        .filter(item => item.type !== 'reply')
        .map(item => ({ ...item }))
      if (itemsToSend.length === 0) {
        return
      }
      this.sendingMessage = true
      try {
        const stampValue = this.chatStore.getStampWei(targetAddress)
        await this.sendDirectMessage({
          wallet: useMonadWallet(),
          address: targetAddress,
          items: itemsToSend,
          stampValue,
          onPreparationProgress: this.showStampPreparation,
        })
        const peer = this.recipientAddress || this.address
        if (targetAddress !== peer) {
          await openChat(this.$router, targetAddress)
        }
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.stampPreparationStatus = null
        this.sendingMessage = false
        this.messageToForward = null
      }
      if (!this.bottom) {
        this.$nextTick(this.buttonScrollBottom)
      }
    },
    async retrySupersededMemberChange() {
      if (!this.conversation) return
      try {
        await this.chatStore.retrySupersededMemberChange(this.conversation.id)
      } catch (error) {
        errorNotify(error instanceof Error ? error : new Error(String(error)))
      }
    },
    async dismissSupersededMemberChange() {
      if (!this.conversation) return
      try {
        await this.chatStore.dismissSupersededMemberChange(this.conversation.id)
      } catch (error) {
        errorNotify(error instanceof Error ? error : new Error(String(error)))
      }
    },
    async retryGroupUpdates() {
      if (!this.conversation) return
      try {
        await this.chatStore.syncGroupConversation(this.conversation.id)
      } catch (error) {
        errorNotify(error, { fallbackKey: 'groupChat.syncFailed' })
      }
    },
    async decideGroupInvite(approve: boolean) {
      if (!this.conversation) return
      try {
        if (approve)
          await this.chatStore.approveGroupInvite(this.conversation.id)
        else await this.chatStore.declineGroupInvite(this.conversation.id)
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      }
    },
    approveScreenerThread() {
      if (!this.conversation) return
      approveScreenerConversation(
        this.conversation,
        this.chatStore,
        this.contactStore,
      )
    },
    replyOnceScreenerThread() {
      if (!this.conversation) return
      this.screenerReplyOnceIds.add(this.conversation.id)
      this.focusReplyComposer()
    },
    dismissScreenerThread() {
      if (!this.conversation) return
      const nextTargetId = this.findAdjacentThreadId(1)
      dismissScreenerConversation(this.conversation, this.chatStore)
      if (nextTargetId) {
        void openChat(this.$router, nextTargetId)
      }
    },
    focusReplyComposer() {
      if (this.isEmailThread) {
        const emailView = this.$refs.emailThreadView as
          | { focusReply?: () => void }
          | undefined
        emailView?.focusReply?.()
        return
      }
      ;(this.$refs.chatInput as { focus?: () => void } | undefined)?.focus?.()
    },
    findAdjacentThreadId(direction: -1 | 1): string | null {
      const list = this.chatStore.getSortedChatOrder.filter(
        conversation => conversation.screenerStatus !== 'dismissed',
      )
      if (list.length === 0) return null
      const currentId = this.conversation?.id || this.address
      const currentIdx = list.findIndex(item => item.id === currentId)
      if (currentIdx === -1) {
        return list[0]?.id ?? null
      }
      const nextIdx = currentIdx + direction
      if (nextIdx < 0 || nextIdx >= list.length) return null
      return list[nextIdx]?.id ?? null
    },
    navigateThread(direction: -1 | 1) {
      const nextId = this.findAdjacentThreadId(direction)
      if (nextId) {
        void openChat(this.$router, nextId)
      }
    },
    navigateEmailThread(direction: 'next' | 'prev') {
      if (direction === 'next') this.navigateThread(1)
      else if (direction === 'prev') this.navigateThread(-1)
    },
    archiveCurrentThread() {
      if (this.isScreenerThread) {
        this.dismissScreenerThread()
        return
      }
      this.navigateThread(1)
    },
    handleTriageKeydown(event: KeyboardEvent) {
      if (this.isEmailThread) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return
        }
      }
      const key = event.key.toLowerCase()
      if (key === 'j') {
        event.preventDefault()
        this.navigateThread(1)
      } else if (key === 'k') {
        event.preventDefault()
        this.navigateThread(-1)
      } else if (key === 'r') {
        event.preventDefault()
        this.focusReplyComposer()
      } else if (key === 'e') {
        event.preventDefault()
        this.archiveCurrentThread()
      }
    },
  },
  computed: {
    activeChainKey(): string {
      return activeChain.chainIdentifier || 'monad'
    },
    activeNetworkId(): string {
      try {
        return getChainConfig(activeChain.chainIdentifier).chainId
      } catch {
        return '10143'
      }
    },
    activeNativeSymbol(): string {
      return activeChain.unit || 'MON'
    },
    activeNativeDecimals(): number {
      try {
        return getChainConfig(activeChain.chainIdentifier).nativeDecimals
      } catch {
        return 18
      }
    },
    swapStampValue(): string {
      try {
        return activeChain.fromDisplayAmount(this.stampAmount || '0').toString()
      } catch {
        return ''
      }
    },
    participantRequests() {
      return this.conversation?.kind === 'direct'
        ? Object.values(this.conversation.pendingParticipantRequests ?? {})
        : []
    },
    isScreenerThread(): boolean {
      if (!this.conversation) return false
      if (this.screenerReplyOnceIds.has(this.conversation.id)) return false
      return isScreenerConversation(
        this.conversation,
        addr => Boolean(this.contactStore?.isContact?.(addr)),
        this.ownAddress,
      )
    },
    screenerStampSummary(): FormattedScreenerStamp {
      const totalWei = this.conversation
        ? getPendingScreenerStampValueWei(this.conversation)
        : 0n
      return formatScreenerStampValue(
        totalWei,
        this.oracle?.current?.rates.monad,
      )
    },
    isDefaultStampMode(): boolean {
      const target = this.conversation?.id || this.recipientAddress
      return !target || this.chatStore.getStampWei(target) === undefined
    },
    stampUnavailable(): string {
      if (this.conversation?.kind === 'group') return ''
      const target = this.conversation?.id || this.recipientAddress
      const explicit = target ? this.chatStore.getStampWei(target) : undefined
      if (
        explicit !== undefined &&
        explicit > 0n &&
        explicit < this.minimumStampWei
      )
        return this.$t('chatInput.stampBelowMinimum', {
          amount: activeChain.toDisplayAmount(this.minimumStampWei),
          unit: activeChain.unit,
        })
      if (!this.isDefaultStampMode || this.defaultStampWei !== undefined)
        return ''
      // A fresh quote can be pending before it has supplied a failure reason.
      if (!this.defaultStampFailure)
        return this.$t('chatInput.stampQuoteUnavailable')
      return this.$t('chatInput.stampQuoteUnavailableReason', {
        reason: this.$t(
          `chatInput.stampQuoteReasons.${this.defaultStampFailure}`,
        ),
      })
    },
    isStampUnavailablePending(): boolean {
      const target = this.conversation?.id || this.recipientAddress
      const explicit = target ? this.chatStore.getStampWei(target) : undefined
      if (
        explicit !== undefined &&
        explicit > 0n &&
        explicit < this.minimumStampWei
      ) {
        return false
      }
      if (!this.isDefaultStampMode || this.defaultStampWei !== undefined) {
        return false
      }
      if (!this.defaultStampFailure) {
        return true
      }
      if (
        this.defaultStampFailure === 'messaging-pending' &&
        !this.messagingState.reason
      ) {
        return true
      }
      return false
    },
    isEmailThread(): boolean {
      if (this.conversation?.kind === 'email') {
        return true
      }
      // An email item makes this an email thread only when we or the peer sent it.
      return this.peerMessages.some(m => m.items?.some(i => i.type === 'email'))
    },
    bannerClearanceStyle(): { paddingTop: string } | undefined {
      return this.bannerClearance > 0
        ? { paddingTop: `${this.bannerClearance}px` }
        : undefined
    },
    messageScrollMarginStyle(): { scrollMarginTop: string } | undefined {
      return this.bannerClearance > 0
        ? { scrollMarginTop: `${this.bannerClearance}px` }
        : undefined
    },
    conversation(): Conversation | null {
      const byIdOrAddress =
        this.chatStore.conversations[this.address] ??
        (isChainAddress(this.address)
          ? this.chatStore.chats[toChainDisplayAddress(this.address)]
          : null)
      if (byIdOrAddress) return byIdOrAddress
      const active = this.chatStore.activeConversation
      if (
        active &&
        (active.id === this.address ||
          (isChainAddress(this.address) &&
            sameCanonicalAddress(active.address, this.address)))
      ) {
        return active
      }
      return null
    },
    recipientAddress(): string {
      if (this.conversation?.address) {
        return this.conversation.address
      }
      if (
        this.conversation?.participants &&
        this.conversation.participants.length > 0
      ) {
        const nonSelf = this.conversation.participants.find(
          p => !sameCanonicalAddress(p, this.ownAddress),
        )
        return nonSelf || this.conversation.participants[0]
      }
      const isEmailWithoutAddress =
        this.conversation?.kind === 'email' ||
        this.messages.some(
          m =>
            (m.outbound ||
              sameCanonicalAddress(m.senderAddress, this.address)) &&
            m.items?.some(i => i.type === 'email'),
        )
      if (isEmailWithoutAddress) {
        try {
          const settingsStore = useSettingsStore()
          return settingsStore.emailGatewayAddress
        } catch {
          return ''
        }
      }
      return this.address
    },
    contact() {
      return this.getContactVuex(this.recipientAddress)
    },
    conversationTopic(): string {
      return this.conversation?.topic || this.conversation?.name || ''
    },
    peerName(): string {
      if (this.conversation?.name) {
        return this.conversation.name
      }
      if (this.conversation?.topic) {
        return this.conversation.topic
      }
      return this.getContactVuex(this.recipientAddress)?.profile?.name ?? ''
    },
    messages(): ChatMessage[] {
      return this.conversation?.messages ?? []
    },
    /** What this user and the conversation's peer sent. A game is between those two; what
     * anyone else posted into the conversation is not one of its moves. */
    peerMessages(): ChatMessage[] {
      const peer = this.recipientAddress || this.address
      return this.messages.filter(
        message =>
          message.outbound || sameCanonicalAddress(message.senderAddress, peer),
      )
    },
    /** More than two people are in this conversation, so each message must say who sent it. */
    isGroup(): boolean {
      return isGroupConversation(
        this.conversation?.participants,
        this.ownAddress,
        this.conversation?.address,
      )
    },
    senders(): Map<string, SenderIdentity> {
      if (!this.isGroup) return new Map()
      return conversationSenders(
        this.conversation,
        this.ownAddress,
        this.contactStore,
        this.chunkedMessages,
      )
    },
    /** One entry per shown message; all empty in a two-person chat. */
    attributions(): Array<BubbleAttribution | undefined> {
      if (!this.isGroup) return []
      return attributeMessages(this.chunkedMessages, this.senders)
    },
    /** Precomputed sender display names per shown message so keystrokes in Chat.vue do not re-run contact lookups for every message row. */
    chunkedMessageSenderNames(): string[] {
      const ownName = this.getProfile.profile?.name ?? 'unknown'
      const names = new Array<string>(this.chunkedMessages.length)
      const bySender = new Map<string, string>()
      for (let i = 0; i < this.chunkedMessages.length; i++) {
        const msg = this.chunkedMessages[i]
        if (msg.outbound) {
          names[i] = ownName
          continue
        }
        const attributed = this.attributions[i]?.sender.label
        if (attributed) {
          names[i] = attributed
          continue
        }
        const addr = msg.senderAddress
        let cached = bySender.get(addr)
        if (cached === undefined) {
          cached = this.getContactVuex(addr)?.profile?.name ?? 'unknown'
          bySender.set(addr, cached)
        }
        names[i] = cached
      }
      return names
    },
    /** These are this user's own notes: what is sent from here goes to nobody else. */
    recipientIsSelf(): boolean {
      return sameCanonicalAddress(this.recipientAddress, this.ownAddress)
    },
    /** Who a message sent from here goes to. */
    recipientName(): string {
      return (
        senderOf(this.senders, this.recipientAddress)?.label ??
        shortAddress(this.recipientAddress)
      )
    },
    chunkedMessages() {
      // TODO: Improve stacking logic e.g. long durations between messages prevent stacking
      // TODO: Optimize this by progressively constructing it
      if (!this.messages) {
        return []
      }

      const length = Math.min(this.messages.length, this.messagesToShow)
      const start = this.messages.length - length
      const end = this.messages.length

      return this.messages.slice(start, end)
    },
    detachedActiveCallController(): WebRtcCallSessionController | null {
      void this.activeCallRegistryTick
      const activeControllers = getActiveCallSessionControllers()
      if (activeControllers.length === 0) return null
      const visibleCallIds = new Set<string>()
      for (const msg of this.chunkedMessages) {
        if (!Array.isArray(msg.items)) continue
        for (const item of msg.items) {
          const payload = extractWebRtcCallPayload(item)
          if (payload?.callId && payload.action === 'invite') {
            visibleCallIds.add(payload.callId)
          }
        }
      }
      for (const ctrl of activeControllers) {
        const callId = ctrl.getSnapshot().callId
        if (!visibleCallIds.has(callId)) {
          return ctrl
        }
      }
      return null
    },
    availableBalanceWei(): bigint | undefined {
      if (
        this.balanceUnavailable ||
        this.activeWalletBalance?.total === undefined
      ) {
        return undefined
      }
      try {
        return BigInt(this.activeWalletBalance.total)
      } catch {
        return undefined
      }
    },
    peerStampSuggestion(): PeerStampSuggestionResult | undefined {
      if (this.isEmailThread || this.defaultStampWei === undefined)
        return undefined
      return computePeerStampSuggestion({
        messages: this.peerMessages ?? [],
        defaultStampWei: this.defaultStampWei,
        minimumStampWei: this.minimumStampWei ?? 0n,
      })
    },
    suggestedStampWei(): bigint | undefined {
      return this.peerStampSuggestion?.suggestedStampWei ?? this.defaultStampWei
    },
    lastPeerStampWei(): bigint | undefined {
      return this.peerStampSuggestion?.lastReceivedWei
    },
    isSuggestedIncrease(): boolean {
      return Boolean(
        this.isDefaultStampMode &&
          this.peerStampSuggestion?.isSuggestedIncrease,
      )
    },
    /** The stamp the next message carries, in the chain's display unit. It is the user's own
     * per-message override for this conversation (zero is a free message), else the converged
     * geometric suggestion for the peer (#820). */
    stampAmount: {
      set(stampAmount: string | number | null | undefined) {
        // An empty box or half-typed text is not an amount: the last valid one stands.
        const text = String(stampAmount ?? '').trim()
        if (!text) return
        let rawAmount: bigint
        try {
          rawAmount = activeChain.fromDisplayAmount(text)
        } catch {
          return
        }
        if (rawAmount < 0n) return
        const target = this.conversation?.id || this.recipientAddress
        if (!target) return
        this.chatStore.setStampWei({
          address: target,
          stampWei: rawAmount,
        })
      },
      get(): string {
        const target = this.conversation?.id || this.recipientAddress
        const explicit = target ? this.chatStore.getStampWei(target) : undefined
        const chosen =
          explicit ??
          this.suggestedStampWei ??
          (!this.isEmailThread && this.defaultStampWei !== undefined
            ? computePeerStampSuggestion({
                messages: this.peerMessages ?? [],
                defaultStampWei: this.defaultStampWei,
                minimumStampWei: this.minimumStampWei ?? 0n,
              }).suggestedStampWei
            : this.defaultStampWei)
        return chosen === undefined ? '' : activeChain.toDisplayAmount(chosen)
      },
    },
  },
  watch: {
    'availableBalanceWei': {
      immediate: true,
      handler() {
        this.sanitizeStaleEmailStampOverride()
      },
    },
    'defaultStampWei'() {
      this.sanitizeStaleEmailStampOverride()
    },
    'conversation.id'() {
      this.sanitizeStaleEmailStampOverride()
    },
    'messagingState.status'() {
      void this.refreshMinimumStamp()
    },
    'accountStatus.revision'() {
      void this.refreshMinimumStamp()
    },
    'accountStatus.status'() {
      void this.refreshMinimumStamp()
    },
    'oracle.current'() {
      void this.refreshMinimumStamp()
    },
    'chatStore.composeFocusRequest': {
      deep: true,
      handler(
        req:
          | { conversationId: string | null; nonce: number }
          | null
          | undefined,
      ) {
        if (!req || req.nonce <= this.lastHandledFocusNonce) return
        this.expectingWindowFocusUntil = Date.now() + 2000
        if (this.matchesConversation(req.conversationId)) {
          this.lastHandledFocusNonce = req.nonce
          this.scheduleComposeFocus(true)
        }
      },
    },
    'chatStore.activeConversationId'(newActiveId: string | null | undefined) {
      if (newActiveId && this.matchesConversation(newActiveId)) {
        const req = this.chatStore?.composeFocusRequest
        const force = Boolean(
          req &&
            req.nonce > this.lastHandledFocusNonce &&
            this.matchesConversation(req.conversationId),
        )
        if (force && req) {
          this.lastHandledFocusNonce = req.nonce
        }
        this.scheduleComposeFocus(force)
      }
    },
    'address'(newAddr: string, oldAddr: string) {
      if (oldAddr && oldAddr !== newAddr && !this.restoringDraft) {
        saveChatDraft(oldAddr, {
          message: this.message,
          attachments: this.attachments,
          replyDigest: this.replyDigest,
        })
      }
      const nextDraft = loadChatDraft(newAddr)
      this.restoringDraft = true
      this.message = nextDraft?.message ?? ''
      this.attachments = nextDraft?.attachments ?? []
      this.replyDigest = nextDraft?.replyDigest ?? null
      this.restoringDraft = false
      if (
        newAddr &&
        typeof this.chatStore?.setActiveConversation === 'function'
      ) {
        if (
          isChainAddress(newAddr) &&
          typeof this.chatStore?.setActiveChat === 'function'
        ) {
          this.chatStore.setActiveChat(newAddr)
        } else {
          this.chatStore.setActiveConversation(newAddr)
        }
      }
      void this.refreshMinimumStamp()
      // Another conversation opens on its newest message, wherever the last one was left.
      this.followBottom = true
      this.$nextTick(() => this.pinScrollToBottom())
      const req = this.chatStore?.composeFocusRequest
      const force = Boolean(
        req &&
          req.nonce > this.lastHandledFocusNonce &&
          this.matchesConversation(req.conversationId),
      )
      if (force && req) {
        this.lastHandledFocusNonce = req.nonce
      }
      this.focusComposeOnOpen(force)
      void this.runBlackjackDealer()
    },
    'message'() {
      if (this.restoringDraft) return
      saveChatDraft(this.address, {
        message: this.message,
        attachments: this.attachments,
        replyDigest: this.replyDigest,
      })
    },
    'replyDigest'() {
      if (this.restoringDraft) return
      saveChatDraft(this.address, {
        message: this.message,
        attachments: this.attachments,
        replyDigest: this.replyDigest,
      })
    },
    'attachments': {
      deep: true,
      handler() {
        if (this.restoringDraft) return
        saveChatDraft(this.address, {
          message: this.message,
          attachments: this.attachments,
          replyDigest: this.replyDigest,
        })
      },
    },
    'messages.length'(newLen: number, oldLen: number) {
      // Scroll to bottom if user was already there.
      this.scrollBottom()
      void this.runBlackjackDealer()
      if (newLen && oldLen !== undefined && newLen > oldLen) {
        const newMsgs = this.messages.slice(oldLen)
        const hasIncomingConfirmedStamps = newMsgs.some(
          msg =>
            !msg.outbound &&
            msg.status === 'confirmed' &&
            ((msg.stampValueWei !== undefined && msg.stampValueWei > 0n) ||
              (msg.stampPayments !== undefined &&
                msg.stampPayments.length > 0)),
        )
        if (hasIncomingConfirmedStamps) {
          void this.refreshBalance?.()
        }
      }
    },
    'sendingMessage'(sending: boolean) {
      if (!sending) void this.runBlackjackDealer()
    },
    'active'(newActive) {
      if (!newActive) {
        return
      }
      // Scroll to bottom only if the view was effectively in it's initial state.
      this.scrollBottom()
      // TODO: Scroll to last unread
    },
  },
})
</script>

<style lang="scss" scoped>
:deep() .message-color {
  background-color: var(--q-message-color);
}
:deep() .message-color-sent {
  background-color: var(--q-message-color-sent);
}
.chat-container {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  width: 100%;
  height: 100%;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
}

.chat-container > :deep(.q-page-container) {
  flex: 1 1 0% !important;
  min-height: 0 !important;
  height: auto !important;
  max-height: 100% !important;
  padding-bottom: 0 !important;
}

.chat-container > :deep(.q-page-container > .q-page) {
  height: 100% !important;
  max-height: 100% !important;
  min-height: 0 !important;
}

.chat-banner-overlay {
  z-index: 1;
}

.chat-floating-webrtc-call {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 1400;
  max-width: min(380px, calc(100% - 32px));
}

.chat-group-recipient {
  display: flex;
  align-items: center;
  opacity: 0.85;
}

// The composer sits in the chat column's flow (so the iOS keyboard pushes it up with the
// column), not where Quasar would fix it. In flow it no longer gets Quasar's `left` offset, so it
// starts after the open conversation-list drawer itself: a margin, not padding, so its box (top
// border, background) stays under the conversation pane and never runs across the list.
// Scoped, `.chat-container > .chat-footer` is (0,3,0): it must outrank the global
// `.q-layout .q-footer { bottom: var(--frank-kb-offset) !important }` (0,2,0), or with the iOS
// keyboard open that `bottom` would lift the in-flow composer a keyboard-height too high.
.chat-container > .chat-footer,
.chat-container > .chat-input-bar {
  position: relative !important;
  top: auto !important;
  bottom: auto !important;
  left: auto !important;
  right: auto !important;
  flex: 0 0 auto !important;
  width: auto !important;
  min-height: 64px;
  margin-left: var(--frank-drawer-offset, 0px);
  box-sizing: border-box;
  transform: none !important;
}

.chat-inline-sheet {
  max-height: min(72vh, 560px);
  overflow-y: auto;
  border-top: 1px solid rgba(128, 128, 128, 0.2);
}

.chat-inline-sheet-card {
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  border-radius: 14px;
}

:deep(.chat-input-toolbar) {
  min-height: 64px;
  padding-top: 8px;
  padding-bottom: max(8px, env(safe-area-inset-bottom, 0px));
  padding-left: max(14px, env(safe-area-inset-left, 0px));
  padding-right: max(14px, env(safe-area-inset-right, 0px));
  align-items: center;
  overflow: visible;
}

// Plain descendant selectors: in scoped styles `:global(x) .y` compiles to just `x`, which
// styled <html> itself. The composer toolbar's own keyboard rule lives in ChatInput.vue.
html.frank-keyboard-open .chat-footer,
html.frank-keyboard-open .chat-input-bar {
  min-height: 52px;
}

:deep(.chat-send-btn) {
  align-self: center;
}

:deep() .q-message-text--sent {
  border-radius: 18px 18px 4px 18px !important;
}

:deep() .q-message-text--received {
  border-radius: 18px 18px 18px 4px !important;
}

.screener-triage-banner {
  background: rgba(245, 158, 11, 0.12);
  border-bottom: 1px solid rgba(245, 158, 11, 0.35);
  z-index: 2;
}
</style>
