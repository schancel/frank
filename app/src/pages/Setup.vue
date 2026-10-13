<template>
  <div>
    <q-header
      ><q-toolbar>
        <q-btn
          flat
          dense
          no-caps
          icon="menu"
          :aria-label="$t('accountRecovery.open_navigation')"
          @click="$emit('toggleMyDrawerOpen')"
        />
        <q-toolbar-title>
          {{ $t('accountRecovery.frank_account') }}
        </q-toolbar-title>
      </q-toolbar></q-header
    >
    <q-page-container
      ><q-page class="q-pa-md">
        <section
          class="account-setup q-mx-auto"
          aria-labelledby="account-heading"
        >
          <h1
            id="account-heading"
            ref="heading"
            tabindex="-1"
            :class="
              tabCoordinator.otherTabActive ||
              account.status === 'standby' ||
              mode === 'legacy'
                ? 'text-h5'
                : 'q-sr-only'
            "
          >
            {{
              tabCoordinator.otherTabActive || account.status === 'standby'
                ? $t('accountRecovery.frank_is_open_in_another_tab')
                : mode === 'legacy'
                ? $t('accountRecovery.identify_legacy_account_locally')
                : $t('accountRecovery.frank_account')
            }}
          </h1>
          <p role="status" aria-live="polite" data-test="account-status">
            {{ statusText }}
          </p>
          <p
            v-if="
              error &&
              !tabCoordinator.otherTabActive &&
              account.status !== 'standby'
            "
            role="alert"
            class="text-negative"
            data-test="account-error"
          >
            {{ error }}
          </p>
          <q-btn
            v-if="
              (account.status === 'locked' ||
                account.status === 'unavailable') &&
              mode !== 'choice' &&
              !tabCoordinator.otherTabActive
            "
            outline
            color="primary"
            no-caps
            :label="$t('accountRecovery.retry_opening_account')"
            :disable="busy"
            data-test="retry-existing-account"
            @click="retry"
          />
          <q-btn
            v-if="profileRecoveryFailed && account.status === 'ready'"
            outline
            color="primary"
            no-caps
            :label="$t('accountRecovery.profile_restore_retry')"
            :disable="busy"
            data-test="retry-profile-recovery"
            @click="retryProfileRecovery"
          />
          <div
            v-if="shareReport.length && mode !== 'restore-choose'"
            role="status"
            data-test="share-report"
          >
            <p class="q-mb-xs">
              {{ $t('accountRecovery.share_report_title') }}
            </p>
            <ul class="q-mt-none">
              <li
                v-for="line in shareReportLines"
                :key="line.position"
                :class="line.ok ? '' : 'text-negative'"
                :data-test="`share-report-${line.status}`"
              >
                {{ line.text }}
              </li>
            </ul>
          </div>
          <p
            v-for="(set, index) in insufficientSets"
            :key="index"
            data-test="insufficient-share-set"
            role="status"
          >
            {{ $t('accountRecovery.insufficient_share_set', set) }}
          </p>
          <template
            v-if="tabCoordinator.otherTabActive || account.status === 'standby'"
          >
            <div class="q-my-md" data-test="multi-tab-locked-container">
              <q-card flat bordered class="q-pa-md">
                <q-card-section class="row items-center q-pb-none">
                  <q-avatar icon="tab" color="primary" text-color="white" />
                  <div class="text-h6 q-ml-md">
                    {{ $t('accountRecovery.frank_is_open_in_another_tab') }}
                  </div>
                </q-card-section>
                <q-card-section>
                  <p class="text-body1 text-grey-8">
                    {{ $t('accountRecovery.multi_tab_notice') }}
                  </p>
                </q-card-section>
                <q-card-actions class="q-pt-none">
                  <q-btn
                    color="primary"
                    no-caps
                    :loading="tabCoordinator.isTakingOver"
                    :label="$t('accountRecovery.use_frank_here')"
                    data-test="use-frank-here-btn"
                    @click="takeoverHere"
                  />
                  <q-btn
                    outline
                    color="primary"
                    no-caps
                    :label="$t('accountRecovery.switch_to_open_tab')"
                    data-test="switch-tab-btn"
                    @click="switchToOpenTab"
                  />
                </q-card-actions>
                <q-card-section
                  v-if="showManualTabHint"
                  class="text-body2 text-grey-8 q-pt-none"
                  role="status"
                  aria-live="polite"
                  data-test="switch-tab-help"
                >
                  {{ $t('accountRecovery.manual_tab_switch_hint') }}
                </q-card-section>
              </q-card>
            </div>
          </template>
          <template
            v-else-if="
              (account.status === 'locked' ||
                account.status === 'unavailable' ||
                legacy.unavailable) &&
              mode === 'choice'
            "
          >
            <p>
              {{
                $t(
                  account.error === 'wallet-chain-mismatch'
                    ? 'accountRecovery.wallet_chain_mismatch'
                    : account.error === 'profile-unreachable'
                    ? 'accountRecovery.profile_restore_unreachable'
                    : 'accountRecovery.saved_account_data_could_not_be_opened',
                )
              }}
            </p>
            <div class="row q-gutter-sm items-center q-my-md">
              <q-btn
                color="primary"
                no-caps
                :label="$t('accountRecovery.retry_opening_account')"
                :loading="busy"
                data-test="retry-account"
                @click="retry"
              />
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.restore_account')"
                data-test="restore-locked-account"
                :disable="busy"
                @click="startRestoreLocked"
              />
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.identify_legacy_account_locally')"
                data-test="legacy-locked-recovery"
                :disable="busy"
                @click="startLegacyLocked"
              />
              <q-btn
                v-if="
                  account.error !== 'profile-unreachable' &&
                  account.error !== 'wallet-chain-mismatch'
                "
                flat
                color="negative"
                no-caps
                :label="$t('accountRecovery.reset_account_storage')"
                data-test="reset-account-storage"
                :loading="busy"
                :disable="busy"
                @click="resetStorage"
              />
            </div>
          </template>
          <template v-else-if="account.pending && mode !== 'legacy'">
            <p
              v-if="account.pendingError === 'outdated-attempt'"
              role="status"
              data-test="pending-outdated"
            >
              {{ $t('accountRecovery.pending_outdated_cancel_and_redo') }}
            </p>
            <p
              v-else-if="account.pendingError"
              role="status"
              data-test="pending-error"
            >
              {{ $t('accountRecovery.pending_retry') }}
            </p>
            <q-btn
              v-if="
                account.pendingError &&
                account.pendingError !== 'outdated-attempt'
              "
              outline
              color="primary"
              no-caps
              :label="$t('accountRecovery.retry_opening_account')"
              data-test="retry-pending"
              :disable="busy"
              @click="retry"
            />
            <p>
              {{ $t('accountRecovery.a_saved_account_attempt_is_pending_it') }}
            </p>
            <h2 class="text-h6" data-test="account-found">
              {{ $t('accountRecovery.account_found') }}
            </h2>
            <div
              v-if="account.pendingIdentityAddress"
              role="status"
              data-test="pending-identity"
            >
              <p class="q-mb-xs">
                {{ $t('accountRecovery.pending_identity_address') }}
              </p>
              <p class="recovery-text" data-test="pending-identity-address">
                {{ account.pendingIdentityAddress }}
              </p>
              <p v-if="pendingProfile?.name" data-test="pending-display-name">
                {{ $t('accountRecovery.display_name') }}:
                {{ pendingProfile.name }}
              </p>
              <p v-if="pendingProfile?.username" data-test="pending-username">
                {{ $t('accountRecovery.pending_username') }}: @{{
                  pendingProfile.username
                }}
              </p>
              <p v-if="pendingProfileStatus === 'loading'" role="status">
                {{ $t('accountRecovery.pending_profile_loading') }}
              </p>
              <div
                v-else-if="
                  pendingProfileStatus === 'unreachable' ||
                  pendingProfileStatus === 'unverified'
                "
                role="alert"
                data-test="pending-profile-error"
              >
                <p>
                  {{
                    pendingProfileStatus === 'unverified'
                      ? $t('accountRecovery.pending_profile_unverified')
                      : $t('accountRecovery.pending_profile_unreachable')
                  }}
                </p>
                <q-btn
                  outline
                  color="primary"
                  no-caps
                  :label="$t('accountRecovery.profile_restore_retry')"
                  data-test="retry-pending-profile"
                  @click="pendingProfileRetry++"
                />
              </div>
              <p class="text-negative">
                {{ $t('accountRecovery.pending_identity_stop_if_unexpected') }}
              </p>
            </div>
            <p
              v-if="discoveredRelay"
              role="status"
              aria-live="polite"
              class="text-positive q-mt-sm"
              data-test="relay-discovered-status"
            >
              {{
                $t('accountRecovery.relay_discovered', { url: discoveredRelay })
              }}
            </p>
            <q-expansion-item
              class="q-mt-md"
              icon="tune"
              :label="$t('accountRecovery.advanced_options')"
              :caption="$t('accountRecovery.relay_server')"
              header-class="text-weight-medium text-grey-8"
              data-test="advanced-relay-expansion"
            >
              <q-card class="bg-transparent q-pa-none">
                <q-card-section class="q-px-none q-pt-sm">
                  <q-input
                    v-model="customRelayUrl"
                    outlined
                    dense
                    :label="$t('accountRecovery.relay_server_url')"
                    :hint="$t('accountRecovery.relay_server_url_hint')"
                    :placeholder="defaultRelayUrl"
                    data-test="custom-relay-input"
                    :rules="[validateRelayUrl]"
                  >
                    <template
                      v-if="
                        customRelayUrl && customRelayUrl !== defaultRelayUrl
                      "
                      #append
                    >
                      <q-btn
                        flat
                        dense
                        round
                        icon="restart_alt"
                        :title="$t('accountRecovery.reset_to_default_relay')"
                        data-test="reset-default-relay"
                        @click="customRelayUrl = defaultRelayUrl"
                      />
                    </template>
                  </q-input>
                </q-card-section>
              </q-card>
            </q-expansion-item>
            <div
              v-if="account.pendingReady && account.pendingIdentityAddress"
              class="row q-gutter-sm q-mt-md items-center"
            >
              <q-btn
                color="primary"
                no-caps
                :label="$t('accountRecovery.activate_account')"
                data-test="activate-account"
                :disable="busy"
                :loading="busy"
                @click="activate"
              />
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.cancel_pending_attempt')"
                data-test="cancel-pending"
                :disable="busy"
                @click="cancelPending"
              />
            </div>
            <div v-else class="q-mt-md">
              <p>
                {{
                  $t(
                    'accountRecovery.the_attempt_is_incomplete_or_awaiting_cleanup',
                  )
                }}
              </p>
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.cancel_pending_attempt')"
                data-test="cancel-pending"
                :disable="busy"
                @click="cancelPending"
              />
            </div>
            <q-btn
              v-if="account.status === 'ready'"
              class="q-mt-md"
              outline
              color="primary"
              no-caps
              :label="$t('accountRecovery.return_to_wallet')"
              @click="$router.push('/wallet')"
            />
          </template>
          <template v-else-if="account.status !== 'loading'">
            <template v-if="mode === 'choice'">
              <p>
                {{
                  $t('accountRecovery.create_a_frank_account_backup_or_restore')
                }}
              </p>
              <div v-if="account.account || legacy.present" class="q-mb-md">
                <p v-if="legacy.present">
                  {{
                    $t(
                      'accountRecovery.an_existing_legacy_account_is_quarantined_its',
                    )
                  }}
                </p>
                <p v-if="account.account">
                  {{
                    $t(
                      'accountRecovery.changing_accounts_replaces_the_active_local_account',
                    )
                  }}
                </p>
                <q-checkbox
                  v-model="replaceAccepted"
                  :label="
                    $t(
                      'accountRecovery.i_understand_this_changes_the_active_local',
                    )
                  "
                  data-test="replace-ack"
                />
              </div>
              <section class="q-mt-lg q-mb-lg" data-test="mera-options">
                <q-btn
                  color="primary"
                  no-caps
                  class="mera-continue-btn"
                  data-test="mera-continue"
                  :disable="!mayBegin || busy"
                  :aria-expanded="passkeyChoicesOpen"
                  @click="passkeyChoicesOpen = !passkeyChoicesOpen"
                >
                  <img
                    :src="meraLogo"
                    alt=""
                    width="24"
                    height="24"
                    class="mera-logo q-mr-sm"
                    data-test="mera-logo"
                  />
                  <span>{{ $t('accountRecovery.mera_login') }}</span>
                </q-btn>
                <div
                  v-if="passkeyChoicesOpen"
                  class="q-mt-md"
                  data-test="mera-choices"
                >
                  <p class="q-my-sm">{{ $t('accountRecovery.mera_choose') }}</p>
                  <div class="row q-gutter-sm items-center">
                    <q-btn
                      outline
                      color="primary"
                      no-caps
                      :label="$t('accountRecovery.mera_existing')"
                      data-test="mera-login"
                      :disable="!mayBegin || busy"
                      @click="beginPasskey('login')"
                    />
                    <q-btn
                      flat
                      color="primary"
                      no-caps
                      :label="$t('accountRecovery.mera_new')"
                      data-test="mera-create"
                      :disable="!mayBegin || busy"
                      @click="beginPasskey('create')"
                    />
                  </div>
                </div>
                <p
                  v-if="!passkeysSupported"
                  class="q-mt-sm"
                  data-test="mera-unsupported"
                >
                  {{ $t('accountRecovery.mera_unsupported') }}
                </p>
              </section>
              <div class="row q-gutter-sm items-center">
                <q-btn
                  color="primary"
                  no-caps
                  outline
                  :label="$t('accountRecovery.new_account')"
                  data-test="new-account"
                  :disable="!mayBegin || busy"
                  @click="changeMode('policy')"
                />
                <q-btn
                  outline
                  color="primary"
                  no-caps
                  :label="$t('accountRecovery.restore_account')"
                  data-test="restore-account"
                  :disable="!mayBegin || busy"
                  @click="startRestore"
                />
                <q-btn
                  outline
                  color="primary"
                  no-caps
                  :label="$t('accountRecovery.identify_legacy_account_locally')"
                  data-test="legacy-recovery"
                  :disable="!mayBegin || busy"
                  @click="changeMode('legacy')"
                />
              </div>

              <q-btn
                v-if="account.status === 'ready'"
                class="q-mt-md"
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.return_to_wallet')"
                @click="$router.push('/wallet')"
              />
            </template>
            <q-form v-else-if="mode === 'legacy'" @submit="submitLegacyPhrase">
              <p>
                {{
                  $t(
                    'accountRecovery.this_identifies_your_old_account_locally_you',
                  )
                }}
              </p>
              <q-input
                v-model="legacyPhrase"
                type="textarea"
                outlined
                autogrow
                :rows="3"
                :label="$t('accountRecovery.legacy_bip39_recovery_phrase')"
                autocomplete="off"
                autocorrect="off"
                :spellcheck="false"
                :maxlength="512"
                data-test="legacy-phrase"
              />
              <div class="row q-gutter-sm q-mt-md items-center">
                <q-btn
                  type="submit"
                  color="primary"
                  no-caps
                  :label="$t('accountRecovery.identify_legacy_account_locally')"
                  data-test="identify-legacy"
                  :disable="busy || !legacyPhrase"
                  :loading="busy"
                />
                <q-btn
                  outline
                  color="primary"
                  no-caps
                  :label="$t('accountRecovery.cancel_and_start_again')"
                  data-test="cancel-ceremony"
                  :disable="busy"
                  @click="cancel"
                />
              </div>
            </q-form>
            <q-form v-else-if="mode === 'policy'" @submit="beginNew">
              <p v-if="legacyAddress">
                {{ $t('accountRecovery.old_account') }} {{ legacyAddress }}
                {{
                  $t('accountRecovery.the_new_identity_is_different_no_funds')
                }}
              </p>
              <q-input
                v-model="displayName"
                outlined
                dense
                class="q-mb-md"
                :label="$t('accountRecovery.display_name')"
                :maxlength="80"
                autocomplete="off"
                data-test="display-name"
              />
              <p>
                {{
                  $t('accountRecovery.choose_how_many_shares_you_must_retain')
                }}
              </p>
              <q-option-group
                v-model="policy"
                type="radio"
                :options="policies"
                data-test="backup-policy"
              />
              <q-expansion-item
                class="q-mt-md"
                icon="tune"
                :label="$t('accountRecovery.advanced_options')"
                :caption="$t('accountRecovery.relay_server')"
                header-class="text-weight-medium text-grey-8"
                data-test="advanced-relay-expansion"
              >
                <q-card class="bg-transparent q-pa-none">
                  <q-card-section class="q-px-none q-pt-sm">
                    <q-input
                      v-model="customRelayUrl"
                      outlined
                      dense
                      :label="$t('accountRecovery.relay_server_url')"
                      :hint="$t('accountRecovery.relay_server_url_hint')"
                      :placeholder="defaultRelayUrl"
                      data-test="custom-relay-input"
                      :rules="[validateRelayUrl]"
                    >
                      <template
                        v-if="
                          customRelayUrl && customRelayUrl !== defaultRelayUrl
                        "
                        #append
                      >
                        <q-btn
                          flat
                          dense
                          round
                          icon="restart_alt"
                          :title="$t('accountRecovery.reset_to_default_relay')"
                          data-test="reset-default-relay"
                          @click="customRelayUrl = defaultRelayUrl"
                        />
                      </template>
                    </q-input>
                  </q-card-section>
                </q-card>
              </q-expansion-item>
              <div class="row q-gutter-sm q-mt-md items-center">
                <q-btn
                  type="submit"
                  color="primary"
                  no-caps
                  :label="$t('welcome.createAccount')"
                  data-test="generate-backups"
                  :disable="!policy || busy"
                  :loading="busy"
                />
                <q-btn
                  outline
                  color="primary"
                  no-caps
                  :label="$t('accountRecovery.cancel_and_start_again')"
                  data-test="cancel-ceremony"
                  :disable="busy"
                  @click="cancel"
                />
              </div>
            </q-form>
            <template v-else-if="mode === 'backup'">
              <p>
                {{ $t('accountRecovery.frank_account_backup') }}
                {{ shareIndex + 1 }} of {{ shareCount }}
                {{
                  $t('accountRecovery.save_each_share_before_moving_on_exactly')
                }}
                {{ threshold }}
                {{
                  $t(
                    'accountRecovery.consistent_shares_are_required_to_confirm',
                  )
                }}
              </p>
              <q-input
                :model-value="shownShare"
                type="textarea"
                outlined
                readonly
                :label="$t('accountRecovery.frank_account_backup_share')"
                autocomplete="off"
                data-test="backup-share"
              />
              <div class="row q-gutter-sm q-mt-md items-center">
                <q-btn
                  outline
                  color="primary"
                  no-caps
                  :label="$t('accountRecovery.copy_this_share')"
                  @click="copy(shownShare)"
                />
                <q-btn
                  color="primary"
                  no-caps
                  :label="
                    shareIndex + 1 < shareCount
                      ? 'Saved this share — next'
                      : 'Saved all shares'
                  "
                  data-test="next-share"
                  @click="nextShare"
                />
                <q-btn
                  outline
                  color="primary"
                  no-caps
                  :label="$t('accountRecovery.cancel_and_start_again')"
                  data-test="cancel-ceremony"
                  :disable="busy"
                  @click="cancel"
                />
              </div>
            </template>
            <template v-else-if="mode === 'restore-choose'">
              <p class="text-negative" data-test="restore-choose-warning">
                {{ $t('accountRecovery.restore_choose_explained') }}
              </p>
              <div
                v-for="(candidate, index) in restoreCandidates"
                :key="candidate.descriptor"
                class="q-mb-md"
                data-test="restore-candidate"
              >
                <p class="q-mb-xs">
                  {{ $t('accountRecovery.restore_choose_identity') }}
                </p>
                <p class="recovery-text" data-test="restore-candidate-address">
                  {{ candidate.address }}
                </p>
                <p class="recovery-text">{{ candidate.descriptor }}</p>
                <p data-test="restore-candidate-shares">
                  {{
                    $t('accountRecovery.restore_choose_shares', {
                      shares: candidate.supporting
                        .map(position => position + 1)
                        .join(', '),
                    })
                  }}
                </p>
                <q-btn
                  color="primary"
                  no-caps
                  :label="$t('accountRecovery.restore_choose_pick')"
                  data-test="restore-candidate-pick"
                  :disable="busy"
                  @click="chooseCandidate(index)"
                />
              </div>
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('accountRecovery.cancel_and_start_again')"
                data-test="cancel-ceremony"
                :disable="busy"
                @click="cancel"
              />
            </template>
            <q-form
              v-else-if="
                mode === 'confirm' ||
                mode === 'restore-shares' ||
                mode === 'restore'
              "
              @submit="confirm"
            >
              <p v-if="mode === 'confirm'">
                {{ $t('accountRecovery.re_enter_exactly') }} {{ threshold }}
                {{
                  $t(
                    'accountRecovery.saved_frank_account_backup_shares_we_reconstruct',
                  )
                }}
              </p>
              <p v-else>
                {{
                  $t(
                    'accountRecovery.enter_at_least_the_threshold_number_of_shares',
                  )
                }}
              </p>
              <p
                v-if="descriptor"
                class="recovery-text"
                data-test="pinned-descriptor"
              >
                {{ $t('accountRecovery.expected_account') }} {{ descriptor }}
              </p>
              <q-input
                v-model="shareInput"
                type="textarea"
                outlined
                :label="$t('accountRecovery.saved_codex32_shares_one_per_line')"
                :maxlength="7000"
                autocomplete="off"
                autocorrect="off"
                :spellcheck="false"
                data-test="confirm-shares"
              />
              <q-input
                v-if="mode === 'confirm'"
                v-model="displayName"
                outlined
                class="q-mt-sm"
                :label="$t('accountRecovery.display_name')"
                :hint="$t('accountRecovery.display_name_required')"
                :maxlength="80"
                autocomplete="off"
                data-test="display-name"
              />
              <p
                v-if="discoveredRelay"
                role="status"
                aria-live="polite"
                class="text-positive q-mt-sm"
                data-test="relay-discovered-status"
              >
                {{
                  $t('accountRecovery.relay_discovered', {
                    url: discoveredRelay,
                  })
                }}
              </p>
              <q-expansion-item
                class="q-mt-md"
                icon="tune"
                :label="$t('accountRecovery.advanced_options')"
                :caption="$t('accountRecovery.relay_server')"
                header-class="text-weight-medium text-grey-8"
                data-test="advanced-relay-expansion"
              >
                <q-card class="bg-transparent q-pa-none">
                  <q-card-section class="q-px-none q-pt-sm">
                    <q-input
                      v-model="customRelayUrl"
                      outlined
                      dense
                      :label="$t('accountRecovery.relay_server_url')"
                      :hint="$t('accountRecovery.relay_server_url_hint')"
                      :placeholder="defaultRelayUrl"
                      data-test="custom-relay-input"
                      :rules="[validateRelayUrl]"
                    >
                      <template
                        v-if="
                          customRelayUrl && customRelayUrl !== defaultRelayUrl
                        "
                        #append
                      >
                        <q-btn
                          flat
                          dense
                          round
                          icon="restart_alt"
                          :title="$t('accountRecovery.reset_to_default_relay')"
                          data-test="reset-default-relay"
                          @click="customRelayUrl = defaultRelayUrl"
                        />
                      </template>
                    </q-input>
                  </q-card-section>
                </q-card>
              </q-expansion-item>
              <div class="row q-gutter-sm q-mt-md items-center">
                <q-btn
                  type="submit"
                  color="primary"
                  no-caps
                  :label="
                    $t('accountRecovery.verify_backups_and_stage_account')
                  "
                  data-test="verify-backups"
                  :disable="
                    busy ||
                    !shareInput ||
                    (mode === 'confirm' && !displayName.trim())
                  "
                  :loading="busy"
                />
                <q-btn
                  outline
                  color="primary"
                  no-caps
                  :label="$t('accountRecovery.cancel_and_start_again')"
                  data-test="cancel-ceremony"
                  :disable="busy"
                  @click="cancel"
                />
              </div>
            </q-form>
          </template>
          <p class="q-mt-lg text-caption">
            {{
              $t(
                'accountRecovery.browser_preview_encrypted_local_storage_does_not',
              )
            }}
          </p>
        </section>
      </q-page></q-page-container
    >
  </div>
