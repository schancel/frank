<template>
  <!-- Phone: the Contacts tab is the contact list, with add from there (the wide layout shows
  the same list in the drawer). -->
  <q-page-container class="col full-height overflow-hidden">
    <q-page
      class="column no-wrap q-pa-none"
      :style-fn="pageStyle"
      data-testid="contacts-page"
    >
      <contacts-panel class="col" />
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import ContactsPanel from 'src/components/panels/ContactsPanel.vue'
import { viewportPageStyle } from 'src/utils/layout'

export default defineComponent({
  name: 'ContactsPage',
  components: { ContactsPanel },
  setup() {
    return { pageStyle: viewportPageStyle }
  },
})
</script>
