<template>
  <div>
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          @click="toggleSettingsDrawerOpen"
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          :aria-expanded="myDrawerOpen"
        />
        <q-toolbar-title class="h6">{{ $t('about.title') }}</q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="q-pa-md about-page">
        <section data-test="third-party-notices">
          <h2 class="text-h6 q-mt-none">{{ $t('about.thirdPartyTitle') }}</h2>

          <h3 class="text-subtitle1">{{ $t('about.dklsName') }}</h3>
          <p data-test="dkls-modified">
            {{ $t('about.dklsModified', { date: changedOn }) }}
          </p>
          <p data-test="dkls-changes">{{ $t('about.dklsChanges') }}</p>
          <p data-test="dkls-non-commercial" class="text-weight-medium">
            {{ $t('about.dklsNonCommercial') }}
          </p>
          <p data-test="dkls-notice" lang="en">{{ notice }}</p>
          <p data-test="dkls-source">
            {{ $t('about.dklsSource', { path: sourcePath }) }}
          </p>

          <h3 class="text-subtitle1">{{ $t('about.licenseHeading') }}</h3>
          <p>{{ $t('about.licenseIntro') }}</p>
          <pre
            data-test="dkls-license"
            class="about-license"
            lang="en"
            tabindex="0"
            :aria-label="$t('about.licenseHeading')"
            >{{ license }}</pre
          >
        </section>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'
import {
  SILENCE_LABORATORIES_CHANGED_ON,
  SILENCE_LABORATORIES_LICENSE,
  SILENCE_LABORATORIES_NOTICE,
  SILENCE_LABORATORIES_SOURCE_PATH,
} from '../licenses/silence-laboratories'

/**
 * About: the notices Frank owes for third-party software it ships. Today
 * that is one component, the modified Silence Laboratories DKLs23 library
 * used for two-party signing. Its licence requires that users are told it is
 * used, that it was changed and by whom, and that they get the licence text.
 */
export default defineComponent({
  emits: ['toggleMyDrawerOpen'],
  setup(_, { emit }) {
    return {
      myDrawerOpen: useMyDrawerOpen(),
      notice: SILENCE_LABORATORIES_NOTICE,
      license: SILENCE_LABORATORIES_LICENSE,
      sourcePath: SILENCE_LABORATORIES_SOURCE_PATH,
      changedOn: SILENCE_LABORATORIES_CHANGED_ON,
      toggleSettingsDrawerOpen() {
        emit('toggleMyDrawerOpen')
      },
    }
  },
})
</script>

<style lang="scss" scoped>
.about-page {
  max-width: 60rem;
}
.about-license {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 60vh;
  overflow-y: auto;
  padding: 0.75rem;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 0.8rem;
}
</style>
