<template>
  <!-- Real bug found live: this page used to wrap itself in its own <q-page-container><q-page>,
  but it's already rendered inside ForumLayout.vue's own <q-page-container><q-page><router-view />
  -- ForumLayout is the actual layout for every route nested under it (see routes.ts: 'forum's
  children include this page, Forum.vue, and ForumPost.vue). Quasar's q-page-container computes
  its content offset from the single shared q-layout instance (the outer MainLayout.vue's), so
  nesting a second one here double-applied that offset calculation -- the visible symptom was the
  whole form rendering shifted right with a large empty gap on the left, worse the narrower the
  actual available width. Neither Forum.vue nor ForumPost.vue (the other two pages under this same
  layout) wrap themselves this way -- this page was the only one that did, confirmed by checking
  both siblings before making this change. -->
  <q-card class="q-ma-none q-pa-sm">
    <q-form @submit="post">
      <q-card-section>
        <q-input
          label="Offering"
          v-model="offering"
          :suffix="chainUnit"
          :rules="[val => Number.parseFloat(val) || 'Invalid number']"
          lazy-rules
        />
        <q-select
          label="Topic"
          :disable="!!parentDigest"
          :model-value="topic"
          @update:model-value="setTopic"
          @input-value="markTopicEdited"
          :options="topics"
          @filter="filterTopics"
          use-input
          @new-value="createValue"
          new-value-mode="add-unique"
          input-debounce="0"
          :rules="[
            val =>
              (val && val.length > 0 && /^[a-z0-9.-]+$/.test(val)) ||
              'Only numbers, lowercase, periods and dashes allowed',
            val =>
              !val.split('.').some(val => val.length === 0) ||
              'Topic segments not allowed to be empty',
          ]"
          lazy-rules
        >
          <template #no-option>
            <q-item>
              <q-item-section class="text-grey">No results</q-item-section>
            </q-item>
          </template>
        </q-select>
        <q-input label="Post Title" v-model="title" />
        <q-input
          label="URL"
          v-model="url"
          :rules="[val => !val || validateUrl(val) || 'Invalid URL']"
          lazy-rules
        />
        <!-- Ticket feedback (real, direct): the side-by-side Message/Preview split used Quasar's
        row/col grid (col-md / col-md-6), which breakpoints off the *viewport* width, not this
        card's own width -- so it went side-by-side even when the card itself was narrow, squeezing
        both halves uncomfortably. Stacked vertically instead, always, regardless of viewport. -->
        <q-card-section class="col-12 q-pa-none">
          <q-input label="Message" v-model="message" type="textarea" />
        </q-card-section>

        <q-card-section class="col-12 q-pa-none q-pt-md" v-show="this.message">
          <div class="text-weight-bold text-caption">Message Preview</div>
          <q-card-section class="q-pa-none q-pt-xs">
            <span class="mdstyle" v-html="markedMessage" />
          </q-card-section>
        </q-card-section>
      </q-card-section>
      <q-card-actions align="right">
        <div
          v-if="preparationStatus"
          class="text-caption q-mr-sm"
          role="status"
          data-test="post-status"
        >
          {{ preparationStatus }}
        </div>
        <q-btn @click="back" label="back" color="negative" class="q-ma-sm" />
        <q-btn
          type="submit"
          label="Post"
          color="primary"
          class="q-ma-sm"
          :disable="posting || (!!parentDigest && !parentMessage)"
          :loading="posting"
        />
      </q-card-actions>
    </q-form>
  </q-card>

  <q-card class="q-ma-sm" v-if="parentMessage">
    <q-card-section>Replying to:</q-card-section>
    <a-message :message="parentMessage" :show-replies="false" :compact="true" />
  </q-card>
</template>

<script lang="ts">
import { navigateBack } from 'src/utils/navigate-back'
import { defineComponent } from 'vue'
import { storeToRefs } from 'pinia'

import { renderMarkdown } from '../utils/markdown'
import { useForumStore } from 'src/stores/forum'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { activeChain } from '@frank/wallet/chain'
import { displayToSafeRawAmount } from 'src/utils/chain-amount'

import { useTopicStore } from 'src/stores/topics'
import { topicOptions } from 'src/utils/topic-options'
import AMessage from '../components/forum/ForumMessage.vue'
import { errorNotify, infoNotify } from 'src/utils/notifications'
import { submitPost } from 'src/utils/submit-post'
import { stampPreparationStatus } from 'src/utils/stamp-preparation-status'

