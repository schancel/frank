//! The curve hot spot of `@frank/dkls-two-party`: the two batches of scalar
//! multiplications of the Verified Simplest OT base OT (128 OTs per batch).
//!
//! The protocol logic is in TypeScript (`src/base-ot.ts`); this crate computes
//! exactly what `src/kernel.ts`'s `typescriptKernel` computes, byte for byte,
//! and nothing else. No hashing, no randomness, no protocol decisions.
//!
//! ABI. No allocator and no imports. The caller writes the input into the
//! static buffer at `input_ptr()`, calls a function, and reads the result from
//! the static buffer at `output_ptr()`. Every function returns 0 on success
//! and a nonzero code otherwise (and then the output is all zero). `wipe()`
//! zeroes both buffers and must be called after every use.
//!
//! Secrets. Scalar multiplication, point addition and the choice-bit
//! selection are the constant-time routines of `k256` / `subtle`. Parsing of
//! points is variable-time; points are public.
#![no_std]

use core::ptr::{addr_of, addr_of_mut};

use k256::elliptic_curve::group::Group;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar};
use subtle::{Choice, ConditionallySelectable};
use zeroize::Zeroize;

/// Largest batch.
const MAX_COUNT: usize = 128;
const POINT: usize = 33;
const SCALAR: usize = 32;
const CHOICE_BYTES: usize = MAX_COUNT / 8;

const INPUT_BYTES: usize = SCALAR + POINT + CHOICE_BYTES + MAX_COUNT * POINT;
const OUTPUT_BYTES: usize = MAX_COUNT * 2 * POINT;

static mut INPUT: [u8; INPUT_BYTES] = [0; INPUT_BYTES];
static mut OUTPUT: [u8; OUTPUT_BYTES] = [0; OUTPUT_BYTES];

const OK: u32 = 0;
const BAD_COUNT: u32 = 1;
const BAD_POINT: u32 = 2;
const BAD_SCALAR: u32 = 3;
const IDENTITY: u32 = 4;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // Unreachable by construction; trap rather than continue.
    core::arch::wasm32::unreachable()
}

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 {
    addr_of_mut!(INPUT) as *mut u8
}

#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 {
    addr_of!(OUTPUT) as *const u8
}

#[no_mangle]
pub extern "C" fn input_len() -> u32 {
    INPUT_BYTES as u32
}

#[no_mangle]
pub extern "C" fn output_len() -> u32 {
    OUTPUT_BYTES as u32
}

/// Zeroes both buffers.
#[no_mangle]
pub extern "C" fn wipe() {
    // Single-threaded: wasm32-unknown-unknown has no threads here.
    unsafe {
        (*addr_of_mut!(INPUT)).zeroize();
        (*addr_of_mut!(OUTPUT)).zeroize();
    }
}

fn parse_point(bytes: &[u8]) -> Option<ProjectivePoint> {
    if bytes.len() != POINT || (bytes[0] != 0x02 && bytes[0] != 0x03) {
        return None;
    }
    let encoded = EncodedPoint::from_bytes(bytes).ok()?;
    let affine: Option<AffinePoint> = AffinePoint::from_encoded_point(&encoded).into();
    affine.map(ProjectivePoint::from)
}

/// A canonical scalar in `[1, q)`.
fn parse_scalar(bytes: &[u8]) -> Option<Scalar> {
    let mut repr = FieldBytes::default();
    repr.copy_from_slice(bytes);
    let scalar: Option<Scalar> = Scalar::from_repr(repr).into();
    repr.zeroize();
    let scalar = scalar?;
    if bool::from(scalar.is_zero()) {
        return None;
    }
    Some(scalar)
}

/// Writes a non-identity point as 33 bytes.
fn write_point(out: &mut [u8], point: &ProjectivePoint) -> bool {
    if bool::from(point.is_identity()) {
        return false;
    }
    let encoded = point.to_affine().to_encoded_point(true);
    out.copy_from_slice(encoded.as_bytes());
    true
}

fn receiver(input: &[u8], output: &mut [u8], count: usize) -> u32 {
    let key = match parse_point(&input[..POINT]) {
        Some(point) => point,
        None => return BAD_POINT,
    };
    let choices = &input[POINT..POINT + CHOICE_BYTES];
    let scalars = &input[POINT + CHOICE_BYTES..];
    for j in 0..count {
        let mut scalar = match parse_scalar(&scalars[j * SCALAR..(j + 1) * SCALAR]) {
            Some(scalar) => scalar,
            None => return BAD_SCALAR,
        };
        let plain = ProjectivePoint::GENERATOR * scalar;
        let shifted = plain + key;
        let bit = Choice::from((choices[j >> 3] >> (j & 7)) & 1);
        let encoded = ProjectivePoint::conditional_select(&plain, &shifted, bit);
        let shared = key * scalar;
        scalar.zeroize();
        let slot = &mut output[j * 2 * POINT..(j + 1) * 2 * POINT];
        let (first, second) = slot.split_at_mut(POINT);
        if !write_point(first, &encoded) || !write_point(second, &shared) {
            return IDENTITY;
        }
    }
    OK
}

fn sender(input: &[u8], output: &mut [u8], count: usize) -> u32 {
    let mut secret = match parse_scalar(&input[..SCALAR]) {
        Some(scalar) => scalar,
        None => return BAD_SCALAR,
    };
    let key = match parse_point(&input[SCALAR..SCALAR + POINT]) {
        Some(point) => point,
        None => return BAD_POINT,
    };
    let offset = key * secret;
    let points = &input[SCALAR + POINT..];
    let mut status = OK;
    for j in 0..count {
        let point = match parse_point(&points[j * POINT..(j + 1) * POINT]) {
            Some(point) => point,
            None => {
                status = BAD_POINT;
                break;
            }
        };
        let product = point * secret;
        let other = product - offset;
        let slot = &mut output[j * 2 * POINT..(j + 1) * 2 * POINT];
        let (first, second) = slot.split_at_mut(POINT);
        if !write_point(first, &product) || !write_point(second, &other) {
            status = IDENTITY;
            break;
        }
    }
    secret.zeroize();
    status
}

fn run(count: u32, body: fn(&[u8], &mut [u8], usize) -> u32) -> u32 {
    let count = count as usize;
    if count == 0 || count > MAX_COUNT {
        return BAD_COUNT;
    }
    // Single-threaded; the two statics are only touched through here, the
    // pointer getters and `wipe`.
    let (input, output) = unsafe { (&*addr_of!(INPUT), &mut *addr_of_mut!(OUTPUT)) };
    output.zeroize();
    let status = body(input, output, count);
    if status != OK {
        output.zeroize();
    }
    status
}

/// Base-OT receiver. Input: `B (33) || choice bits (16, bit j least
/// significant first) || count x a_j (32)`. Output: `count x (A_j (33) ||
/// a_j*B (33))` with `A_j = a_j*G + choice_j*B`.
#[no_mangle]
pub extern "C" fn ot_receiver_points(count: u32) -> u32 {
    run(count, receiver)
}

/// Base-OT sender. Input: `b (32) || B (33) || count x A_j (33)`. Output:
/// `count x (b*A_j (33) || b*A_j - b*B (33))`. Fails if any result is the
/// identity (which happens exactly when `A_j = B`).
#[no_mangle]
pub extern "C" fn ot_sender_points(count: u32) -> u32 {
    run(count, sender)
}