</template>

<script setup lang="ts">
import {
  parseAccountBackupShareInput,
  type ShareVerdict,
} from '@frank/account-recovery'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import meraLogo from '../assets/mera/mera-logo.svg'
import { useRouter } from 'vue-router'
import { useTranslate } from '../composables/useTranslate'
import {
  accountSession,
  accountStatus as account,
  importBip39Wallet,
} from '../accounts/session'
import {
  createAccountCeremony,
  recoveryErrorMessage,
} from '../accounts/ceremony'
import {
  MeraAccountError,
  supportsMeraPasskeys,
  type MeraAccountAction,
} from '../accounts/mera-passkey'
import {
  legacyStatus as legacy,
  retryLegacyInspection,
} from '../accounts/legacy'
import { usePersistentStorageStore } from '../stores/persistent-storage'
import { nameOwnProfile } from '../utils/monad-identity-session'
import { restoreOwnProfileWithRelay } from '../utils/own-profile'
import {
  PendingProfilePreviewError,
  readPendingProfilePreview,
} from '../accounts/pending-profile-preview'
import type { MonadIdentity } from '@frank/wallet/monad-identity'
import { useTabCoordinatorStore } from '../stores/tab-coordinator'
import {
  getDefaultRelayBaseUrl,
  getCustomRelayBaseUrl,
  setCustomRelayBaseUrl,
  activeChain,
  onActiveChainChange,
} from '@frank/wallet/chain'