export default defineComponent({
  setup() {
    const forum = useForumStore()
    const { topics, getMessage, selectedTopic } = storeToRefs(forum)
    return {
      topicStore: useTopicStore(),
      getMessage: getMessage,
      availableTopics: topics,
      selectedTopic,
      pushNewTopic: forum.pushNewTopic,
      postMessage: forum.putMessage,
    }
  },
  components: {
    AMessage,
  },
  emits: ['setTopic'],
  props: {},
  data() {
    const forum = useForumStore()
    const parentDigest = this.$route.params.parentDigest as string
    const topLevelTopic = forum.selectedTopic
    return {
      offering: activeChain.toDisplayAmount(activeChain.defaultTopicVoteValue),
      topic: parentDigest
        ? forum.index[parentDigest]?.topic ?? ''
        : topLevelTopic,
      topLevelTopic,
      topLevelTopicWasEdited: false,
      topics: [] as string[],
      title: '',
      url: null,
      message: '',
      parentDigest,
      chainUnit: activeChain.unit,
      posting: false,
      preparationStatus: null as string | null,
      nextSubmissionId: 0,
      activeSubmissionId: null as number | null,
      inFlightSubmissions: {} as Record<string, number | undefined>,
      submissionStatuses: {} as Record<string, string | null | undefined>,
      componentMounted: false,
    }
  },
  mounted() {
    this.componentMounted = true
  },
  beforeUnmount() {
    this.componentMounted = false
    this.activeSubmissionId = null
  },
  computed: {
    // Topics seen in posts, plus the default and relay-discovered ones the topic store tracks.
    knownTopics(): string[] {
      return [...this.availableTopics, ...this.topicStore.getTopics]
    },
    markedMessage() {
      const text: string = this.message
      return renderMarkdown(text, this.$q.dark.isActive)
    },
    parentMessage() {
      return this.parentDigest ? this.getMessage(this.parentDigest) : undefined
    },
  },
  watch: {
    '$route.params.parentDigest'(nextParentDigest: unknown) {
      this.syncParentDigest(
        typeof nextParentDigest === 'string' ? nextParentDigest : undefined,
      )
    },
    'parentMessage'(nextParent: { topic: string } | undefined) {
      if (this.parentDigest && nextParent) {
        this.topic = nextParent.topic
      }
    },
    'selectedTopic'(nextTopic: string) {
      if (!this.parentDigest && !this.topLevelTopicWasEdited) {
        this.topLevelTopic = nextTopic
        this.topic = nextTopic
      }
    },
  },
  methods: {
    submissionDestination(parentDigest: string | undefined) {
      return parentDigest ? `reply:${parentDigest}` : 'top-level'
    },
    syncSubmissionUi(parentDigest: string | undefined) {
      const destination = this.submissionDestination(parentDigest)
      const submissionId = this.inFlightSubmissions[destination] ?? null
      this.activeSubmissionId = submissionId
      this.posting = submissionId !== null
      this.preparationStatus =
        submissionId === null
          ? null
          : this.submissionStatuses[destination] ?? null
    },
    syncParentDigest(parentDigest: string | undefined) {
      this.parentDigest = parentDigest
      if (parentDigest) {
        this.topic = this.getMessage(parentDigest)?.topic ?? ''
      } else {
        if (!this.topLevelTopicWasEdited) {
          this.topLevelTopic = this.selectedTopic
        }
        this.topic = this.topLevelTopic
      }
      this.syncSubmissionUi(parentDigest)
    },
    setTopic(topic: string | null) {
      if (this.parentDigest) return
      this.topLevelTopicWasEdited = true
      this.topLevelTopic = topic ?? ''
      this.topic = this.topLevelTopic
    },
    markTopicEdited() {
      if (!this.parentDigest) {
        this.topLevelTopicWasEdited = true
      }
    },
    filterTopics(inputTopic: string, update: (arg: () => void) => void) {
      update(() => {
        this.topics = topicOptions(inputTopic, this.knownTopics)
      })
    },
    createValue(
      val: string,
      done: (val: string, newValueMode: string) => void,
    ) {
      // Calling done(var) when newValueMode is "add-unique", or done(var, "add-unique")
      // adds "var" content to the model only if is not already set
      // and it resets the input textbox to empty string
      // https://quasar.dev/vue-components/select#example--filtering-and-adding-to-menu
      if (val.length > 0) {
        if (!this.availableTopics.includes(val)) {
          this.pushNewTopic(val)
        }
        done(val, 'add-unique')
      }
    },
    async post() {
      if (this.parentDigest && !this.parentMessage) return
      // A second submit while the first is still preparing/funding would queue a second burn.
      if (this.posting) return

      const submittedTopic = this.topic
      const submittedParentDigest = this.parentDigest
      const submittedDestination = this.submissionDestination(
        submittedParentDigest,
      )
      if (this.inFlightSubmissions[submittedDestination] !== undefined) return

      const submissionId = ++this.nextSubmissionId
      const postingStatus = this.$t('stampPreparation.posting')
      this.inFlightSubmissions[submittedDestination] = submissionId
      this.submissionStatuses[submittedDestination] = postingStatus
      this.activeSubmissionId = submissionId
      const entry = {
        kind: 'post' as const,
        title: this.title,
        url: this.url ? this.url : undefined,
        message: this.message,
      }
      console.log('posting message', entry)
      if (!entry) {
        console.error('entry is null in CreatePost.vue post handler')
        return
      }
      this.posting = true
      this.preparationStatus = postingStatus

      await submitPost({
        submit: async () => {
          const wallet = await useActiveWallet()
          await this.postMessage({
            wallet,
            entry,
            satoshis: displayToSafeRawAmount(
              activeChain,
              this.offering.toString(),
            ),
            topic: submittedTopic,
            parentDigest: submittedParentDigest,
            onPreparationProgress: progress => {
              if (
                this.inFlightSubmissions[submittedDestination] !== submissionId
              ) {
                return
              }
              const status = stampPreparationStatus(
                progress,
                (key, params) => this.$t(key, params ?? {}),
                {
                  format: raw => activeChain.toDisplayAmount(raw),
                  unit: activeChain.unit,
                },
              )
              this.submissionStatuses[submittedDestination] = status
              if (this.activeSubmissionId === submissionId) {
                this.preparationStatus = status
              }
            },
          })
        },
        errorNotify,
        infoNotify,
        navigateBack: () => {
          if (
            this.componentMounted &&
            this.activeSubmissionId === submissionId &&
            this.submissionDestination(this.parentDigest) ===
              submittedDestination
          ) {
            this.back()
          }
        },
        messages: {
          created: this.$t('stampPreparation.postCreated', {
            topic: submittedTopic,
          }),
          refreshFailed: this.$t('stampPreparation.postedRefreshFailed'),
        },
      }).finally(() => {
        if (this.inFlightSubmissions[submittedDestination] === submissionId) {
          delete this.inFlightSubmissions[submittedDestination]
          delete this.submissionStatuses[submittedDestination]
        }
        if (this.activeSubmissionId === submissionId) {
          this.activeSubmissionId = null
          this.posting = false
          this.preparationStatus = null
        }
      })
    },
    back() {
      navigateBack(this.$router)
    },
    validateUrl(val: string) {
      try {
        const url = new URL(val)
        return !!url
      } catch (err) {
        console.log(err)
        return false
      }
    },
  },
})
</script>

<style scoped>
:deep() .mdstyle img {
  max-width: 100%;
  max-height: 448px;
}
:deep() .mdstyle pre code {
  /*overflow-wrap: break-word;*/
  max-width: 100%;
  white-space: pre-wrap;
}
:deep() .mdstyle table {
  /*overflow-wrap: break-word;*/
  max-width: 100%;
  white-space: pre-wrap;
}
:deep() .mdstyle p {
  max-width: 100%;
  word-break: break-word;
}
:deep() .mdstyle h1 {
  font-size: 120%;
  font-weight: bold;
  line-height: inherit;
}
:deep() .mdstyle h2 {
  font-size: 120%;
  font-weight: bold;
  line-height: inherit;
}
:deep() .mdstyle h3 {
  font-size: 120%;
  font-weight: bold;
  line-height: inherit;
}
:deep() .mdstyle h4 {
  font-size: 120%;
  font-weight: bold;
  line-height: inherit;
}
</style>
