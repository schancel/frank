use borsh::BorshSerialize;
use generic_htlc::{
    error::HtlcError,
    instruction::{HtlcInstruction, Payout},
    processor::Processor,
    state::{LockState, LOCK_SEED},
};
use solana_program::{
    account_info::AccountInfo,
    hash::hash as sha256_hash,
    keccak::hash as keccak256_hash,
    program_error::ProgramError,
    pubkey::Pubkey,
};

fn create_account<'a>(
    key: &'a Pubkey,
    is_signer: bool,
    is_writable: bool,
    lamports: &'a mut u64,
    data: &'a mut [u8],
    owner: &'a Pubkey,
) -> AccountInfo<'a> {
    AccountInfo::new(
        key,
        is_signer,
        is_writable,
        lamports,
        data,
        owner,
        false,
        0,
    )
}

#[test]
fn test_lock_and_withdraw_sha256() {
    let program_id = Pubkey::new_unique();
    let funder_key = Pubkey::new_unique();
    let recipient_key = Pubkey::new_unique();
    let refund_key = Pubkey::new_unique();

    let lock_id = [42u8; 32];
    let (lock_pda, _bump) =
        Pubkey::find_program_address(&[LOCK_SEED, lock_id.as_ref()], &program_id);

    let preimage = b"solana-htlc-secret-sha256";
    let hash_lock = sha256_hash(preimage).to_bytes();
    let amount = 1_500_000u64;
    let duration = 3600i64;

    let mut funder_lamports = 10_000_000u64;
    let mut lock_lamports = 0u64;
    let mut funder_data = vec![];
    let mut lock_data = vec![0u8; LockState::LEN];

    let system_program_id = solana_program::system_program::id();

    // 1. Lock funds
    {
        let funder_acc = create_account(&funder_key, true, true, &mut funder_lamports, &mut funder_data, &system_program_id);
        let lock_acc = create_account(&lock_pda, false, true, &mut lock_lamports, &mut lock_data, &program_id);

        let lock_ix = HtlcInstruction::Lock {
            lock_id,
            recipient: recipient_key,
            refund_address: refund_key,
            hash_lock,
            amount,
            duration,
        };
        let mut ix_data = vec![];
        lock_ix.serialize(&mut ix_data).unwrap();

        let accounts = [funder_acc, lock_acc];
        Processor::process(&program_id, &accounts, &ix_data).unwrap();
    }

    assert_eq!(lock_lamports, amount);
    assert_eq!(funder_lamports, 10_000_000 - amount);

    // 2. Withdraw funds with valid preimage
    let mut recipient_lamports = 500_000u64;
    let mut caller_lamports = 1_000_000u64;
    let mut caller_data = vec![];
    let mut recipient_data = vec![];
    let caller_key = Pubkey::new_unique();

    {
        let caller_acc = create_account(&caller_key, true, false, &mut caller_lamports, &mut caller_data, &system_program_id);
        let lock_acc = create_account(&lock_pda, false, true, &mut lock_lamports, &mut lock_data, &program_id);
        let recipient_acc = create_account(&recipient_key, false, true, &mut recipient_lamports, &mut recipient_data, &system_program_id);

        let withdraw_ix = HtlcInstruction::Withdraw {
            preimage: preimage.to_vec(),
        };
        let mut ix_data = vec![];
        withdraw_ix.serialize(&mut ix_data).unwrap();

        let accounts = [caller_acc, lock_acc, recipient_acc];
        Processor::process(&program_id, &accounts, &ix_data).unwrap();
    }

    assert_eq!(lock_lamports, 0);
    assert_eq!(recipient_lamports, 500_000 + amount);

    // 3. Second withdraw must fail
    {
        let caller_acc = create_account(&caller_key, true, false, &mut caller_lamports, &mut caller_data, &system_program_id);
        let lock_acc = create_account(&lock_pda, false, true, &mut lock_lamports, &mut lock_data, &program_id);
        let recipient_acc = create_account(&recipient_key, false, true, &mut recipient_lamports, &mut recipient_data, &system_program_id);

        let withdraw_ix = HtlcInstruction::Withdraw {
            preimage: preimage.to_vec(),
        };
        let mut ix_data = vec![];
        withdraw_ix.serialize(&mut ix_data).unwrap();

        let accounts = [caller_acc, lock_acc, recipient_acc];
        let err = Processor::process(&program_id, &accounts, &ix_data).unwrap_err();
        assert_eq!(err, ProgramError::Custom(HtlcError::AlreadyWithdrawn as u32));
    }
}

