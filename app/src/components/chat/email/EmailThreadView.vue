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
                    <div v-else>
                      <div
                        class="email-body-text text-body1"
                        v-html="
                          formatMessageBody(card.mainBody || card.textBody)
                        "
                      />
                      <div v-if="card.quotedBody" class="q-mt-sm">
                        <q-btn
                          flat
                          dense
                          no-caps
                          size="xs"
                          color="grey-7"
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
      <div class="row items-center justify-between q-mb-sm composer-header-bar">
        <div class="row items-center q-gutter-x-sm">
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
            flat
            dense
            no-caps
            size="sm"
            class="recipient-toggle-btn q-px-sm"
            :class="{ 'recipient-toggle-btn--active': showCc }"
            :label="
              showCc ? $t('emailThread.hideCc') : $t('emailThread.showCc')
            "
            @click="showCc = !showCc"
          />
          <q-btn
            flat
            dense
            no-caps
            size="sm"
            class="recipient-toggle-btn q-px-sm"
            :class="{ 'recipient-toggle-btn--active': showBcc }"
            :label="
              showBcc ? $t('emailThread.hideBcc') : $t('emailThread.showBcc')
            "
            @click="showBcc = !showBcc"
          />
        </div>
        <div class="text-caption text-grey-6" v-if="stampStatus">
          {{ stampStatus }}
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
            :placeholder="composerPlaceholder"
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
            color="grey-7"
            icon="attach_file"
            :disable="sending"
            class="attach-btn"
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
            <span class="chat-stamp-pill-text q-ml-xs">{{
              stampPillText
            }}</span>
            <span
              v-if="stampMultiplier && stampMultiplier !== '1'"
              class="chat-stamp-pill-multiple q-ml-xs"
              data-testid="stamp-pill-multiple"
              >{{ stampMultiplier }}×</span
            >
            <q-tooltip max-width="280px">
              <div data-testid="stamp-tooltip-amount">{{ stampLabel }}</div>
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
    </div>
  </q-page>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type { Conversation, ChatMessage } from 'src/stores/chats'
import type {
  EmailItem,
  EmailParty,
  EmailAttachment,
  MessageItem,
} from '@frank/cashweb/types/messages'
import { formatConversationTimestamp } from 'src/utils/formatting'
import {
  formatCompactAmount,
  formatDisplayAmount,
} from 'src/utils/chain-amount'
import { STAMP_MULTIPLIER_TENTHS } from 'src/components/chat/ChatInput.vue'
import { defaultStaticStampForChain } from '@frank/wallet/oracle'
import { activeChain } from '@frank/wallet/chain'
import { purify, renderMarkdown } from 'src/utils/markdown'
import {
  applyMarkdownFormat,
  type MarkdownFormatAction,
} from 'src/utils/post-editor'
import { useSettingsStore } from 'src/stores/settings'
import { useProfileStore } from 'src/stores/my-profile'
import { isChainAddress } from 'src/utils/chain-address'
import { cleanEmailSnippet } from 'src/utils/markdown-plain-text'
import {
  getOwnCanonicalAddress,
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
} from 'src/utils/own-address'

const DEFAULT_STAMP_MULTIPLIER_TENTHS = [
  1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 80, 100, 150, 200, 300, 500, 800, 1000,
  1500, 2000, 3000, 5000, 8000, 10000,
]

function isValidRecipientAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  const trimmed = addr.trim()
  if (!trimmed) return false
  if (trimmed.length < 3 || trimmed.length > 320) return false
  if (trimmed.toLowerCase() === 'me') return false
  if (trimmed.includes('@')) return true
  if (isChainAddress(trimmed)) return true
  return false
}

const THREAD_REPLY_ALIAS_LOCAL_RE = /^m[0-9a-f]{30}$/i

export function extractPartyFromRaw(
  input: string | EmailParty | undefined | null,
): { address: string; name?: string } | null {
  if (!input) return null
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return null
    const angleMatch = trimmed.match(/^(.*?)\s*<([^<>]+)>\s*$/)
    if (angleMatch) {
      const rawName = angleMatch[1]
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim()
      const address = angleMatch[2].trim()
      if (!isValidRecipientAddress(address)) return null
      return {
        address,
        ...(rawName ? { name: rawName } : {}),
      }
    }
    if (!isValidRecipientAddress(trimmed)) return null
    return { address: trimmed }
  }
  const parsedFromAddr = extractPartyFromRaw(input.address)
  if (!parsedFromAddr) return null
  const explicitName = input.name?.trim()
  return {
    address: parsedFromAddr.address,
    ...(explicitName
      ? { name: explicitName }
      : parsedFromAddr.name
      ? { name: parsedFromAddr.name }
      : {}),
  }
}

