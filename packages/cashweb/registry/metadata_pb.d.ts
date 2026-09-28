// package: keyserver
// file: metadata.proto

import * as jspb from "google-protobuf";

export class Header extends jspb.Message {
  getName(): string;
  setName(value: string): void;

  getValue(): string;
  setValue(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Header.AsObject;
  static toObject(includeInstance: boolean, msg: Header): Header.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Header, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Header;
  static deserializeBinaryFromReader(message: Header, reader: jspb.BinaryReader): Header;
}

export namespace Header {
  export type AsObject = {
    name: string,
    value: string,
  }
}

export class Entry extends jspb.Message {
  getKind(): string;
  setKind(value: string): void;

  clearHeadersList(): void;
  getHeadersList(): Array<Header>;
  setHeadersList(value: Array<Header>): void;
  addHeaders(value?: Header, index?: number): Header;

  getBody(): Uint8Array | string;
  getBody_asU8(): Uint8Array;
  getBody_asB64(): string;
  setBody(value: Uint8Array | string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Entry.AsObject;
  static toObject(includeInstance: boolean, msg: Entry): Entry.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Entry, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Entry;
  static deserializeBinaryFromReader(message: Entry, reader: jspb.BinaryReader): Entry;
}

export namespace Entry {
  export type AsObject = {
    kind: string,
    headersList: Array<Header.AsObject>,
    body: Uint8Array | string,
  }
}

export class AddressMetadata extends jspb.Message {
  getTimestamp(): number;
  setTimestamp(value: number): void;

  getTtl(): number;
  setTtl(value: number): void;

  clearEntriesList(): void;
  getEntriesList(): Array<Entry>;
  setEntriesList(value: Array<Entry>): void;
  addEntries(value?: Entry, index?: number): Entry;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): AddressMetadata.AsObject;
  static toObject(includeInstance: boolean, msg: AddressMetadata): AddressMetadata.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: AddressMetadata, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): AddressMetadata;
  static deserializeBinaryFromReader(message: AddressMetadata, reader: jspb.BinaryReader): AddressMetadata;
}

export namespace AddressMetadata {
  export type AsObject = {
    timestamp: number,
    ttl: number,
    entriesList: Array<Entry.AsObject>,
  }
}

export class Peer extends jspb.Message {
  getUrl(): string;
  setUrl(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Peer.AsObject;
  static toObject(includeInstance: boolean, msg: Peer): Peer.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Peer, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Peer;
  static deserializeBinaryFromReader(message: Peer, reader: jspb.BinaryReader): Peer;
}

export namespace Peer {
  export type AsObject = {
    url: string,
  }
}

export class Peers extends jspb.Message {
  clearPeersList(): void;
  getPeersList(): Array<Peer>;
  setPeersList(value: Array<Peer>): void;
  addPeers(value?: Peer, index?: number): Peer;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Peers.AsObject;
  static toObject(includeInstance: boolean, msg: Peers): Peers.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Peers, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Peers;
  static deserializeBinaryFromReader(message: Peers, reader: jspb.BinaryReader): Peers;
}

export namespace Peers {
  export type AsObject = {
    peersList: Array<Peer.AsObject>,
  }
}

export class ListMonadProfilesEntry extends jspb.Message {
  getAddress(): string;
  setAddress(value: string): void;

  getSignedPayload(): Uint8Array | string;
  getSignedPayload_asU8(): Uint8Array;
  getSignedPayload_asB64(): string;
  setSignedPayload(value: Uint8Array | string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ListMonadProfilesEntry.AsObject;
  static toObject(includeInstance: boolean, msg: ListMonadProfilesEntry): ListMonadProfilesEntry.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ListMonadProfilesEntry, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ListMonadProfilesEntry;
  static deserializeBinaryFromReader(message: ListMonadProfilesEntry, reader: jspb.BinaryReader): ListMonadProfilesEntry;
}

export namespace ListMonadProfilesEntry {
  export type AsObject = {
    address: string,
    signedPayload: Uint8Array | string,
  }
}

export class ListMonadProfilesResponse extends jspb.Message {
  clearEntriesList(): void;
  getEntriesList(): Array<ListMonadProfilesEntry>;
  setEntriesList(value: Array<ListMonadProfilesEntry>): void;
  addEntries(value?: ListMonadProfilesEntry, index?: number): ListMonadProfilesEntry;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ListMonadProfilesResponse.AsObject;
  static toObject(includeInstance: boolean, msg: ListMonadProfilesResponse): ListMonadProfilesResponse.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ListMonadProfilesResponse, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ListMonadProfilesResponse;
  static deserializeBinaryFromReader(message: ListMonadProfilesResponse, reader: jspb.BinaryReader): ListMonadProfilesResponse;
}

export namespace ListMonadProfilesResponse {
  export type AsObject = {
    entriesList: Array<ListMonadProfilesEntry.AsObject>,
  }
}

