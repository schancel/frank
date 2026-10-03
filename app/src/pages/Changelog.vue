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
        />
        <q-toolbar-title class="h6">Changelog</q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page>
        <q-scroll-area
          ref="chatScroll"
          @scroll="scrollHandler"
          class="q-px-sm absolute full-width full-height"
        >
          <template v-for="section in sections" :key="section.title">
            <div class="text-h6 q-mt-md">{{ section.title }}</div>
            <div class="text-body1">
              <div
                v-for="group in section.groups"
                :key="group.heading"
                :class="{ 'q-mt-md': group.heading }"
              >
                <div v-if="group.heading" class="text-subtitle2">
                  {{ group.heading }}
                </div>
                <ul>
                  <li v-for="item in group.items" :key="item">{{ item }}</li>
                </ul>
              </div>
            </div>
          </template>
        </q-scroll-area>
        <q-page-sticky
          position="bottom-right"
          :offset="[18, 18]"
          v-show="!bottom"
        >
          <q-btn
            round
            size="md"
            icon="keyboard_arrow_down"
            color="accent"
            @click="scrollBottom"
          />
        </q-page-sticky>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent, nextTick, ref } from 'vue'
import { QScrollArea } from 'quasar'

interface SectionGroup {
  heading?: string
  items: string[]
}

interface ChangelogSection {
  title: string
  groups: SectionGroup[]
}

const scrollDuration = 0

