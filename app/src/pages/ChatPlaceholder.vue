<template>
  <q-page-container>
    <q-page class="flex flex-center text-center q-pa-md">
      <div class="column items-center q-gutter-md">
        <q-icon name="chat" size="4rem" color="primary" />
        <div class="text-h6 text-weight-medium">
          {{ $t('chatList.directMessages') }}
        </div>
        <div class="text-body2 text-grey-7" style="max-width: 360px">
          {{ $t('chatList.selectChatOrAddContact') }}
        </div>
        <q-btn
          color="primary"
          no-caps
          icon="person_add"
          :label="$t('newContactDialog.newContact')"
          @click="openAddContact"
        />
      </div>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { openPage } from 'src/utils/routes'

export default defineComponent({
  name: 'ChatPlaceholder',
  methods: {
    openAddContact() {
      openPage(this.$router, '/add-contact')
    },
  },
})
</script>
