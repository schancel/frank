//! Pure-Rust Keccak-256 (the original Keccak padding 0x01, not SHA3's 0x06), used only for the
//! M6 canonical-address derivation of README section 11. Pinned by the committed values
//! vectors and the empty-input reference hash.

/// The 24 Keccak-f[1600] round constants.
const ROUND_CONSTANTS: [u64; 24] = [
    0x0000_0000_0000_0001,
    0x0000_0000_0000_8082,
    0x8000_0000_0000_808a,
    0x8000_0000_8000_8000,
    0x0000_0000_0000_808b,
    0x0000_0000_8000_0001,
    0x8000_0000_8000_8081,
    0x8000_0000_0000_8009,
    0x0000_0000_0000_008a,
    0x0000_0000_0000_0088,
    0x0000_0000_8000_8009,
    0x0000_0000_8000_000a,
    0x0000_0000_8000_808b,
    0x8000_0000_0000_008b,
    0x8000_0000_0000_8089,
    0x8000_0000_0000_8003,
    0x8000_0000_0000_8002,
    0x8000_0000_0000_0080,
    0x0000_0000_0000_800a,
    0x8000_0000_8000_000a,
    0x8000_0000_8000_8081,
    0x8000_0000_0000_8080,
    0x0000_0000_8000_0001,
    0x8000_0000_8000_8008,
];

/// Rho rotation offsets, `ROTATION[x][y]` for the lane at `(x, y)`.
const ROTATION: [[u32; 5]; 5] = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
];

fn keccak_f1600(lanes: &mut [[u64; 5]; 5]) {
    for round in ROUND_CONSTANTS {
        let mut c = [0u64; 5];
        for (x, lane) in c.iter_mut().enumerate() {
            *lane = lanes[x][0] ^ lanes[x][1] ^ lanes[x][2] ^ lanes[x][3] ^ lanes[x][4];
        }
        let mut d = [0u64; 5];
        for x in 0..5 {
            d[x] = c[(x + 4) % 5] ^ c[(x + 1) % 5].rotate_left(1);
        }
        for (x, lane_column) in lanes.iter_mut().enumerate() {
            for lane in lane_column.iter_mut() {
                *lane ^= d[x];
            }
        }
        let mut b = [[0u64; 5]; 5];
        for x in 0..5 {
            for y in 0..5 {
                b[y][(2 * x + 3 * y) % 5] = lanes[x][y].rotate_left(ROTATION[x][y]);
            }
        }
        for x in 0..5 {
            for y in 0..5 {
                lanes[x][y] = b[x][y] ^ ((!b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]);
            }
        }
        lanes[0][0] ^= round;
    }
}

/// Keccak-256 of `data`.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut lanes = [[0u64; 5]; 5];
    let rate = 136;
    let mut padded = data.to_vec();
    padded.push(0x01);
    while !padded.len().is_multiple_of(rate) {
        padded.push(0);
    }
    let last = padded.len() - 1;
    padded[last] |= 0x80;
    for block in padded.chunks(rate) {
        for (i, lane) in block.chunks(8).enumerate() {
            let mut value = [0u8; 8];
            value.copy_from_slice(lane);
            lanes[i % 5][i / 5] ^= u64::from_le_bytes(value);
        }
        keccak_f1600(&mut lanes);
    }
    let mut out = [0u8; 32];
    for i in 0..4 {
        out[8 * i..8 * i + 8].copy_from_slice(&lanes[i % 5][i / 5].to_le_bytes());
    }
    out
}