#[test]
fn test_lock_and_withdraw_keccak256() {
    let program_id = Pubkey::new_unique();
    let funder_key = Pubkey::new_unique();
    let recipient_key = Pubkey::new_unique();
    let refund_key = Pubkey::new_unique();

    let lock_id = [77u8; 32];
    let (lock_pda, _) =
        Pubkey::find_program_address(&[LOCK_SEED, lock_id.as_ref()], &program_id);

    let preimage = b"solana-htlc-secret-keccak256";
    let hash_lock = keccak256_hash(preimage).to_bytes();
    let amount = 2_000_000u64;
    let duration = 1800i64;

    let mut funder_lamports = 5_000_000u64;
    let mut lock_lamports = 0u64;
    let mut funder_data = vec![];
    let mut lock_data = vec![0u8; LockState::LEN];
    let system_program_id = solana_program::system_program::id();

    // Lock
    {
        let funder_acc = create_account(&funder_key, true, true, &mut funder_lamports, &mut funder_data, &system_program_id);
        let lock_acc = create_account(&lock_pda, false, true, &mut lock_lamports, &mut lock_data, &program_id);

        let lock_ix = HtlcInstruction::Lock {
            lock_id,
            recipient: recipient_key,
            refund_address: refund_key,
            hash_lock,
            amount,
            duration,
        };
        let mut ix_data = vec![];
        lock_ix.serialize(&mut ix_data).unwrap();

        Processor::process(&program_id, &[funder_acc, lock_acc], &ix_data).unwrap();
    }

    // Invalid preimage fails
    let caller_key = Pubkey::new_unique();
    let mut caller_lamports = 100_000u64;
    let mut recipient_lamports = 0u64;
    let mut caller_data = vec![];
    let mut recipient_data = vec![];

    {
        let caller_acc = create_account(&caller_key, true, false, &mut caller_lamports, &mut caller_data, &system_program_id);
        let lock_acc = create_account(&lock_pda, false, true, &mut lock_lamports, &mut lock_data, &program_id);
        let recipient_acc = create_account(&recipient_key, false, true, &mut recipient_lamports, &mut recipient_data, &system_program_id);

        let withdraw_ix = HtlcInstruction::Withdraw {
            preimage: b"wrong-secret".to_vec(),
        };
        let mut ix_data = vec![];
        withdraw_ix.serialize(&mut ix_data).unwrap();

        let err = Processor::process(&program_id, &[caller_acc, lock_acc, recipient_acc], &ix_data).unwrap_err();
        assert_eq!(err, ProgramError::Custom(HtlcError::InvalidPreimage as u32));
    }

    // Valid keccak256 withdraw succeeds
    {
        let caller_acc = create_account(&caller_key, true, false, &mut caller_lamports, &mut caller_data, &system_program_id);
        let lock_acc = create_account(&lock_pda, false, true, &mut lock_lamports, &mut lock_data, &program_id);
        let recipient_acc = create_account(&recipient_key, false, true, &mut recipient_lamports, &mut recipient_data, &system_program_id);

        let withdraw_ix = HtlcInstruction::Withdraw {
            preimage: preimage.to_vec(),
        };
        let mut ix_data = vec![];
        withdraw_ix.serialize(&mut ix_data).unwrap();

        Processor::process(&program_id, &[caller_acc, lock_acc, recipient_acc], &ix_data).unwrap();
    }

    assert_eq!(lock_lamports, 0);
    assert_eq!(recipient_lamports, amount);
}

