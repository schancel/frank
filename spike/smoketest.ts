import { PayloadConstructor } from '../app/src/cashweb/relay/crypto'
import { PrivateKey } from 'bitcore-lib-xpi'

const pc = new PayloadConstructor({ networkName: 'livenet' })

const alice = new PrivateKey()
const bob = new PrivateKey()

const salt = Buffer.from('spike-demo-salt')

const sharedA = pc.constructSharedKey(alice, bob.toPublicKey(), salt)
const sharedB = pc.constructSharedKey(bob, alice.toPublicKey(), salt)

console.log('shared keys match:', sharedA.equals(sharedB))

const plaintext = Buffer.from('hello from the real cashweb crypto.ts')
const ciphertext = pc.encrypt(sharedA, plaintext)
const decrypted = pc.decrypt(sharedB, ciphertext)

console.log('roundtrip match:', Buffer.from(decrypted).equals(plaintext))
console.log('decrypted:', Buffer.from(decrypted).toString('utf8'))
