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

  getCborPostFrame(): Uint8Array | string;
  getCborPostFrame_asU8(): Uint8Array;
  getCborPostFrame_asB64(): string;
  setCborPostFrame(value: Uint8Array | string): void;

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
    cborPostFrame: Uint8Array | string,
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

export class MonadTopicPostViews extends jspb.Message {
  clearViewsList(): void;
  getViewsList(): Array<MonadTopicPostView>;
  setViewsList(value: Array<MonadTopicPostView>): void;
  addViews(value?: MonadTopicPostView, index?: number): MonadTopicPostView;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): MonadTopicPostViews.AsObject;
  static toObject(includeInstance: boolean, msg: MonadTopicPostViews): MonadTopicPostViews.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: MonadTopicPostViews, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): MonadTopicPostViews;
  static deserializeBinaryFromReader(message: MonadTopicPostViews, reader: jspb.BinaryReader): MonadTopicPostViews;
}

export namespace MonadTopicPostViews {
  export type AsObject = {
    viewsList: Array<MonadTopicPostView.AsObject>,
  }
}

export class TopicDiscoveryStats extends jspb.Message {
  getPostCount(): number;
  setPostCount(value: number): void;

  getLastActivityMs(): number;
  setLastActivityMs(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): TopicDiscoveryStats.AsObject;
  static toObject(includeInstance: boolean, msg: TopicDiscoveryStats): TopicDiscoveryStats.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: TopicDiscoveryStats, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): TopicDiscoveryStats;
  static deserializeBinaryFromReader(message: TopicDiscoveryStats, reader: jspb.BinaryReader): TopicDiscoveryStats;
}

export namespace TopicDiscoveryStats {
  export type AsObject = {
    postCount: number,
    lastActivityMs: number,
  }
}

export class TopicDiscoveryEntry extends jspb.Message {
  getTopic(): string;
  setTopic(value: string): void;

  getPostCount(): number;
  setPostCount(value: number): void;

  getLastActivityMs(): number;
  setLastActivityMs(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): TopicDiscoveryEntry.AsObject;
  static toObject(includeInstance: boolean, msg: TopicDiscoveryEntry): TopicDiscoveryEntry.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: TopicDiscoveryEntry, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): TopicDiscoveryEntry;
  static deserializeBinaryFromReader(message: TopicDiscoveryEntry, reader: jspb.BinaryReader): TopicDiscoveryEntry;
}

export namespace TopicDiscoveryEntry {
  export type AsObject = {
    topic: string,
    postCount: number,
    lastActivityMs: number,
  }
}

export class ListTopicsResponse extends jspb.Message {
  clearEntriesList(): void;
  getEntriesList(): Array<TopicDiscoveryEntry>;
  setEntriesList(value: Array<TopicDiscoveryEntry>): void;
  addEntries(value?: TopicDiscoveryEntry, index?: number): TopicDiscoveryEntry;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ListTopicsResponse.AsObject;
  static toObject(includeInstance: boolean, msg: ListTopicsResponse): ListTopicsResponse.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ListTopicsResponse, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ListTopicsResponse;
  static deserializeBinaryFromReader(message: ListTopicsResponse, reader: jspb.BinaryReader): ListTopicsResponse;
}

export namespace ListTopicsResponse {
  export type AsObject = {
    entriesList: Array<TopicDiscoveryEntry.AsObject>,
  }
}

