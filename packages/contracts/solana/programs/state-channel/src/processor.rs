use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    sysvar::Sysvar,
};

use crate::{
    digest::{get_checkpoint_digest, get_close_digest, verify_signature},
    error::StateChannelError,
    instruction::StateChannelInstruction,
    state::{ChannelState, CHANNEL_SEED},
};

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> ProgramResult {
        let instruction = StateChannelInstruction::try_from_slice(instruction_data)
            .map_err(|_| ProgramError::InvalidInstructionData)?;

        match instruction {
            StateChannelInstruction::OpenChannel {
                channel_id,
                peer,
                deposit_a,
                challenge_duration,
            } => Self::process_open_channel(
                program_id,
                accounts,
                channel_id,
                peer,
                deposit_a,
                challenge_duration,
            ),
            StateChannelInstruction::JoinChannel { deposit_b } => {
                Self::process_join_channel(program_id, accounts, deposit_b)
            }
            StateChannelInstruction::Checkpoint {
                seq,
                balances,
                sig0,
                sig1,
            } => Self::process_checkpoint(program_id, accounts, seq, balances, sig0, sig1),
            StateChannelInstruction::CloseCooperative {
                seq,
                balances,
                payout0,
                payout1,
                sig0,
                sig1,
            } => Self::process_close_cooperative(
                program_id, accounts, seq, balances, payout0, payout1, sig0, sig1,
            ),
            StateChannelInstruction::CloseAfterChallenge => {
                Self::process_close_after_challenge(program_id, accounts)
            }
            StateChannelInstruction::RefundTimeout => {
                Self::process_refund_timeout(program_id, accounts)
            }
        }
    }

    pub fn process_open_channel(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        channel_id: [u8; 32],
        peer: Pubkey,
        deposit_a: u64,
        challenge_duration: i64,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let party_a = next_account_info(account_info_iter)?;
        let channel_account = next_account_info(account_info_iter)?;
        let system_program = next_account_info(account_info_iter).ok();

        if !party_a.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if peer == Pubkey::default() || peer == *party_a.key {
            return Err(StateChannelError::InvalidZeroAddress.into());
        }
        if challenge_duration <= 0 {
            return Err(StateChannelError::ZeroDuration.into());
        }

        let (expected_pda, bump) =
            Pubkey::find_program_address(&[CHANNEL_SEED, channel_id.as_ref()], program_id);
        if expected_pda != *channel_account.key {
            return Err(StateChannelError::InvalidPda.into());
        }

        if !channel_account.data_is_empty() {
            if let Ok(existing) = ChannelState::try_from_slice(&channel_account.data.borrow()) {
                if existing.is_initialized {
                    return Err(StateChannelError::ChannelAlreadyExists.into());
                }
            }
        }

        if deposit_a > 0 {
            if let Some(sys_prog) = system_program {
                if party_a.lamports() < deposit_a {
                    return Err(ProgramError::InsufficientFunds);
                }
                invoke(
                    &system_instruction::transfer(party_a.key, channel_account.key, deposit_a),
                    &[party_a.clone(), channel_account.clone(), sys_prog.clone()],
                )?;
            } else {
                if **party_a.lamports.borrow() < deposit_a {
                    return Err(ProgramError::InsufficientFunds);
                }
                **party_a.try_borrow_mut_lamports()? -= deposit_a;
                **channel_account.try_borrow_mut_lamports()? += deposit_a;
            }
        }

        let channel_state = ChannelState {
            is_initialized: true,
            channel_id,
            participants: [*party_a.key, peer],
            balances: [deposit_a, 0],
            current_seq: 0,
            challenge_duration,
            challenge_expires_at: 0,
            settled: false,
            bump,
        };

        let mut data = channel_account.data.borrow_mut();
        if data.len() < ChannelState::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        channel_state
            .serialize(&mut &mut data[..ChannelState::LEN])
            .map_err(|_| ProgramError::AccountDataTooSmall)?;

        msg!("StateChannel: Opened channel successfully with deposit {}", deposit_a);
        Ok(())
    }

    pub fn process_join_channel(
        _program_id: &Pubkey,
        accounts: &[AccountInfo],
        deposit_b: u64,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let party_b = next_account_info(account_info_iter)?;
        let channel_account = next_account_info(account_info_iter)?;
        let system_program = next_account_info(account_info_iter).ok();

        if !party_b.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        let mut ch = ChannelState::try_from_slice(&channel_account.data.borrow())
            .map_err(|_| StateChannelError::ChannelNotFound)?;

        if !ch.is_initialized {
            return Err(StateChannelError::ChannelNotFound.into());
        }
        if ch.settled {
            return Err(StateChannelError::ChannelAlreadySettled.into());
        }
        if *party_b.key != ch.participants[1] {
            return Err(StateChannelError::Unauthorized.into());
        }

        if deposit_b > 0 {
            if let Some(sys_prog) = system_program {
                if party_b.lamports() < deposit_b {
                    return Err(ProgramError::InsufficientFunds);
                }
                invoke(
                    &system_instruction::transfer(party_b.key, channel_account.key, deposit_b),
                    &[party_b.clone(), channel_account.clone(), sys_prog.clone()],
                )?;
            } else {
                if **party_b.lamports.borrow() < deposit_b {
                    return Err(ProgramError::InsufficientFunds);
                }
                **party_b.try_borrow_mut_lamports()? -= deposit_b;
                **channel_account.try_borrow_mut_lamports()? += deposit_b;
            }
        }

        ch.balances[1] = ch
            .balances[1]
            .checked_add(deposit_b)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        ch.serialize(&mut &mut channel_account.data.borrow_mut()[..ChannelState::LEN])
            .map_err(|_| ProgramError::AccountDataTooSmall)?;

        msg!("StateChannel: Counterparty joined with deposit {}", deposit_b);
        Ok(())
    }

    pub fn process_checkpoint(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        seq: u64,
        balances: [u64; 2],
        sig0: [u8; 64],
        sig1: [u8; 64],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let _caller = next_account_info(account_info_iter)?;
        let channel_account = next_account_info(account_info_iter)?;

        let mut ch = ChannelState::try_from_slice(&channel_account.data.borrow())
            .map_err(|_| StateChannelError::ChannelNotFound)?;

        if !ch.is_initialized {
            return Err(StateChannelError::ChannelNotFound.into());
        }
        if ch.settled {
            return Err(StateChannelError::ChannelAlreadySettled.into());
        }
        if seq <= ch.current_seq {
            return Err(StateChannelError::StaleSequence.into());
        }

        let total_deposit = ch
            .balances[0]
            .checked_add(ch.balances[1])
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let new_total = balances[0]
            .checked_add(balances[1])
            .ok_or(ProgramError::ArithmeticOverflow)?;

        if total_deposit != new_total {
            return Err(StateChannelError::InvalidBalanceSum.into());
        }

        // Verify dual Ed25519 signatures
        let digest = get_checkpoint_digest(&ch.channel_id, seq, &balances, program_id);
        verify_signature(&ch.participants[0], &digest, &sig0)?;
        verify_signature(&ch.participants[1], &digest, &sig1)?;

        let now = Clock::get().map(|c| c.unix_timestamp).unwrap_or(0);
        ch.current_seq = seq;
        ch.balances = balances;
        ch.challenge_expires_at = now.saturating_add(ch.challenge_duration);

        ch.serialize(&mut &mut channel_account.data.borrow_mut()[..ChannelState::LEN])
            .map_err(|_| ProgramError::AccountDataTooSmall)?;

        msg!("StateChannel: Checkpoint accepted for seq {}", seq);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn process_close_cooperative(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        seq: u64,
        balances: [u64; 2],
        payout0: Pubkey,
        payout1: Pubkey,
        sig0: [u8; 64],
        sig1: [u8; 64],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let _caller = next_account_info(account_info_iter)?;
        let channel_account = next_account_info(account_info_iter)?;
        let dest0_account = next_account_info(account_info_iter)?;
        let dest1_account = next_account_info(account_info_iter)?;

        let mut ch = ChannelState::try_from_slice(&channel_account.data.borrow())
            .map_err(|_| StateChannelError::ChannelNotFound)?;

        if !ch.is_initialized {
            return Err(StateChannelError::ChannelNotFound.into());
        }
        if ch.settled {
            return Err(StateChannelError::ChannelAlreadySettled.into());
        }
        if seq < ch.current_seq {
            return Err(StateChannelError::StaleSequence.into());
        }

        let total_deposit = ch
            .balances[0]
            .checked_add(ch.balances[1])
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let new_total = balances[0]
            .checked_add(balances[1])
            .ok_or(ProgramError::ArithmeticOverflow)?;

        if total_deposit != new_total {
            return Err(StateChannelError::InvalidBalanceSum.into());
        }

        // Verify signatures over close digest
        let digest = get_close_digest(&ch.channel_id, seq, &balances, &payout0, &payout1, program_id);
        verify_signature(&ch.participants[0], &digest, &sig0)?;
        verify_signature(&ch.participants[1], &digest, &sig1)?;

        let expected_dest0 = if payout0 == Pubkey::default() {
            ch.participants[0]
        } else {
            payout0
        };
        let expected_dest1 = if payout1 == Pubkey::default() {
            ch.participants[1]
        } else {
            payout1
        };

        if *dest0_account.key != expected_dest0 || *dest1_account.key != expected_dest1 {
            return Err(StateChannelError::AccountMismatch.into());
        }

        ch.settled = true;
        ch.balances = balances;

        ch.serialize(&mut &mut channel_account.data.borrow_mut()[..ChannelState::LEN])
            .map_err(|_| ProgramError::AccountDataTooSmall)?;

        // Disburse balances
        if balances[0] > 0 {
            if **channel_account.lamports.borrow() < balances[0] {
                return Err(ProgramError::InsufficientFunds);
            }
            **channel_account.try_borrow_mut_lamports()? -= balances[0];
            **dest0_account.try_borrow_mut_lamports()? += balances[0];
        }

        if balances[1] > 0 {
            if **channel_account.lamports.borrow() < balances[1] {
                return Err(ProgramError::InsufficientFunds);
            }
            **channel_account.try_borrow_mut_lamports()? -= balances[1];
            **dest1_account.try_borrow_mut_lamports()? += balances[1];
        }

        msg!("StateChannel: Cooperative close successful. Settled balances: {:?}", balances);
        Ok(())
    }

    pub fn process_close_after_challenge(
        _program_id: &Pubkey,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let _caller = next_account_info(account_info_iter)?;
        let channel_account = next_account_info(account_info_iter)?;
        let part0_account = next_account_info(account_info_iter)?;
        let part1_account = next_account_info(account_info_iter)?;
        let clock = Clock::get().map_err(|_| ProgramError::InvalidAccountData)?;

        let mut ch = ChannelState::try_from_slice(&channel_account.data.borrow())
            .map_err(|_| StateChannelError::ChannelNotFound)?;

        if !ch.is_initialized {
            return Err(StateChannelError::ChannelNotFound.into());
        }
        if ch.settled {
            return Err(StateChannelError::ChannelAlreadySettled.into());
        }
        if ch.challenge_expires_at == 0 {
            return Err(StateChannelError::ChallengeNotActive.into());
        }
        if clock.unix_timestamp < ch.challenge_expires_at {
            return Err(StateChannelError::ChallengeNotExpired.into());
        }

        if *part0_account.key != ch.participants[0] || *part1_account.key != ch.participants[1] {
            return Err(StateChannelError::AccountMismatch.into());
        }

        ch.settled = true;
        let bal0 = ch.balances[0];
        let bal1 = ch.balances[1];

        ch.serialize(&mut &mut channel_account.data.borrow_mut()[..ChannelState::LEN])
            .map_err(|_| ProgramError::AccountDataTooSmall)?;

        if bal0 > 0 {
            if **channel_account.lamports.borrow() < bal0 {
                return Err(ProgramError::InsufficientFunds);
            }
            **channel_account.try_borrow_mut_lamports()? -= bal0;
            **part0_account.try_borrow_mut_lamports()? += bal0;
        }

        if bal1 > 0 {
            if **channel_account.lamports.borrow() < bal1 {
                return Err(ProgramError::InsufficientFunds);
            }
            **channel_account.try_borrow_mut_lamports()? -= bal1;
            **part1_account.try_borrow_mut_lamports()? += bal1;
        }

        msg!("StateChannel: Challenge expired and closed. Disbursed [{}, {}]", bal0, bal1);
        Ok(())
    }

    pub fn process_refund_timeout(
        _program_id: &Pubkey,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let party_a = next_account_info(account_info_iter)?;
        let channel_account = next_account_info(account_info_iter)?;

        let mut ch = ChannelState::try_from_slice(&channel_account.data.borrow())
            .map_err(|_| StateChannelError::ChannelNotFound)?;

        if !ch.is_initialized {
            return Err(StateChannelError::ChannelNotFound.into());
        }
        if ch.settled {
            return Err(StateChannelError::ChannelAlreadySettled.into());
        }
        if ch.balances[1] != 0 || ch.current_seq != 0 {
            return Err(StateChannelError::Unauthorized.into());
        }
        if *party_a.key != ch.participants[0] {
            return Err(StateChannelError::Unauthorized.into());
        }

        ch.settled = true;
        let refund_amount = ch.balances[0];

        ch.serialize(&mut &mut channel_account.data.borrow_mut()[..ChannelState::LEN])
            .map_err(|_| ProgramError::AccountDataTooSmall)?;

        if refund_amount > 0 {
            if **channel_account.lamports.borrow() < refund_amount {
                return Err(ProgramError::InsufficientFunds);
            }
            **channel_account.try_borrow_mut_lamports()? -= refund_amount;
            **party_a.try_borrow_mut_lamports()? += refund_amount;
        }

        msg!("StateChannel: Channel refunded to partyA. Amount: {}", refund_amount);
        Ok(())
    }
}
