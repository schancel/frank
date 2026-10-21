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
        v-if="showUnverifiedPeerBanner"
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
        class="email-thread-subbar row items-start justify-between no-wrap q-mt-xs text-caption"
        v-if="allParticipants.length > 0 || parsedEmails.length > 0"
      >
        <div
          class="row items-baseline col q-mr-md participant-row"
          v-if="allParticipants.length > 0"
        >
          <q-icon
            name="people_outline"
            size="16px"
            color="grey-6"
            class="q-mr-xs flex-shrink-0"
          />
          <span class="text-weight-medium text-grey-7 q-mr-xs flex-shrink-0"
            >{{ $t('emailThread.participants') }}:</span
          >
          <span
            class="text-grey-8 participant-list"
            :title="allParticipants.join(', ')"
          >
            {{ allParticipants.join(', ') }}
          </span>
        </div>
        <div
          class="col-auto row items-center q-gutter-x-xs q-ml-auto flex-shrink-0"
          v-if="parsedEmails.length > 0"
        >
          <q-badge
            rounded
            outline
            color="grey-6"
            class="email-count-pill q-px-sm q-py-none text-caption text-weight-medium"
          >
            <q-icon name="chat_bubble_outline" size="12px" class="q-mr-xs" />
            {{ parsedEmails.length }}
            {{
              parsedEmails.length === 1
                ? $t('emailThread.messageSingle')
                : $t('emailThread.messagePlural')
            }}
          </q-badge>
        </div>
      </div>
    </div>

    <!-- Scrollable Email Message Cards Area -->
    <div class="col relative-position" style="min-height: 0; overflow: hidden">
      <q-scroll-area
        ref="emailScroll"
        class="q-px-none absolute full-width full-height column"
        :content-style="{ width: '100%', minWidth: '100%' }"
        :content-active-style="{ width: '100%', minWidth: '100%' }"
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
              class="q-mb-md email-card"
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
                  <q-avatar
                    size="36px"
                    :color="card.isOutbound ? 'secondary' : 'primary'"
                    text-color="white"
                    class="email-card-avatar"
                  >
                    <span class="text-weight-bold">{{
                      getInitials(card.fromName || card.fromAddress)
                    }}</span>
                  </q-avatar>
                </q-item-section>

                <q-item-section>
                  <div class="row items-center justify-between no-wrap">
                    <div class="row items-center no-wrap ellipsis col">
                      <span
                        class="text-weight-bold text-body2 q-mr-xs ellipsis sender-name"
                      >
                        {{
                          card.isOutbound
                            ? card.fromName || $t('selfChat.you', 'You')
                            : card.fromName || card.fromAddress
                        }}
                      </span>
                      <span
                        class="text-caption text-grey-6 ellipsis q-mr-xs sender-address"
                        v-if="card.fromName || card.isOutbound"
                      >
                        &lt;{{ card.fromAddress }}&gt;
                      </span>
                      <q-badge
                        v-if="isVerifiedGateway && card.isDkimVerified"
                        color="positive"
                        outline
                        class="text-caption q-px-xs q-ml-xs dkim-pill"
                        data-testid="dkim-badge"
                      >
                        <q-icon
                          name="verified_user"
                          size="12px"
                          class="q-mr-xs text-positive"
                        />
                        DKIM
                      </q-badge>
                      <q-badge
                        v-if="cardDeliveryBadge(card)"
                        :color="cardDeliveryBadge(card)!.color"
                        outline
                        class="text-caption q-px-xs q-ml-xs"
                        data-testid="email-delivery-badge"
                      >
                        <q-icon
                          :name="cardDeliveryBadge(card)!.icon"
                          size="12px"
                          class="q-mr-xs"
                        />
                        {{ cardDeliveryBadge(card)!.label }}
                      </q-badge>
                      <q-btn
                        v-if="isCardCancelable(card)"
                        flat
                        dense
                        no-caps
                        size="xs"
                        color="negative"
                        icon="close"
                        class="q-ml-xs q-px-xs"
                        :label="cancelSendLabel"
                        :aria-label="cancelSendLabel"
                        data-testid="email-card-cancel-btn"
                        @click.stop="cancelOrDiscardCard(card)"
                      />
                      <template v-else-if="isCardFailed(card)">
                        <q-btn
                          flat
                          dense
                          no-caps
                          size="xs"
                          color="primary"
                          icon="refresh"
                          class="q-ml-xs q-px-xs"
                          :label="retrySendLabel"
                          :aria-label="retrySendLabel"
                          data-testid="email-card-retry-btn"
                          @click.stop="retryFailedCard(card)"
                        />
                        <q-btn
                          flat
                          dense
                          no-caps
                          size="xs"
                          color="negative"
                          icon="delete_outline"
                          class="q-ml-xs q-px-xs"
                          :label="discardCardLabel"
                          :aria-label="discardCardLabel"
                          data-testid="email-card-discard-btn"
                          @click.stop="cancelOrDiscardCard(card)"
                        />
                      </template>
                    </div>
                    <div class="text-caption text-grey-6 text-no-wrap q-ml-sm">
                      {{ card.formattedDate }}
                    </div>
                  </div>

                  <!-- Collapsed summary preview -->
                  <div
                    class="row items-center justify-between text-caption text-grey-7 no-wrap collapsed-email-summary"
                    v-if="!isExpanded(card.id)"
                    data-test="collapsed-email-summary"
                    data-testid="collapsed-email-summary"
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
                        unelevated
                        no-caps
                        dense
                        size="sm"
                        color="primary"
                        class="frank-tonal-btn q-px-sm"
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
                    <div v-else>
                      <div
                        class="email-body-text text-body1"
                        v-html="
                          formatMessageBody(card.mainBody || card.textBody)
                        "
                      />
                      <div v-if="card.quotedBody" class="q-mt-sm">
                        <q-btn
                          unelevated
                          dense
                          no-caps
                          size="xs"
                          class="frank-tonal-btn q-px-sm"
                          icon="more_horiz"
                          :label="
                            isQuoteExpanded(card.id)
                              ? $t('emailThread.hideQuotedText')
                              : $t('emailThread.showQuotedText')
                          "
                          data-test="toggle-quoted-text"
                          data-testid="toggle-quoted-text"
                          @click.stop="toggleQuoteExpanded(card.id)"
                        />
                        <div
                          v-if="isQuoteExpanded(card.id)"
                          class="email-quoted-block q-mt-xs q-pl-sm text-body2 text-grey-7"
                          data-test="email-quoted-block"
                          data-testid="email-quoted-block"
                          v-html="formatMessageBody(card.quotedBody)"
                        />
                      </div>
                    </div>

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
                    class="q-px-md q-py-xs bg-grey-1 q-gutter-x-xs"
                    :class="{ 'bg-grey-10': $q.dark.isActive }"
                  >
                    <q-btn
                      v-if="isCardCancelable(card)"
                      unelevated
                      no-caps
                      dense
                      size="sm"
                      color="negative"
                      icon="close"
                      class="q-px-sm"
                      :label="cancelSendLabel"
                      :aria-label="cancelSendLabel"
                      data-testid="email-card-footer-cancel-btn"
                      @click.stop="cancelOrDiscardCard(card)"
                    />
                    <template v-else-if="isCardFailed(card)">
                      <q-btn
                        unelevated
                        no-caps
                        dense
                        size="sm"
                        color="primary"
                        icon="refresh"
                        class="frank-tonal-btn q-px-sm"
                        :label="retrySendLabel"
                        :aria-label="retrySendLabel"
                        data-testid="email-card-footer-retry-btn"
                        @click.stop="retryFailedCard(card)"
                      />
                      <q-btn
                        unelevated
                        no-caps
                        dense
                        size="sm"
                        color="negative"
                        icon="delete_outline"
                        class="q-px-sm"
                        :label="discardCardLabel"
                        :aria-label="discardCardLabel"
                        data-testid="email-card-footer-discard-btn"
                        @click.stop="cancelOrDiscardCard(card)"
                      />
                    </template>
                    <q-btn
                      unelevated
                      no-caps
                      dense
                      size="sm"
                      icon="reply"
                      class="frank-tonal-btn q-px-sm"
                      :label="$t('emailThread.reply')"
                      @click.stop="prepareReply(card, 'reply')"
                    />
                    <q-btn
                      unelevated
                      no-caps
                      dense
                      size="sm"
                      icon="reply_all"
                      class="frank-tonal-btn q-px-sm"
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

      <!-- Stamp / Network Status Banner (full width so it never wraps composer action buttons) -->
      <div
        v-if="stampStatus"
        class="text-caption text-warning q-mb-xs row items-center no-wrap composer-stamp-status"
        role="status"
        data-testid="composer-stamp-status"
      >
        <q-icon name="info_outline" size="15px" class="q-mr-xs col-auto" />
        <span class="col">{{ stampStatus }}</span>
      </div>

      <!-- Pre-Send Insufficient Stamp Balance Banner -->
      <div
        v-if="insufficientStampBalanceReason"
        class="row items-center justify-between no-wrap q-px-sm q-py-xs q-mb-xs rounded-borders bg-negative text-white text-caption"
        role="alert"
        data-testid="email-insufficient-balance-warning"
      >
        <div class="row items-center no-wrap col ellipsis">
          <q-icon name="warning" size="14px" class="q-mr-xs" />
          <span class="ellipsis">{{ insufficientStampBalanceReason }}</span>
        </div>
        <q-btn
          v-if="!defaultStampMode"
          flat
          dense
          no-caps
          size="xs"
          color="white"
          class="q-ml-sm col-auto"
          :label="resetFeeButtonLabel"
          :aria-label="resetFeeButtonLabel"
          data-testid="email-reset-fee-btn"
          @click="resetToDefaultStamp"
        />
      </div>

      <!-- Composer Controls Header -->
      <div
        class="row items-center justify-between no-wrap q-mb-sm composer-header-bar"
      >
        <div class="row items-center no-wrap q-gutter-x-xs">
          <template v-if="showReplyModeToggle">
            <q-btn-toggle
              v-model="replyMode"
              dense
              rounded
              unelevated
              no-caps
              toggle-color="primary"
              color="grey-3"
              text-color="grey-8"
              size="sm"
              class="reply-mode-toggle"
              :options="replyOptions"
              @update:model-value="onReplyModeChanged"
            />
          </template>
          <span
            v-else-if="isOutboundFollowUp"
            class="text-weight-bold text-caption text-primary composer-draft-indicator"
          >
            <q-icon name="forward_to_inbox" size="18px" class="q-mr-xs" />
            {{ $t('emailThread.followUp', 'Follow-up') }}
          </span>
          <span
            v-else-if="isDraft"
            class="text-weight-bold text-caption text-primary composer-draft-indicator"
          >
            <q-icon name="edit_note" size="18px" class="q-mr-xs" />
            {{ $t('emailThread.newEmail') }}
          </span>
          <q-btn
            unelevated
            dense
            no-caps
            size="sm"
            class="recipient-toggle-btn frank-tonal-btn q-px-sm"
            :class="{ 'recipient-toggle-btn--active': showCc }"
            :label="
              showCc ? $t('emailThread.hideCc') : $t('emailThread.showCc')
            "
            @click="showCc = !showCc"
          />
          <q-btn
            unelevated
            dense
            no-caps
            size="sm"
            class="recipient-toggle-btn frank-tonal-btn q-px-sm"
            :class="{ 'recipient-toggle-btn--active': showBcc }"
            :label="
              showBcc ? $t('emailThread.hideBcc') : $t('emailThread.showBcc')
            "
            @click="showBcc = !showBcc"
          />
        </div>
        <div
          class="composer-top-actions row items-center no-wrap q-gutter-x-xs"
          data-testid="composer-top-actions"
        >
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
            icon="attach_file"
            :disable="sending"
            class="attach-btn chat-attach-btn"
            @click="triggerFileInput"
            data-testid="attach-file-btn"
          >
            <q-tooltip>{{
              $t('emailThread.attachFiles', 'Attach files')
            }}</q-tooltip>
          </q-btn>
          <!-- Email Stamp Price / Multiplier Pill -->
          <q-btn
            flat
            rounded
            no-caps
            icon="local_post_office"
            class="chat-stamp-btn q-mr-xs"
            :aria-label="$t('a11y.stampPayment')"
            aria-haspopup="menu"
            :disable="sending"
            data-testid="email-stamp-btn"
          >
            <span
              v-if="stampAvu"
              class="chat-stamp-pill-avu q-ml-xs"
              :class="{ 'chat-stamp-pill-avu--stale': stampAvu.stale }"
              data-testid="stamp-pill-avu"
              ><q-icon
                v-if="stampAvu.stale"
                name="schedule"
                size="12px"
                class="chat-stamp-pill-stale q-mr-xs"
                data-testid="stamp-pill-avu-stale"
              />{{ stampAvu.figure }}</span
            >
            <span
              class="chat-stamp-pill-text q-ml-xs"
              :class="{ 'chat-stamp-pill-text--secondary': stampAvu }"
              >{{ stampPillText }}</span
            >
            <span
              v-if="!stampAvu && stampMultiplier && stampMultiplier !== '1'"
              class="chat-stamp-pill-multiple q-ml-xs"
              data-testid="stamp-pill-multiple"
              >{{ stampMultiplier }}×</span
            >
            <q-tooltip max-width="280px">
              <div data-testid="stamp-tooltip-amount">{{ stampLabel }}</div>
              <div v-if="stampAvu" data-testid="stamp-tooltip-avu">
                {{ $t('chatInput.stampChipAvu', { value: stampAvu.line }) }}
              </div>
              <div>
                {{
                  $t(
                    'chatInput.stampWhat',
                    'A stamp fee is burned to prioritize and deliver email via the gateway.',
                  )
                }}
              </div>
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
                    {{
                      $t('chatInput.stampPayment', 'Email Stamp / Delivery Fee')
                    }}
                  </div>
                </div>

                <div
                  class="text-caption chat-stamp-explanation q-mb-sm"
                  data-testid="stamp-explanation"
                >
                  <div>
                    {{
                      $t(
                        'emailThread.stampExplanation',
                        'The email gateway requires a stamp (default 0.01 MONT) to bridge and dispatch email.',
                      )
                    }}
                  </div>
                  <div
                    v-if="defaultStampMode && stampBasisNote"
                    data-testid="stamp-basis-note"
                  >
                    {{ stampBasisNote }}
                  </div>
                </div>

                <q-input
                  v-model="innerStampAmount"
                  dense
                  autofocus
                  type="number"
                  min="0"
                  step="any"
                  data-testid="email-input-stamp-amount"
                  :suffix="chainUnit"
                  :label="$t('chatInput.stampPayment', 'Stamp Amount')"
                />
                <q-btn
                  flat
                  dense
                  no-caps
                  color="primary"
                  data-testid="email-input-stamp-free"
                  :label="$t('chatInput.stampFree', 'Free')"
                  :disable="sending"
                  @click="chooseFreeStamp"
                />

                <div class="q-mt-sm q-px-md">
                  <q-slider
                    v-model="decadeIndex"
                    class="q-mt-md"
                    :min="0"
                    :max="(multiplierSteps?.length || 1) - 1"
                    :disable="sending"
                    :step="1"
                    label
                    label-always
                    :label-value="stampMultiplier ? `${stampMultiplier}×` : ''"
                    markers
                    :marker-labels="decadeMarkerLabels"
                    data-testid="email-input-stamp-slider"
                  />
                </div>

                <div
                  class="text-caption q-mt-sm"
                  style="overflow-wrap: anywhere"
                  data-testid="email-input-stamp-selection"
                >
                  {{ sliderLabelValue }}
                </div>
                <div class="text-caption text-grey-7 q-mt-sm">
                  {{
                    $t(
                      'chatInput.stampQuickSelection',
                      'Quick multiplier selection',
                    )
                  }}
                </div>

                <div
                  v-if="!isDefaultStamp"
                  class="row items-center justify-between q-mt-sm"
                >
                  <div class="text-caption text-grey-7">
                    {{
                      $t('chatInput.defaultStamp', {
                        amount: defaultStampText,
                      })
                    }}
                  </div>
                  <q-btn
                    flat
                    dense
                    no-caps
                    size="sm"
                    color="primary"
                    :label="$t('chatInput.stampReset', 'Default')"
                    @click="resetToDefaultStamp"
                    data-testid="email-input-stamp-reset"
                  />
                </div>
              </div>
            </q-menu>
          </q-btn>
          <q-btn
            unelevated
            no-caps
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
            class="send-btn q-px-md"
            data-testid="send-email-btn"
          >
            <q-tooltip>{{ sendButtonTooltip }}</q-tooltip>
          </q-btn>
        </div>
      </div>

      <!-- Recipient Container -->
      <div class="recipients-container q-mb-sm">
        <!-- Recipient To Field -->
        <div class="recipient-row row items-center no-wrap">
          <span class="recipient-label col-auto"
            >{{ $t('emailThread.to') }}:</span
          >
          <div class="col row items-center q-gutter-xs">
            <q-chip
              v-for="(addr, idx) in toList"
              :key="idx"
              removable
              dense
              size="sm"
              class="recipient-chip q-ma-none text-caption"
              @remove="removeToRecipient(idx)"
            >
              <q-avatar
                icon="person"
                size="18px"
                color="primary"
                text-color="white"
                class="q-mr-xs"
              />
              <span class="ellipsis recipient-chip-text" :title="addr">{{
                addr
              }}</span>
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
        <div
          class="recipient-row row items-center no-wrap"
          v-if="showCc || ccList.length > 0"
        >
          <span class="recipient-label col-auto"
            >{{ $t('emailThread.cc') }}:</span
          >
          <div class="col row items-center q-gutter-xs">
            <q-chip
              v-for="(addr, idx) in ccList"
              :key="idx"
              removable
              dense
              size="sm"
              class="recipient-chip recipient-chip--cc q-ma-none text-caption"
              @remove="removeCcRecipient(idx)"
            >
              <span class="ellipsis recipient-chip-text" :title="addr">{{
                addr
              }}</span>
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
          class="recipient-row row items-center no-wrap"
          v-if="showBcc || bccList.length > 0"
          data-testid="composer-bcc-row"
        >
          <span class="recipient-label col-auto"
            >{{ $t('emailThread.bcc') }}:</span
          >
          <div class="col row items-center q-gutter-xs">
            <q-chip
              v-for="(addr, idx) in bccList"
              :key="idx"
              removable
              dense
              size="sm"
              class="recipient-chip recipient-chip--bcc q-ma-none text-caption"
              @remove="removeBccRecipient(idx)"
            >
              <span class="ellipsis recipient-chip-text" :title="addr">{{
                addr
              }}</span>
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
        <div class="recipient-row row items-center no-wrap">
          <span class="recipient-label col-auto">{{
            $t('emailThread.subjectLabel')
          }}</span>
          <q-input
            ref="subjectInputRef"
            v-model="subject"
            dense
            borderless
            :placeholder="$t('emailThread.subjectPlaceholder')"
            class="col text-caption input-inline"
          />
        </div>
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
          unelevated
          dense
          no-caps
          size="sm"
          icon="reply"
          class="frank-tonal-btn q-px-sm"
          :label="$t('emailThread.quoteOriginal', 'Quote Original')"
          @click="insertOriginalQuote(activeReplyCard)"
        >
          <q-tooltip>{{
            $t('emailThread.quoteOriginal', 'Quote Original')
          }}</q-tooltip>
        </q-btn>
        <q-space />
        <q-btn
          unelevated
          dense
          no-caps
          size="sm"
          class="frank-tonal-btn q-px-sm"
          :icon="isPreviewMode ? 'edit' : 'visibility'"
          :label="
            isPreviewMode
              ? $t('emailThread.edit', 'Edit')
              : $t('emailThread.preview', 'Preview')
          "
          @click="isPreviewMode = !isPreviewMode"
        />
      </div>

      <!-- Message Textarea -->
      <div class="composer-body-container">
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
          :rows="isDraft ? 6 : 4"
          outlined
          dense
          :placeholder="composerPlaceholder"
          class="email-textarea"
          data-testid="email-body-textarea"
          :disable="sending"
          @keydown.ctrl.enter="handleSend"
          @keydown.meta.enter="handleSend"
        />
      </div>
    </div>
  </q-page>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import {
  useChatStore,
  type Conversation,
  type ChatMessage,
} from 'src/stores/chats'
import type { EmailItem, MessageItem } from '@frank/cashweb/types/messages'
import type { EmailParty, EmailAttachment } from '@frank/codec'
import {
  formatCompactAmount,
  formatDisplayAmount,
} from 'src/utils/chain-amount'
import { STAMP_MULTIPLIER_TENTHS } from 'src/components/chat/ChatInput.vue'
import { defaultStaticStampForChain } from '@frank/wallet/oracle'
import { activeChain } from '@frank/wallet/chain'
import {
  stampAvu as stampAvuOf,
  stampMultiplierText,
  type StampAvu,
} from 'src/utils/stamp-display'
import { purify, renderMarkdown } from 'src/utils/markdown'
import {
  applyMarkdownFormat,
  type MarkdownFormatAction,
} from 'src/utils/post-editor'
import { useSettingsStore } from 'src/stores/settings'
import { useProfileStore } from 'src/stores/my-profile'
import { errorNotify } from 'src/utils/notifications'
import { isChainAddress } from 'src/utils/chain-address'
import {
  getOwnCanonicalAddress,
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
} from 'src/utils/own-address'
import {
  sendsWaitingForChain,
  sendsWaitingForPreviousPayment,
} from 'src/utils/outgoing-waiting'
import {
  THREAD_REPLY_ALIAS_LOCAL_RE,
  GATEWAY_USERNAME_LOCAL_RE,
  isValidRecipientAddress,
  extractPartyFromRaw,
  decodeQuotedPrintableIfNeeded,
  splitQuotedEmailBody,
  getSenderInitials,
  formatEmailParties,
  formatAttachmentBytes,
  parseEmailCardsFromMessages,
  type ParsedEmailCard,
  type EmailReply,
} from './email-thread-parser'

