// package: cashweb.registry
// file: monad_message.proto

import * as jspb from "google-protobuf";

export class MonadStampPayment extends jspb.Message {
  getChildIndex(): number;
  setChildIndex(value: number): void;

  getRawTx(): Uint8Array | string;
  getRawTx_asU8(): Uint8Array;
  getRawTx_asB64(): string;
  setRawTx(value: Uint8Array | string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): MonadStampPayment.AsObject;
  static toObject(includeInstance: boolean, msg: MonadStampPayment): MonadStampPayment.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: MonadStampPayment, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): MonadStampPayment;
  static deserializeBinaryFromReader(message: MonadStampPayment, reader: jspb.BinaryReader): MonadStampPayment;
}

export namespace MonadStampPayment {
  export type AsObject = {
    childIndex: number,
    rawTx: Uint8Array | string,
  }
}

export class MonadStampedMessage extends jspb.Message {
  getEncryptedPayload(): Uint8Array | string;
  getEncryptedPayload_asU8(): Uint8Array;
  getEncryptedPayload_asB64(): string;
  setEncryptedPayload(value: Uint8Array | string): void;

  getPayloadHash(): Uint8Array | string;
  getPayloadHash_asU8(): Uint8Array;
  getPayloadHash_asB64(): string;
  setPayloadHash(value: Uint8Array | string): void;

  clearStampPaymentsList(): void;
  getStampPaymentsList(): Array<MonadStampPayment>;
  setStampPaymentsList(value: Array<MonadStampPayment>): void;
  addStampPayments(value?: MonadStampPayment, index?: number): MonadStampPayment;

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
    encryptedPayload: Uint8Array | string,
    payloadHash: Uint8Array | string,
    stampPaymentsList: Array<MonadStampPayment.AsObject>,
  }
}

export class StoredMonadMessage extends jspb.Message {
  hasMessage(): boolean;
  clearMessage(): void;
  getMessage(): MonadStampedMessage | undefined;
  setMessage(value?: MonadStampedMessage): void;

  getTimestamp(): number;
  setTimestamp(value: number): void;

  getNetworkTag(): Uint8Array | string;
  getNetworkTag_asU8(): Uint8Array;
  getNetworkTag_asB64(): string;
  setNetworkTag(value: Uint8Array | string): void;

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
    timestamp: number,
    networkTag: Uint8Array | string,
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

