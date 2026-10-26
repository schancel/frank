<template>
  <div
    class="satoshi-dice-game"
    style="width: 100%; min-width: 0; max-width: 100%"
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

    <div
      v-if="rejection"
      role="status"
      class="text-body2 q-my-xs"
      data-testid="dice-rejected"
    >
      {{ $t('gameFairness.diceRejected') }}
      {{ $t(`gameFairness.diceRejectionReasons.${rejection.rejectionReason}`) }}
    </div>

    <!-- The player's own bet, or an inbound bet from a peer when this user offered the roll -->
    <template v-if="item.action === 'roll'">
      <div v-if="isPeerRoll" class="text-body2" data-testid="dice-peer-bet">
        {{
          $t('gameFairness.dicePeerBet', {
            amount: displayMon(item.wagerWei),
            target: item.target,
          })
        }}
      </div>
      <div v-else class="text-body2" data-testid="dice-bet">
        Bet {{ displayMon(item.wagerWei) }} on a roll below
        <strong>{{ item.target }}</strong
        >.
      </div>
      <div v-if="dealerStep" class="row q-gutter-xs q-mt-xs">
        <q-btn
          v-if="dealerStep.payWei > 0n"
          no-caps
          dense
          color="primary"
          data-testid="dice-dealer-pay"
          :disable="rolling"
          :label="
            $t('gameFairness.diceDealerPay', {
              amount: displayMon(dealerStep.payWei.toString()),
              rolled: dealerStep.luckyNumber,
            })
          "
          @click="revealAsDealer"
        />
        <q-btn
          v-else
          no-caps
          dense
          color="primary"
          data-testid="dice-dealer-reveal"
          :disable="rolling"
          :label="
            $t('gameFairness.diceDealerReveal', {
              rolled: dealerStep.luckyNumber,
            })
          "
          @click="revealAsDealer"
        />
        <q-btn
          v-if="dealerStep.payWei > 0n"
          no-caps
          dense
          flat
          color="primary"
          data-testid="dice-dealer-refund"
          :disable="rolling"
          :label="
            $t('gameFairness.diceDealerRefund', {
              amount: displayMon(dealerStep.wagerWei.toString()),
            })
          "
          @click="refundAsDealer"
        />
      </div>
      <div
        v-else-if="waiting"
        class="text-body2"
        :class="waiting.late ? 'text-weight-bold' : 'game-waiting-quiet'"
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
          <div class="text-body2">
            Target: <strong>&lt; {{ item.target }}</strong>
          </div>
          <div class="text-body2">
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
          class="text-body2 q-mb-xs"
          :class="
            payout.short
              ? 'text-negative'
              : payout.verified
              ? 'text-positive'
              : 'text-grey-8'
          "
          data-testid="dice-payout"
        >
          {{
            $t(
              payout.short
                ? 'gameFairness.payoutMissing'
                : payout.verified
                ? 'gameFairness.payoutVerified'
                : 'gameFairness.payoutClaimed',
              payout,
            )
          }}
        </div>

        <!-- Fairness: checked here, from the messages alone. -->
        <div
          v-if="check.ok"
          class="text-body2 text-positive q-my-xs"
          data-testid="dice-verified"
        >
          {{ $t('gameFairness.diceVerified') }}
        </div>
        <q-banner
          v-else
          class="bg-negative text-white q-my-xs"
          data-testid="dice-not-verified"
        >
          <strong>{{ $t('gameFairness.notVerified') }}</strong>
          {{ check.reason }}
        </q-banner>
        <details class="q-my-xs text-body2 text-grey-8">
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
        <div
          v-if="outbound"
          class="text-body2 text-grey-8 q-mb-xs"
          :title="offer.commitment"
          data-testid="dice-own-committed"
        >
          {{ $t('gameFairness.diceOwnCommitted') }}
        </div>
        <template v-else>
          <!-- The commitment itself is a long hash: it is on hover here, and in full under
          "how this was checked" on the result. -->
          <div
            class="text-body2 text-grey-8 q-mb-xs"
            :title="offer.commitment"
            data-testid="dice-committed"
          >
            The bot has committed to its secret for the next roll.
          </div>
          <div class="text-body2 text-weight-medium q-mb-xs">1. Target:</div>
          <div class="row q-gutter-xs q-mb-sm">
            <q-btn
              v-for="preset in presets"
              :key="preset.target"
              no-caps
              :color="target === preset.target ? 'primary' : 'grey-8'"
              :outline="target !== preset.target"
              :label="`${preset.label} (${preset.multiplier}x)`"
              :data-testid="`dice-preset-${preset.target}`"
              @click="target = preset.target"
            />
          </div>

          <div class="text-body2 text-weight-medium q-mb-xs">2. Stake:</div>
          <div class="row q-gutter-xs items-center q-mb-xs">
            <q-btn
              v-for="chip in wagerChips"
              :key="chip.value"
              no-caps
              :outline="stakeText !== chip.value"
              color="primary"
              :label="chip.value ? chip.label : $t('gameFairness.dicePractice')"
              :data-testid="`dice-chip-${chip.value || 'free'}`"
              @click="stakeText = chip.value"
            />
          </div>

          <q-input
            v-model="stakeText"
            outlined
            label="Stake"
            :suffix="unit"
            inputmode="decimal"
            class="q-mb-xs"
            data-testid="dice-wager-input"
            style="max-width: 220px"
          />

          <div
            v-if="minimumStake > 0n"
            class="text-body2 text-grey-9 q-mb-xs"
            data-testid="dice-stake-minimum"
          >
            {{
              $t('gameFairness.stakeMinimum', {
                amount: displayMon(minimumStake.toString()),
              })
            }}
          </div>
          <div
            v-if="practice"
            class="text-body2 text-grey-9 q-mb-sm"
            data-testid="dice-practice-description"
          >
            {{ $t('gameFairness.dicePracticeDescription') }}
          </div>
          <div v-else class="text-body2 text-grey-9 q-mb-sm">
            Your stake is paid with the bet message. A win pays
            <strong class="text-positive">{{ estimatedPayout }}</strong
            >.
          </div>
          <div
            v-if="stakeError"
            role="alert"
            class="text-body2 text-negative q-mb-sm"
            data-testid="dice-stake-error"
          >
            {{ stakeError }}
          </div>

          <q-btn
            no-caps
            color="amber-9"
            text-color="black"
            class="full-width text-weight-bold"
            :label="
              practice
                ? $t('gameFairness.dicePracticeRoll')
                : $t('gameFairness.diceRoll')
            "
            data-testid="dice-roll-btn"
            :loading="rolling"
            :disable="rolling || played || !!stakeError"
            @click="rollDice"
          />
          <div
            v-if="betFailed"
            class="text-body2 text-negative q-mt-xs"
            data-testid="dice-bet-not-sent"
          >
            {{ $t('gameFairness.moveNotSent') }}
          </div>
          <div v-else-if="played" class="text-body2 text-grey-7 q-mt-xs">
            You have bet on this roll.
          </div>
        </template>
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
import { useChatStore } from '../../../stores/chats'
import { formatDisplayAmount } from '../../../utils/chain-amount'
import { stakeMinimumWei } from '@frank/wallet/message-item-plugins/shared/stake-minimum'
import {
  BOT_ANSWER_WAIT_MS,
  chatGameItems,
  type ChatGameItem,
  parseWager,
  randomHex,
} from '../../../utils/chat-game-items'
import {
  PAYMENT_FLOOR_INJECTION,
  payoutView,
  stakeChipsWei,
  stakeProblem,
  type PayoutView,
} from '../../../utils/game-stakes'
import { useStampReceipt } from '../../../composables/useStampReceipt'
import { errorNotify } from '../../../utils/notifications'
import {
  dealerDiceStepForRoll,
  type DealerDiceStep,
  type P2pGameChatMessage,
} from '../../../utils/p2p-games'

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
    outbound: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['sendFollowUp'],
  setup(props) {
    // The bot's result message carries the payout as its stamp: verified by the same wallet
    // evidence the message footer shows (`useStampReceipt`), not by what the message says.
    const payoutReceipt = useStampReceipt(() => {
      if (props.item.action !== 'result' || props.outbound) return undefined
      const entry = chatGameItems('dice', props.address).find(
        other =>
          !other.outbound &&
          other.item.action === 'result' &&
          other.item.rollId === props.item.rollId,
      )
      return entry && { ...entry, outbound: false }
    })
    return { payoutReceipt }
  },
  inject: {
    /** The wallet's payment floor for this chain (`PAYMENT_FLOOR_INJECTION`), zero if unknown. */
    paymentFloorWei: {
      from: PAYMENT_FLOOR_INJECTION,
      default: () => (): bigint => 0n,
    },
  },
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
      /** What the player typed or picked; `null` until then, when the stake is the minimum. */
      wagerInput: null as string | null,
      presets: [64000, 32768, 16384, 6553, 655].map(target => ({
        target,
        label: `< ${target.toLocaleString('en-US')}`,
        multiplier: diceMultiplier(target),
      })),
    }
  },
  computed: {
    /** The smallest stake the table takes: twice the payment floor (`stakeMinimumWei`, the rule
     * the bot enforces). Zero while the floor is not known. */
    minimumStake(): bigint {
      return stakeMinimumWei(
        (this.paymentFloorWei as unknown as () => bigint)(),
      )
    },
    /** Practice, then the paid stakes the floor allows; never a stake below the minimum. */
    wagerChips(): { label: string; value: string }[] {
      return [
        { label: '', value: '' },
        ...stakeChipsWei(
          (this.paymentFloorWei as unknown as () => bigint)(),
        ).map(wei => {
          const value = activeChain.toDisplayAmount(wei)
          return { label: value, value }
        }),
      ]
    },
    /** The stake field: what the player chose, or the minimum until they choose. */
    stakeText: {
      get(): string {
        if (this.wagerInput !== null) return this.wagerInput
        return this.minimumStake > 0n
          ? activeChain.toDisplayAmount(this.minimumStake)
          : ''
      },
      set(value: string) {
        this.wagerInput = value
      },
    },
    practice(): boolean {
      return (
        parseWager(this.stakeText, a => activeChain.fromDisplayAmount(a)) === 0n
      )
    },
    unit(): string {
      return activeChain.unit
    },
    /** Whether this `roll` item was sent by the peer against a roll we offered. */
    isPeerRoll(): boolean {
      if (this.item.action !== 'roll' || this.outbound) return false
      const all = chatGameItems('dice', this.address)
      return all.some(
        entry =>
          !entry.outbound &&
          entry.item === this.item &&
          all.some(
            prev =>
              prev.outbound &&
              ((prev.item.action === 'table' &&
                prev.item.rollId === this.item.rollId) ||
                (prev.item.action === 'result' &&
                  prev.item.nextRollId === this.item.rollId)),
          ),
      )
    },
    dealerStep(): DealerDiceStep | undefined {
      if (this.item.action !== 'roll' || !this.item.rollId) return undefined
      const messages = (useChatStore().activeConversation?.messages ??
        []) as readonly P2pGameChatMessage[]
      return dealerDiceStepForRoll(
        messages,
        'self',
        this.address,
        this.item.rollId,
      )
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
    /** The message carrying the player's bet on this card's roll, if there is one. */
    myBet(): ChatGameItem<SatoshiDiceItem> | undefined {
      const rollId = this.offer?.rollId
      return chatGameItems('dice', this.address).find(
        entry =>
          entry.outbound &&
          entry.item.action === 'roll' &&
          entry.item.rollId === rollId,
      )
    },
    /** Whether the player already bet on this card's roll. */
    played(): boolean {
      return !!this.myBet
    },
    /** The bet is in the chat but its send failed: the bot has not received it. */
    betFailed(): boolean {
      return !!this.myBet?.failed
    },
    /** The game's outcome only: that the roll is the one the commitment and the player's own
     * value give. Whether the payout arrived is a separate matter (`payout`). */
    check(): FairCheck {
      const all = chatGameItems('dice', this.address)
      if (this.outbound) {
        const peerBet = all.find(
          entry =>
            !entry.outbound &&
            entry.item.action === 'roll' &&
            entry.item.rollId === this.item.rollId,
        )?.item
        const ownResults = all
          .filter(entry => entry.outbound && entry.item.action === 'result')
          .map(entry => entry.item)
        return verifyDiceResult(this.item, peerBet, ownResults)
      }
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
    /** What the result says it pays, and what its message carried: verified once the wallet
     * saw the stamp land on chain (the evidence the footer uses), short if what it carried, or
     * what landed, is less, and claimed until then. */
    payout(): PayoutView | null {
      const owed = BigInt(this.item.payoutWei ?? '0')
      if (this.item.action !== 'result' || owed <= 0n || this.outbound)
        return null
      const carried =
        chatGameItems('dice', this.address).find(
          entry =>
            !entry.outbound &&
            entry.item.action === 'result' &&
            entry.item.rollId === this.item.rollId,
        )?.stampValueWei ?? 0n
      return payoutView(owed, carried, this.payoutReceipt)
    },
    /** A terminal game answer, separate from any payment or refund settlement. */
    rejection(): SatoshiDiceItem | undefined {
      if (!this.item.rollId) return undefined
      if (this.item.action === 'rejected')
        return this.item.rejectionReason ? this.item : undefined
      if (this.item.action !== 'roll') return undefined
      return chatGameItems('dice', this.address).find(
        entry =>
          !entry.outbound &&
          entry.item.action === 'rejected' &&
          !!entry.item.rejectionReason &&
          entry.item.rollId === this.item.rollId,
      )?.item
    },
    /** The player's own bet, while the bot has not answered it: how long it has waited. */
    waiting(): { seconds: number; late: boolean } | null {
      if (this.item.action !== 'roll' || this.rejection || this.isPeerRoll)
        return null
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
      const own = all.find(entry => entry.outbound && entry.item === this.item)
      // A message that failed to send is not being answered: its own line says it failed.
      if (own?.failed) return null
      const sentAt = own?.timeMs || this.mountedAt
      const waited = Math.max(0, this.now - sentAt)
      return {
        seconds: Math.floor(waited / 1000),
        late: waited >= BOT_ANSWER_WAIT_MS,
      }
    },
    estimatedPayout(): string {
      return formatDisplayAmount(
        activeChain,
        dicePayoutWei(this.wagerWei ?? 0n, this.target),
      )
    },
    wagerWei(): bigint | undefined {
      return parseWager(this.stakeText, a => activeChain.fromDisplayAmount(a))
    },
    /** The most one roll on this offer pays, as the bot stated it with the offer; unknown for
     * an offer that did not state it. */
    tableLimitWei(): bigint | undefined {
      const stated = this.outbound ? undefined : this.item.maxPayoutWei
      if (!stated || !/^[0-9]{1,78}$/.test(stated)) return undefined
      return BigInt(stated)
    },
    /** Why this bet cannot be sent, as the player is told it ('' when it can): the stake is not a
     * number or is below the smallest stake, or a win would pay more than the table limit (the
     * bot would refuse it, and the player would have paid the fees for nothing). */
    stakeError(): string {
      const problem = stakeProblem(
        this.wagerWei,
        this.minimumStake,
        (key, params) => this.$t(key, params ?? {}),
        wei => this.displayMon(wei.toString()),
      )
      if (problem || !this.wagerWei) return problem
      const limit = this.tableLimitWei
      const payout = dicePayoutWei(this.wagerWei, this.target)
      return limit !== undefined && payout > limit
        ? this.$t('gameFairness.diceAboveTableLimit', {
            payout: this.displayMon(payout.toString()),
            limit: this.displayMon(limit.toString()),
          })
        : ''
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
      const wager = this.wagerWei
      if (this.stakeError || wager === undefined) {
        errorNotify(new Error(this.stakeError), {
          safeMessage: this.stakeError,
        })
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
        // The stake is the value of the bet message itself: a practice roll carries no stamp.
        stampValueWei: wager,
        settled: () => {
          this.rolling = false
        },
      })
    },
    revealAsDealer() {
      if (this.rolling || !this.dealerStep) return
      this.rolling = true
      this.$emit('sendFollowUp', {
        items: [this.dealerStep.item],
        stampValueWei: this.dealerStep.payWei,
        settled: () => {
          this.rolling = false
        },
      })
    },
    refundAsDealer() {
      if (this.rolling || !this.dealerStep) return
      this.rolling = true
      this.$emit('sendFollowUp', {
        items: [this.dealerStep.refundItem],
        stampValueWei: this.dealerStep.wagerWei,
        settled: () => {
          this.rolling = false
        },
      })
    },
  },
})
</script>

<style lang="scss" scoped>
.satoshi-dice-game {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  background: #ffffff;
  color: #1e293b;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 14px;
  padding: 12px 14px;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);

  .text-grey-7,
  .text-grey-8,
  .text-grey-9,
  .game-waiting-quiet {
    color: #475569 !important;
  }

  :deep(.q-field--outlined .q-field__control) {
    border-radius: 10px !important;
    background: rgba(15, 23, 42, 0.03);
  }

  .body--dark & {
    background: #1e293b;
    color: #f8fafc;
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);

    .text-grey-7,
    .text-grey-8,
    .text-grey-9,
    .game-waiting-quiet {
      color: #cbd5e1 !important;
    }

    :deep(.q-field--outlined .q-field__control) {
      background: rgba(255, 255, 255, 0.06);
    }

    :deep(.q-field__native),
    :deep(.q-field__label),
    :deep(.q-field__suffix) {
      color: #f8fafc !important;
    }

    :deep(.q-btn--outline.text-grey-8) {
      color: #cbd5e1 !important;
    }
  }
}
</style>
