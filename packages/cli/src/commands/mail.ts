import axios from 'axios';
import { randomBytes } from 'crypto';
import { loadConfig, loadIdentity, resolveDataDir } from '../config';
import { outputError, outputResult } from '../util';

export interface MailSendOptions {
  subject?: string;
  conversation?: string;
  conversationId?: string;
  inReplyTo?: string;
  messageId?: string;
  frankMessageId?: string;
  gateway?: string;
  dataDir?: string;
  password?: string;
  json?: boolean;
}

export interface MailSendResult {
  ok: boolean;
  rfc822MessageId: string;
  recipientEmail: string;
  conversationId: string;
  inReplyToRfc822?: string;
  grantedReplyAllowance: number;
}

export async function mailSendCommand(
  recipientEmail: string,
  message: string,
  options: MailSendOptions
): Promise<void> {
  try {
    const trimmedEmail = recipientEmail.trim();
    if (!trimmedEmail.includes('@')) {
      throw new Error(`Invalid recipient email address: "${recipientEmail}"`);
    }
    const dataDir = resolveDataDir(options.dataDir);
    const config = loadConfig(dataDir);
    const gatewayUrl = (options.gateway ?? config.gatewayUrl)?.replace(/\/+$/, '');
    if (!gatewayUrl) {
      throw new Error(
        'Gateway URL must be specified via --gateway or in config.json ("gatewayUrl")'
      );
    }

    const { identity } = await loadIdentity(
      dataDir,
      undefined,
      options.password
    );

    const conversationId =
      options.conversationId ?? options.conversation ?? `conv_${randomBytes(16).toString('hex')}`;
    const frankMessageId =
      options.frankMessageId ?? options.messageId ?? `frank_msg_${randomBytes(16).toString('hex')}`;

    const response = await axios.post(`${gatewayUrl}/api/mail/send`, {
      senderFrankAddress: identity.displayAddress,
      recipientEmail: trimmedEmail,
      subject: options.subject,
      bodyText: message,
      conversationId,
      frankMessageId,
      inReplyToFrankMessageId: options.inReplyTo,
    });

    const data = response.data as {
      ok: boolean;
      rfc822MessageId: string;
      inReplyToRfc822?: string;
      grantedReplyAllowance: number;
    };

    const result: MailSendResult = {
      ok: data.ok,
      rfc822MessageId: data.rfc822MessageId,
      recipientEmail: trimmedEmail,
      conversationId,
      inReplyToRfc822: data.inReplyToRfc822,
      grantedReplyAllowance: data.grantedReplyAllowance,
    };

    outputResult(
      result,
      () => {
        console.log('Outbound email dispatched successfully via gateway:');
        console.log(`  Recipient:         ${result.recipientEmail}`);
        console.log(`  RFC822 Message-ID: ${result.rfc822MessageId}`);
        console.log(`  Conversation ID:   ${result.conversationId}`);
        if (result.inReplyToRfc822) {
          console.log(`  In-Reply-To:       ${result.inReplyToRfc822}`);
        }
        console.log(
          `  Reply Allowance:   ${result.grantedReplyAllowance} free replies granted`
        );
      },
      options.json
    );
  } catch (err: unknown) {
    outputError(err, options.json);
    process.exitCode = 1;
  }
}