defineProps<{ myDrawerOpen?: boolean }>()
const emit = defineEmits([
  'toggleMyDrawerOpen',
  'setupCompleted',
  'toggleContactDrawerOpen',
  'setupNavigationLocked',
])
const router = useRouter()
const t = useTranslate()
const ceremony = createAccountCeremony()
const passkeysSupported = supportsMeraPasskeys()
const tabCoordinator = useTabCoordinatorStore()
const showManualTabHint = ref(false)

const defaultRelayUrl = getDefaultRelayBaseUrl()
const customRelayUrl = ref(getCustomRelayBaseUrl() ?? defaultRelayUrl)
const discoveredRelay = ref<string | null>(null)
const pendingProfile = ref<{ name?: string; username?: string } | null>(null)
const pendingProfileStatus = ref<
  'idle' | 'loading' | 'missing' | 'found' | 'unreachable' | 'unverified'
>('idle')
const pendingProfileRetry = ref(0)

watch(
  () =>
    [
      account.pending?.account.receipt?.operationId,
      account.pendingIdentityAddress,
      customRelayUrl.value,
      pendingProfileRetry.value,
    ] as const,
  ([attemptId, address, relay], _previous, onCleanup) => {
    pendingProfile.value = null
    pendingProfileStatus.value = 'idle'
    if (!attemptId || !address || !relay) return
    const abort = new AbortController()
    let stale = false
    const deadline = setTimeout(() => abort.abort(), 10_000)
    onCleanup(() => {
      stale = true
      clearTimeout(deadline)
      abort.abort()
    })
    pendingProfileStatus.value = 'loading'
    void readPendingProfilePreview({
      relayBaseUrl: relay.trim(),
      address,
      signal: abort.signal,
    }).then(
      profile => {
        if (stale) return
        clearTimeout(deadline)
        pendingProfile.value = profile ?? null
        pendingProfileStatus.value = profile ? 'found' : 'missing'
      },
      error => {
        if (stale) return
        clearTimeout(deadline)
        pendingProfileStatus.value =
          error instanceof PendingProfilePreviewError
            ? error.code
            : 'unreachable'
      },
    )
  },
  { immediate: true },
)