const sections: ChangelogSection[] = [
  {
    title: '2026-10-01 — Games, wallet, and preview hardening',
    groups: [
      {
        heading: 'Messaging',
        items: [
          'A full visual redesign: new typography, color system, and chat polish.',
          'Failed and payment-pending messages stay in the thread with a manual Retry that never pays twice.',
          'Inbox and outbox messages persist across restarts.',
          'Outgoing messages show immediately while stamps prepare, with preparation status moved to the top of the chat.',
          'The chat shows when the mailbox is unavailable or unreachable instead of failing silently.',
          'One desktop notification per incoming message.',
          'The compose box keeps focus during a send so the first typed character is not lost, and focuses again when opening a chat.',
          'Cleaner chat spacing, banner placement, and scroll behavior; time and stamp now sit on the last bubble line.',
          'Retry keeps its keyboard focus and screen-reader announcement.',
        ],
      },
      {
        heading: 'Accounts and onboarding',
        items: [
          'New Account requires confirming your recovery phrase before signup.',
          'Sign-up resume can import a different recovery phrase, and imported or refreshed phrases persist.',
          'An existing account can no longer be silently replaced from setup.',
          'Recovery-phrase confirmation shows per-field errors, and display-name errors say what is wrong and what to do.',
          'Opening setup no longer persists a generated seed, and setup persistence completes before reload.',
          'The Monad identity initializes in place when sign-up finishes.',
        ],
      },
      {
        heading: 'Wallet and settings',
        items: [
          'A Wallet tab joins the sidebar rail.',
          'Drawer and Receive share one balance that polls instead of fetching once; unknown balances show a dash instead of 0.0 MON.',
          'The Settings language choice persists reliably.',
          'Persistent storage is requested and its status is shown in Settings.',
        ],
      },
      {
        heading: 'Forum',
        items: [
          'Forum requires wallet setup before use.',
          'Discovered topics appear as a real, clickable list in the sidebar, with blank-pane and selection-styling bugs fixed.',
          'Posting and voting fund the burn account automatically, and other users’ posts appear because topics are requested by name.',
          'Vote tallies refresh on existing posts, and compose drafts survive a failed post or reply.',
        ],
      },
      {
        heading: 'Games',
        items: [
          'Provably-fair blackjack over stamped direct messages: dealer welcome, bet-size picker, double-down, dealer-rule fairness on a natural, and exactly-once payouts.',
          'Provably-fair raffle: winner takes the pot, draws verify against the announced commitment and show Verified fair, and the pot is paid before announcing.',
          'A flat-price vendor bot with a picture shop, catalog thumbnails, and translated strings.',
        ],
      },
      {
        heading: 'Bots and demo',
        items: [
          'Bot profiles with curated demo defaults replace Loading... placeholders.',
          'Bots persist state across restarts, skip history they already answered, and never ping-pong.',
          'Bot errors quote MON instead of raw wei.',
          'A one-command demo launcher with a fake chain, testnet faucet, and smoke test.',
        ],
      },
      {
        heading: 'Under the hood',
        items: [
          'Monad direct-message envelopes are hardened end to end.',
          'Stamp affordability is checked before sending, and relay success is tied to the exact stamp set paid.',
          'The browser no longer sends a forbidden Origin header.',
          'Faster Monad inventory confirmations.',
          'French-mode strings moved into proper locales, and locale packs load statically.',
        ],
      },
    ],
  },
  {
    title: '2026-09-28 — Frank Monad Preview',
    groups: [
      {
        items: [
          'Port direct messages and topic broadcasts to Monad testnet.',
          'Pay direct-message stamps to recipient-controlled stealth addresses, split across disposable sender accounts.',
          'Add Monad identity registration, profile discovery, name search, and curated default contacts.',
          'Add Qwen bot replies and automatic welcome messages.',
          'Add Monad topic discovery, posting, voting, and relay-side verification.',
          'Restore fresh-account setup and remove dead Lotus services from the default Monad startup path.',
        ],
      },
    ],
  },
  {
    title: 'v0.0.23 Changelog',
    groups: [
      {
        items: [
          'Convert everything from vuex to pinia',
          'Convert most of the codebase to typescript',
          'Fix various bugs associated with pinia upgrade',
          'Retheme the form entirely',
          'Remove nested QLayouts to fix rendering issues on mobile',
          'Upgrade quasar to the latest version',
          'Fixed keyboard/input box rendering issues on mobile Safari',
          'Fixed issue where in some cases clicking a contact was unresponsive.',
          'Update Workbox options to set that the PWA should auto update. 🤞',
        ],
      },
    ],
  },
  {
    title: 'v0.0.22 Changelog',
    groups: [
      {
        items: [
          'Add spinner at forum page before posts are loaded (#499)',
          'Custom window bar for electron build. (#496)',
          'Forum: add link icon to post titles containing URL (#498)',
          'Give topic hints to user when posting (#497)',
          'Enable configuration for a "compact mode" (#495)',
          'Use percent instead of vw for post size (#494)',
          'Fix width on small devices (#493)',
          'Fix margin in reply view (#492)',
          'Add `top` sort to Forum (#491)',
          'Fix Threshold filtering on Forum (#490)',
          'Add some configurability to the Forum feed (#489)',
          '(sorts) Update POST UX (#487)',
          'Change header color to white (#488)',
          'Remove mentions of minimum acceptance price (#486)',
          'Add error notification to Create Post screen (#485)',
          'Remove forum icon from title bar in Forum screen (#484)',
          'Add toast on post, and ensure it loads (#483)',
          'Fix topic filtering button on Forum (#482)',
          'Protect `/forum/new-post` route for non-signed up users (#481)',
          'Open links in new browser tab (#480)',
          'Add message markdown preview (#479)',
          'Fix Reply, Send File, and Give Lotus Actions (#477)',
          'Fix scrolling behavior in chat on new messages (#476)',
          'Update buttons on Forum title bar (#475)',
          'Remove CircleCI builds (#474)',
          'Move header buttons to side panel of Forum (#473)',
          'Invert ChatLayout to be above the actual Chat page (#472)',
          'Change formatting of timestamps in forum (#467)',
          'Update Android manifests for Google Play (#468)',
          'Fix type warning on `errorNotify`',
          'Upgrade quasar and capacitor to latest version within channel',
          'Fix reply attachment to parent messages (#466)',
        ],
      },
    ],
  },
  {
    title: 'v0.0.21 Changelog',
    groups: [
      {
        items: [
          'Add a Forum feature so people can post, reply, and vote on topics',
          'Fix P2PKH sends to non-Stamp wallets.',
          'Fix the ability to delete single messages.',
        ],
      },
    ],
  },
  {
    title: 'v0.0.20 Changelog',
    groups: [
      {
        items: [
          'Fixes signup issue when attempting to create an account.',
          'Convert more code to typescript and fix misc associated issues.',
          'Parallelize message downloading and deletion.',
          'Fix remote wallet wipe functionality.',
        ],
      },
    ],
  },
  {
    title: 'v0.0.19 Changelog',
    groups: [
      {
        items: [
          'Check all UTXOs before sending messages as a precautionary measure to avoid losing coins.',
        ],
      },
    ],
  },
  {
    title: 'v0.0.18 Changelog',
    groups: [
      {
        items: [
          'Added support for adding a contact via links to https://web.stampchat.io/#/chat/&lt;address&gt; This can be used to onboard new users directly though a link.',
          'Fix Stamp Android packaging to properly say "Stamp"',
          'Fix an issue with change generation under certain cases omitting a change output and creating a very high fee transaction.',
        ],
      },
    ],
  },
  {
    title: 'v0.0.17 Changelog',
    groups: [
      {
        items: [
          'Make references to sending Lotus to be more thematic',
          'Redenominate the UI to Lotus everywhere with 2 decimals',
          'Updating your avatar now works correctly',
          'Reply components now show contents of the messages they replied to (Except for in group chat)',
          'Clip long words in userlist captions to prevent widget overflows',
          'More fixes to restoring state on schema version change',
          'Fix display of addresses in the Transactions Dialog',
          'Fix seed phrase entry to allow spaces',
          'One (final?) fix to the scrolling behavior',
        ],
      },
    ],
  },
  {
    title: 'v0.0.16 Changelog',
    groups: [
      {
        items: [
          'Fix bug with stamp amounts not being settable after upgrading to Quasar 2',
          'Fix more issues with scrolling on Quasar 2',
          'Clean up Ok/Cancel button placements',
          'Fix storage migrations when schema changes',
          'Move setup dialog to after main layout loads so homepage can be seen',
          'Add confirmation route for remote wiping wallet',
          'Added a link to the lotus lounge faucet from the deposit screen',
          'Clicking anywhere on the contact "notifications" button now toggles it',
          'Remove several non-functioning widgets in the UI',
        ],
      },
    ],
  },
  {
    title: 'v0.0.15 Changelog',
    groups: [
      {
        items: [
          'Fix scrolling behavior on Quasar 2',
          'Fix attaching images to messages',
        ],
      },
    ],
  },
  {
    title: 'v0.0.14 Changelog',
    groups: [
      {
        items: [
          'Upgrade to quasar v2, vuejs v3, and vuex v4',
          'Convert wallet and messaging libraries to typescript',
          'Rewrite vuex local storage module',
          'Fix a significant number of bugs which were revealed during typescript conversion',
        ],
      },
    ],
  },
  {
    title: 'v0.0.13 Changelog',
    groups: [
      {
        items: [
          'Fix issue where received stamps and stealth amounts were adding invalid utxos to wallet due to using the transactionss TxHash instead of TxId',
          'Fix sending Lotus to legacy wallets via P2PKH transactions',
        ],
      },
    ],
  },
  {
    title: 'v0.0.12 Changelog',
    groups: [
      {
        items: ['Use XAddresses', 'Use `Lotus` and `XPI` units'],
      },
    ],
  },
  {
    title: 'v0.0.11 Changelog',
    groups: [
      {
        items: [
          'Change licensing to be GPL for UI, and MIT for libraries',
          'Fix balance button on UI',
          'Various improvements to transaction construction and change creation',
          'Update quasar and other dependencies',
        ],
      },
    ],
  },
  {
    title: 'v0.0.10 Changelog',
    groups: [
      {
        items: [
          'Ensure UTXOs are unable to be used twice during transaction construction',
          'Select UTXOs and fee rates to avoid creating change almost always',
        ],
      },
    ],
  },
  {
    title: 'v0.0.9 Changelog',
    groups: [
      {
        items: [
          'Fix various issues with transaction construction which were causing coin burns',
        ],
      },
    ],
  },
  {
    title: 'v0.0.8 Changelog',
    groups: [
      {
        items: [
          'Use Stamp icon on EULA screen',
          'Add stamp icon to assets and use it for default news icon',
          'Fix copy on news page to say Stamp',
          'Add HostFat to default contacts',
          'Update EULA copy',
          'Remove add/remove UTXO log lines which slow down client',
          'Remove the need to recalculate wallet balance from all UTXOs',
          'Increase chunk size when reloading messages',
          'Implement a quick-and-dirty way to reset your remote wallet',
          'Fix bugs in forwardUTXOsToAddress when deleting messages',
          'Add recording of p2pkh transactions in remote outbox',
          'Refresh contacts on start, including fetching profile image',
        ],
      },
    ],
  },
]

