// package: cashweb.registry
// file: forum_message.proto

import * as jspb from "google-protobuf";

export class MonadForumPost extends jspb.Message {
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
  toObject(includeInstance?: boolean): MonadForumPost.AsObject;
  static toObject(includeInstance: boolean, msg: MonadForumPost): MonadForumPost.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: MonadForumPost, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): MonadForumPost;
  static deserializeBinaryFromReader(message: MonadForumPost, reader: jspb.BinaryReader): MonadForumPost;
}

export namespace MonadForumPost {
  export type AsObject = {
    topic: string,
    parentPostHash: Uint8Array | string,
    rawBurnTx: Uint8Array | string,
    encryptedPayload: Uint8Array | string,
    payloadHash: Uint8Array | string,
  }
}

export class MonadForumVote extends jspb.Message {
  getTargetPayloadHash(): Uint8Array | string;
  getTargetPayloadHash_asU8(): Uint8Array;
  getTargetPayloadHash_asB64(): string;
  setTargetPayloadHash(value: Uint8Array | string): void;

  getRawBurnTx(): Uint8Array | string;
  getRawBurnTx_asU8(): Uint8Array;
  getRawBurnTx_asB64(): string;
  setRawBurnTx(value: Uint8Array | string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): MonadForumVote.AsObject;
  static toObject(includeInstance: boolean, msg: MonadForumVote): MonadForumVote.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: MonadForumVote, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): MonadForumVote;
  static deserializeBinaryFromReader(message: MonadForumVote, reader: jspb.BinaryReader): MonadForumVote;
}

export namespace MonadForumVote {
  export type AsObject = {
    targetPayloadHash: Uint8Array | string,
    rawBurnTx: Uint8Array | string,
  }
}

export class StoredMonadForumPost extends jspb.Message {
  hasPost(): boolean;
  clearPost(): void;
  getPost(): MonadForumPost | undefined;
  setPost(value?: MonadForumPost): void;

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
  toObject(includeInstance?: boolean): StoredMonadForumPost.AsObject;
  static toObject(includeInstance: boolean, msg: StoredMonadForumPost): StoredMonadForumPost.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: StoredMonadForumPost, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): StoredMonadForumPost;
  static deserializeBinaryFromReader(message: StoredMonadForumPost, reader: jspb.BinaryReader): StoredMonadForumPost;
}

export namespace StoredMonadForumPost {
  export type AsObject = {
    post?: MonadForumPost.AsObject,
    senderAddress: Uint8Array | string,
    txHash: Uint8Array | string,
    timestamp: number,
    networkTag: Uint8Array | string,
  }
}

export class StoredMonadForumVoteEntry extends jspb.Message {
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
  toObject(includeInstance?: boolean): StoredMonadForumVoteEntry.AsObject;
  static toObject(includeInstance: boolean, msg: StoredMonadForumVoteEntry): StoredMonadForumVoteEntry.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: StoredMonadForumVoteEntry, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): StoredMonadForumVoteEntry;
  static deserializeBinaryFromReader(message: StoredMonadForumVoteEntry, reader: jspb.BinaryReader): StoredMonadForumVoteEntry;
}

export namespace StoredMonadForumVoteEntry {
  export type AsObject = {
    targetPayloadHash: Uint8Array | string,
    senderAddress: Uint8Array | string,
    txHash: Uint8Array | string,
    timestamp: number,
    weight: number,
  }
}

export class MonadForumPostView extends jspb.Message {
  hasPost(): boolean;
  clearPost(): void;
  getPost(): StoredMonadForumPost | undefined;
  setPost(value?: StoredMonadForumPost): void;

  getVoteWeight(): number;
  setVoteWeight(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): MonadForumPostView.AsObject;
  static toObject(includeInstance: boolean, msg: MonadForumPostView): MonadForumPostView.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: MonadForumPostView, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): MonadForumPostView;
  static deserializeBinaryFromReader(message: MonadForumPostView, reader: jspb.BinaryReader): MonadForumPostView;
}

export namespace MonadForumPostView {
  export type AsObject = {
    post?: StoredMonadForumPost.AsObject,
    voteWeight: number,
  }
}