export {
  extractPartyFromRaw,
  decodeQuotedPrintableIfNeeded,
  splitQuotedEmailBody,
  type ParsedEmailCard,
  type EmailReply,
}

const DEFAULT_STAMP_MULTIPLIER_TENTHS = [
  1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 80, 100, 150, 200, 300, 500, 800, 1000,
  1500, 2000, 3000, 5000, 8000, 10000,
]

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
    stampAmount: {
      type: String,
      default: () => '',
    },
    minimumStampWei: {
      type: BigInt as unknown as PropType<bigint>,
      default: () => 0n,
    },
    defaultStampWei: {
      type: BigInt as unknown as PropType<bigint>,
      default: undefined,
    },
    availableBalanceWei: {
      type: BigInt as unknown as PropType<bigint | undefined>,
      default: undefined,
    },
    stampBasisNote: { type: String, default: '' },
    defaultStampMode: { type: Boolean, default: true },
    stampUnavailable: { type: String, default: '' },
  },
  emits: {
    'sendReply': (_payload: EmailReply) => true,
    'update:stampAmount': (_amount: string) => true,
    'resetStampDefault': () => true,
    'navigateThread': (_direction: 'next' | 'prev') => true,
    'archiveThread': () => true,
  },
  data() {
    return {
      ownAddress: useReactiveOwnCanonicalAddress(),
      composerActive: true,
      composerInitialized: false,
      preparingSend: false,
      replyRouting: 'peer' as 'peer' | 'gateway',
      typedStamp: null as string | null,
      multiplierSteps:
        (typeof STAMP_MULTIPLIER_TENTHS !== 'undefined' &&
          STAMP_MULTIPLIER_TENTHS) ||
        DEFAULT_STAMP_MULTIPLIER_TENTHS,
      expandedMap: {} as Record<string, boolean>,
      quoteExpandedMap: {} as Record<string, boolean>,
      focusedCardIndex: 0,
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
      if (this.conversation?.verifiedGateway === true) return true
      if (!this.emailGatewayAddress) return false
      if (
        this.peerFrankAddress &&
        sameCanonicalAddress(this.peerFrankAddress, this.emailGatewayAddress)
      ) {
        return true
      }
      if (
        this.conversation?.address &&
        sameCanonicalAddress(
          this.conversation.address,
          this.emailGatewayAddress,
        )
      ) {
        return true
      }
      return false
    },
    showUnverifiedPeerBanner(): boolean {
      if (this.isVerifiedGateway) return false
      // Only display unverified warning if an inbound email arrived from an unverified peer
      return this.messages.some(m => !m.outbound)
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
      let tip = ''
      if (this.isVerifiedGateway) {
        tip = 'Send via Frank Email Gateway (Ctrl+Enter)'
      } else if (this.replyRouting === 'gateway') {
        tip =
          'Route through Frank Email Gateway to dispatch to external recipients (Ctrl+Enter)'
      } else {
        tip =
          'Reply will only be delivered as a Frank direct message to the peer, not dispatched to external email addresses via MX (Ctrl+Enter)'
      }
      const fee = this.stampPillText
      return fee ? `${tip} [Fee: ${fee}]` : tip
    },
    chainUnit() {
      return activeChain.unit
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
    decadeMarkerLabels(): Record<number, string> {
      return {
        0: this.$t('chatInput.stampFree', 'Free'),
        5: '1×',
        8: '10×',
        11: '100×',
        14: '1k×',
        17: '10k×',
      }
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
        const steps = this.multiplierSteps || DEFAULT_STAMP_MULTIPLIER_TENTHS
        for (let i = 0; i < steps.length; i++) {
          const raw = (this.effectiveDefaultStampWei * BigInt(steps[i])) / 10n
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
        const steps = this.multiplierSteps || DEFAULT_STAMP_MULTIPLIER_TENTHS
        const i = Math.max(0, Math.min(steps.length - 1, Math.round(index)))
        const raw = this.multipliedStamp(steps[i])
        this.$emit('update:stampAmount', activeChain.toDisplayAmount(raw))
      },
    },
    sliderLabelValue(): string {
      if (this.stampWei === 0n) return this.$t('chatInput.stampFree', 'Free')
      if (this.stampWei === undefined)
        return this.$t('chatInput.stampQuoteUnavailable', 'Quote unavailable')
      const amount = `${activeChain.toDisplayAmount(this.stampWei)} ${
        this.chainUnit
      }`
      return this.stampMultiplier
        ? this.$t('chatInput.stampMultiplierValue', {
            multiplier: this.stampMultiplier,
            amount,
          })
        : amount
    },
    /** The stamp as a multiple of the default stamp ("≈1.0511"); the default is priced in
     * AVU, so a fixed coin amount drifts from 1× as the coin's price moves. */
    stampMultiplier(): string {
      return stampMultiplierText(this.stampWei, this.effectiveDefaultStampWei)
    },
    /** What the stamp is worth in AVU; undefined with no rate. */
    stampAvu(): StampAvu | undefined {
      return stampAvuOf(activeChain, this.stampWei)
    },
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
      const stamp = this.effectiveDefaultStampWei
      return stamp === undefined || stamp <= 0n
        ? this.$t('chatInput.stampQuoteUnavailable', 'Quote unavailable')
        : formatCompactAmount(activeChain, stamp)
    },
    stampPillText(): string {
      if (this.stampWei === 0n) return this.$t('chatInput.stampFree', 'Free')
      try {
        return formatCompactAmount(
          activeChain,
          activeChain.fromDisplayAmount(this.stampAmount),
        )
      } catch {
        return `${this.stampAmount} ${activeChain.unit}`
      }
    },
    stampLabel(): string {
      if (this.stampWei === 0n)
        return this.$t('chatInput.stampChipFree', 'Free stamp')
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
    emailGatewayAddress(): string {
      try {
        const settingsStore = useSettingsStore()
        return settingsStore.emailGatewayAddress
      } catch {
        return ''
      }
    },
    parsedEmails(): ParsedEmailCard[] {
      return parseEmailCardsFromMessages({
        messages: this.messages,
        conversation: this.conversation,
        recipientAddress: this.recipientAddress,
        threadSubject: this.threadSubject,
      })
    },
    isDraft(): boolean {
      return !this.messages || this.messages.length === 0
    },
    replyOptions(): Array<{ label: string; value: 'reply' | 'reply_all' }> {
      return [
        { label: this.$t('emailThread.replyAll'), value: 'reply_all' },
        { label: this.$t('emailThread.replySender'), value: 'reply' },
      ]
    },
    threadSubject(): string {
      if (this.subject && (!this.messages || this.messages.length === 0)) {
        return this.subject
      }
      if (this.conversation?.name) {
        return this.conversation.name
      }
      if (this.messages) {
        for (let i = this.messages.length - 1; i >= 0; i--) {
          const msg = this.messages[i]
          const emailItem = msg.items?.find(it => it.type === 'email') as
            | EmailItem
            | undefined
          if (emailItem?.subject && emailItem.subject !== 'No Subject') {
            return emailItem.subject
          }
        }
      }
      if (this.toList.length > 0) {
        return `Draft to ${this.toList[0]}`
      }
      return this.$t('emailThread.newDraftTitle', 'New Email Thread')
    },
    allParticipants(): string[] {
      const participants = new Map<string, { address: string; name?: string }>()
      const gatewayDomain = this.getGatewayDomain()
      const ownAddrs = this.getOwnCanonicalAddresses()
      const ownUsername =
        this.getPreferredGatewayUsername(ownAddrs[0], gatewayDomain) || ''

      const addParticipant = (
        input: string | EmailParty | undefined | null,
      ) => {
        const party = extractPartyFromRaw(input)
        if (!party) return
        const isSelf = this.isSelfOrThreadAliasAddress(party.address)
        const key = isSelf ? '__self__' : party.address.trim().toLowerCase()
        const existing = participants.get(key)
        if (!existing) {
          participants.set(key, {
            address: party.address.trim(),
            ...(party.name ? { name: party.name } : {}),
          })
          return
        }
        if (isSelf) {
          const existingRank = this.getSelfAddressRank(existing.address)
          const incomingRank = this.getSelfAddressRank(party.address)
          if (incomingRank > existingRank) {
            existing.address = party.address.trim()
          }
        }
        if (!existing.name && party.name) {
          existing.name = party.name
        }
      }

      for (const email of this.parsedEmails) {
        addParticipant({ address: email.fromAddress, name: email.fromName })
        for (const party of email.to || []) {
          addParticipant(party)
        }
        for (const party of email.cc || []) {
          addParticipant(party)
        }
      }
      if (this.toList.length > 0) {
        for (const t of this.toList) {
          addParticipant(t)
        }
      }
      if (participants.size === 0 && this.conversation?.emailRecipient) {
        addParticipant(this.conversation.emailRecipient)
      }

      const selfEntry = participants.get('__self__')
      if (selfEntry) {
        const currentRank = this.getSelfAddressRank(selfEntry.address)
        if (
          ownUsername &&
          !THREAD_REPLY_ALIAS_LOCAL_RE.test(ownUsername) &&
          currentRank < 4
        ) {
          selfEntry.address = `${ownUsername}@${gatewayDomain}`
        } else if (currentRank === 1 && ownAddrs.length > 0) {
          selfEntry.address = `${ownAddrs[0]}@${gatewayDomain}`
        }
      }

      return Array.from(participants.values()).map(p =>
        p.name ? `${p.name} <${p.address}>` : p.address,
      )
    },
    isOutboundFollowUp(): boolean {
      if (this.isDraft) return false
      const target = this.activeReplyCard || this.latestEmail
      return Boolean(target?.isOutbound)
    },
    showReplyModeToggle(): boolean {
      if (this.isDraft) return false
      const target = this.activeReplyCard || this.latestEmail
      if (!target || target.isOutbound) return false
      return this.canReplyAll(target)
    },
    composerPlaceholder(): string {
      if (this.isDraft || this.isOutboundFollowUp) {
        return this.$t('emailThread.writeMessagePlaceholder')
      }
      return this.$t('emailThread.writeReplyPlaceholder')
    },
    canSend(): boolean {
      if (
        this.conversation?.verifiedGateway === true &&
        !this.isVerifiedGateway
      )
        return false
      if (this.isVerifiedGateway || this.replyRouting === 'gateway') {
        if (!this.emailGatewayAddress) return false
        if (
          this.isVerifiedGateway &&
          !sameCanonicalAddress(
            this.peerFrankAddress,
            this.emailGatewayAddress,
          ) &&
          !sameCanonicalAddress(
            this.conversation?.address ?? '',
            this.emailGatewayAddress,
          )
        )
          return false
      }
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
    insufficientStampBalanceReason(): string | null {
      if (
        this.stampWei !== undefined &&
        this.stampWei > 0n &&
        this.availableBalanceWei !== undefined &&
        this.stampWei > this.availableBalanceWei
      ) {
        return `Not enough ${
          this.chainUnit
        }: need ${activeChain.toDisplayAmount(this.stampWei)} ${
          this.chainUnit
        }, have ${activeChain.toDisplayAmount(this.availableBalanceWei)} ${
          this.chainUnit
        }`
      }
      return null
    },
    resetFeeButtonLabel(): string {
      return this.$t('emailThread.resetFeeToDefault')
    },
    cancelSendLabel(): string {
      return this.$t('chatMessage.cancelSend')
    },
    retrySendLabel(): string {
      return this.$t('chatMessage.retrySend')
    },
    discardCardLabel(): string {
      return this.$t('chatMessage.discardSend')
    },
    latestEmail(): ParsedEmailCard | undefined {
      return (
        this.findDefaultReplyTargetCard(this.parsedEmails) ??
        this.parsedEmails[this.parsedEmails.length - 1]
      )
    },
  },
  watch: {
    parsedEmails: {
      immediate: true,
      handler(cards: ParsedEmailCard[]) {
        if (cards.length > 0) {
          // Default latest message and any unread messages to expanded, earlier read ones collapsed
          const latestId = cards[cards.length - 1].id
          if (!(latestId in this.expandedMap)) {
            this.expandedMap[latestId] = true
          }
          for (const card of cards) {
            if (card.isUnread && !(card.id in this.expandedMap)) {
              this.expandedMap[card.id] = true
            }
          }
          this.focusedCardIndex = cards.length - 1
        }
        // This component is keyed by conversation ID. Initialize once; empty fields do not
        // imply an untouched draft or permission to replace an explicitly selected parent.
        const defaultTarget = this.findDefaultReplyTargetCard(cards)
        if (!this.composerInitialized) {
          this.composerInitialized = true
          if (defaultTarget) this.setupComposerDefaults(defaultTarget)
          else this.setupNewDraftDefaults()
        } else if (
          this.activeReplyCard &&
          defaultTarget &&
          (this.activeReplyCard.status === 'error' ||
            this.activeReplyCard.status === 'pending' ||
            this.activeReplyCard.status === 'payment-pending' ||
            !cards.some(c => c.id === this.activeReplyCard?.id))
        ) {
          this.setupComposerDefaults(defaultTarget)
        }
      },
    },
  },
  beforeUnmount() {
    this.composerActive = false
  },
  methods: {
    getGatewayDomain(): string {
      try {
        const settings = useSettingsStore()
        return (
          settings.acceptedEmailGateway?.domain ||
          settings.advertisedEmailGateway?.domain ||
          'signet.mx'
        ).trim()
      } catch {
        return 'signet.mx'
      }
    },
    getPreferredGatewayUsername(
      canonicalAddress?: string,
      gatewayDomain?: string,
    ): string | undefined {
      const domain = (gatewayDomain || this.getGatewayDomain())
        .trim()
        .toLowerCase()
      try {
        const settings = useSettingsStore()
        if (
          settings.emailGatewayStatus === 'changed' ||
          settings.emailGatewayStatus === 'error'
        ) {
          return undefined
        }
        if (settings.emailGatewayRelayOrigin) {
          if (!settings.advertisedEmailGateway) {
            return undefined
          }
          if (
            settings.advertisedEmailGateway.domain.trim().toLowerCase() !==
            domain
          ) {
            return undefined
          }
          if (
            settings.acceptedEmailGateway?.relayOrigin &&
            settings.acceptedEmailGateway.relayOrigin !==
              settings.emailGatewayRelayOrigin
          ) {
            return undefined
          }
        } else if (
          settings.advertisedEmailGateway &&
          settings.advertisedEmailGateway.domain.trim().toLowerCase() !== domain
        ) {
          return undefined
        }
        if (
          settings.emailGatewayOverride &&
          settings.advertisedEmailGateway &&
          !sameCanonicalAddress(
            settings.emailGatewayOverride.address,
            settings.advertisedEmailGateway.address,
          )
        ) {
          return undefined
        }

        const profileStore = useProfileStore()
        if (profileStore.unpublished === true) {
          return undefined
        }
        if (
          canonicalAddress &&
          profileStore.owner &&
          !sameCanonicalAddress(profileStore.owner, canonicalAddress)
        ) {
          return undefined
        }
        if (
          profileStore.emailBridgeGatewayAddress &&
          this.emailGatewayAddress &&
          !sameCanonicalAddress(
            profileStore.emailBridgeGatewayAddress,
            this.emailGatewayAddress,
          )
        ) {
          return undefined
        }

        const rawUsername = (profileStore.profile?.username || '')
          .trim()
          .toLowerCase()
        if (
          !rawUsername ||
          !GATEWAY_USERNAME_LOCAL_RE.test(rawUsername) ||
          THREAD_REPLY_ALIAS_LOCAL_RE.test(rawUsername)
        ) {
          return undefined
        }
        return rawUsername
      } catch {
        return undefined
      }
    },
    getOwnCanonicalAddresses(): string[] {
      const candidates = new Set<string>()
      const rawOwn =
        typeof this.ownAddress === 'string'
          ? this.ownAddress
          : (this.ownAddress as any)?.value
      if (rawOwn && typeof rawOwn === 'string' && rawOwn.trim().length >= 3) {
        candidates.add(rawOwn.trim().toLowerCase())
      }
      try {
        const profileStore = useProfileStore()
        if (profileStore.owner && profileStore.owner.trim().length >= 3) {
          candidates.add(profileStore.owner.trim().toLowerCase())
        }
      } catch {
        /* ignore */
      }
      for (const msg of this.messages || []) {
        if (!msg.outbound) continue
        if (msg.senderAddress && isChainAddress(msg.senderAddress.trim())) {
          candidates.add(msg.senderAddress.trim().toLowerCase())
        }
        const emailItem = msg.items?.find(it => it.type === 'email') as
          | EmailItem
          | undefined
        const fromParsed = extractPartyFromRaw(emailItem?.from)
        if (fromParsed) {
          const addr = fromParsed.address.trim()
          const atIdx = addr.lastIndexOf('@')
          const local = (atIdx >= 0 ? addr.slice(0, atIdx) : addr).replace(
            /^u\./i,
            '',
          )
          if (isChainAddress(local)) {
            candidates.add(local.toLowerCase())
          }
        }
      }
      return Array.from(candidates)
    },
    isSelfOrThreadAliasAddress(rawAddr: string | undefined | null): boolean {
      if (!rawAddr) return false
      const parsed = extractPartyFromRaw(rawAddr)
      const addr = (parsed ? parsed.address : rawAddr).trim().toLowerCase()
      if (!addr) return false

      const gatewayDomain = this.getGatewayDomain().toLowerCase()
      const ownAddrs = this.getOwnCanonicalAddresses()

      let ownUsername = ''
      try {
        const profileStore = useProfileStore()
        ownUsername = (profileStore.profile?.username || '')
          .trim()
          .toLowerCase()
      } catch {
        /* ignore */
      }

      const atIdx = addr.lastIndexOf('@')
      const localPart = atIdx >= 0 ? addr.slice(0, atIdx) : addr
      const domainPart = atIdx >= 0 ? addr.slice(atIdx + 1) : ''

      for (const own of ownAddrs) {
        if (
          addr === own ||
          localPart === own ||
          localPart === `u.${own}` ||
          sameCanonicalAddress(localPart.replace(/^u\./i, ''), own)
        ) {
          return true
        }
      }

      if (domainPart === gatewayDomain) {
        if (ownUsername && localPart === ownUsername) {
          return true
        }
        if (THREAD_REPLY_ALIAS_LOCAL_RE.test(localPart)) {
          return true
        }
      }

      return false
    },
    getSelfAddressRank(rawAddr: string): number {
      const addr = rawAddr.trim().toLowerCase()
      const gatewayDomain = this.getGatewayDomain().toLowerCase()
      const atIdx = addr.lastIndexOf('@')
      if (atIdx < 0) return 2
      const local = addr.slice(0, atIdx)
      const domain = addr.slice(atIdx + 1)
      if (domain === gatewayDomain && THREAD_REPLY_ALIAS_LOCAL_RE.test(local)) {
        return 1
      }
      const stripped = local.replace(/^u\./i, '')
      if (isChainAddress(stripped)) {
        return 3
      }
      return 4
    },
    setupNewDraftDefaults() {
      const recipient =
        this.conversation?.emailRecipient ||
        (this.conversation?.topic?.includes('@')
          ? this.conversation.topic
          : undefined) ||
        (this.conversation?.name?.includes('@')
          ? this.conversation.name
          : undefined)

      if (
        recipient &&
        isValidRecipientAddress(recipient) &&
        !this.toList.includes(recipient)
      ) {
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
    focusReplyComposer() {
      this.focusInput(this.$refs.bodyInputRef)
      const textarea = this.getTextareaElement()
      textarea?.focus?.()
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
    isQuoteExpanded(id: string): boolean {
      return !!this.quoteExpandedMap[id]
    },
    toggleQuoteExpanded(id: string) {
      this.quoteExpandedMap[id] = !this.quoteExpandedMap[id]
    },
    toggleAllExpanded() {
      this.allExpanded = !this.allExpanded
      for (const card of this.parsedEmails) {
        this.expandedMap[card.id] = this.allExpanded
      }
    },
    handleTriageKeydown(event: KeyboardEvent): boolean {
      if (event.metaKey || event.ctrlKey || event.altKey) return false
      const target = (event.target ||
        document.activeElement) as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return false
      }
      const key = event.key.toLowerCase()
      const cards = this.parsedEmails
      if (key === 'j') {
        event.preventDefault()
        if (this.focusedCardIndex < cards.length - 1) {
          this.focusedCardIndex += 1
          const nextCard = cards[this.focusedCardIndex]
          if (nextCard) this.expandedMap[nextCard.id] = true
        } else {
          this.$emit('navigateThread', 'next')
        }
        return true
      }
      if (key === 'k') {
        event.preventDefault()
        if (this.focusedCardIndex > 0) {
          this.focusedCardIndex -= 1
          const prevCard = cards[this.focusedCardIndex]
          if (prevCard) this.expandedMap[prevCard.id] = true
        } else {
          this.$emit('navigateThread', 'prev')
        }
        return true
      }
      if (key === 'r') {
        event.preventDefault()
        const targetCard =
          cards[this.focusedCardIndex] || cards[cards.length - 1]
        if (targetCard) {
          this.prepareReply(
            targetCard,
            this.canReplyAll(targetCard) ? 'reply_all' : 'reply',
          )
        }
        this.focusReplyComposer()
        return true
      }
      if (key === 'e') {
        event.preventDefault()
        this.$emit('archiveThread')
        return true
      }
      return false
    },
    getInitials(nameOrAddress: string): string {
      return getSenderInitials(nameOrAddress)
    },
    formatParties(parties: EmailParty[]): string {
      return formatEmailParties(parties)
    },
    formatBytes(bytes: number | undefined): string {
      return formatAttachmentBytes(bytes)
    },
    cardDeliveryBadge(card: ParsedEmailCard): {
      color: string
      icon: string
      label: string
    } | null {
      if (!card.isOutbound) return null
      if (card.status === 'error') {
        if (card.failureReason === 'insufficient-funds') {
          return {
            color: 'negative',
            icon: 'error_outline',
            label: this.$t('chatMessage.insufficientFunds', {
              unit: this.chainUnit,
            }),
          }
        }
        if (card.failureReason === 'stamp-below-fee') {
          return {
            color: 'negative',
            icon: 'error_outline',
            label: this.$t('chatMessage.stampBelowFee'),
          }
        }
        return {
          color: 'negative',
          icon: 'error_outline',
          label: this.$t('chatMessage.failedToSend', 'Failed to send'),
        }
      }
      if (card.payloadDigest && sendsWaitingForChain.has(card.payloadDigest)) {
        return {
          color: 'warning',
          icon: 'schedule',
          label: this.$t('outgoing.waitingForChain', 'Waiting for network…'),
        }
      }
      if (
        card.payloadDigest &&
        sendsWaitingForPreviousPayment.has(card.payloadDigest)
      ) {
        return {
          color: 'warning',
          icon: 'schedule',
          label: this.$t(
            'outgoing.waitingForPreviousPayment',
            'Waiting for previous payment…',
          ),
        }
      }
      if (card.status === 'payment-pending') {
        return {
          color: 'warning',
          icon: 'schedule',
          label: this.$t('outgoing.paymentPending', 'Payment pending…'),
        }
      }
      if (card.status === 'pending') {
        return {
          color: 'grey-7',
          icon: 'schedule',
          label: this.$t('outgoing.sending', 'Sending…'),
        }
      }
      return null
    },
    isCardCancelable(card: ParsedEmailCard): boolean {
      return Boolean(
        card.isOutbound &&
          card.payloadDigest &&
          (card.status === 'pending' || card.status === 'payment-pending'),
      )
    },
    isCardFailed(card: ParsedEmailCard): boolean {
      return Boolean(
        card.isOutbound && card.payloadDigest && card.status === 'error',
      )
    },
    cancelOrDiscardCard(card: ParsedEmailCard) {
      if (!card.payloadDigest) return
      if (
        (card.status === 'pending' || card.status === 'payment-pending') &&
        !this.replyText.trim() &&
        card.mainBody
      ) {
        this.replyText = card.mainBody
      }
      const address = this.conversation?.id || this.recipientAddress
      if (!address) return
      try {
        useChatStore().deleteMessage({
          address,
          payloadDigest: card.payloadDigest,
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      }
    },
    async retryFailedCard(card: ParsedEmailCard) {
      if (!card.payloadDigest) return
      try {
        await useChatStore().retryOutgoing(card.payloadDigest)
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      }
    },
    findDefaultReplyTargetCard(
      cards: ParsedEmailCard[],
    ): ParsedEmailCard | undefined {
      if (!cards || cards.length === 0) return undefined
      for (let i = cards.length - 1; i >= 0; i--) {
        if (!cards[i].isOutbound) {
          return cards[i]
        }
      }
      for (let i = cards.length - 1; i >= 0; i--) {
        const status = cards[i].status
        if (
          status !== 'error' &&
          status !== 'pending' &&
          status !== 'payment-pending'
        ) {
          return cards[i]
        }
      }
      return cards[cards.length - 1]
    },
    buildThreadReplyHeaders(targetCard?: ParsedEmailCard): {
      inReplyTo?: string
      references?: string[]
    } {
      const cards = this.parsedEmails || []
      const effectiveCard =
        targetCard ??
        this.activeReplyCard ??
        this.findDefaultReplyTargetCard(cards)
      if (!effectiveCard) {
        return { inReplyTo: undefined, references: undefined }
      }
      const isValidMessageId = (id: string | undefined): id is string =>
        Boolean(
          id &&
            typeof id === 'string' &&
            /^<[^<>@\s]+@[^<>@\s]+>$/.test(id.trim()),
        )

      let inReplyTo: string | undefined
      if (
        !effectiveCard.isOutbound &&
        isValidMessageId(effectiveCard.rawEmail?.messageId)
      ) {
        inReplyTo = effectiveCard.rawEmail!.messageId.trim()
      } else {
        for (let i = cards.length - 1; i >= 0; i--) {
          const c = cards[i]
          if (!c.isOutbound && isValidMessageId(c.rawEmail?.messageId)) {
            inReplyTo = c.rawEmail!.messageId.trim()
            break
          }
        }
        if (
          !inReplyTo &&
          effectiveCard.status !== 'error' &&
          effectiveCard.status !== 'pending' &&
          effectiveCard.status !== 'payment-pending' &&
          isValidMessageId(effectiveCard.rawEmail?.messageId)
        ) {
          inReplyTo = effectiveCard.rawEmail!.messageId.trim()
        }
      }

      const refs: string[] = []
      const addRef = (id: string | undefined) => {
        if (!isValidMessageId(id)) return
        const trimmed = id.trim()
        if (!refs.includes(trimmed)) {
          refs.push(trimmed)
        }
      }

      const hasAnyInbound = cards.some(c => !c.isOutbound)
      const explicitIdx = cards.findIndex(c => c.id === effectiveCard.id)
      const stopIdx =
        !effectiveCard.isOutbound && explicitIdx >= 0
          ? explicitIdx
          : cards.length - 1

      for (let i = 0; i <= stopIdx; i++) {
        const c = cards[i]
        if (!c) continue
        const includeCard =
          !c.isOutbound ||
          (!hasAnyInbound &&
            c.status !== 'error' &&
            c.status !== 'pending' &&
            c.status !== 'payment-pending')
        if (!includeCard) continue
        for (const r of c.rawEmail?.references ?? []) {
          addRef(r)
        }
        addRef(c.rawEmail?.inReplyTo)
        addRef(c.rawEmail?.messageId)
      }

      if (inReplyTo) {
        addRef(inReplyTo)
      }

      return {
        inReplyTo,
        references: refs.length > 0 ? refs : undefined,
      }
    },
    canReplyAll(card: ParsedEmailCard): boolean {
      if (card.isOutbound) return false
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
      const headers = this.buildThreadReplyHeaders(card)
      this.activeInReplyTo = headers.inReplyTo
      this.activeReferences = headers.references
    },
    populateRecipientsForCard(
      card: ParsedEmailCard,
      mode: 'reply' | 'reply_all',
    ) {
      if (card.isOutbound) {
        // Outbound email follow-up: send to original external recipients, not 'me'!
        const validTos = (card.to || [])
          .map(t => t.address)
          .filter(isValidRecipientAddress)
        const validCcs = (card.cc || [])
          .map(c => c.address)
          .filter(isValidRecipientAddress)

        this.toList = validTos.length > 0 ? validTos : []
        if (this.toList.length === 0 && this.conversation?.emailRecipient) {
          if (isValidRecipientAddress(this.conversation.emailRecipient)) {
            this.toList = [this.conversation.emailRecipient]
          }
        }
        this.ccList = validCcs
        if (validCcs.length > 0) this.showCc = true
        return
      }

      const fromAddr = card.fromAddress

      if (mode === 'reply') {
        this.toList = isValidRecipientAddress(fromAddr) ? [fromAddr] : []
        this.ccList = []
      } else {
        // Reply All
        this.toList = isValidRecipientAddress(fromAddr) ? [fromAddr] : []
        const ccs: string[] = []
        const seenCcs = new Set<string>()
        const fromLower = (extractPartyFromRaw(fromAddr)?.address || fromAddr)
          .trim()
          .toLowerCase()

        const addCcIfExternal = (rawAddr: string | undefined) => {
          if (!rawAddr) return
          const parsed = extractPartyFromRaw(rawAddr)
          const cleanAddr = parsed ? parsed.address : rawAddr.trim()
          if (!isValidRecipientAddress(cleanAddr)) return
          const lower = cleanAddr.trim().toLowerCase()
          if (lower === fromLower) return
          if (this.isSelfOrThreadAliasAddress(cleanAddr)) return
          if (!seenCcs.has(lower)) {
            seenCcs.add(lower)
            ccs.push(cleanAddr)
          }
        }

        // Add remaining 'To' recipients (excluding sender and self/thread-alias)
        if (card.to) {
          for (const t of card.to) {
            addCcIfExternal(t.address)
          }
        }
        // Add 'Cc' recipients (excluding sender and self/thread-alias)
        if (card.cc) {
          for (const c of card.cc) {
            addCcIfExternal(c.address)
          }
        }
        this.ccList = ccs
        if (ccs.length > 0) this.showCc = true
      }

      if (this.toList.length === 0) {
        const fallbackTos = (card.to || [])
          .map(t => t.address)
          .filter(
            addr =>
              isValidRecipientAddress(addr) &&
              !this.isSelfOrThreadAliasAddress(addr),
          )
        if (fallbackTos.length > 0) {
          this.toList = fallbackTos
        } else if (
          this.conversation?.emailRecipient &&
          isValidRecipientAddress(this.conversation.emailRecipient)
        ) {
          this.toList = [this.conversation.emailRecipient]
        }
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
      const headers = this.buildThreadReplyHeaders(card)
      this.activeInReplyTo = headers.inReplyTo
      this.activeReferences = headers.references

      // Standard email convention: insert bottom quote with cursor at top
      this.insertOriginalQuote(card)

      // Expand card and scroll to composer
      this.expandedMap[card.id] = true
    },
    pageStyleFn() {
      return {
        height: '100%',
        maxHeight: '100%',
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
      if (val && isValidRecipientAddress(val) && !this.toList.includes(val)) {
        this.toList.push(val)
      }
      this.newToInput = ''
    },
    removeToRecipient(index: number) {
      this.toList.splice(index, 1)
    },
    addCcRecipient() {
      const val = this.newCcInput.trim()
      if (val && isValidRecipientAddress(val) && !this.ccList.includes(val)) {
        this.ccList.push(val)
      }
      this.newCcInput = ''
    },
    removeCcRecipient(index: number) {
      this.ccList.splice(index, 1)
    },
    addBccRecipient() {
      const val = this.newBccInput.trim()
      if (val && isValidRecipientAddress(val) && !this.bccList.includes(val)) {
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
      if (this.insufficientStampBalanceReason) {
        errorNotify(new Error(this.insufficientStampBalanceReason))
        return
      }
      if (this.newToInput.trim()) this.addToRecipient()
      if (this.newCcInput.trim()) this.addCcRecipient()
      if (this.newBccInput.trim()) this.addBccRecipient()

      const isGatewayRoute =
        this.isVerifiedGateway || this.replyRouting === 'gateway'

      let senderAddress =
        (typeof this.ownAddress === 'string'
          ? this.ownAddress
          : (this.ownAddress as any)?.value) || ''
      if (!senderAddress || senderAddress.length < 3) {
        senderAddress = (await getOwnCanonicalAddress()) || ''
      }
      if (!senderAddress || senderAddress.length < 3) {
        try {
          const profile = useProfileStore()
          if (profile.owner && profile.owner.length >= 3) {
            senderAddress = profile.owner
          }
        } catch {
          /* ignore */
        }
      }
      if (!senderAddress || senderAddress.length < 3) {
        senderAddress = 'frank-user'
      }

      const gatewayDomain = this.getGatewayDomain()

      if (isGatewayRoute && gatewayDomain && !senderAddress.includes('@')) {
        const preferredUsername = this.getPreferredGatewayUsername(
          senderAddress,
          gatewayDomain,
        )
        const senderLocalPart = preferredUsername || senderAddress
        senderAddress = `${senderLocalPart}@${gatewayDomain}`
      }

      let senderName: string | undefined
      try {
        const profile = useProfileStore()
        const name = profile.profile?.name?.trim()
        if (name && name.length >= 1 && name.length <= 256) {
          senderName = name
        }
      } catch {
        /* ignore */
      }

      const fromParty: EmailParty = {
        address: senderAddress,
        ...(senderName ? { name: senderName } : {}),
      }

      const isCleanRecipient = (addr: unknown): addr is string => {
        if (typeof addr !== 'string') return false
        const trimmed = addr.trim()
        return (
          trimmed.length >= 3 &&
          trimmed.length <= 320 &&
          trimmed.toLowerCase() !== 'me'
        )
      }

      let validTos = this.toList
        .map(a => (typeof a === 'string' ? a.trim() : ''))
        .filter(isCleanRecipient)

      if (
        validTos.length === 0 &&
        this.toList.some(
          t => typeof t === 'string' && t.trim().toLowerCase() === 'me',
        ) &&
        this.conversation?.emailRecipient
      ) {
        const fallback = this.conversation.emailRecipient.trim()
        if (isCleanRecipient(fallback)) {
          validTos = [fallback]
        }
      }

      const validCcs = this.ccList
        .map(a => (typeof a === 'string' ? a.trim() : ''))
        .filter(isCleanRecipient)

      const validBccs = this.bccList
        .map(a => (typeof a === 'string' ? a.trim() : ''))
        .filter(isCleanRecipient)

      if (validTos.length === 0 && validBccs.length === 0) {
        return // cannot send email without at least a To or Bcc recipient
      }

      const emailSubject =
        this.subject || (this.isDraft ? 'No Subject' : this.threadSubject)
      const body = this.replyText
      const replyHeaders = this.buildThreadReplyHeaders(
        this.activeReplyCard ?? undefined,
      )
      const resolvedInReplyTo = replyHeaders.inReplyTo ?? this.activeInReplyTo
      const resolvedReferences =
        replyHeaders.references ??
        (this.activeReferences ? [...this.activeReferences] : undefined)
      const emailItem: EmailItem = {
        type: 'email',
        messageId: `<frank_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 9)}@frank.org>`,
        from: fromParty,
        to: validTos.map(address => ({ address })),
        cc: validCcs.length
          ? validCcs.map(address => ({ address }))
          : undefined,
        bcc: validBccs.length
          ? validBccs.map(address => ({ address }))
          : undefined,
        subject: emailSubject,
        textBody: body,
        inReplyTo: resolvedInReplyTo,
        references: resolvedReferences,
      }
      const targetAddress =
        !this.isVerifiedGateway && this.replyRouting === 'gateway'
          ? this.emailGatewayAddress
          : undefined
      const fallbackText = isGatewayRoute
        ? `[Email to ${validTos.join(
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
        if (!this.stampUnavailable && !this.insufficientStampBalanceReason) {
          // File reads leave authoring enabled. Clear only what this send actually captured.
          if (this.replyText === body) {
            this.replyText = ''
            this.isPreviewMode = false
          }
          this.stagedFiles = this.stagedFiles.filter(
            file => !files.includes(file),
          )
        }
      } finally {
        this.preparingSend = false
      }
    },
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
      if (this.sending) return
      this.typedStamp = '0'
      this.$emit('update:stampAmount', '0')
    },
    resetToDefaultStamp() {
      this.typedStamp = null
      this.$emit('resetStampDefault')
    },
  },
})
</script>

<style scoped>
.email-thread-page {
  background-color: var(--q-page-background, #f5f6f8);
  height: 100%;
  max-height: 100%;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow: hidden;
  overflow-x: hidden;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
}

.email-thread-header {
  background-color: var(--q-card-background, #ffffff);
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  z-index: 10;
  flex-shrink: 0;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow-x: hidden;
}

.body--dark .email-thread-header {
  background-color: #1e1e1e;
  border-bottom-color: rgba(255, 255, 255, 0.08);
}

.email-thread-subbar {
  min-height: 24px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.participant-row {
  min-width: 0;
  max-width: 100%;
}

.participant-list {
  color: #3c4043;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  min-width: 0;
}

.body--dark .participant-list {
  color: #bdc1c6;
}

.email-count-pill {
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.03);
}

.body--dark .email-count-pill {
  background: rgba(255, 255, 255, 0.05);
}

.email-cards-container {
  padding: 16px 24px 24px 24px;
  width: 100%;
  box-sizing: border-box;
}

.email-card {
  border-radius: 12px;
  background-color: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
  overflow: hidden;
}

.email-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.07);
}

.body--dark .email-card {
  background-color: #1e1e1e;
  border-color: rgba(255, 255, 255, 0.08);
}

.email-card-header {
  min-height: 60px;
  padding: 10px 16px;
  user-select: none;
  transition: background-color 0.15s ease;
}

.email-card-avatar {
  border-radius: 50%;
  font-weight: 600;
}

.sender-name {
  color: #202124;
}

.body--dark .sender-name {
  color: #e8eaed;
}

.sender-address {
  color: #5f6368;
}

.body--dark .sender-address {
  color: #9aa0a6;
}

.dkim-pill {
  font-size: 10px;
  border-radius: 4px;
}

.email-card-body {
  padding: 16px 20px 20px 20px;
}

.email-body-text {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica,
    Arial, sans-serif;
  font-size: 14.5px;
  line-height: 1.65;
  color: #202124;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 4px 0;
}

.body--dark .email-body-text {
  color: #e8eaed;
}

.email-composer-dock {
  background-color: var(--q-card-background, #ffffff);
  border-top: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.05);
  z-index: 20;
  flex-shrink: 0;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow-x: hidden;
}

.body--dark .email-composer-dock {
  background-color: #181818;
  border-top-color: rgba(255, 255, 255, 0.08);
}

.composer-header-bar {
  min-height: 32px;
}

/* Attach and the stamp pill: may shrink (the pill gives way) rather than push the row
 * off-screen. */
.composer-top-actions {
  flex: 0 1 auto;
  min-width: 0;
}

.composer-draft-indicator {
  display: inline-flex;
  align-items: center;
}

.reply-mode-toggle {
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 20px;
  overflow: hidden;
}

.body--dark .reply-mode-toggle {
  border-color: rgba(255, 255, 255, 0.15);
}

.recipient-toggle-btn {
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 999px !important;
  font-size: 11px;
  font-weight: 600;
  color: var(--q-primary, #c8431e);
  transition: all 0.15s ease;
  min-height: 26px;
}

.recipient-toggle-btn:hover {
  background: var(--q-chat-stamp-bg-hover, rgba(0, 0, 0, 0.09));
}

.recipient-toggle-btn--active {
  background: var(--q-chat-stamp-bg-hover, rgba(0, 0, 0, 0.12));
  border-color: var(--q-primary, #c8431e);
}

.body--dark .recipient-toggle-btn {
  border-color: rgba(255, 255, 255, 0.16);
}

.recipients-container {
  background: rgba(0, 0, 0, 0.02);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 8px;
  padding: 4px 10px;
}

.body--dark .recipients-container {
  background: rgba(255, 255, 255, 0.03);
  border-color: rgba(255, 255, 255, 0.08);
}

.recipient-row {
  min-height: 36px;
  padding: 2px 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}

.recipient-row:last-child {
  border-bottom: none;
}

.body--dark .recipient-row {
  border-bottom-color: rgba(255, 255, 255, 0.04);
}

.recipient-label {
  width: 48px;
  font-size: 12px;
  font-weight: 600;
  color: #5f6368;
  user-select: none;
}

.body--dark .recipient-label {
  color: #9aa0a6;
}

.recipient-chip {
  background: rgba(25, 118, 210, 0.08);
  border: 1px solid rgba(25, 118, 210, 0.2);
  color: var(--q-primary, #1976d2);
  font-weight: 500;
  border-radius: 14px;
  padding: 1px 4px 1px 6px;
  max-width: 260px;
}

.recipient-chip--cc {
  background: rgba(38, 166, 154, 0.08);
  border-color: rgba(38, 166, 154, 0.25);
  color: #00796b;
}

.recipient-chip--bcc {
  background: rgba(103, 58, 183, 0.08);
  border-color: rgba(103, 58, 183, 0.25);
  color: #512da8;
}

.body--dark .recipient-chip {
  background: rgba(25, 118, 210, 0.2);
  border-color: rgba(25, 118, 210, 0.4);
  color: #90caf9;
}

.body--dark .recipient-chip--cc {
  background: rgba(38, 166, 154, 0.2);
  border-color: rgba(38, 166, 154, 0.4);
  color: #80cbc4;
}

.body--dark .recipient-chip--bcc {
  background: rgba(103, 58, 183, 0.2);
  border-color: rgba(103, 58, 183, 0.4);
  color: #b39ddb;
}

.recipient-chip-text {
  max-width: 200px;
}

.formatting-toolbar {
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  padding: 2px 0 6px 0;
}

.body--dark .formatting-toolbar {
  border-bottom-color: rgba(255, 255, 255, 0.06);
}

.composer-body-container {
  width: 100%;
}

.email-textarea {
  width: 100%;
}

.email-textarea :deep(.q-field__control) {
  border-radius: 8px;
}

.email-textarea :deep(textarea) {
  min-height: 96px;
  max-height: 240px;
  resize: vertical;
  line-height: 1.5;
  padding: 6px 0;
}

.staged-attachment-chip {
  border-radius: 14px;
}

.send-btn {
  flex-shrink: 0;
  min-height: 36px;
  border-radius: 12px !important;
  font-weight: 600;
  letter-spacing: -0.005em;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.16);
  transition: transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease;
}

.send-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.22);
}

.send-btn:disabled {
  opacity: 0.45 !important;
  box-shadow: none !important;
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
