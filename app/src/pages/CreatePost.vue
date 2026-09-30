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
          :disable="!!getMessage(parentDigest)"
          v-model="topic"
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
          :disable="posting"
          :loading="posting"
        />
      </q-card-actions>
    </q-form>
  </q-card>

  <q-card class="q-ma-sm" v-if="getMessage(parentDigest)">
    <q-card-section>Replying to:</q-card-section>
    <a-message
      :message="getMessage(parentDigest)"
      :show-replies="false"
      :compact="true"
    />
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
    const { topics, getMessage } = storeToRefs(forum)
    return {
      topicStore: useTopicStore(),
      getMessage: getMessage,
      availableTopics: topics,
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
    return {
      offering: activeChain.toDisplayAmount(activeChain.defaultTopicVoteValue),
      topic: forum.index[parentDigest]?.topic ?? '',
      topics: [] as string[],
      title: '',
      url: null,
      message: '',
      parentDigest,
      chainUnit: activeChain.unit,
      posting: false,
      preparationStatus: null as string | null,
    }
  },
  beforeRouteUpdate(to, from, next) {
    this.parentDigest = to.params.parentDigest as string
    next()
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
  },
  methods: {
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
      // A second submit while the first is still preparing/funding would queue a second burn.
      if (this.posting) return
      this.posting = true
      this.preparationStatus = this.$t('stampPreparation.posting')

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
            topic: this.topic,
            parentDigest: this.parentDigest,
            onPreparationProgress: progress => {
              this.preparationStatus = stampPreparationStatus(
                progress,
                (key, params) => this.$t(key, params ?? {}),
                {
                  format: raw => activeChain.toDisplayAmount(raw),
                  unit: activeChain.unit,
                },
              )
            },
          })
        },
        errorNotify,
        infoNotify,
        navigateBack: this.back,
        messages: {
          created: this.$t('stampPreparation.postCreated'),
          refreshFailed: this.$t('stampPreparation.postedRefreshFailed'),
        },
      }).finally(() => {
        this.posting = false
        this.preparationStatus = null
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
