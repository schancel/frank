/**
 * Lightweight, zero-dependency wire codec for legacy Monad mailbox messages.
 * Replaces protoc-generated monad_message_pb bindings without google-protobuf.
 * @deprecated Legacy mailbox protobuf wire format; use Canonical CBOR (/message/monad/cbor).
 */

function encodeVarint(val: number | bigint): number[] {
  let v = BigInt(val)
  const buf: number[] = []
  while (v >= 0x80n) {
    buf.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  buf.push(Number(v & 0x7fn))
  return buf
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const res = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    res.set(c, off)
    off += c.length
  }
  return res
}

function decodeVarint(bytes: Uint8Array, off: { pos: number }): bigint {
  let res = 0n
  let shift = 0n
  while (off.pos < bytes.length) {
    const b = BigInt(bytes[off.pos++])
    res |= (b & 0x7fn) << shift
    if ((b & 0x80n) === 0n) return res
    shift += 7n
  }
  return res
}

function skipField(bytes: Uint8Array, wt: number, off: { pos: number }) {
  if (wt === 0) {
    decodeVarint(bytes, off)
  } else if (wt === 2) {
    const len = Number(decodeVarint(bytes, off))
    off.pos += len
  } else if (wt === 1) {
    off.pos += 8
  } else if (wt === 5) {
    off.pos += 4
  } else {
    throw new Error(`Unsupported wire type ${wt}`)
  }
}

export class MonadStampPayment {
  childIndex = 0
  rawTx: Uint8Array = new Uint8Array()

  setChildIndex(v: number) {
    this.childIndex = v
  }
  getChildIndex(): number {
    return this.childIndex
  }
  setRawTx(v: Uint8Array) {
    this.rawTx = v
  }
  getRawTx_asU8(): Uint8Array {
    return this.rawTx
  }

  serializeBinary(): Uint8Array {
    const parts: number[] = []
    if (this.childIndex !== 0) {
      parts.push(0x08, ...encodeVarint(this.childIndex))
    }
    if (this.rawTx.length > 0) {
      parts.push(0x12, ...encodeVarint(this.rawTx.length), ...this.rawTx)
    }
    return new Uint8Array(parts)
  }

  static deserializeBinary(bytes: Uint8Array): MonadStampPayment {
    const p = new MonadStampPayment()
    const off = { pos: 0 }
    while (off.pos < bytes.length) {
      const tag = Number(decodeVarint(bytes, off))
      const fn = tag >> 3
      const wt = tag & 7
      if (fn === 1 && wt === 0) {
        p.childIndex = Number(decodeVarint(bytes, off))
      } else if (fn === 2 && wt === 2) {
        const len = Number(decodeVarint(bytes, off))
        p.rawTx = bytes.subarray(off.pos, off.pos + len)
        off.pos += len
      } else {
        skipField(bytes, wt, off)
      }
    }
    return p
  }
}

export class MonadStampedMessage {
  encryptedPayload: Uint8Array = new Uint8Array()
  payloadHash: Uint8Array = new Uint8Array()
  stampPayments: MonadStampPayment[] = []

  setEncryptedPayload(v: Uint8Array) {
    this.encryptedPayload = v
  }
  getEncryptedPayload_asU8(): Uint8Array {
    return this.encryptedPayload
  }
  setPayloadHash(v: Uint8Array) {
    this.payloadHash = v
  }
  getPayloadHash_asU8(): Uint8Array {
    return this.payloadHash
  }
  setStampPaymentsList(v: MonadStampPayment[]) {
    this.stampPayments = v
  }
  addStampPayments(v: MonadStampPayment) {
    this.stampPayments.push(v)
  }
  getStampPaymentsList(): MonadStampPayment[] {
    return this.stampPayments
  }

  serializeBinary(): Uint8Array {
    const chunks: Uint8Array[] = []
    if (this.encryptedPayload.length > 0) {
      chunks.push(
        new Uint8Array([0x12, ...encodeVarint(this.encryptedPayload.length)]),
        this.encryptedPayload,
      )
    }
    if (this.payloadHash.length > 0) {
      chunks.push(
        new Uint8Array([0x1a, ...encodeVarint(this.payloadHash.length)]),
        this.payloadHash,
      )
    }
    for (const p of this.stampPayments) {
      const pb = p.serializeBinary()
      chunks.push(new Uint8Array([0x22, ...encodeVarint(pb.length)]), pb)
    }
    return concatUint8Arrays(chunks)
  }

