import { readUint16BE, readUint16LE, readUint32BE, readUint32LE, writeUint16BE, writeUint16LE, writeUint32BE, writeUint32LE } from "./binary.js";

export type PathTableEndian = "little" | "big";

export type PathTableRecord = {
  identifier: Uint8Array;
  extent: number;
  parentDirectoryNumber: number;
  extendedAttributeRecordLength?: number;
};

export function pathTableRecordLength(identifierLength: number): number {
  const base = 8 + identifierLength;
  return base + (identifierLength % 2 === 0 ? 0 : 1);
}

export function encodePathTable(records: PathTableRecord[], endian: PathTableEndian): Uint8Array {
  const size = records.reduce((sum, record) => sum + pathTableRecordLength(checkedIdentifierLength(record.identifier.length)), 0);
  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const record of records) {
    const identifierLength = checkedIdentifierLength(record.identifier.length);
    const length = pathTableRecordLength(identifierLength);
    const extendedAttributeRecordLength = record.extendedAttributeRecordLength ?? 0;
    if (!Number.isInteger(extendedAttributeRecordLength) || extendedAttributeRecordLength < 0 || extendedAttributeRecordLength > 0xff) {
      throw new RangeError("extended attribute record length must be an integer from 0 to 255 logical blocks");
    }
    const parentDirectoryNumber = checkedParentDirectoryNumber(record.parentDirectoryNumber);
    bytes[offset] = identifierLength;
    bytes[offset + 1] = extendedAttributeRecordLength;
    if (endian === "little") {
      writeUint32LE(bytes, offset + 2, record.extent);
      writeUint16LE(bytes, offset + 6, parentDirectoryNumber);
    } else {
      writeUint32BE(bytes, offset + 2, record.extent);
      writeUint16BE(bytes, offset + 6, parentDirectoryNumber);
    }
    bytes.set(record.identifier, offset + 8);
    offset += length;
  }

  return bytes;
}

function checkedIdentifierLength(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xff) {
    throw new RangeError("path table identifier length must be an integer from 1 to 255 bytes");
  }
  return value;
}

function checkedParentDirectoryNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff) {
    throw new RangeError("path table parent directory number must be an integer from 1 to 65535");
  }
  return value;
}

export function decodePathTable(bytes: Uint8Array, endian: PathTableEndian): PathTableRecord[] {
  const records: PathTableRecord[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const identifierLength = bytes[offset]!;
    if (identifierLength === 0) {
      throw new Error(`path table record at offset ${offset} has invalid zero identifier length`);
    }
    const recordLength = pathTableRecordLength(identifierLength);
    if (offset + recordLength > bytes.length) {
      throw new Error(`path table record at offset ${offset} has invalid length`);
    }
    if (identifierLength % 2 === 1 && bytes[offset + 8 + identifierLength] !== 0) {
      throw new Error(`path table record at offset ${offset} has nonzero padding byte`);
    }
    const extent = endian === "little" ? readUint32LE(bytes, offset + 2) : readUint32BE(bytes, offset + 2);
    const parentDirectoryNumber = endian === "little" ? readUint16LE(bytes, offset + 6) : readUint16BE(bytes, offset + 6);
    records.push({
      identifier: bytes.slice(offset + 8, offset + 8 + identifierLength),
      extent,
      parentDirectoryNumber,
      extendedAttributeRecordLength: bytes[offset + 1]!,
    });
    offset += recordLength;
  }

  return records;
}