export default defineComponent({
  props: {},
  components: {},
  emits: ['toggleMyDrawerOpen'],
  setup(_, { emit }) {
    const bottom = ref(false)
    const chatScroll = ref<QScrollArea | null>(null)

    return {
      sections,
      bottom,
      chatScroll,
      scrollBottom() {
        const scrollArea = chatScroll.value
        if (!scrollArea) {
          // Not mounted yet
          return
        }
        nextTick(() =>
          scrollArea.setScrollPercentage('vertical', 1.0, scrollDuration),
        )
      },
      scrollHandler(details: {
        verticalSize: number
        verticalPosition: number
        verticalContainerSize: number
      }) {
        if (
          // Ten pixels from bottom
          details.verticalSize -
            details.verticalPosition -
            details.verticalContainerSize <=
          10
        ) {
          bottom.value = true
        } else {
          bottom.value = false
        }
      },
      toggleSettingsDrawerOpen() {
        emit('toggleMyDrawerOpen')
      },
    }
  },
})
</script>

<style lang="scss" scoped>
.reply {
  padding: 5px 0;
  color: var(--q-color-text);
  background: var(--q-color-background);
  padding-left: 8px;
  border-left: 3px;
  border-left-style: solid;
  border-left-color: $primary;
}

.scroll-area-bordered {
  border-right: 1px;
  border-right-style: solid;
  border-right-color: $separator-color;
  border-bottom: 1px;
  border-bottom-style: solid;
  border-bottom-color: $separator-color;
}
</style>
