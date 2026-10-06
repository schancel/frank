use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    hash::hash as sha256_hash,
    keccak::hash as keccak256_hash,
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    sysvar::Sysvar,
};

use crate::{
    error::HtlcError,
    instruction::{HtlcInstruction, Payout},
    state::{LockState, LOCK_SEED},
};

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> ProgramResult {
        let instruction = HtlcInstruction::try_from_slice(instruction_data)
            .map_err(|_| ProgramError::InvalidInstructionData)?;

        match instruction {
            HtlcInstruction::Lock {
                lock_id,
                recipient,
                refund_address,
                hash_lock,
                amount,
                duration,
            } => Self::process_lock(
                program_id,
                accounts,
                lock_id,
                recipient,
                refund_address,
                hash_lock,
                amount,
                duration,
            ),
            HtlcInstruction::Withdraw { preimage } => {
                Self::process_withdraw(program_id, accounts, preimage)
            }
            HtlcInstruction::BatchWithdraw { preimage } => {
                Self::process_batch_withdraw(program_id, accounts, preimage)
            }
            HtlcInstruction::BatchDistribute { preimage, payouts } => {
                Self::process_batch_distribute(program_id, accounts, preimage, payouts)
            }
            HtlcInstruction::Refund => Self::process_refund(program_id, accounts),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn process_lock(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        lock_id: [u8; 32],
        recipient: Pubkey,
        refund_address: Pubkey,
        hash_lock: [u8; 32],
        amount: u64,
        duration: i64,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let funder = next_account_info(account_info_iter)?;
        let lock_account = next_account_info(account_info_iter)?;
        let system_program = next_account_info(account_info_iter).ok();

        if !funder.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if recipient == Pubkey::default() {
            return Err(HtlcError::InvalidZeroAddress.into());
        }
        if amount == 0 {
            return Err(HtlcError::ZeroAmount.into());
        }
        if duration <= 0 {
            return Err(HtlcError::LockExpired.into());
        }

        let (expected_pda, bump) =
            Pubkey::find_program_address(&[LOCK_SEED, lock_id.as_ref()], program_id);
        if expected_pda != *lock_account.key {
            return Err(HtlcError::InvalidPda.into());
        }

        if !lock_account.data_is_empty() {
            if let Ok(existing) = LockState::try_from_slice(&lock_account.data.borrow()) {
                if existing.is_initialized {
                    return Err(HtlcError::LockAlreadyExists.into());
                }
            }
        }

        let effective_refund = if refund_address == Pubkey::default() {
            *funder.key
        } else {
            refund_address
        };

        let now = Clock::get().map(|c| c.unix_timestamp).unwrap_or(0);
        let expires_at = now.saturating_add(duration);

        // Transfer funds from funder to lock PDA
        if let Some(sys_prog) = system_program {
            if funder.lamports() < amount {
                return Err(ProgramError::InsufficientFunds);
            }
            invoke(
                &system_instruction::transfer(funder.key, lock_account.key, amount),
                &[funder.clone(), lock_account.clone(), sys_prog.clone()],
            )?;
        } else {
            // Local / mock test execution: direct lamport transfer
            if **funder.lamports.borrow() < amount {
                return Err(ProgramError::InsufficientFunds);
            }
            **funder.try_borrow_mut_lamports()? -= amount;
            **lock_account.try_borrow_mut_lamports()? += amount;
        }

        let lock_state = LockState {
            is_initialized: true,
            lock_id,
            sender: *funder.key,
            recipient,
            refund_address: effective_refund,
            hash_lock,
            amount,
            expires_at,
            withdrawn: false,
            refunded: false,
            bump,
        };

        let mut data = lock_account.data.borrow_mut();
        if data.len() < LockState::LEN {
            // Account data buffer too small
            return Err(ProgramError::AccountDataTooSmall);
        }
        lock_state
            .serialize(&mut &mut data[..LockState::LEN])
            .map_err(|_| ProgramError::AccountDataTooSmall)?;

        msg!("GenericHTLC: Lock created for lock_id with amount {}", amount);
        Ok(())
    }

    pub fn process_withdraw(
        _program_id: &Pubkey,
        accounts: &[AccountInfo],
        preimage: Vec<u8>,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let _caller = next_account_info(account_info_iter)?;
        let lock_account = next_account_info(account_info_iter)?;
        let recipient_account = next_account_info(account_info_iter)?;

        let mut lock_state = LockState::try_from_slice(&lock_account.data.borrow())
            .map_err(|_| HtlcError::LockNotFound)?;

        if !lock_state.is_initialized {
            return Err(HtlcError::LockNotFound.into());
        }
        if lock_state.withdrawn {
            return Err(HtlcError::AlreadyWithdrawn.into());
        }
        if lock_state.refunded {
            return Err(HtlcError::AlreadyRefunded.into());
        }
        if *recipient_account.key != lock_state.recipient {
            return Err(HtlcError::AccountMismatch.into());
        }

        // Verify hashlock with sha256 or keccak256
        let sha_h = sha256_hash(&preimage).to_bytes();
        let keccak_h = keccak256_hash(&preimage).to_bytes();
        if sha_h != lock_state.hash_lock && keccak_h != lock_state.hash_lock {
            return Err(HtlcError::InvalidPreimage.into());
        }

        lock_state.withdrawn = true;
        lock_state
            .serialize(&mut &mut lock_account.data.borrow_mut()[..LockState::LEN])
            .map_err(|_| ProgramError::AccountDataTooSmall)?;

        let payout = lock_state.amount;
        if **lock_account.lamports.borrow() < payout {
            return Err(ProgramError::InsufficientFunds);
        }
        **lock_account.try_borrow_mut_lamports()? -= payout;
        **recipient_account.try_borrow_mut_lamports()? += payout;

        msg!("GenericHTLC: Withdraw successful, paid out {}", payout);
        Ok(())
    }

    pub fn process_batch_withdraw(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        preimage: Vec<u8>,
    ) -> ProgramResult {
        if accounts.len() < 3 || (accounts.len() - 1) % 2 != 0 {
            return Err(HtlcError::EmptyBatch.into());
        }

        let account_info_iter = &mut accounts.iter();
        let caller = next_account_info(account_info_iter)?;

        let count = (accounts.len() - 1) / 2;
        for _ in 0..count {
            let lock_account = next_account_info(account_info_iter)?;
            let recipient_account = next_account_info(account_info_iter)?;

            let sub_accounts = [caller.clone(), lock_account.clone(), recipient_account.clone()];
            Self::process_withdraw(program_id, &sub_accounts, preimage.clone())?;
        }

        Ok(())
    }

    pub fn process_batch_distribute(
        _program_id: &Pubkey,
        accounts: &[AccountInfo],
        preimage: Vec<u8>,
        payouts: Vec<Payout>,
    ) -> ProgramResult {
        if payouts.is_empty() {
            return Err(HtlcError::EmptyBatch.into());
        }

        let account_info_iter = &mut accounts.iter();
        let _caller = next_account_info(account_info_iter)?;

        // Find how many lock accounts vs payout accounts:
        // Next accounts are lock accounts until we reach accounts matching payouts[0].recipient
        let first_payout_pubkey = payouts[0].recipient;

        let mut lock_accounts: Vec<AccountInfo> = Vec::new();
        let mut payout_accounts: Vec<AccountInfo> = Vec::new();
        let mut remainder_account: Option<AccountInfo> = None;

        let mut in_payouts = false;
        while let Ok(acc) = next_account_info(account_info_iter) {
            if !in_payouts && *acc.key == first_payout_pubkey {
                in_payouts = true;
            }
            if !in_payouts {
                lock_accounts.push(acc.clone());
            } else if payout_accounts.len() < payouts.len() {
                payout_accounts.push(acc.clone());
            } else {
                remainder_account = Some(acc.clone());
            }
        }

        if lock_accounts.is_empty() {
            return Err(HtlcError::EmptyBatch.into());
        }
        if payout_accounts.len() != payouts.len() {
            return Err(HtlcError::AccountMismatch.into());
        }

        let sha_h = sha256_hash(&preimage).to_bytes();
        let keccak_h = keccak256_hash(&preimage).to_bytes();

        let mut total_pool: u64 = 0;
        let mut primary_refund_dest: Option<Pubkey> = None;

        // Verify and mark all locks as withdrawn
        for (i, lock_account) in lock_accounts.iter().enumerate() {
            let mut lock_state = LockState::try_from_slice(&lock_account.data.borrow())
                .map_err(|_| HtlcError::LockNotFound)?;

            if !lock_state.is_initialized {
                return Err(HtlcError::LockNotFound.into());
            }
            if lock_state.withdrawn {
                return Err(HtlcError::AlreadyWithdrawn.into());
            }
            if lock_state.refunded {
                return Err(HtlcError::AlreadyRefunded.into());
            }

            if sha_h != lock_state.hash_lock && keccak_h != lock_state.hash_lock {
                return Err(HtlcError::InvalidPreimage.into());
            }

            if i == 0 {
                primary_refund_dest = Some(lock_state.refund_address);
            }

            lock_state.withdrawn = true;
            lock_state
                .serialize(&mut &mut lock_account.data.borrow_mut()[..LockState::LEN])
                .map_err(|_| ProgramError::AccountDataTooSmall)?;

            total_pool = total_pool
                .checked_add(lock_state.amount)
                .ok_or(HtlcError::InvalidPayoutSum)?;
        }

        // Calculate total payouts
        let mut total_payouts: u64 = 0;
        for (j, p) in payouts.iter().enumerate() {
            if p.recipient == Pubkey::default() {
                return Err(HtlcError::InvalidZeroAddress.into());
            }
            if p.amount == 0 {
                return Err(HtlcError::ZeroAmount.into());
            }
            if *payout_accounts[j].key != p.recipient {
                return Err(HtlcError::AccountMismatch.into());
            }
            total_payouts = total_payouts
                .checked_add(p.amount)
                .ok_or(HtlcError::InvalidPayoutSum)?;
        }

        if total_payouts > total_pool {
            return Err(HtlcError::InvalidPayoutSum.into());
        }

        // Disburse payouts from lock accounts
        let mut current_lock_idx = 0;
        for (j, p) in payouts.iter().enumerate() {
            let mut remaining_to_pay = p.amount;
            while remaining_to_pay > 0 && current_lock_idx < lock_accounts.len() {
                let lock_acc = &lock_accounts[current_lock_idx];
                let lock_lamports = **lock_acc.lamports.borrow();
                let take = remaining_to_pay.min(lock_lamports);
                **lock_acc.try_borrow_mut_lamports()? -= take;
                **payout_accounts[j].try_borrow_mut_lamports()? += take;
                remaining_to_pay -= take;
                if **lock_acc.lamports.borrow() == 0 {
                    current_lock_idx += 1;
                }
            }
            if remaining_to_pay > 0 {
                return Err(ProgramError::InsufficientFunds);
            }
        }

        // Leftover remainder goes to primary lock's refund address
        let remainder = total_pool.saturating_sub(total_payouts);
        if remainder > 0 {
            let rem_acc = remainder_account.ok_or(HtlcError::AccountMismatch)?;
            if Some(*rem_acc.key) != primary_refund_dest {
                return Err(HtlcError::AccountMismatch.into());
            }

            while current_lock_idx < lock_accounts.len() {
                let lock_acc = &lock_accounts[current_lock_idx];
                let avail = **lock_acc.lamports.borrow();
                if avail > 0 {
                    **lock_acc.try_borrow_mut_lamports()? -= avail;
                    **rem_acc.try_borrow_mut_lamports()? += avail;
                }
                current_lock_idx += 1;
            }
        }

        msg!("GenericHTLC: BatchDistribute complete. Total disbursed: {}", total_payouts);
        Ok(())
    }

    pub fn process_refund(_program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let _caller = next_account_info(account_info_iter)?;
        let lock_account = next_account_info(account_info_iter)?;
        let refund_account = next_account_info(account_info_iter)?;
        let clock = Clock::get().map_err(|_| ProgramError::InvalidAccountData)?;

        let mut lock_state = LockState::try_from_slice(&lock_account.data.borrow())
            .map_err(|_| HtlcError::LockNotFound)?;

        if !lock_state.is_initialized {
            return Err(HtlcError::LockNotFound.into());
        }
        if lock_state.withdrawn {
            return Err(HtlcError::AlreadyWithdrawn.into());
        }
        if lock_state.refunded {
            return Err(HtlcError::AlreadyRefunded.into());
        }
        if clock.unix_timestamp < lock_state.expires_at {
            return Err(HtlcError::LockNotExpired.into());
        }
        if *refund_account.key != lock_state.refund_address {
            return Err(HtlcError::AccountMismatch.into());
        }

        lock_state.refunded = true;
        lock_state
            .serialize(&mut &mut lock_account.data.borrow_mut()[..LockState::LEN])
            .map_err(|_| ProgramError::AccountDataTooSmall)?;

        let refund_amount = lock_state.amount;
        if **lock_account.lamports.borrow() < refund_amount {
            return Err(ProgramError::InsufficientFunds);
        }
        **lock_account.try_borrow_mut_lamports()? -= refund_amount;
        **refund_account.try_borrow_mut_lamports()? += refund_amount;

        msg!("GenericHTLC: Refund successful to explicit destination. Amount: {}", refund_amount);
        Ok(())
    }
}