  static deserializeBinary(bytes: Uint8Array): MonadStampedMessage {
    const msg = new MonadStampedMessage()
    const off = { pos: 0 }
    while (off.pos < bytes.length) {
      const tag = Number(decodeVarint(bytes, off))
      const fn = tag >> 3
      const wt = tag & 7
      if (fn === 2 && wt === 2) {
        const len = Number(decodeVarint(bytes, off))
        msg.encryptedPayload = bytes.subarray(off.pos, off.pos + len)
        off.pos += len
      } else if (fn === 3 && wt === 2) {
        const len = Number(decodeVarint(bytes, off))
        msg.payloadHash = bytes.subarray(off.pos, off.pos + len)
        off.pos += len
      } else if (fn === 4 && wt === 2) {
        const len = Number(decodeVarint(bytes, off))
        msg.stampPayments.push(
          MonadStampPayment.deserializeBinary(
            bytes.subarray(off.pos, off.pos + len),
          ),
        )
        off.pos += len
      } else {
        skipField(bytes, wt, off)
      }
    }
    return msg
  }
}

export class StoredMonadMessage {
  message?: MonadStampedMessage
  timestamp = 0
  networkTag: Uint8Array = new Uint8Array()

  setMessage(v: MonadStampedMessage) {
    this.message = v
  }
  getMessage(): MonadStampedMessage | undefined {
    return this.message
  }
  setTimestamp(v: number) {
    this.timestamp = v
  }
  getTimestamp(): number {
    return this.timestamp
  }
  setNetworkTag(v: Uint8Array) {
    this.networkTag = v
  }
  getNetworkTag_asU8(): Uint8Array {
    return this.networkTag
  }

  serializeBinary(): Uint8Array {
    const chunks: Uint8Array[] = []
    if (this.message !== undefined) {
      const mb = this.message.serializeBinary()
      chunks.push(new Uint8Array([0x0a, ...encodeVarint(mb.length)]), mb)
    }
    if (this.timestamp !== 0) {
      chunks.push(new Uint8Array([0x20, ...encodeVarint(this.timestamp)]))
    }
    if (this.networkTag.length > 0) {
      chunks.push(
        new Uint8Array([0x2a, ...encodeVarint(this.networkTag.length)]),
        this.networkTag,
      )
    }
    return concatUint8Arrays(chunks)
  }

  static deserializeBinary(bytes: Uint8Array): StoredMonadMessage {
    const s = new StoredMonadMessage()
    const off = { pos: 0 }
    while (off.pos < bytes.length) {
      const tag = Number(decodeVarint(bytes, off))
      const fn = tag >> 3
      const wt = tag & 7
      if (fn === 1 && wt === 2) {
        const len = Number(decodeVarint(bytes, off))
        s.message = MonadStampedMessage.deserializeBinary(
          bytes.subarray(off.pos, off.pos + len),
        )
        off.pos += len
      } else if (fn === 4 && wt === 0) {
        s.timestamp = Number(decodeVarint(bytes, off))
      } else if (fn === 5 && wt === 2) {
        const len = Number(decodeVarint(bytes, off))
        s.networkTag = bytes.subarray(off.pos, off.pos + len)
        off.pos += len
      } else {
        skipField(bytes, wt, off)
      }
    }
    return s
  }
}

export class StoredMonadMessages {
  messages: StoredMonadMessage[] = []

  addMessages(v: StoredMonadMessage) {
    this.messages.push(v)
  }
  getMessagesList(): StoredMonadMessage[] {
    return this.messages
  }

  serializeBinary(): Uint8Array {
    const chunks: Uint8Array[] = []
    for (const m of this.messages) {
      const mb = m.serializeBinary()
      chunks.push(new Uint8Array([0x0a, ...encodeVarint(mb.length)]), mb)
    }
    return concatUint8Arrays(chunks)
  }

  static deserializeBinary(bytes: Uint8Array): StoredMonadMessages {
    const res = new StoredMonadMessages()
    const off = { pos: 0 }
    while (off.pos < bytes.length) {
      const tag = Number(decodeVarint(bytes, off))
      const fn = tag >> 3
      const wt = tag & 7
      if (fn === 1 && wt === 2) {
        const len = Number(decodeVarint(bytes, off))
        res.messages.push(
          StoredMonadMessage.deserializeBinary(
            bytes.subarray(off.pos, off.pos + len),
          ),
        )
        off.pos += len
      } else {
        skipField(bytes, wt, off)
      }
    }
    return res
  }
}