async function takeoverHere() {
  await tabCoordinator.requestTakeover()
  if (account.status === 'ready') {
    emit('setupCompleted')
    router.push('/wallet')
  }
}

function switchToOpenTab() {
  tabCoordinator.requestTabFocus()
  showManualTabHint.value = true
}

watch(
  () => account.status,
  status => {
    if (status === 'ready' && !tabCoordinator.otherTabActive) {
      if (tabCoordinator.wasAutoReleased) {
        tabCoordinator.wasAutoReleased = false
        emit('setupCompleted')
        router.push('/wallet')
      }
    }
  },
)

function validateRelayUrl(val: string): boolean | string {
  if (!val || val.trim().length === 0) return true
  try {
    const parsed = new URL(val.trim())
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return true
    }
  } catch {
    // invalid url
  }
  return t('accountRecovery.invalid_relay_url')
}
type Mode =
  | 'choice'
  | 'legacy'
  | 'policy'
  | 'backup'
  | 'save-descriptor'
  | 'descriptor'
  | 'confirm'
  | 'restore'
  | 'restore-shares'
  | 'restore-choose'
const mode = ref<Mode>('choice')
const passkeyChoicesOpen = ref(false)
const heading = ref<HTMLElement>()
const busy = ref(false)
const error = ref('')
const profileRecoveryFailed = ref(false)
const policy = ref<string | null>('2-3')
const policies = [
  { label: '2 of 3 shards — tolerate losing one', value: '2-3' },
  { label: '3 of 5 shards — tolerate losing two', value: '3-5' },
]
const threshold = ref<2 | 3>(2)
const shareCount = ref<3 | 5>(3)
const shareIndex = ref(0)
const shownShare = ref('')
const descriptor = ref('')
const descriptorInput = ref('')
const descriptorSaved = ref(false)
const shareInput = ref('')
/** What the last restore found in each entered share. Public facts only, never contents. */
const shareReport = ref<readonly ShareVerdict[]>([])
const insufficientSets = ref<
  readonly { identifier: string; required: number; available: number }[]
