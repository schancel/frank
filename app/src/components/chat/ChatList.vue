<template>
  <div class="full-width column col">
    <q-scroll-area
      class="q-px-none col full-width"
      :content-style="{ width: '100%', minWidth: '100%' }"
      :content-active-style="{ width: '100%', minWidth: '100%' }"
    >
      <q-list class="full-width">
        <q-separator />
        <q-item>
          <q-item-section>
            <q-item-label>{{ $t('chatList.directMessages') }}</q-item-label>
          </q-item-section>
          <q-space />
          <q-btn
            dense
            flat
            icon="add"
            :aria-label="$t('newContactDialog.startConversation')"
            data-testid="start-conversation-btn"
            @click="openNewConversation"
          />
        </q-item>
        <q-separator />

        <!-- Full-Text E2EE Search Input & Paid-Stranger Screener Filter Chip -->
        <div
          v-if="!compact && $status.setup"
          class="q-px-sm q-py-xs chat-list-triage-controls"
        >
          <div class="chat-search-box row items-center no-wrap">
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="search"
              class="chat-search-native-input col"
              :placeholder="$t('chatList.searchPlaceholder')"
              :aria-label="$t('chatList.searchPlaceholder')"
              data-test="chat-search-input"
              data-testid="chat-search-input"
              @keydown.esc="clearSearch"
            />
            <span
              v-if="searchQuery"
              role="button"
              tabindex="0"
              class="chat-search-clear cursor-pointer q-px-xs"
              :aria-label="$t('chatList.clearSearch')"
              data-test="chat-search-clear"
              @click="clearSearch"
              @keydown.enter.prevent="clearSearch"
              >×</span
            >
          </div>

          <div
            v-if="screenerSummary.count > 0 || activeFilter === 'screener'"
            class="row items-center q-gutter-xs q-mt-xs"
            data-test="screener-filter-bar"
          >
            <div
              role="button"
              tabindex="0"
              class="screener-chip cursor-pointer"
              :class="{ 'screener-chip--active': activeFilter === 'all' }"
              data-test="all-chats-filter-chip"
              @click="activeFilter = 'all'"
              @keydown.enter.prevent="activeFilter = 'all'"
            >
              {{ $t('chatList.allConversationsFilter') }}
            </div>
            <div
              role="button"
              tabindex="0"
              class="screener-chip screener-chip--tollbooth cursor-pointer"
              :class="{ 'screener-chip--active': activeFilter === 'screener' }"
              data-test="screener-filter-chip"
              data-testid="screener-filter-chip"
              @click="toggleScreenerFilter"
              @keydown.enter.prevent="toggleScreenerFilter"
            >
              {{
                $t('chatList.screenerFilterLabel', {
                  count: screenerSummary.count,
                  value: screenerSummary.formattedTotal.combinedDisplay,
                })
              }}
            </div>
          </div>
        </div>

        <template v-if="$status.setup">
          <div
            v-for="conversation in displayedConversations"
            :key="conversation.id || conversation.address"
            class="chat-list-entry-wrapper"
          >
            <chat-list-item
              :conversation="conversation"
              :conversation-id="conversation.id"
              :conversation-name="conversation.name || conversation.topic"
              :participants="conversation.participants"
              :timestamp="
                conversation.lastReceived ||
                conversation.updatedAt ||
                conversation.createdAt
              "
              :chat-address="conversation.address || conversation.id"
              :value-unread="formatAmount(conversation.totalUnreadValue)"
              :num-unread="conversation.totalUnreadMessages"
              :compact="compact"
              @click="selectConversation(conversation)"
            />
            <div
              v-if="
                !compact &&
                normalizedQuery &&
                searchSnippetByConv[conversation.id || conversation.address]
              "
              class="chat-search-hit-snippet q-px-md q-pb-xs text-caption"
              data-test="chat-search-snippet"
              data-testid="chat-search-snippet"
              @click="selectConversation(conversation)"
              v-html="
                searchSnippetByConv[conversation.id || conversation.address]
                  .html
              "
            />
          </div>
        </template>

        <q-item
          v-if="
            displayedConversations.length === 0 &&
            $status.setup &&
            normalizedQuery
          "
          data-test="chat-search-empty"
        >
          <q-item-section>
            <q-item-label>{{ $t('chatList.noSearchResults') }}</q-item-label>
          </q-item-section>
        </q-item>

        <q-item
          v-else-if="
            displayedConversations.length === 0 &&
            $status.setup &&
            activeFilter === 'screener'
          "
          data-test="screener-empty"
        >
          <q-item-section>
            <q-item-label>{{
              $t('chatList.screenerFilterEmpty')
            }}</q-item-label>
          </q-item-section>
        </q-item>

        <q-item v-else-if="getSortedChatOrder.length === 0 && $status.setup">
          <q-item-section>
            <q-item-label>{{ $t('chatList.noContactMessage') }}</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </q-scroll-area>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, ref } from 'vue'
import { storeToRefs } from 'pinia'

import ChatListItem from './ChatListItem.vue'
import { Conversation, useChatStore } from '../../stores/chats'
import { useContactStore } from '../../stores/contacts'

import { openChat, openPage } from '../../utils/routes'
import { useRouter } from 'vue-router'
import { useQuasar } from 'quasar'
import { isNarrowWidth } from '../../utils/layout'
import { activeChain } from '@frank/wallet/chain'
import { formatDisplayAmount } from 'src/utils/chain-amount'
import {
  ChatSearchIndex,
  type SearchSnippet,
} from '../../utils/chat-search-index'
import {
  isScreenerConversation,
  rankScreenerConversations,
  summarizeScreenerQueue,
} from '../../utils/screener-triage'

