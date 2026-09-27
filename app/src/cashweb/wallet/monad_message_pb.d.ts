// package: cashweb.registry
// file: monad_message.proto

import * as jspb from "google-protobuf";

export class MonadStampedMessage extends jspb.Message {
  getRawBurnTx(): Uint8Array | string;
  getRawBurnTx_asU8(): Uint8Array;
  getRawBurnTx_asB64(): string;
  setRawBurnTx(value: Uint8Array | string): void;

  getEncryptedPayload(): Uint8Array | string;
  getEncryptedPayload_asU8(): Uint8Array;
  getEncryptedPayload_asB64(): string;
  setEncryptedPayload(value: Uint8Array | string): void;

  getPayloadHash(): Uint8Array | string;
  getPayloadHash_asU8(): Uint8Array;
  getPayloadHash_asB64(): string;
  setPayloadHash(value: Uint8Array | string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): MonadStampedMessage.AsObject;
  static toObject(includeInstance: boolean, msg: MonadStampedMessage): MonadStampedMessage.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: MonadStampedMessage, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): MonadStampedMessage;
  static deserializeBinaryFromReader(message: MonadStampedMessage, reader: jspb.BinaryReader): MonadStampedMessage;
}

export namespace MonadStampedMessage {
  export type AsObject = {
    rawBurnTx: Uint8Array | string,
    encryptedPayload: Uint8Array | string,
    payloadHash: Uint8Array | string,
  }
}

export class StoredMonadMessage extends jspb.Message {
  hasMessage(): boolean;
  clearMessage(): void;
  getMessage(): MonadStampedMessage | undefined;
  setMessage(value?: MonadStampedMessage): void;

  getSenderAddress(): Uint8Array | string;
  getSenderAddress_asU8(): Uint8Array;
  getSenderAddress_asB64(): string;
  setSenderAddress(value: Uint8Array | string): void;

  getTxHash(): Uint8Array | string;
  getTxHash_asU8(): Uint8Array;
  getTxHash_asB64(): string;
  setTxHash(value: Uint8Array | string): void;

  getTimestamp(): number;
  setTimestamp(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): StoredMonadMessage.AsObject;
  static toObject(includeInstance: boolean, msg: StoredMonadMessage): StoredMonadMessage.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: StoredMonadMessage, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): StoredMonadMessage;
  static deserializeBinaryFromReader(message: StoredMonadMessage, reader: jspb.BinaryReader): StoredMonadMessage;
}

export namespace StoredMonadMessage {
  export type AsObject = {
    message?: MonadStampedMessage.AsObject,
    senderAddress: Uint8Array | string,
    txHash: Uint8Array | string,
    timestamp: number,
  }
}

export class StoredMonadMessages extends jspb.Message {
  clearMessagesList(): void;
  getMessagesList(): Array<StoredMonadMessage>;
  setMessagesList(value: Array<StoredMonadMessage>): void;
  addMessages(value?: StoredMonadMessage, index?: number): StoredMonadMessage;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): StoredMonadMessages.AsObject;
  static toObject(includeInstance: boolean, msg: StoredMonadMessages): StoredMonadMessages.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: StoredMonadMessages, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): StoredMonadMessages;
  static deserializeBinaryFromReader(message: StoredMonadMessages, reader: jspb.BinaryReader): StoredMonadMessages;
}

export namespace StoredMonadMessages {
  export type AsObject = {
    messagesList: Array<StoredMonadMessage.AsObject>,
  }
}

