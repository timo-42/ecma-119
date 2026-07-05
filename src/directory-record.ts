import {
  decodeDirectoryDate,
  encodeDirectoryDate,
  readUint16Both,
  readUint32Both,
  writeUint16Both,
  writeUint32Both,
} from "./binary.js";

export const FILE_FLAG_DIRECTORY = 0x02;

export type DirectoryRecordInput = {
  extent: number;
  dataLength: number;
  flags: number;
  identifier: Uint8Array;
  date: Date;
  volumeSequenceNumber?: number;
};

export type DecodedDirectoryRecord = {
  length: number;
  extent: number;
  dataLength: number;
  date: Date;
  flags: number;
  volumeSequenceNumber: number;
  identifier: Uint8Array;
};

export function directoryRecordLength(identifierLength: number): number {
  const base = 33 + identifierLength;
  return base + (base % 2 === 0 ? 0 : 1);
}

export function encodeDirectoryRecord(input: DirectoryRecordInput): Uint8Array {
  const length = directoryRecordLength(input.identifier.length);
  if (length > 255) {
    throw new Error("directory record is too long");
  }

  const bytes = new Uint8Array(length);
  bytes[0] = length;
  bytes[1] = 0;
  writeUint32Both(bytes, 2, input.extent);
  writeUint32Both(bytes, 10, input.dataLength);
  bytes.set(encodeDirectoryDate(input.date), 18);
  bytes[25] = input.flags;
  bytes[26] = 0;
  bytes[27] = 0;
  writeUint16Both(bytes, 28, input.volumeSequenceNumber ?? 1);
  bytes[32] = input.identifier.length;
  bytes.set(input.identifier, 33);
  return bytes;
}

export function decodeDirectoryRecord(bytes: Uint8Array, offset: number): DecodedDirectoryRecord {
  const length = bytes[offset]!;
  if (length === 0) {
    throw new Error(`missing directory record at offset ${offset}`);
  }
  const identifierLength = bytes[offset + 32]!;
  return {
    length,
    extent: readUint32Both(bytes, offset + 2),
    dataLength: readUint32Both(bytes, offset + 10),
    date: decodeDirectoryDate(bytes, offset + 18),
    flags: bytes[offset + 25]!,
    volumeSequenceNumber: readUint16Both(bytes, offset + 28),
    identifier: bytes.slice(offset + 33, offset + 33 + identifierLength),
  };
}
