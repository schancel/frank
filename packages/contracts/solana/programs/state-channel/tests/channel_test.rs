use borsh::BorshSerialize;
use ed25519_dalek::{Signer, SigningKey};
use rand::{rngs::OsRng, Rng};
use solana_program::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use state_channel::{
    digest::{get_checkpoint_digest, get_close_digest},
    error::StateChannelError,
    instruction::StateChannelInstruction,
    processor::Processor,
    state::{ChannelState, CHANNEL_SEED},
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

fn generate_keypair() -> (SigningKey, Pubkey) {
    let mut secret = [0u8; 32];
    OsRng.fill(&mut secret);
    let signing = SigningKey::from_bytes(&secret);
    let pubkey = Pubkey::new_from_array(signing.verifying_key().to_bytes());
    (signing, pubkey)
}

#[test]
fn test_open_join_and_cooperative_close_with_stealth_payout() {
    let program_id = Pubkey::new_unique();
    let system_program_id = solana_program::system_program::id();

    let (alice_signing, alice_pubkey) = generate_keypair();
    let (bob_signing, bob_pubkey) = generate_keypair();

    let channel_id = [99u8; 32];
    let (channel_pda, _) =
        Pubkey::find_program_address(&[CHANNEL_SEED, channel_id.as_ref()], &program_id);

    let deposit_a = 1_000_000u64;
    let deposit_b = 1_000_000u64;
    let challenge_duration = 3600i64;

    let mut alice_lamports = 5_000_000u64;
    let mut bob_lamports = 5_000_000u64;
    let mut channel_lamports = 0u64;

    let mut alice_data = vec![];
    let mut bob_data = vec![];
    let mut channel_data = vec![0u8; ChannelState::LEN];

    // 1. Alice opens channel
    {
        let alice_acc = create_account(&alice_pubkey, true, true, &mut alice_lamports, &mut alice_data, &system_program_id);
        let ch_acc = create_account(&channel_pda, false, true, &mut channel_lamports, &mut channel_data, &program_id);

        let open_ix = StateChannelInstruction::OpenChannel {
            channel_id,
            peer: bob_pubkey,
            deposit_a,
            challenge_duration,
        };
        let mut ix_data = vec![];
        open_ix.serialize(&mut ix_data).unwrap();

        Processor::process(&program_id, &[alice_acc, ch_acc], &ix_data).unwrap();
    }
    assert_eq!(channel_lamports, deposit_a);
    assert_eq!(alice_lamports, 4_000_000);

    // 2. Bob joins channel
    {
        let bob_acc = create_account(&bob_pubkey, true, true, &mut bob_lamports, &mut bob_data, &system_program_id);
        let ch_acc = create_account(&channel_pda, false, true, &mut channel_lamports, &mut channel_data, &program_id);

        let join_ix = StateChannelInstruction::JoinChannel { deposit_b };
        let mut ix_data = vec![];
        join_ix.serialize(&mut ix_data).unwrap();

        Processor::process(&program_id, &[bob_acc, ch_acc], &ix_data).unwrap();
    }
    assert_eq!(channel_lamports, deposit_a + deposit_b);
    assert_eq!(bob_lamports, 4_000_000);

    // 3. Play game and cooperatively close with fresh DKSAP stealth payout for Alice!
    let stealth_payout0 = Pubkey::new_unique(); // One-time DKSAP stealth address
    let dest_payout1 = bob_pubkey; // Bob's regular address

    let final_seq = 10u64;
    let final_balances = [1_750_000u64, 250_000u64]; // Alice wins 750,000 lamports from Bob

    // Compute close cooperative digest
    let close_digest = get_close_digest(
        &channel_id,
        final_seq,
        &final_balances,
        &stealth_payout0,
        &dest_payout1,
        &program_id,
    );

    // Dual co-signatures from Alice and Bob
    let sig0 = alice_signing.sign(&close_digest).to_bytes();
    let sig1 = bob_signing.sign(&close_digest).to_bytes();

    let caller_key = Pubkey::new_unique();
    let mut caller_lamports = 100_000u64;
    let mut caller_data = vec![];

    let mut stealth_lamports = 0u64;
    let mut stealth_data = vec![];

    {
        let caller_acc = create_account(&caller_key, true, false, &mut caller_lamports, &mut caller_data, &system_program_id);
        let ch_acc = create_account(&channel_pda, false, true, &mut channel_lamports, &mut channel_data, &program_id);
        let dest0_acc = create_account(&stealth_payout0, false, true, &mut stealth_lamports, &mut stealth_data, &system_program_id);
        let dest1_acc = create_account(&dest_payout1, false, true, &mut bob_lamports, &mut bob_data, &system_program_id);

        let close_ix = StateChannelInstruction::CloseCooperative {
            seq: final_seq,
            balances: final_balances,
            payout0: stealth_payout0,
            payout1: dest_payout1,
            sig0,
            sig1,
        };
        let mut ix_data = vec![];
        close_ix.serialize(&mut ix_data).unwrap();

        Processor::process(&program_id, &[caller_acc, ch_acc, dest0_acc, dest1_acc], &ix_data).unwrap();
    }

    // Assert funds disbursed directly to stealth destination and counterparty
    assert_eq!(channel_lamports, 0);
    assert_eq!(stealth_lamports, 1_750_000);
    assert_eq!(bob_lamports, 4_000_000 + 250_000);
}

#[test]
fn test_checkpoint_dispute_and_stale_sequence_rejection() {
    let program_id = Pubkey::new_unique();
    let system_program_id = solana_program::system_program::id();

    let (alice_signing, alice_pubkey) = generate_keypair();
    let (bob_signing, bob_pubkey) = generate_keypair();

    let channel_id = [123u8; 32];
    let (channel_pda, _) =
        Pubkey::find_program_address(&[CHANNEL_SEED, channel_id.as_ref()], &program_id);

    let mut ch_lamports = 2_000_000u64;
    let mut ch_data = vec![0u8; ChannelState::LEN];

    ChannelState {
        is_initialized: true,
        channel_id,
        participants: [alice_pubkey, bob_pubkey],
        balances: [1_000_000, 1_000_000],
        current_seq: 0,
        challenge_duration: 3600,
        challenge_expires_at: 0,
        settled: false,
        bump: 0,
    }.serialize(&mut &mut ch_data[..ChannelState::LEN]).unwrap();

    let caller_key = Pubkey::new_unique();
    let mut caller_lamports = 100_000u64;
    let mut caller_data = vec![];

    // Checkpoint seq = 3 with balances [1_400_000, 600_000]
    let seq3 = 3u64;
    let balances3 = [1_400_000u64, 600_000u64];
    let digest3 = get_checkpoint_digest(&channel_id, seq3, &balances3, &program_id);

    let sig0 = alice_signing.sign(&digest3).to_bytes();
    let sig1 = bob_signing.sign(&digest3).to_bytes();

    {
        let caller_acc = create_account(&caller_key, true, false, &mut caller_lamports, &mut caller_data, &system_program_id);
        let ch_acc = create_account(&channel_pda, false, true, &mut ch_lamports, &mut ch_data, &program_id);

        let cp_ix = StateChannelInstruction::Checkpoint {
            seq: seq3,
            balances: balances3,
            sig0,
            sig1,
        };
        let mut ix_data = vec![];
        cp_ix.serialize(&mut ix_data).unwrap();

        Processor::process(&program_id, &[caller_acc, ch_acc], &ix_data).unwrap();
    }

    // Sore loser attack: Bob attempts to submit stale seq = 2
    let seq2 = 2u64;
    let balances2 = [800_000u64, 1_200_000u64];
    let digest2 = get_checkpoint_digest(&channel_id, seq2, &balances2, &program_id);
    let sig0_stale = alice_signing.sign(&digest2).to_bytes();
    let sig1_stale = bob_signing.sign(&digest2).to_bytes();

    {
        let caller_acc = create_account(&caller_key, true, false, &mut caller_lamports, &mut caller_data, &system_program_id);
        let ch_acc = create_account(&channel_pda, false, true, &mut ch_lamports, &mut ch_data, &program_id);

        let stale_ix = StateChannelInstruction::Checkpoint {
            seq: seq2,
            balances: balances2,
            sig0: sig0_stale,
            sig1: sig1_stale,
        };
        let mut ix_data = vec![];
        stale_ix.serialize(&mut ix_data).unwrap();

        let err = Processor::process(&program_id, &[caller_acc, ch_acc], &ix_data).unwrap_err();
        assert_eq!(err, ProgramError::Custom(StateChannelError::StaleSequence as u32));
    }
}

#[test]
fn test_refund_timeout_when_peer_never_joins() {
    let program_id = Pubkey::new_unique();
    let system_program_id = solana_program::system_program::id();

    let alice_pubkey = Pubkey::new_unique();
    let bob_pubkey = Pubkey::new_unique();
    let channel_id = [55u8; 32];
    let (channel_pda, _) =
        Pubkey::find_program_address(&[CHANNEL_SEED, channel_id.as_ref()], &program_id);

    let mut ch_lamports = 1_000_000u64;
    let mut alice_lamports = 0u64;
    let mut ch_data = vec![0u8; ChannelState::LEN];
    let mut alice_data = vec![];

    ChannelState {
        is_initialized: true,
        channel_id,
        participants: [alice_pubkey, bob_pubkey],
        balances: [1_000_000, 0], // Bob balance is 0
        current_seq: 0,
        challenge_duration: 3600,
        challenge_expires_at: 0,
        settled: false,
        bump: 0,
    }.serialize(&mut &mut ch_data[..ChannelState::LEN]).unwrap();

    // Alice refunds
    {
        let alice_acc = create_account(&alice_pubkey, true, true, &mut alice_lamports, &mut alice_data, &system_program_id);
        let ch_acc = create_account(&channel_pda, false, true, &mut ch_lamports, &mut ch_data, &program_id);

        let refund_ix = StateChannelInstruction::RefundTimeout;
        let mut ix_data = vec![];
        refund_ix.serialize(&mut ix_data).unwrap();

        Processor::process(&program_id, &[alice_acc, ch_acc], &ix_data).unwrap();
    }

    assert_eq!(ch_lamports, 0);
    assert_eq!(alice_lamports, 1_000_000);
}
