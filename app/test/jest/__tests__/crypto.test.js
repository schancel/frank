import { PayloadConstructor } from '@frank/cashweb/relay/crypto'
import { randomBytes } from '@frank/crypto-box'
import { secretKey } from '@frank/cashweb/nakamoto-oracle'

const payloadConstructor = new PayloadConstructor({ networkName: 'test-net' })

function randomKey() {
  for (;;) {
    try {
      return secretKey(Buffer.from(randomBytes(32)).toString('hex'))
    } catch {
      // scalar was 0 or not below the group order
    }
  }
}

function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max))
}

test('Encrypt', () => {
  const length = 8
  const plainText = new Uint8Array(new ArrayBuffer(length))
  for (let i = 0; i < length; i++) {
    plainText[i] = getRandomInt(255)
  }

  const salt = new Uint8Array(new ArrayBuffer(32))
  for (let i = 0; i < length; i++) {
    salt[i] = getRandomInt(255)
  }

  const privateKey = randomKey()
  const destinationPublicKey = randomKey().toPublicKey()
  const sharedKey = payloadConstructor.constructSharedKey(
    privateKey,
    destinationPublicKey,
    salt,
  )

  payloadConstructor.encrypt(sharedKey, plainText)
})

test('Decrypt', () => {
  const length = 300
  const prePlainText = new Uint8Array(new ArrayBuffer(length))
  for (let i = 0; i < length; i++) {
    prePlainText[i] = getRandomInt(255)
  }

  const salt = new Uint8Array(new ArrayBuffer(32))
  for (let i = 0; i < length; i++) {
    salt[i] = getRandomInt(255)
  }

  const privateKey = randomKey()
  const destinationPublicKey = randomKey().toPublicKey()
  const sharedKey = payloadConstructor.constructSharedKey(
    privateKey,
    destinationPublicKey,
    salt,
  )
  const cipherText = payloadConstructor.encrypt(sharedKey, prePlainText)
  const postPlainText = payloadConstructor.decrypt(sharedKey, cipherText)

  expect(postPlainText).toStrictEqual(prePlainText)
})

test('StealthKey', () => {
  const destPrivKey = randomKey()
  const destPubKey = destPrivKey.toPublicKey()

  const ephemeralPrivKey = randomKey()
  const ephemeralPubKey = ephemeralPrivKey.toPublicKey()

  const { stealthPublicKey } = payloadConstructor.constructStealthPublicKey(
    ephemeralPrivKey,
    destPubKey,
  )
  const { stealthPrivateKey } = payloadConstructor.constructStealthPrivateKey(
    ephemeralPubKey,
    destPrivKey,
  )

  expect(stealthPublicKey.toBuffer()).toStrictEqual(
    stealthPrivateKey.toPublicKey().toBuffer(),
  )
})
