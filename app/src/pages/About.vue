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
        <!-- Hero section -->
        <div
          class="column items-center q-mb-lg text-center about-hero"
          data-test="about-hero"
        >
          <q-avatar size="80px" class="q-mb-sm shadow-2">
            <img src="~assets/stamp-icon.png" :alt="$t('about.appName')" />
          </q-avatar>
          <div class="text-h4 text-weight-bold">
            {{ $t('about.appName') }}
          </div>
          <div class="text-subtitle1 text-grey-8 q-mt-xs">
            {{ $t('about.tagline') }}
          </div>
          <div class="row q-gutter-xs q-mt-sm justify-center">
            <q-chip dense outline color="primary" icon="bolt">
              {{ $t('about.badgeMonad') }}
            </q-chip>
            <q-chip dense outline color="secondary" icon="mail">
              {{ $t('about.badgeStamp') }}
            </q-chip>
            <q-chip dense outline color="accent" icon="lock">
              {{ $t('about.badgeEncrypted') }}
            </q-chip>
            <q-chip dense outline color="dark" icon="key">
              {{ $t('about.badgePermissionless') }}
            </q-chip>
          </div>
        </div>

        <!-- Frank Overview Card -->
        <q-card flat bordered class="q-mb-md" data-test="about-frank">
          <q-card-section>
            <div class="text-h6 q-mb-sm">{{ $t('about.frankTitle') }}</div>
            <p class="text-body2 text-grey-9 q-mb-sm">
              {{ $t('about.frankIntro') }}
            </p>
            <p class="text-body2 text-grey-9 q-mb-none">
              {{ $t('about.frankAccounts') }}
            </p>
          </q-card-section>
        </q-card>

        <!-- Stamp Protocol Card -->
        <q-card flat bordered class="q-mb-md" data-test="about-stamp">
          <q-card-section>
            <div class="text-h6 q-mb-sm">{{ $t('about.stampTitle') }}</div>
            <p class="text-body2 text-grey-9 q-mb-md">
              {{ $t('about.stampIntro') }}
            </p>

            <div class="column q-gutter-y-sm">
              <div class="row no-wrap items-start">
                <q-icon
                  name="payments"
                  color="primary"
                  size="24px"
                  class="q-mr-sm q-mt-xs"
                />
                <div>
                  <div class="text-weight-bold text-body2">
                    {{ $t('about.stampDMsTitle') }}
                  </div>
                  <div class="text-caption text-grey-8">
                    {{ $t('about.stampDMsDesc') }}
                  </div>
                </div>
              </div>

              <div class="row no-wrap items-start">
                <q-icon
                  name="local_fire_department"
                  color="negative"
                  size="24px"
                  class="q-mr-sm q-mt-xs"
                />
                <div>
                  <div class="text-weight-bold text-body2">
                    {{ $t('about.stampTopicsTitle') }}
                  </div>
                  <div class="text-caption text-grey-8">
                    {{ $t('about.stampTopicsDesc') }}
                  </div>
                </div>
              </div>

              <div class="row no-wrap items-start">
                <q-icon
                  name="security"
                  color="secondary"
                  size="24px"
                  class="q-mr-sm q-mt-xs"
                />
                <div>
                  <div class="text-weight-bold text-body2">
                    {{ $t('about.stampPrivacyTitle') }}
                  </div>
                  <div class="text-caption text-grey-8">
                    {{ $t('about.stampPrivacyDesc') }}
                  </div>
                </div>
              </div>
            </div>
          </q-card-section>
        </q-card>

        <!-- Links Card -->
        <q-card flat bordered class="q-mb-lg" data-test="about-links">
          <q-card-section>
            <div class="text-h6 q-mb-sm">{{ $t('about.linksTitle') }}</div>
            <div class="row q-gutter-sm">
              <q-btn
                outline
                no-caps
                color="primary"
                icon="code"
                :label="$t('about.githubRepo')"
                href="https://github.com/schancel/frank"
                target="_blank"
                rel="noopener noreferrer"
              />
            </div>
          </q-card-section>
        </q-card>

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