>([])
const restoreCandidates = ref<
  { address: string; descriptor: string; supporting: readonly number[] }[]
>([])
/** Which reconstructed account the report is about, once there is exactly one. */
const reportCandidate = ref(0)
const shareReportLines = computed(() =>
  shareReport.value.map(share => {
    // A share of an account the user did not restore is, for them, a share that does not fit.
    const status =
      share.status === 'supports' &&
      !share.candidates.includes(reportCandidate.value)
        ? 'inconsistent'
        : share.status
    return {
      position: share.position,
      status,
      ok: status === 'supports',
      text: t(`accountRecovery.share_report_${status.replace('-', '_')}`, {
        n: share.position + 1,
        index: share.index ?? '?',
        identifier: share.identifier ?? '?',
      }),
    }
  }),
)
const displayName = ref('')
const legacyPhrase = ref('')
const legacyAddress = ref('')
const replaceAccepted = ref(false)
let alive = true
let request = 0
const mayBegin = computed(
  () => !(account.account || legacy.present) || replaceAccepted.value,
)
const statusText = computed(() =>
  busy.value
    ? 'Account operation in progress.'
    : tabCoordinator.otherTabActive || account.status === 'standby'
    ? t('accountRecovery.frank_is_open_in_another_tab')
    : account.status === 'ready'
    ? 'Local account ready.'
    : account.status === 'fresh'
    ? 'No active local account.'
    : account.status === 'pending'
    ? 'Account pending explicit activation.'
    : account.status === 'loading'
    ? 'Opening account storage…'
    : account.error === 'wallet-chain-mismatch'
    ? t('accountRecovery.wallet_chain_mismatch')
    : 'Account storage locked or unavailable.',
)
function clearSecrets(preserveLegacyPhrase = false) {
  shownShare.value = ''
  shareInput.value = ''
  if (!preserveLegacyPhrase) {
    legacyPhrase.value = ''
  }
}
function focus() {
  void nextTick(() => heading.value?.focus())
}
function changeMode(value: Mode) {
  if (value === 'restore') {
    void startRestore()
    return
  }
  mode.value = value
  error.value = ''
  focus()
}
function cancel() {
  request++
  profileRecoveryFailed.value = false
  ceremony.cancel()
  clearSecrets()
  shareReport.value = []
  insufficientSets.value = []
  restoreCandidates.value = []
  descriptor.value = ''
  descriptorInput.value = ''
  descriptorSaved.value = false
  policy.value = null
  legacyAddress.value = ''
  customRelayUrl.value = getCustomRelayBaseUrl() ?? defaultRelayUrl
  discoveredRelay.value = null
  changeMode('choice')
}
watch(
  () => [account.revision, legacy.revision],
  () => {
    replaceAccepted.value = false
  },
)
async function run(work: (isCurrent: () => boolean) => Promise<void>) {
  if (busy.value) return
  const token = ++request
  const expectedRevision = account.revision
  const expectedLegacyRevision = legacy.revision
  const expectedAccount = account.account
  const chainIdentifier = activeChain.chainIdentifier
  let invalidated = false
  const stopChain = onActiveChainChange(() => {
    invalidated = true
  })
  // A closed/reopened session must stay invalid even if its revision did not change.
  const stopStatus = watch(
    () => account.status,
    status => {
      if (['loading', 'locked', 'unavailable', 'standby'].includes(status))
        invalidated = true
    },
    { flush: 'sync' },
  )
  const isCurrent = () =>
    alive &&
    token === request &&
    !invalidated &&
    account.revision === expectedRevision &&
    legacy.revision === expectedLegacyRevision &&
    account.account === expectedAccount &&
    activeChain.chainIdentifier === chainIdentifier
  busy.value = true
  error.value = ''
  try {
    await work(isCurrent)
  } catch (failure) {
    const isVerification =
      mode.value === 'confirm' || mode.value === 'restore-shares'
    const wasLegacy = mode.value === 'legacy'
    if (!isVerification) {
      ceremony.cancel()
      clearSecrets(wasLegacy)
    }
    if (alive && token === request) {
      if (!wasLegacy && !isVerification) {
        mode.value = 'choice'
      }
      error.value =
        failure instanceof MeraAccountError
          ? t(`accountRecovery.mera_${failure.code}`)
          : recoveryErrorMessage(failure)
      // Which share was wrong is worth knowing even when nothing could be restored.
      shareReport.value = (failure as { shares?: ShareVerdict[] })?.shares ?? []
      reportCandidate.value = 0
      focus()
    }
  } finally {
    stopChain()
    stopStatus()
    if (alive && token === request) busy.value = false
  }
}
function beginPasskey(action: MeraAccountAction) {
  return run(async isCurrent => {
    if (!mayBegin.value) return
    shareReport.value = []
    const mayAutoActivate = !account.account && !legacy.present
    const outcome = await ceremony.beginPasskey(action)
    if (!isCurrent()) return
    applyDiscoveredRelay(outcome, isCurrent)
    changeMode('choice')
    if (action === 'login' && outcome.loginVerification === 'unreachable')
      error.value = t('accountRecovery.mera_verification_unreachable')
    if (
      action === 'login' &&
      mayAutoActivate &&
      outcome.loginVerification === 'existing' &&
      account.pending?.account.receipt.operationId === outcome.attemptId &&
      account.pendingReady &&
      isCurrent()
    )
      await activateStagedAccount(outcome.attemptId)
  })
}
function beginNew() {
  return run(async isCurrent => {
    shareReport.value = []
    insufficientSets.value = []
    if (!mayBegin.value) return
    const cleanedRelay = customRelayUrl.value?.trim()
    if (cleanedRelay && cleanedRelay !== defaultRelayUrl) {
      setCustomRelayBaseUrl(cleanedRelay)
    } else {
      setCustomRelayBaseUrl(undefined)
    }
    const outcome = await ceremony.createDirect(displayName.value)
    if (!isCurrent()) return
    applyDiscoveredRelay(outcome, isCurrent)
    if (
      alive &&
      account.pendingReady &&
      account.pending?.account.receipt.operationId === outcome.attemptId
    ) {
      await activateStagedAccount(outcome.attemptId)
    }
  })
}
function nextShare() {
  shownShare.value = ''
  if (++shareIndex.value < shareCount.value) {
    shownShare.value = ceremony.share(shareIndex.value)
    focus()
  } else changeMode('confirm')
}
function startRestore() {
  return run(async () => {
    shareReport.value = []
    insufficientSets.value = []
    if (!mayBegin.value) return
    descriptor.value = await ceremony.beginRestore()
    if (alive) changeMode('restore-shares')
  })
}
function pinDescriptor() {
  return run(async () => {
    shareReport.value = []
    insufficientSets.value = []
    if (!mayBegin.value) return
    descriptor.value = await ceremony.beginRestore(descriptorInput.value)
    descriptorInput.value = ''
    if (alive) changeMode('restore-shares')
  })
}
function confirm() {
  return run(async isCurrent => {
    let shares = parseAccountBackupShareInput(shareInput.value)
    try {
      const outcome = (await ceremony.confirm(shares, displayName.value)) as any
      if (!isCurrent()) return
      shareInput.value = ''
      shownShare.value = ''
      shareReport.value = outcome?.report ?? []
      insufficientSets.value = outcome?.insufficientSets ?? []
      reportCandidate.value = 0
      if (outcome?.candidates) {
        // Complete backups of more than one account: the user picks, with the addresses shown.
        restoreCandidates.value = outcome.candidates
        if (alive) changeMode('restore-choose')
        return
      }
      applyDiscoveredRelay(outcome, isCurrent)
    } finally {
      shares = []
    }
    if (alive) {
      changeMode('choice')
      focus()
    }
  })
}
function chooseCandidate(index: number) {
  return run(async isCurrent => {
    restoreCandidates.value = []
    reportCandidate.value = index
    const outcome = await ceremony.choose(index, displayName.value)
    if (!isCurrent()) return
    applyDiscoveredRelay(outcome, isCurrent)
    if (alive) {
      changeMode('choice')
      focus()
    }
  })
}
/** Discovery is read-only in the ceremony; this is its only selection effect. */
function applyDiscoveredRelay(
  outcome: { readonly discoveredRelayUrl?: string } | undefined,
  isCurrent: () => boolean,
) {
  if (!isCurrent()) return
  const discovered = outcome?.discoveredRelayUrl
  if (!discovered) return
  setCustomRelayBaseUrl(discovered)
  customRelayUrl.value = discovered
  discoveredRelay.value = discovered
}
function submitLegacyPhrase() {
  return run(async () => {
    let phrase = legacyPhrase.value
    const token = request
    try {
      await importBip39Wallet(
        phrase,
        undefined,
        () => !alive || token !== request || mode.value !== 'legacy',
      )
      if (!alive || token !== request || mode.value !== 'legacy') return
      legacyPhrase.value = ''
      mode.value = 'choice'
    } finally {
      phrase = ''
    }
  })
}

