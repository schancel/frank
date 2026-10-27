<template>
  <div class="column full-height overflow-hidden">
    <!-- Phone: the Contacts tab is the contact list, under the same app header as the other
    tabs. Wide: the list is already in the sidebar, so this pane only invites picking one
    (as the Messages pane does), not a second copy of the list. -->
    <q-header v-if="narrow">
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          data-testid="contacts-menu"
          @click="$emit('toggleMyDrawerOpen')"
        />
        <q-toolbar-title class="h6">{{
          $t('contactBookDialog.contacts')
        }}</q-toolbar-title>
      </q-toolbar>
    </q-header>
    <q-page-container class="col full-height overflow-hidden">
      <q-page
        v-if="narrow"
        class="column no-wrap q-pa-none"
        :style-fn="pageStyle"
        data-testid="contacts-page"
      >
        <contacts-panel class="col" :show-title="false" />
      </q-page>
      <q-page
        v-else
        class="flex flex-center text-center q-pa-md"
        data-testid="contacts-placeholder"
      >
        <div class="column items-center q-gutter-md">
          <q-icon name="contacts" size="4rem" color="primary" />
          <div class="text-h6 text-weight-medium">
            {{ $t('contactBookDialog.contacts') }}
          </div>
          <div class="text-body2 contacts-placeholder-muted">
            {{ $t('contactBookDialog.pickContact') }}
          </div>
        </div>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import ContactsPanel from 'src/components/panels/ContactsPanel.vue'
import { isNarrowWidth, viewportPageStyle } from 'src/utils/layout'
import { getEffectiveScreenWidth } from 'src/utils/mobile-viewport-scale'

export default defineComponent({
  name: 'ContactsPage',
  components: { ContactsPanel },
  emits: ['toggleMyDrawerOpen'],
  setup() {
    return { pageStyle: viewportPageStyle }
  },
  computed: {
    narrow(): boolean {
      const raw =
        this.$q?.screen?.width ??
        (typeof window !== 'undefined' ? window.innerWidth : 1024)
      return isNarrowWidth(getEffectiveScreenWidth(raw))
    },
  },
})
</script>

<style lang="scss" scoped>
.contacts-placeholder-muted {
  opacity: 0.7;
}
</style>
