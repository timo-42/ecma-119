import {
  decodeDirectoryDate,
  encodeDirectoryDate,
  readUint16Both,
  readUint32Both,
  writeUint16Both,
  writeUint32Both,
} from "./binary.js";

export const FILE_FLAG_DIRECTORY = 0x02;
export const FILE_FLAG_HIDDEN = 0x01;
export const FILE_FLAG_ASSOCIATED = 0x04;
export const FILE_FLAG_MULTI_EXTENT = 0x80;

export type DirectoryRecordInput = {
  extent: number;
  extendedAttributeRecordLength?: number;
  dataLength: number;
  flags: number;
  fileUnitSize?: number;
  interleaveGapSize?: number;
  identifier: Uint8Array;
  date: Date;
  timeZoneOffsetMinutes?: number;
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
  fileUnitSize: number;
  interleaveGapSize: number;
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
  checkedIdentifierLength(input.identifier.length, "directory record identifier");
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
  bytes.set(encodeDirectoryDate(input.date, input.timeZoneOffsetMinutes ?? 0), 18);
  bytes[25] = checkedFileFlags(input.flags);
  bytes[26] = checkedByte(input.fileUnitSize ?? 0, "file unit size");
  bytes[27] = checkedByte(input.interleaveGapSize ?? 0, "interleave gap size");
  writeUint16Both(bytes, 28, input.volumeSequenceNumber ?? 1);
  bytes[32] = input.identifier.length;
  bytes.set(input.identifier, 33);
  bytes.set(systemUse, systemUseOffset);
  return bytes;
}

export function decodeDirectoryRecord(bytes: Uint8Array, offset: number, spanEnd = bytes.byteLength): DecodedDirectoryRecord {
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.byteLength || offset >= spanEnd) {
    throw new Error(`directory record offset ${offset} is out of bounds`);
  }
  const length = bytes[offset]!;
  if (length === 0) {
    throw new Error(`missing directory record at offset ${offset}`);
  }
  if (length < 34 || offset + length > spanEnd || offset + length > bytes.byteLength) {
    throw new Error(`directory record has invalid length at offset ${offset}`);
  }
  const identifierLength = bytes[offset + 32]!;
  const minimumLength = directoryRecordLength(identifierLength);
  if (identifierLength === 0 || minimumLength > length) {
    throw new Error(`directory record identifier length is inconsistent with record length at offset ${offset}`);
  }
  const paddingOffset = offset + 33 + identifierLength;
  if (identifierLength % 2 === 0 && bytes[paddingOffset] !== 0) {
    throw new Error(`directory record file identifier padding byte must be zero at offset ${offset}`);
  }
  const systemUseOffset = offset + directoryRecordLength(identifierLength);
  return {
    length,
    extent: readUint32Both(bytes, offset + 2),
    extendedAttributeRecordLength: bytes[offset + 1]!,
    dataLength: readUint32Both(bytes, offset + 10),
    date: decodeDirectoryDate(bytes, offset + 18),
    flags: bytes[offset + 25]!,
    fileUnitSize: bytes[offset + 26]!,
    interleaveGapSize: bytes[offset + 27]!,
    volumeSequenceNumber: readUint16Both(bytes, offset + 28),
    identifier: bytes.slice(offset + 33, offset + 33 + identifierLength),
    systemUse: bytes.slice(systemUseOffset, offset + length),
  };
}

function checkedByte(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be an integer from 0 to 255`);
  }
  return value;
}

function checkedIdentifierLength(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xff) {
    throw new RangeError(`${name} length must be an integer from 1 to 255 bytes`);
  }
  return value;
}

function checkedFileFlags(value: number): number {
  const flags = checkedByte(value, "file flags");
  if ((flags & 0x60) !== 0) {
    throw new Error("directory record file flags bits 5 and 6 are reserved");
  }
  if ((flags & FILE_FLAG_MULTI_EXTENT) !== 0) {
    throw new Error("directory record multi-extent file sections are not supported by the encoder");
  }
  return flags;
}