export function decodeQuotedPrintableIfNeeded(text: string): string {
  if (!text) return ''
  const hasSoftLineBreak = /=\r?\n/.test(text)
  const hasUtf8QpSequence =
    /=[C-Fc-f][0-9A-Fa-f](?:=[89ABab][0-9A-Fa-f])+/.test(text)
  const hasCommonQpEscape = /=(?:3D|20(?=\r?\n|$)|09)/i.test(text)
  if (!hasSoftLineBreak && !hasUtf8QpSequence && !hasCommonQpEscape) {
    return text
  }

  const withoutSoftBreaks = text.replace(/=\r?\n/g, '')

  return withoutSoftBreaks.replace(/(?:=[0-9A-Fa-f]{2})+/g, match => {
    try {
      const hexParts = match.slice(1).split('=')
      const bytes = new Uint8Array(hexParts.map(h => parseInt(h, 16)))
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return match
    }
  })
}

export function splitQuotedEmailBody(text: string): {
  mainBody: string
  visibleBody: string
  quotedBody: string
} {
  if (!text) return { mainBody: '', visibleBody: '', quotedBody: '' }
  const decoded = decodeQuotedPrintableIfNeeded(text)
  const lines = decoded.split(/\r?\n/)
  let quoteStartIdx = -1

  // Look for a trailing block of `>` quoted lines (optionally preceded by `On ... wrote:`)
  let idx = lines.length - 1
  while (idx >= 0 && lines[idx].trim() === '') {
    idx--
  }

  let hasTrailingQuoteLines = false
  while (idx >= 0 && /^\s*>/.test(lines[idx])) {
    hasTrailingQuoteLines = true
    quoteStartIdx = idx
    idx--
  }

  if (hasTrailingQuoteLines) {
    // Check if the line(s) immediately preceding the `>` block (skipping blank lines) are an attribution header like `On ..., ... wrote:`
    let attrIdx = quoteStartIdx - 1
    while (attrIdx >= 0 && lines[attrIdx].trim() === '') {
      attrIdx--
    }
    if (attrIdx >= 0) {
      if (/^on\s+.+wrote:\s*$/i.test(lines[attrIdx].trim())) {
        quoteStartIdx = attrIdx
      } else if (/wrote:\s*$/i.test(lines[attrIdx].trim())) {
        for (
          let startIdx = attrIdx - 1;
          startIdx >= Math.max(0, attrIdx - 3);
          startIdx--
        ) {
          const joined = lines
            .slice(startIdx, attrIdx + 1)
            .map(l => l.trim())
            .join(' ')
          if (/^on\s+.+wrote:\s*$/i.test(joined)) {
            quoteStartIdx = startIdx
            break
          }
        }
      }
    }

    const mainBody = lines.slice(0, quoteStartIdx).join('\n').trim()
    const quotedBody = lines.slice(quoteStartIdx).join('\n').trim()
    if (mainBody.length > 0 && quotedBody.length > 0) {
      return { mainBody, visibleBody: mainBody, quotedBody }
    }
  }

  return { mainBody: decoded, visibleBody: decoded, quotedBody: '' }
}

interface ParsedEmailCard {
  id: string
  fromAddress: string
  fromName?: string
  to: EmailParty[]
  cc?: EmailParty[]
  bcc?: EmailParty[]
  subject: string
  textBody: string
  mainBody: string
  quotedBody: string
  snippet: string
  formattedDate: string
  timestamp: number
  isOutbound: boolean
  isUnread: boolean
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
      const cards: ParsedEmailCard[] = []
      const lastRead = this.conversation?.lastRead ?? 0
      const hasLastRead =
        this.conversation !== null &&
        this.conversation !== undefined &&
        this.conversation.lastRead !== undefined

