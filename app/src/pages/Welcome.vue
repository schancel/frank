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
          data-test="welcome-menu"
        />
        <q-toolbar-title class="h6">{{ $t('welcome.title') }}</q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="q-pa-md welcome-page">
        <!-- Hero Section -->
        <div
          class="column items-center q-mb-xl text-center welcome-hero"
          data-test="welcome-hero"
        >
          <q-avatar size="96px" class="q-mb-md shadow-3">
            <img src="~assets/stamp-icon.png" alt="Frank" />
          </q-avatar>
          <div class="text-h3 text-weight-bolder tracking-tight">
            {{ $t('about.appName') }}
          </div>
          <div
            class="text-h6 text-primary text-weight-bold q-mt-xs"
            data-test="welcome-tagline"
          >
            {{ $t('welcome.tagline') }}
          </div>
          <div class="text-subtitle1 text-grey-8 q-mt-xs">
            {{ $t('welcome.subtitle') }}
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

          <p class="text-body1 text-grey-9 q-mt-md welcome-intro-text">
            {{ $t('welcome.introText') }}
          </p>

          <!-- Primary Call to Actions -->
          <div
            class="row q-gutter-md q-mt-md justify-center full-width"
            style="max-width: 32rem"
          >
            <q-btn
              color="primary"
              unelevated
              size="lg"
              class="col-12 col-sm full-width text-weight-bold"
              icon="login"
              :label="$t('welcome.createAccount')"
              to="/setup"
              data-test="btn-create-account"
            />
            <q-btn
              color="primary"
              outline
              size="lg"
              class="col-12 col-sm full-width text-weight-bold"
              icon="dynamic_feed"
              :label="$t('welcome.browseForum')"
              to="/forum"
              data-test="btn-browse-forum"
            />
          </div>

          <div class="q-mt-md">
            <q-btn
              flat
              dense
              no-caps
              color="grey-8"
              icon="menu_book"
              :label="$t('welcome.readDocs')"
              to="/docs"
              data-test="btn-read-docs"
            />
          </div>
        </div>

        <!-- How Frank Works / Core Pillars Grid -->
        <div class="q-mb-xl" data-test="welcome-features">
          <div class="text-h5 text-weight-bold q-mb-md text-center">
            {{ $t('welcome.howItWorks') }}
          </div>

          <div class="row q-col-gutter-md">
            <!-- Pillar 1: Free Speech Is Not Free -->
            <div class="col-12 col-md-6">
              <q-card flat bordered class="feature-card full-height">
                <q-card-section>
                  <div class="row items-center q-mb-sm">
                    <q-avatar
                      color="primary"
                      text-color="white"
                      icon="payments"
                      size="40px"
                      class="q-mr-sm"
                    />
                    <div class="text-h6 text-weight-bold">
                      {{ $t('welcome.pillarFreeSpeechTitle') }}
                    </div>
                  </div>
                  <p class="text-body2 text-grey-8 q-mb-none">
                    {{ $t('welcome.pillarFreeSpeechDesc') }}
                  </p>
                </q-card-section>
              </q-card>
            </div>

            <!-- Pillar 2: Ambient Privacy & DKSAP -->
            <div class="col-12 col-md-6">
              <q-card flat bordered class="feature-card full-height">
                <q-card-section>
                  <div class="row items-center q-mb-sm">
                    <q-avatar
                      color="secondary"
                      text-color="white"
                      icon="security"
                      size="40px"
                      class="q-mr-sm"
                    />
                    <div class="text-h6 text-weight-bold">
                      {{ $t('welcome.pillarPrivacyTitle') }}
                    </div>
                  </div>
                  <p class="text-body2 text-grey-8 q-mb-none">
                    {{ $t('welcome.pillarPrivacyDesc') }}
                  </p>
                </q-card-section>
              </q-card>
            </div>

            <!-- Pillar 3: Zero-PII Sovereign Identity -->
            <div class="col-12 col-md-6">
              <q-card flat bordered class="feature-card full-height">
                <q-card-section>
                  <div class="row items-center q-mb-sm">
                    <q-avatar
                      color="dark"
                      text-color="white"
                      icon="key"
                      size="40px"
                      class="q-mr-sm"
                    />
                    <div class="text-h6 text-weight-bold">
                      {{ $t('welcome.pillarIdentityTitle') }}
                    </div>
                  </div>
                  <p class="text-body2 text-grey-8 q-mb-none">
                    {{ $t('welcome.pillarIdentityDesc') }}
                  </p>
                </q-card-section>
              </q-card>
            </div>

            <!-- Pillar 4: Federated Mailbox Relays -->
            <div class="col-12 col-md-6">
              <q-card flat bordered class="feature-card full-height">
                <q-card-section>
                  <div class="row items-center q-mb-sm">
                    <q-avatar
                      color="accent"
                      text-color="white"
                      icon="hub"
                      size="40px"
                      class="q-mr-sm"
                    />
                    <div class="text-h6 text-weight-bold">
                      {{ $t('welcome.pillarRelayTitle') }}
                    </div>
                  </div>
                  <p class="text-body2 text-grey-8 q-mb-none">
                    {{ $t('welcome.pillarRelayDesc') }}
                  </p>
                </q-card-section>
              </q-card>
            </div>
          </div>
        </div>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'

export default defineComponent({
  name: 'WelcomePage',
  emits: ['toggleMyDrawerOpen'],
  setup(_, { emit }) {
    return {
      myDrawerOpen: useMyDrawerOpen(),
      toggleSettingsDrawerOpen() {
        emit('toggleMyDrawerOpen')
      },
    }
  },
})
</script>

<style lang="scss" scoped>
.welcome-page {
  max-width: 56rem;
  margin: 0 auto;
}
.welcome-intro-text {
  max-width: 42rem;
  line-height: 1.6;
}
.feature-card {
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  border-radius: 8px;
  &:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }
}
</style>
