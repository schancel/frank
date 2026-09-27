import assert from 'assert'
import axios, { Method } from 'axios'
import { Transaction } from 'bitcore-lib-xpi'

// Ticket #51 (Vite migration): generated `*_pb.js` files (google-protobuf codegen, e.g.
// `goog.object.extend(exports, proto.bip70)`) are genuinely CommonJS despite living in
// first-party `src/`. Vite's CJS interop only synthesizes a `default` export for these, not
// per-property named exports -- confirmed live, the original combined `import paymentrequest, {
// Payment, PaymentDetails } from ...` failed at runtime. `Payment`/`PaymentDetails` are only ever
// used as types below (real *values* go through `paymentrequest.Payment`/`.PaymentDetails`
// directly), so a plain `import type` -- always erased before this file reaches the CJS-interop
// plugin at all -- is both correct and the simplest fix.
import paymentrequest from './bip70/paymentrequest_pb'
import type { Payment, PaymentDetails } from './bip70/paymentrequest_pb'
import { Wallet } from './wallet'

export default {
  async getPaymentRequest(url: string, method: Method, data?: Uint8Array) {
    try {
      await axios({
        method,
        url,
        responseType: 'arraybuffer',
        data,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      const response = err.response
      if (response.status === 402) {
        const paymentRequest = paymentrequest.PaymentRequest.deserializeBinary(
          response.data,
        )
        const serializedPaymentDetails =
          paymentRequest.getSerializedPaymentDetails()
        assert(
          typeof serializedPaymentDetails !== 'string',
          'serializedPaymentDetails of wrong type?',
        )
        const paymentDetails = paymentrequest.PaymentDetails.deserializeBinary(
          serializedPaymentDetails,
        )
        return { paymentRequest, paymentDetails }
      }
    }
  },

  async sendPayment(paymentUrl: string, payment: Payment) {
    const rawPayment = payment.serializeBinary()
    const response = await axios({
      method: 'post',
      headers: {
        'Content-Type': 'application/bitcoincash-payment',
        'Accept': 'application/bitcoincash-paymentack',
      },
      url: paymentUrl,
      data: rawPayment,
    })

    const token = response.headers.authorization
    const paymentReceipt = response.data
    return { paymentReceipt, token }
  },

  async constructPaymentTransaction(
    wallet: Wallet,
    paymentDetails: PaymentDetails,
  ) {
    // Get Outputs
    const requestOutputs = paymentDetails.getOutputsList()
    const outputs = requestOutputs.map(reqOutput => {
      const script = Buffer.from(reqOutput.getScript())
      const satoshis = reqOutput.getAmount()
      const output = new Transaction.Output({
        script,
        satoshis,
      })
      return output
    })

    // Construct tx
    const { transaction, usedUtxos } = await wallet.constructTransaction({
      outputs,
    })
    const rawTransaction = transaction.toBuffer()

    // Send payment and receive token
    const payment = new paymentrequest.Payment()
    payment.addTransactions(rawTransaction)
    payment.setMerchantData(paymentDetails.getMerchantData())
    const paymentUrl = paymentDetails.getPaymentUrl()
    assert(
      typeof paymentUrl === 'string',
      'Payment url undefined when it should not be',
    )
    return { payment, paymentUrl, usedUtxos }
  },
}
