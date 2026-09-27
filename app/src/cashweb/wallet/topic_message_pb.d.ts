// package: cashweb.registry
// file: topic_message.proto

import * as jspb from "google-protobuf";

export class MonadTopicPost extends jspb.Message {
  getTopic(): string;
  setTopic(value: string): void;

  getParentPostHash(): Uint8Array | string;
  getParentPostHash_asU8(): Uint8Array;
  getParentPostHash_asB64(): string;
  setParentPostHash(value: Uint8Array | string): void;

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
  toObject(includeInstance?: boolean): MonadTopicPost.AsObject;
  static toObject(includeInstance: boolean, msg: MonadTopicPost): MonadTopicPost.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: MonadTopicPost, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): MonadTopicPost;
  static deserializeBinaryFromReader(message: MonadTopicPost, reader: jspb.BinaryReader): MonadTopicPost;
}

export namespace MonadTopicPost {
  export type AsObject = {
    topic: string,
    parentPostHash: Uint8Array | string,
    rawBurnTx: Uint8Array | string,
    encryptedPayload: Uint8Array | string,
    payloadHash: Uint8Array | string,
  }
}

export class MonadTopicVote extends jspb.Message {
  getTargetPayloadHash(): Uint8Array | string;
  getTargetPayloadHash_asU8(): Uint8Array;
  getTargetPayloadHash_asB64(): string;
  setTargetPayloadHash(value: Uint8Array | string): void;

  getRawBurnTx(): Uint8Array | string;
  getRawBurnTx_asU8(): Uint8Array;
  getRawBurnTx_asB64(): string;
  setRawBurnTx(value: Uint8Array | string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): MonadTopicVote.AsObject;
  static toObject(includeInstance: boolean, msg: MonadTopicVote): MonadTopicVote.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: MonadTopicVote, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): MonadTopicVote;
  static deserializeBinaryFromReader(message: MonadTopicVote, reader: jspb.BinaryReader): MonadTopicVote;
}

export namespace MonadTopicVote {
  export type AsObject = {
    targetPayloadHash: Uint8Array | string,
    rawBurnTx: Uint8Array | string,
  }
}

export class StoredMonadTopicPost extends jspb.Message {
  hasPost(): boolean;
  clearPost(): void;
  getPost(): MonadTopicPost | undefined;
  setPost(value?: MonadTopicPost): void;

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

  getNetworkTag(): Uint8Array | string;
  getNetworkTag_asU8(): Uint8Array;
  getNetworkTag_asB64(): string;
  setNetworkTag(value: Uint8Array | string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): StoredMonadTopicPost.AsObject;
  static toObject(includeInstance: boolean, msg: StoredMonadTopicPost): StoredMonadTopicPost.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: StoredMonadTopicPost, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): StoredMonadTopicPost;
  static deserializeBinaryFromReader(message: StoredMonadTopicPost, reader: jspb.BinaryReader): StoredMonadTopicPost;
}

export namespace StoredMonadTopicPost {
  export type AsObject = {
    post?: MonadTopicPost.AsObject,
    senderAddress: Uint8Array | string,
    txHash: Uint8Array | string,
    timestamp: number,
    networkTag: Uint8Array | string,
  }
}

export class StoredMonadTopicVoteEntry extends jspb.Message {
  getTargetPayloadHash(): Uint8Array | string;
  getTargetPayloadHash_asU8(): Uint8Array;
  getTargetPayloadHash_asB64(): string;
  setTargetPayloadHash(value: Uint8Array | string): void;

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

  getWeight(): number;
  setWeight(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): StoredMonadTopicVoteEntry.AsObject;
  static toObject(includeInstance: boolean, msg: StoredMonadTopicVoteEntry): StoredMonadTopicVoteEntry.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: StoredMonadTopicVoteEntry, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): StoredMonadTopicVoteEntry;
  static deserializeBinaryFromReader(message: StoredMonadTopicVoteEntry, reader: jspb.BinaryReader): StoredMonadTopicVoteEntry;
}

export namespace StoredMonadTopicVoteEntry {
  export type AsObject = {
    targetPayloadHash: Uint8Array | string,
    senderAddress: Uint8Array | string,
    txHash: Uint8Array | string,
    timestamp: number,
    weight: number,
  }
}

export class MonadTopicPostView extends jspb.Message {
  hasPost(): boolean;
  clearPost(): void;
  getPost(): StoredMonadTopicPost | undefined;
  setPost(value?: StoredMonadTopicPost): void;

  getVoteWeight(): number;
  setVoteWeight(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): MonadTopicPostView.AsObject;
  static toObject(includeInstance: boolean, msg: MonadTopicPostView): MonadTopicPostView.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: MonadTopicPostView, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): MonadTopicPostView;
  static deserializeBinaryFromReader(message: MonadTopicPostView, reader: jspb.BinaryReader): MonadTopicPostView;
}

export namespace MonadTopicPostView {
  export type AsObject = {
    post?: StoredMonadTopicPost.AsObject,
    voteWeight: number,
  }
}