export default defineComponent({
  emits: ['closeDrawer'],
  setup(props, { emit }) {
    const chatStore = useChatStore()
    const { getSortedChatOrder } = storeToRefs(chatStore)

    const contactStore = useContactStore()

    const searchQuery = ref('')
    const activeFilter = ref<'all' | 'screener'>('all')
    const searchInputRef = ref<HTMLInputElement | null>(null)
    const searchIndex = new ChatSearchIndex()

    const isContactFn = (address: string): boolean =>
      contactStore.isContact(address)

    const getContactFn = (address: string) => contactStore.getContact(address)

    const screenerSummary = computed(() => {
      const list = Array.isArray(getSortedChatOrder?.value)
        ? getSortedChatOrder.value
        : []
      return summarizeScreenerQueue(list, {
        isContact: isContactFn,
        chain: activeChain,
      })
    })

    const normalizedQuery = computed(() => searchQuery.value.trim())

    const searchResults = computed(() => {
      const q = normalizedQuery.value
      if (!q) return []
      const list = Array.isArray(getSortedChatOrder?.value)
        ? getSortedChatOrder.value
        : []
      searchIndex.clear()
      searchIndex.indexConversations(list, {
        getContact: getContactFn,
        isScreened: conv =>
          isScreenerConversation(conv, { isContact: isContactFn }),
      })
      return searchIndex.searchConversations(q)
    })

    const searchSnippetByConv = computed<Record<string, SearchSnippet>>(() => {
      const map: Record<string, SearchSnippet> = {}
      for (const hit of searchResults.value) {
        if (hit.conversationId && hit.snippet?.text) {
          map[hit.conversationId] = hit.snippet
        }
      }
      return map
    })

    const displayedConversations = computed<Conversation[]>(() => {
      const list: Conversation[] = Array.isArray(getSortedChatOrder?.value)
        ? getSortedChatOrder.value
        : []
      if (normalizedQuery.value) {
        const byId = new Map<string, Conversation>()
        for (const c of list) {
          const key = c.id || c.address
          if (key) byId.set(key, c)
        }
        const matched: Conversation[] = []
        for (const hit of searchResults.value) {
          const conv = byId.get(hit.conversationId)
          if (conv) matched.push(conv)
        }
        if (activeFilter.value === 'screener') {
          return rankScreenerConversations(matched, {
            isContact: isContactFn,
          })
        }
        return matched
      }

      if (activeFilter.value === 'screener') {
        return rankScreenerConversations(list, {
          isContact: isContactFn,
        })
      }

      return list
    })

    const router = useRouter()
    const $q = useQuasar()
    return {
      getSortedChatOrder,
      displayedConversations,
      searchQuery,
      normalizedQuery,
      searchSnippetByConv,
      activeFilter,
      screenerSummary,
      searchInputRef,
      clearSearch() {
        searchQuery.value = ''
      },
      toggleScreenerFilter() {
        activeFilter.value =
          activeFilter.value === 'screener' ? 'all' : 'screener'
      },
      focusSearchInput() {
        searchInputRef.value?.focus()
        searchInputRef.value?.select()
      },
      openPage,
      openNewConversation() {
        const from =
          router.currentRoute?.value?.fullPath ||
          router.currentRoute?.value?.path ||
          ''
        const target = from.startsWith('/chat')
          ? `/new-conversation?from=${encodeURIComponent(from)}`
          : '/new-conversation'
        openPage(router, target)
      },
      selectConversation(item: Conversation | string) {
        const target = typeof item === 'string' ? item : item.id
        chatStore.setActiveConversation(target)
        openChat(router, target)
        // Direct user feedback (2026-09-29, ticket #123): on a narrow/mobile viewport the
        // drawer this list lives in is an overlay covering the whole chat -- selecting a chat
        // used to leave that overlay open on top of the chat it just navigated to, so the chat
        // was unusable until the user separately dismissed the drawer. Same shared threshold
        // as MainLayout.vue's drawer (`utils/layout`). Desktop (>800px) never emits this: the
        // sidebar is meant to stay open there.
        if (isNarrowWidth($q.screen.width)) {
          emit('closeDrawer')
        }
      },
      setActiveChat(
        this: { selectConversation(item: Conversation | string): void },
        item: Conversation | string,
      ) {
        return this.selectConversation(item)
      },
      formatAmount(amount?: number) {
        if (amount === undefined) {
          return
        }
        return formatDisplayAmount(activeChain, BigInt(Math.trunc(amount)))
      },
    }
  },
  props: {
    compact: {
      type: Boolean,
      required: true,
    },
  },
  components: {
    ChatListItem,
  },
})
</script>

<style lang="scss" scoped>
.active-chat-list-item {
  background: var(--q-color-bg-active);
  color: var(--q-primary);
}

.chat-search-box {
  border: 1px solid rgba(128, 128, 128, 0.3);
  border-radius: 8px;
  padding: 4px 8px;
  background: rgba(128, 128, 128, 0.06);
}

.chat-search-native-input {
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  width: 100%;
}

.screener-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid rgba(128, 128, 128, 0.3);
  user-select: none;
}

.screener-chip--tollbooth {
  border-color: rgba(25, 118, 210, 0.45);
  color: var(--q-primary, #1976d2);
}

.screener-chip--active {
  background: var(--q-primary, #1976d2);
  color: #ffffff;
  border-color: var(--q-primary, #1976d2);
}

.chat-search-hit-snippet {
  opacity: 0.85;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-search-hit-snippet :deep(mark) {
  background-color: rgba(255, 213, 79, 0.45);
  color: inherit;
  padding: 0 2px;
  border-radius: 2px;
}
</style>
