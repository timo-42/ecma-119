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
  extendedAttributeRecordLength?: number;
  dataLength: number;
  flags: number;
  identifier: Uint8Array;
  date: Date;
  volumeSequenceNumber?: number;
  systemUse?: Uint8Array;
};

export type DecodedDirectoryRecord = {
  length: number;
  extent: number;
  extendedAttributeRecordLength: number;
  dataLength: number;
  date: Date;
  flags: number;
  volumeSequenceNumber: number;
  identifier: Uint8Array;
  systemUse: Uint8Array;
};

export function directoryRecordLength(identifierLength: number, systemUseLength = 0): number {
  const base = 33 + identifierLength;
  return base + (base % 2 === 0 ? 0 : 1) + systemUseLength;
}

export function encodeDirectoryRecord(input: DirectoryRecordInput): Uint8Array {
  const systemUse = input.systemUse ?? new Uint8Array();
  const extendedAttributeRecordLength = input.extendedAttributeRecordLength ?? 0;
  if (!Number.isInteger(extendedAttributeRecordLength) || extendedAttributeRecordLength < 0 || extendedAttributeRecordLength > 0xff) {
    throw new RangeError("extended attribute record length must be an integer from 0 to 255 logical blocks");
  }
  const systemUseOffset = directoryRecordLength(input.identifier.length);
  const length = directoryRecordLength(input.identifier.length, systemUse.byteLength);
  if (length > 255) {
    throw new Error("directory record is too long");
  }

  const bytes = new Uint8Array(length);
  bytes[0] = length;
  bytes[1] = extendedAttributeRecordLength;
  writeUint32Both(bytes, 2, input.extent);
  writeUint32Both(bytes, 10, input.dataLength);
  bytes.set(encodeDirectoryDate(input.date), 18);
  bytes[25] = input.flags;
  bytes[26] = 0;
  bytes[27] = 0;
  writeUint16Both(bytes, 28, input.volumeSequenceNumber ?? 1);
  bytes[32] = input.identifier.length;
  bytes.set(input.identifier, 33);
  bytes.set(systemUse, systemUseOffset);
  return bytes;
}

export function decodeDirectoryRecord(bytes: Uint8Array, offset: number): DecodedDirectoryRecord {
  const length = bytes[offset]!;
  if (length === 0) {
    throw new Error(`missing directory record at offset ${offset}`);
  }
  const identifierLength = bytes[offset + 32]!;
  const systemUseOffset = offset + directoryRecordLength(identifierLength);
  return {
    length,
    extent: readUint32Both(bytes, offset + 2),
    extendedAttributeRecordLength: bytes[offset + 1]!,
    dataLength: readUint32Both(bytes, offset + 10),
    date: decodeDirectoryDate(bytes, offset + 18),
    flags: bytes[offset + 25]!,
    volumeSequenceNumber: readUint16Both(bytes, offset + 28),
    identifier: bytes.slice(offset + 33, offset + 33 + identifierLength),
    systemUse: bytes.slice(systemUseOffset, offset + length),
  };
}
