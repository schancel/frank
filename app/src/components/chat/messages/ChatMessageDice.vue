<template>
  <div
    class="satoshi-dice-game q-pa-sm"
    style="min-width: 280px; max-width: 400px"
  >
    <div class="row items-center q-mb-xs">
      <q-icon name="casino" size="22px" class="q-mr-xs text-amber-9" />
      <span class="text-subtitle2 text-weight-bold">Satoshi Dice</span>
      <q-badge
        color="orange"
        text-color="black"
        class="q-ml-xs"
        label="1.9% House Edge"
      />
    </div>

    <!-- The player's own bet -->
    <template v-if="item.action === 'roll'">
      <div class="text-caption" data-testid="dice-bet">
        Bet {{ displayMon(item.wagerWei) }} on a roll below
        <strong>{{ item.target }}</strong
        >.
      </div>
      <div
        v-if="waiting"
        class="text-caption"
        :class="waiting.late ? 'text-negative' : 'text-grey-7'"
        data-testid="dice-waiting"
      >
        {{
          $t(waiting.late ? 'gameFairness.noAnswer' : 'gameFairness.awaiting', {
            seconds: waiting.seconds,
          })
        }}
      </div>
    </template>

    <template v-else>
      <template v-if="item.action === 'result'">
        <div class="q-my-xs">
          <div class="text-caption">
            Target: <strong>&lt; {{ item.target }}</strong>
          </div>
          <div class="text-caption">
            Rolled:
            <strong class="text-mono">{{ item.luckyNumber }}</strong> / 65,535
          </div>
        </div>

        <div
          class="text-subtitle1 q-my-xs text-weight-bold"
          :class="item.isWin ? 'text-positive' : 'text-negative'"
        >
          {{ item.isWin ? 'YOU WIN' : 'YOU LOSE' }}
        </div>

        <div
          v-if="payout"
          class="text-caption q-mb-xs"
          :class="payout.short ? 'text-negative' : 'text-grey-8'"
          data-testid="dice-payout"
        >
          {{
            $t(
              payout.short
                ? 'gameFairness.payoutMissing'
                : 'gameFairness.payoutClaimed',
              payout,
            )
          }}
        </div>

        <!-- Fairness: checked here, from the messages alone. -->
        <div
          v-if="check.ok"
          class="text-caption text-positive q-my-xs"
          data-testid="dice-verified"
        >
          {{ $t('gameFairness.diceVerified') }}
        </div>
        <q-banner
          v-else
          dense
          class="bg-negative text-white q-my-xs"
          data-testid="dice-not-verified"
        >
          <strong>{{ $t('gameFairness.notVerified') }}</strong>
          {{ check.reason }}
        </q-banner>
        <details
          class="q-my-xs text-caption text-grey-8"
          style="font-size: 11px"
        >
          <summary>{{ $t('gameFairness.diceHow') }}</summary>
          <div class="q-pt-xs text-mono" style="word-break: break-all">
            <div>
              {{
                $t('gameFairness.diceCommitment', { value: item.commitment })
              }}
            </div>
            <div>
              {{ $t('gameFairness.diceSecret', { value: item.serverSecret }) }}
            </div>
            <div>
              {{ $t('gameFairness.diceSeed', { value: item.clientSeed }) }}
            </div>
            <div>{{ $t('gameFairness.diceRule') }}</div>
          </div>
        </details>
        <q-separator class="q-my-sm" />
      </template>

      <template v-if="offer">
        <!-- The commitment itself is a long hash: it is on hover here, and in full under
        "how this was checked" on the result. -->
        <div
          class="text-caption text-grey-8 q-mb-xs"
          style="font-size: 11px"
          :title="offer.commitment"
          data-testid="dice-committed"
        >
          The bot has committed to its secret for the next roll.
        </div>
        <div class="text-caption text-weight-medium q-mb-xs">1. Target:</div>
        <div class="row q-gutter-xs q-mb-sm">
          <q-btn
            v-for="preset in presets"
            :key="preset.target"
            dense
            no-caps
            size="sm"
            :color="target === preset.target ? 'primary' : 'grey-8'"
            :outline="target !== preset.target"
            :label="`${preset.label} (${preset.multiplier}x)`"
            :data-testid="`dice-preset-${preset.target}`"
            @click="target = preset.target"
          />
        </div>

        <div class="text-caption text-weight-medium q-mb-xs">2. Stake:</div>
        <div class="row q-gutter-xs items-center q-mb-xs">
          <q-btn
            v-for="chip in wagerChips"
            :key="chip.label"
            dense
            no-caps
            size="sm"
            :outline="wagerInput !== chip.value"
            color="primary"
            :label="chip.label"
            :data-testid="`dice-chip-${chip.value || 'free'}`"
            @click="wagerInput = chip.value"
          />
        </div>

        <q-input
          v-model="wagerInput"
          dense
          outlined
          label="Stake"
          :suffix="unit"
          inputmode="decimal"
          class="q-mb-xs"
          data-testid="dice-wager-input"
          style="max-width: 220px"
        />

        <div class="text-caption text-grey-9 q-mb-sm" style="font-size: 12px">
          Your stake is paid with the bet message. A win pays
          <strong class="text-positive">{{ estimatedPayout }}</strong
          >.
        </div>

        <q-btn
          dense
          no-caps
          color="amber-9"
          text-color="black"
          class="full-width text-weight-bold"
          label="Roll"
          data-testid="dice-roll-btn"
          :loading="rolling"
          :disable="rolling || played"
          @click="rollDice"
        />
        <div v-if="played" class="text-caption text-grey-7 q-mt-xs">
          You have bet on this roll.
        </div>
      </template>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'