function activate() {
  return run(async () => activateStagedAccount())
}

async function activateStagedAccount(expectedAttemptId?: string) {
  const token = request
  let chainChanged = false
  const stopChain = onActiveChainChange(() => {
    chainChanged = true
  })
  const current = () => alive && token === request && !chainChanged
  try {
    const pending = account.pending
    if (!pending) return
    const cleanedRelay = customRelayUrl.value?.trim()
    if (cleanedRelay && cleanedRelay !== defaultRelayUrl) {
      setCustomRelayBaseUrl(cleanedRelay)
    } else if (!cleanedRelay || cleanedRelay === defaultRelayUrl) {
      setCustomRelayBaseUrl(undefined)
    }
    const identityAddress = account.pendingIdentityAddress
    await accountSession.activatePending(
      pending.account.receipt.operationId,
      pending.expectedActive,
    )
    if (
      !current() ||
      account.status !== 'ready' ||
      (expectedAttemptId !== undefined &&
        account.account?.receipt.operationId !== expectedAttemptId)
    )
      return
    void usePersistentStorageStore().afterActivation()
    if (!pending.account.displayName) {
      await completeProfileRecovery(current)
      return
    }
    // The name typed at setup is a new account's name. An account restored here has the
    // profile it published, which the relay holds.
    void nameOwnProfile(
      pending.account.displayName,
      identityAddress ?? undefined,
    ).catch(() => undefined)
    emit('setupCompleted')
    await router.push('/wallet')
  } finally {
    stopChain()
  }
}

