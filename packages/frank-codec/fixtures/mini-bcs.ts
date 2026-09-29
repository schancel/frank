// A minimal BCS (Binary Canonical Serialization) writer and reader, enough to encode the Frank
// fixtures for the #131 falsification check. Its output for the reference struct is pinned to
// what @mysten/bcs 2.1.2 produced (fixtures/bcs-reference-v1.hex); the library itself is not a
// dependency. BCS has no field tags and no lengths for structs/enums; the spec defines signed integers as
// two-complement little-endian, but this writer only needs the unsigned form (i64 is carried as u64).
import { utf8Decode, utf8Encode } from '../src/utf8'

export class BcsWriter {
  private out: number[] = []
  u8(n: number): this {
    this.out.push(n & 0xff)
    return this
  }
  u16(n: number): this {
    return this.u8(n).u8(n >>> 8)
  }
  u32(n: number): this {
    return this.u16(n & 0xffff).u16(n >>> 16)
  }
  u64(n: bigint): this {
    let v = BigInt.asUintN(64, n)
    for (let i = 0; i < 8; i++) {
      this.out.push(Number(v & 0xffn))
      v >>= 8n
    }
    return this
  }
  /** ULEB128, used for every length and enum variant index. */
  uleb(n: number): this {
    let v = n
    do {
      let b = v & 0x7f
      v = Math.floor(v / 128)
      if (v > 0) b |= 0x80
      this.out.push(b)
    } while (v > 0)
    return this
  }
  fixed(b: Uint8Array): this {
    for (const x of b) this.out.push(x)
    return this
  }
  bytes(b: Uint8Array): this {
    return this.uleb(b.length).fixed(b)
  }
  string(s: string): this {
    return this.bytes(utf8Encode(s))
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

export class BcsReader {
  pos = 0
  constructor(private readonly b: Uint8Array) {}
  private need(n: number): void {
    if (this.pos + n > this.b.length)
      throw new RangeError('BCS: read past the end')
  }
  u8(): number {
    this.need(1)
    return this.b[this.pos++]
  }
  u16(): number {
    return this.u8() | (this.u8() << 8)
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0
  }
  u64(): bigint {
    let v = 0n
    for (let i = 0; i < 8; i++) v |= BigInt(this.u8()) << BigInt(8 * i)
    return v
  }
  uleb(): number {
    let v = 0
    let shift = 1
    for (let i = 0; i < 5; i++) {
      const b = this.u8()
      v += (b & 0x7f) * shift
      if (!(b & 0x80)) return v
      shift *= 128
    }
    throw new RangeError('BCS: ULEB128 too long')
  }
  bytes(): Uint8Array {
    const n = this.uleb()
    this.need(n)
    const out = this.b.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  string(): string {
    const b = this.bytes()
    return utf8Decode(b, 0, b.length)
  }
  get remaining(): number {
    return this.b.length - this.pos
  }
}
