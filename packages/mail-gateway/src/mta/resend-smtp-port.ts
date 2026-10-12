import nodemailer from 'nodemailer';
import type { OutboundMailPort } from './journaled-outbound-worker';

/** Resend's authenticated SMTPS service sends the journal's original signed MIME. */
export function createResendSmtpPort(apiKey: string): OutboundMailPort {
  if (!apiKey) throw new Error('Resend SMTP API key is required');
  const transport = nodemailer.createTransport({
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    auth: { user: 'resend', pass: apiKey },
  });
  return {
    async submit(input) {
      const info = await transport.sendMail({
        envelope: { from: input.fromAddress, to: [input.recipientEmail] },
        raw: Buffer.from(input.signedRfc822),
      });
      const accepted = info.accepted
        .map(String)
        .some((address) => address.toLowerCase() === input.recipientEmail.toLowerCase());
      if (!accepted || info.rejected.length > 0) {
        // The provider reply may have been recorded after it accepted DATA;
        // leave the claimed job for reconciliation rather than resubmission.
        throw new Error('Resend SMTP did not confirm the sole recipient');
      }
    },
  };
}
