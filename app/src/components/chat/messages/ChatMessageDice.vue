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
          v-if="item.payoutWei && item.payoutWei !== '0'"
          class="text-caption q-mb-xs"
        >
          Payout: <strong>{{ displayMon(item.payoutWei) }}</strong>
        </div>

        <!-- Fairness: checked here, from the messages alone. -->
        <div
          v-if="check.ok"
          class="text-caption text-positive q-my-xs"
          data-testid="dice-verified"
        >
          Verified: the secret matches the commitment you bet on, and the
          number, outcome and payout follow from it and your own random value.
        </div>
        <q-banner
          v-else
          dense
          class="bg-negative text-white q-my-xs"
          data-testid="dice-not-verified"
        >
          <strong>NOT VERIFIED.</strong> {{ check.reason }}
        </q-banner>
        <details
          class="q-my-xs text-caption text-grey-8"
          style="font-size: 11px"
        >
          <summary>How this was checked</summary>
          <div class="q-pt-xs text-mono" style="word-break: break-all">
            <div>Commitment (before your bet): {{ item.commitment }}</div>
            <div>Secret (revealed): {{ item.serverSecret }}</div>
            <div>Your random value: {{ item.clientSeed }}</div>
            <div>
              SHA-256(secret) must equal the commitment; the roll is the first
              16 bits of HMAC-SHA256(secret, your value).
            </div>
          </div>
        </details>
        <q-separator class="q-my-sm" />
      </template>

      <template v-if="offer">
        <div class="text-caption text-grey-8 q-mb-xs" style="font-size: 11px">
          The bot has committed to its secret for the next roll:
          <span class="text-mono">{{ offer.commitment.slice(0, 16) }}…</span>
        </div>
        <div class="text-caption text-weight-medium q-mb-xs">1. Target:</div>
        <div class="row q-gutter-xs q-mb-sm">
          <q-btn
            v-for="preset in presets"
            :key="preset.target"
            dense
            no-caps
            size="xs"
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
            size="xs"
            :outline="wagerInput !== chip.value"
            color="amber-10"
            text-color="white"
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
  data() {
    return {
      rolling: false,
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
      return chatGameItems('dice').some(
        entry =>
          entry.outbound &&
          entry.item.action === 'roll' &&
          entry.item.rollId === rollId,
      )
    },
    check(): FairCheck {
      const all = chatGameItems('dice')
      const bet = all.find(
        entry =>
          entry.outbound &&
          entry.item.action === 'roll' &&
          entry.item.rollId === this.item.rollId,
      )?.item
      const results = all
        .filter(entry => !entry.outbound && entry.item.action === 'result')
        .map(entry => entry.item)
      const checked = verifyDiceResult(this.item, bet, results)
      if (!checked.ok) return checked
      // A payout shown is a payout only if this message carried it.
      const carried = all.find(
        entry => !entry.outbound && entry.item.rollId === this.item.rollId &&
          entry.item.action === 'result',
      )?.stampValueWei
      const owed = BigInt(this.item.payoutWei ?? '0')
      if (owed > 0n && (carried ?? 0n) < owed)
        return {
          ok: false,
          reason: 'The payout shown was not paid with this message.',
        }
      return checked
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
