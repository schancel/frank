<template>
  <div class="full-width column col" data-test="wallet-panel">
    <q-scroll-area class="col">
      <q-list>
        <q-item-label header>{{ $t('walletPanel.title') }}</q-item-label>

        <!-- Monad Main Wallet -->
        <q-item
          clickable
          v-ripple
          data-test="wallet-row"
          @click="$router.push('/wallet')"
        >
          <q-item-section avatar>
            <q-icon name="account_balance_wallet" />
          </q-item-section>
          <q-item-section>
            <q-item-label data-test="wallet-name">
              {{ $t('walletPanel.mainWallet') }}
            </q-item-label>
            <q-item-label caption role="status" data-test="wallet-balance">
              {{
                loaded
                  ? formattedBalance
                  : $t(
                      hasError
                        ? 'walletPanel.balanceUnavailable'
                        : 'walletPanel.balanceLoading',
                    )
              }}
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption data-test="wallet-chain">
              {{ $t('walletPanel.monad') }}
            </q-item-label>
          </q-item-section>
        </q-item>
        <p
          v-if="loaded && hasError"
          role="status"
          data-test="balance-stale"
          class="q-px-md text-caption text-negative"
        >
          {{ $t('accountRecovery.balance_stale') }}
        </p>

        <q-separator class="q-my-sm" />

        <!-- eCash Wallet -->
        <q-item clickable v-ripple data-test="ecash-wallet-row">
          <q-item-section avatar>
            <q-icon name="toll" />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ $t('walletPanel.ecash') }}</q-item-label>
            <q-item-label caption>{{ $t('walletPanel.zeroXec') }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ $t('walletPanel.ecash') }}</q-item-label>
          </q-item-section>
        </q-item>

        <!-- Solana Wallet -->
        <q-item clickable v-ripple data-test="solana-wallet-row">
          <q-item-section avatar>
            <q-icon name="account_balance" />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ $t('walletPanel.solana') }}</q-item-label>
            <q-item-label caption>{{ $t('walletPanel.zeroSol') }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ $t('walletPanel.solana') }}</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </q-scroll-area>
  </div>
</template>

<script setup lang="ts">
import { useBalance } from '../../composables/useBalance'

const { loaded, hasError, formattedBalance } = useBalance()
</script>