#[test]
fn test_batch_distribute_multi_winner_and_remainder() {
    let program_id = Pubkey::new_unique();
    let system_program_id = solana_program::system_program::id();

    let preimage = b"table-poker-secret-456";
    let hash_lock = sha256_hash(preimage).to_bytes();

    // 3 players deposit 1,000,000 lamports each = 3,000,000 lamports pool
    let lock_id1 = [1u8; 32];
    let lock_id2 = [2u8; 32];
    let lock_id3 = [3u8; 32];

    let (lock_pda1, _) = Pubkey::find_program_address(&[LOCK_SEED, lock_id1.as_ref()], &program_id);
    let (lock_pda2, _) = Pubkey::find_program_address(&[LOCK_SEED, lock_id2.as_ref()], &program_id);
    let (lock_pda3, _) = Pubkey::find_program_address(&[LOCK_SEED, lock_id3.as_ref()], &program_id);

    let alice = Pubkey::new_unique();
    let bob = Pubkey::new_unique();
    let carol = Pubkey::new_unique();

    let primary_refund = Pubkey::new_unique(); // Alice's cold refund address

    let mut l1_lamports = 1_000_000u64;
    let mut l2_lamports = 1_000_000u64;
    let mut l3_lamports = 1_000_000u64;

    let mut l1_data = vec![0u8; LockState::LEN];
    let mut l2_data = vec![0u8; LockState::LEN];
    let mut l3_data = vec![0u8; LockState::LEN];

    LockState {
        is_initialized: true,
        lock_id: lock_id1,
        sender: alice,
        recipient: Pubkey::new_unique(),
        refund_address: primary_refund,
        hash_lock,
        amount: 1_000_000,
        expires_at: 10_000,
        withdrawn: false,
        refunded: false,
        bump: 0,
    }.serialize(&mut &mut l1_data[..LockState::LEN]).unwrap();

    LockState {
        is_initialized: true,
        lock_id: lock_id2,
        sender: bob,
        recipient: Pubkey::new_unique(),
        refund_address: bob,
        hash_lock,
        amount: 1_000_000,
        expires_at: 10_000,
        withdrawn: false,
        refunded: false,
        bump: 0,
    }.serialize(&mut &mut l2_data[..LockState::LEN]).unwrap();

    LockState {
        is_initialized: true,
        lock_id: lock_id3,
        sender: carol,
        recipient: Pubkey::new_unique(),
        refund_address: carol,
        hash_lock,
        amount: 1_000_000,
        expires_at: 10_000,
        withdrawn: false,
        refunded: false,
        bump: 0,
    }.serialize(&mut &mut l3_data[..LockState::LEN]).unwrap();

    // Winners:
    // Dave gets 2,200,000 lamports
    // Eve gets 600,000 lamports
    // Remainder: 200,000 lamports returns to primary_refund
    let dave = Pubkey::new_unique();
    let eve = Pubkey::new_unique();
    let mut dave_lamports = 0u64;
    let mut eve_lamports = 0u64;
    let mut refund_lamports = 0u64;

    let mut dave_data = vec![];
    let mut eve_data = vec![];
    let mut refund_data = vec![];

    let caller_key = Pubkey::new_unique();
    let mut caller_lamports = 100_000u64;
    let mut caller_data = vec![];

    let caller_acc = create_account(&caller_key, true, false, &mut caller_lamports, &mut caller_data, &system_program_id);
    let l1_acc = create_account(&lock_pda1, false, true, &mut l1_lamports, &mut l1_data, &program_id);
    let l2_acc = create_account(&lock_pda2, false, true, &mut l2_lamports, &mut l2_data, &program_id);
    let l3_acc = create_account(&lock_pda3, false, true, &mut l3_lamports, &mut l3_data, &program_id);

    let dave_acc = create_account(&dave, false, true, &mut dave_lamports, &mut dave_data, &system_program_id);
    let eve_acc = create_account(&eve, false, true, &mut eve_lamports, &mut eve_data, &system_program_id);
    let rem_acc = create_account(&primary_refund, false, true, &mut refund_lamports, &mut refund_data, &system_program_id);

    let distribute_ix = HtlcInstruction::BatchDistribute {
        preimage: preimage.to_vec(),
        payouts: vec![
            Payout { recipient: dave, amount: 2_200_000 },
            Payout { recipient: eve, amount: 600_000 },
        ],
    };
    let mut ix_data = vec![];
    distribute_ix.serialize(&mut ix_data).unwrap();

    let accounts = [
        caller_acc,
        l1_acc,
        l2_acc,
        l3_acc,
        dave_acc,
        eve_acc,
        rem_acc,
    ];

    Processor::process(&program_id, &accounts, &ix_data).unwrap();

    assert_eq!(dave_lamports, 2_200_000);
    assert_eq!(eve_lamports, 600_000);
    assert_eq!(refund_lamports, 200_000); // 3,000,000 - 2,800,000 = 200,000
    assert_eq!(l1_lamports, 0);
    assert_eq!(l2_lamports, 0);
    assert_eq!(l3_lamports, 0);
}