      for (const msg of this.messages) {
        const emailItem = msg.items?.find(it => it.type === 'email') as
          | EmailItem
          | undefined
        const timestamp =
          msg.serverTime || msg.receivedTime || (msg as any).localTime || 0
        const formattedDate = formatConversationTimestamp(timestamp)
        const isUnread =
          !msg.outbound &&
          ((hasLastRead && timestamp > lastRead) ||
            (!hasLastRead && (this.conversation?.totalUnreadMessages ?? 0) > 0))

        if (emailItem) {
          const fromAddr = emailItem.from?.address || msg.senderAddress
          const fromName = emailItem.from?.name
          const text = decodeQuotedPrintableIfNeeded(emailItem.textBody || '')
          const { mainBody, quotedBody } = splitQuotedEmailBody(text)
          const snippetSource = mainBody || text
          const snippet = snippetSource.replace(/\s+/g, ' ').slice(0, 100)

          cards.push({
            id: emailItem.messageId || msg.payloadDigest,
            fromAddress: fromAddr,
            fromName,
            to: emailItem.to || [],
            cc: emailItem.cc || [],
            subject: emailItem.subject || 'No Subject',
            textBody: text,
            mainBody,
            quotedBody,
            snippet,
            formattedDate,
            timestamp,
            isOutbound: msg.outbound,
            isUnread,
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
          const cleanText = decodeQuotedPrintableIfNeeded(
            cleanEmailSnippet(text),
          )
          const { mainBody, quotedBody } = splitQuotedEmailBody(cleanText)
          const snippetSource = mainBody || cleanText
          const snippet = snippetSource.replace(/\s+/g, ' ').slice(0, 100)

          cards.push({
            id: msg.payloadDigest,
            fromAddress: msg.senderAddress,
            to: [{ address: msg.destinationAddress || this.recipientAddress }],
            subject: this.threadSubject,
            textBody: cleanText,
            mainBody,
            quotedBody,
            snippet,
            formattedDate,
            timestamp,
            isOutbound: msg.outbound,
            isUnread,
          })
        }
      }

      // Chronological sort
      cards.sort((a, b) => a.timestamp - b.timestamp)
      return cards
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
      let ownUsername = ''
      try {
        const profileStore = useProfileStore()
        ownUsername = (profileStore.profile?.username || '').trim()
      } catch {
        /* ignore */
      }

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
      if (
        selfEntry &&
        ownUsername &&
        !THREAD_REPLY_ALIAS_LOCAL_RE.test(ownUsername)
      ) {
        const currentRank = this.getSelfAddressRank(selfEntry.address)
        if (currentRank < 4) {
          selfEntry.address = `${ownUsername}@${gatewayDomain}`
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
    latestEmail(): ParsedEmailCard | undefined {
      return this.parsedEmails[this.parsedEmails.length - 1]
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
        if (!this.composerInitialized) {
          this.composerInitialized = true
          if (cards.length) this.setupComposerDefaults(cards[cards.length - 1])
          else this.setupNewDraftDefaults()
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
        .filter(p => isValidRecipientAddress(p.address))
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

      let gatewayDomain = ''
      try {
        const settings = useSettingsStore()
        gatewayDomain =
          settings.acceptedEmailGateway?.domain ||
          settings.advertisedEmailGateway?.domain ||
          'signet.mx'
      } catch {
        gatewayDomain = 'signet.mx'
      }

      if (isGatewayRoute && gatewayDomain && !senderAddress.includes('@')) {
        senderAddress = `${senderAddress}@${gatewayDomain}`
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
        inReplyTo: this.activeInReplyTo,
        references: this.activeReferences
          ? [...this.activeReferences]
          : undefined,
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
        // File reads leave authoring enabled. Clear only what this send actually captured.
        if (this.replyText === body) {
          this.replyText = ''
          this.isPreviewMode = false
        }
        this.stagedFiles = this.stagedFiles.filter(
          file => !files.includes(file),
        )
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
  border: 1px dashed rgba(0, 0, 0, 0.18);
  border-radius: 16px;
  font-size: 11px;
  font-weight: 500;
  color: var(--q-primary, #1976d2);
  transition: all 0.15s ease;
  min-height: 24px;
}

.recipient-toggle-btn:hover {
  background: rgba(25, 118, 210, 0.08);
  border-style: solid;
}

.recipient-toggle-btn--active {
  background: rgba(25, 118, 210, 0.12);
  border-style: solid;
  border-color: var(--q-primary, #1976d2);
}

.body--dark .recipient-toggle-btn {
  border-color: rgba(255, 255, 255, 0.2);
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

.email-textarea :deep(.q-field__control) {
  border-radius: 8px;
}

.staged-attachment-chip {
  border-radius: 14px;
}

.send-btn {
  border-radius: 8px;
  font-weight: 600;
  letter-spacing: 0.2px;
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

.chat-stamp-btn {
  flex-shrink: 0;
  height: 28px;
  padding: 0 8px;
  border-radius: 14px;
  font-size: 12px;
  color: var(--q-primary);
  background-color: var(--q-chat-stamp-bg, rgba(0, 0, 0, 0.05));
  transition: background-color 0.15s ease, opacity 0.15s ease;
}

.chat-stamp-btn:hover:not(:disabled) {
  background-color: var(--q-chat-stamp-bg-hover, rgba(0, 0, 0, 0.09));
}

.chat-stamp-pill-text {
  font-weight: 600;
  font-size: 11px;
  font-family: inherit;
  opacity: 0.9;
  white-space: nowrap;
}

.chat-stamp-pill-multiple {
  font-size: 10px;
  opacity: 0.8;
  white-space: nowrap;
}

.chat-stamp-explanation {
  opacity: 0.8;
  max-width: 320px;
}

.body--dark .chat-stamp-btn {
  background-color: rgba(255, 255, 255, 0.08);
}

.body--dark .chat-stamp-btn:hover:not(:disabled) {
  background-color: rgba(255, 255, 255, 0.14);
}
</style>