async function completeProfileRecovery(isCurrent: () => boolean = () => true) {
  const revision = account.revision
  const current = () =>
    isCurrent() &&
    alive &&
    account.status === 'ready' &&
    account.revision === revision
  const wallet = await accountSession.getWallet()
  if (!current()) return
  const outcome = await restoreOwnProfileWithRelay({
    relayBaseUrl:
      (wallet as { relayBaseUrl?: string }).relayBaseUrl ??
      (customRelayUrl.value.trim() || defaultRelayUrl),
    identity: wallet.identity as MonadIdentity,
    isCancelled: () => !current(),
  })
  if (!current()) return
  profileRecoveryFailed.value = outcome === 'unreachable'
  if (profileRecoveryFailed.value) {
    error.value = t('accountRecovery.profile_restore_unreachable')
    return
  }
  emit('setupCompleted')
  await router.push(outcome === 'missing' ? '/profile' : '/wallet')
}

function retryProfileRecovery() {
  return run(async () => completeProfileRecovery())
}
function cancelPending() {
  return run(async () => {
    const id = account.pending?.account.receipt.operationId
    if (id) await accountSession.cancelPending(id)
    cancel()
    busy.value = false
  })
}
function retry() {
  return run(async () => {
    await retryLegacyInspection()
    await accountSession.retry()
    if (account.status === 'ready' && !account.account?.displayName)
      await completeProfileRecovery()
  })
}
function startRestoreLocked() {
  replaceAccepted.value = true
  return startRestore()
}
function startLegacyLocked() {
  changeMode('legacy')
}
function resetStorage() {
  const confirmMsg = t('accountRecovery.reset_account_storage_confirm')
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    if (!window.confirm(confirmMsg)) return
  }
  return run(async () => {
    cancel()
    await accountSession.reset()
    await retryLegacyInspection()
    replaceAccepted.value = false
    changeMode('choice')
  })
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    error.value = 'Copy unavailable. Save the displayed text manually.'
  }
}
onBeforeUnmount(() => {
  alive = false
  request++
  ceremony.cancel()
  clearSecrets()
})
</script>
<style scoped>
.account-setup {
  max-width: 48rem;
}
.recovery-text {
  overflow-wrap: anywhere;
}
.mera-continue-btn {
  font-weight: 600;
  letter-spacing: 0.01em;
}
.mera-logo {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}
</style>