import type { SatoshiDiceItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import {
  DICE_DEFAULT_TARGET,
  diceMultiplier,
  dicePayoutWei,
  verifyDiceResult,
  type FairCheck,
} from '@frank/wallet/message-item-plugins/dice/fair'
import { formatDisplayAmount } from '../../../utils/chain-amount'
import {
  BOT_ANSWER_WAIT_MS,
  chatGameItems,
  parseWager,
  randomHex,
} from '../../../utils/chat-game-items'
import { errorNotify } from '../../../utils/notifications'

export default defineComponent({
  name: 'ChatMessageDice',
  props: {
    item: {
      type: Object as PropType<SatoshiDiceItem>,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
  },
  emits: ['sendFollowUp'],
  mounted() {
    // Only a card that is waiting for the bot keeps time.
    if (this.item.action === 'roll')
      this.timer = setInterval(() => (this.now = Date.now()), 1000)
  },
  beforeUnmount() {
    if (this.timer) clearInterval(this.timer)
  },
  data() {
    return {
      rolling: false,
      now: Date.now(),
      mountedAt: Date.now(),
      timer: undefined as ReturnType<typeof setInterval> | undefined,
      target: DICE_DEFAULT_TARGET,
      wagerInput: '0.01',
      wagerChips: [
        { label: 'Free', value: '' },
        { label: '0.01', value: '0.01' },
        { label: '0.05', value: '0.05' },
        { label: '0.1', value: '0.1' },
      ],
      presets: [64000, 32768, 16384, 6553, 655].map(target => ({
        target,
        label: `< ${target.toLocaleString('en-US')}`,
        multiplier: diceMultiplier(target),
      })),
    }
  },
  computed: {
    unit(): string {
      return activeChain.unit
    },
    /** The roll this card lets the player bet on: the one the bot committed to in this item. */
    offer(): { rollId: string; commitment: string } | undefined {
      const rollId =
        this.item.action === 'result' ? this.item.nextRollId : this.item.rollId
      const commitment =
        this.item.action === 'result'
          ? this.item.nextCommitment
          : this.item.commitment
      return rollId && commitment ? { rollId, commitment } : undefined
    },
    /** Whether the player already bet on this card's roll. */
    played(): boolean {
      const rollId = this.offer?.rollId
      return chatGameItems('dice', this.address).some(
        entry =>
          entry.outbound &&
          entry.item.action === 'roll' &&
          entry.item.rollId === rollId,
      )
    },
    /** The game's outcome only: that the roll is the one the commitment and the player's own
     * value give. Whether the payout arrived is a separate matter (`payout`). */
    check(): FairCheck {
      const all = chatGameItems('dice', this.address)
      const bet = all.find(
        entry =>
          entry.outbound &&
          entry.item.action === 'roll' &&
          entry.item.rollId === this.item.rollId,
      )?.item
      const results = all
        .filter(entry => !entry.outbound && entry.item.action === 'result')
        .map(entry => entry.item)
      return verifyDiceResult(this.item, bet, results)
    },
    /** What the result says it pays, and what the wallet reports its message carried. The
     * wallet's figure is not a chain check, so a payout is never shown as verified here: it is
     * either short, or claimed. */
    payout(): { amount: string; carried: string; short: boolean } | null {
      const owed = BigInt(this.item.payoutWei ?? '0')
      if (this.item.action !== 'result' || owed <= 0n) return null
      const carried =
        chatGameItems('dice', this.address).find(
          entry =>
            !entry.outbound &&
            entry.item.action === 'result' &&
            entry.item.rollId === this.item.rollId,
        )?.stampValueWei ?? 0n
      return {
        amount: formatDisplayAmount(activeChain, owed),
        carried: formatDisplayAmount(activeChain, carried),
        short: carried < owed,
      }
    },
    /** The player's own bet, while the bot has not answered it: how long it has waited. */
    waiting(): { seconds: number; late: boolean } | null {
      if (this.item.action !== 'roll') return null
      const all = chatGameItems('dice', this.address)
      if (
        all.some(
          entry =>
            !entry.outbound &&
            entry.item.action === 'result' &&
            entry.item.rollId === this.item.rollId,
        )
      )
        return null
      const sentAt =
        all.find(entry => entry.outbound && entry.item === this.item)?.timeMs ||
        this.mountedAt
      const waited = Math.max(0, this.now - sentAt)
      return {
        seconds: Math.floor(waited / 1000),
        late: waited >= BOT_ANSWER_WAIT_MS,
      }
    },
    estimatedPayout(): string {
      const wager = parseWager(this.wagerInput, a =>
        activeChain.fromDisplayAmount(a),
      )
      return formatDisplayAmount(
        activeChain,
        dicePayoutWei(wager ?? 0n, this.target),
      )
    },
  },
  methods: {
    displayMon(weiString?: string): string {
      try {
        return formatDisplayAmount(activeChain, BigInt(weiString ?? '0'))
      } catch {
        return formatDisplayAmount(activeChain, 0n)
      }
    },
    rollDice() {
      if (this.rolling || !this.offer) return
      const wager = parseWager(this.wagerInput, a =>
        activeChain.fromDisplayAmount(a),
      )
      if (wager === undefined) {
        errorNotify(new Error('Enter the stake as a number.'))
        return
      }
      this.rolling = true
      const bet: SatoshiDiceItem = {
        type: 'dice',
        action: 'roll',
        rollId: this.offer.rollId,
        commitment: this.offer.commitment,
        // The player's own randomness: the bot committed before it could see this.
        clientSeed: randomHex(16),
        target: this.target,
        wagerWei: wager.toString(),
      }
      this.$emit('sendFollowUp', {
        items: [bet],
        // The stake is the value of the bet message itself.
        ...(wager > 0n ? { stampValueWei: wager } : {}),
        settled: () => {
          this.rolling = false
        },
      })
    },
  },
})
</script>