#[test]
fn test_batch_withdraw() {
    let program_id = Pubkey::new_unique();
    let system_program_id = solana_program::system_program::id();
    let preimage = b"shared-batch-preimage";
    let hash_lock = sha256_hash(preimage).to_bytes();

    let lock_id1 = [10u8; 32];
    let lock_id2 = [20u8; 32];
    let (lock_pda1, _) = Pubkey::find_program_address(&[LOCK_SEED, lock_id1.as_ref()], &program_id);
    let (lock_pda2, _) = Pubkey::find_program_address(&[LOCK_SEED, lock_id2.as_ref()], &program_id);

    let rec1 = Pubkey::new_unique();
    let rec2 = Pubkey::new_unique();

    let mut l1_lamports = 400_000u64;
    let mut l2_lamports = 600_000u64;
    let mut rec1_lamports = 0u64;
    let mut rec2_lamports = 0u64;

    let mut l1_data = vec![0u8; LockState::LEN];
    let mut l2_data = vec![0u8; LockState::LEN];
    let mut rec1_data = vec![];
    let mut rec2_data = vec![];

    LockState {
        is_initialized: true,
        lock_id: lock_id1,
        sender: Pubkey::new_unique(),
        recipient: rec1,
        refund_address: Pubkey::new_unique(),
        hash_lock,
        amount: 400_000,
        expires_at: 10_000,
        withdrawn: false,
        refunded: false,
        bump: 0,
    }.serialize(&mut &mut l1_data[..LockState::LEN]).unwrap();

    LockState {
        is_initialized: true,
        lock_id: lock_id2,
        sender: Pubkey::new_unique(),
        recipient: rec2,
        refund_address: Pubkey::new_unique(),
        hash_lock,
        amount: 600_000,
        expires_at: 10_000,
        withdrawn: false,
        refunded: false,
        bump: 0,
    }.serialize(&mut &mut l2_data[..LockState::LEN]).unwrap();

    let caller_key = Pubkey::new_unique();
    let mut caller_lamports = 100_000u64;
    let mut caller_data = vec![];

    let caller_acc = create_account(&caller_key, true, false, &mut caller_lamports, &mut caller_data, &system_program_id);
    let l1_acc = create_account(&lock_pda1, false, true, &mut l1_lamports, &mut l1_data, &program_id);
    let rec1_acc = create_account(&rec1, false, true, &mut rec1_lamports, &mut rec1_data, &system_program_id);
    let l2_acc = create_account(&lock_pda2, false, true, &mut l2_lamports, &mut l2_data, &program_id);
    let rec2_acc = create_account(&rec2, false, true, &mut rec2_lamports, &mut rec2_data, &system_program_id);

    let batch_ix = HtlcInstruction::BatchWithdraw {
        preimage: preimage.to_vec(),
    };
    let mut ix_data = vec![];
    batch_ix.serialize(&mut ix_data).unwrap();

    let accounts = [caller_acc, l1_acc, rec1_acc, l2_acc, rec2_acc];
    Processor::process(&program_id, &accounts, &ix_data).unwrap();

    assert_eq!(rec1_lamports, 400_000);
    assert_eq!(rec2_lamports, 600_000);
    assert_eq!(l1_lamports, 0);
    assert_eq!(l2_lamports, 0);
}
