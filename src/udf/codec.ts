import { assertUintRange, readUint16LE, readUint32LE, writeUint16LE, writeUint32LE } from "../binary.js";
import {
  UDF_DESCRIPTOR_TAG_SIZE,
  UDF_DESCRIPTOR_VERSION,
  crc16Ccitt,
  encodeUdfDescriptorTag,
} from "../udf-tag.js";

/** Size of an ECMA-167 entity identifier (regid). */
export const UDF_ENTITY_IDENTIFIER_SIZE = 32;
/** Size of an ECMA-167 timestamp. */
export const UDF_TIMESTAMP_SIZE = 12;
/** Size of an ECMA-167 extent_ad. */
export const UDF_EXTENT_AD_SIZE = 8;
/** Size of an ECMA-167 short_ad. */
export const UDF_SHORT_AD_SIZE = 8;
/** Size of an ECMA-167 long_ad. */
export const UDF_LONG_AD_SIZE = 16;

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const EXTENT_LENGTH_MASK = 0x3fff_ffff;
const EXTENT_TYPE_MASK = 0xc000_0000;

export type OstaCompressedUnicodeMode = 8 | 16;

/** The on-disk ECMA-167 entity identifier, also called a regid. */
export type UdfEntityIdentifier = {
  flags: number;
  identifier: string;
  identifierSuffix: Uint8Array;
};

/** The fields of an ECMA-167 extent_ad. */
export type UdfExtentAd = {
  length: number;
  location: number;
};

/** The fields of an ECMA-167 short_ad. */
export type UdfShortAd = {
  length: number;
  location: number;
  type?: number;
};

/** The fields of an ECMA-167 long_ad. */
export type UdfLongAd = {
  length: number;
  location: number;
  partitionReferenceNumber: number;
  implementationUse: Uint8Array;
  type?: number;
};

/** Arguments used to create a descriptor tag after its body has been written. */
export type FinalizeUdfDescriptorOptions = {
  tagIdentifier: number;
  tagLocation: number;
  tagSerialNumber?: number;
  descriptorVersion?: number;
  descriptorCRCLength?: number;
};

/**
 * Encodes a Unicode string with OSTA CS0 compression.  With no mode supplied,
 * the shortest supported form is selected.  CS0 supports BMP scalar values only.
 */
export function encodeOstaCompressedUnicode(value: string, mode?: OstaCompressedUnicodeMode): Uint8Array {
  const codeUnits = unicodeCodeUnits(value);
  const selectedMode = mode ?? (codeUnits.every((codeUnit) => codeUnit <= 0xff) ? 8 : 16);
  if (selectedMode === 8 && codeUnits.some((codeUnit) => codeUnit > 0xff)) {
    throw new RangeError("8-bit OSTA compressed Unicode cannot encode code points above U+00FF");
  }

  const bytes = new Uint8Array(1 + codeUnits.length * (selectedMode === 8 ? 1 : 2));
  bytes[0] = selectedMode;
  for (let index = 0; index < codeUnits.length; index += 1) {
    const offset = 1 + index * (selectedMode === 8 ? 1 : 2);
    const codeUnit = codeUnits[index]!;
    if (selectedMode === 8) {
      bytes[offset] = codeUnit;
    } else {
      bytes[offset] = codeUnit >>> 8;
      bytes[offset + 1] = codeUnit & 0xff;
    }
  }
  return bytes;
}

/** Decodes OSTA CS0 compressed Unicode in either supported compression form. */
export function decodeOstaCompressedUnicode(bytes: Uint8Array, offset = 0, length = bytes.byteLength - offset): string {
  ensureLength(bytes, offset, length, "OSTA compressed Unicode");
  if (length < 1) {
    throw new RangeError("OSTA compressed Unicode must include a compression identifier");
  }

  const mode = bytes[offset]!;
  const payloadLength = length - 1;
  if (mode !== 8 && mode !== 16) {
    throw new Error(`unsupported OSTA compressed Unicode compression identifier ${mode}`);
  }
  if (mode === 16 && payloadLength % 2 !== 0) {
    throw new Error("16-bit OSTA compressed Unicode payload has an odd length");
  }

  let result = "";
  if (mode === 8) {
    for (let index = offset + 1; index < offset + length; index += 1) {
      result += String.fromCharCode(bytes[index]!);
    }
  } else {
    for (let index = offset + 1; index < offset + length; index += 2) {
      const codeUnit = (bytes[index]! << 8) | bytes[index + 1]!;
      if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
        throw new Error("16-bit OSTA compressed Unicode contains a UTF-16 surrogate");
      }
      result += String.fromCharCode(codeUnit);
    }
  }
  return result;
}

/** Encodes a fixed-size ECMA-167 dstring, including its trailing length byte. */
export function encodeDstring(value: string, length: number, mode?: OstaCompressedUnicodeMode): Uint8Array {
  assertDstringLength(length);
  const compressed = encodeOstaCompressedUnicode(value, mode);
  if (compressed.byteLength > length - 1) {
    throw new RangeError(`OSTA compressed Unicode value needs ${compressed.byteLength} bytes, but dstring has room for ${length - 1}`);
  }
  const bytes = new Uint8Array(length);
  bytes.set(compressed);
  bytes[length - 1] = compressed.byteLength;
  return bytes;
}

/** Decodes a fixed-size ECMA-167 dstring. */
export function decodeDstring(bytes: Uint8Array, offset = 0, length = bytes.byteLength - offset): string {
  assertDstringLength(length);
  ensureLength(bytes, offset, length, "dstring");
  const encodedLength = bytes[offset + length - 1]!;
  if (encodedLength > length - 1) {
    throw new Error(`dstring length byte ${encodedLength} exceeds field capacity ${length - 1}`);
  }
  for (let index = offset + encodedLength; index < offset + length - 1; index += 1) {
    if (bytes[index] !== 0) {
      throw new Error("dstring padding must be zero-filled");
    }
  }
  return encodedLength === 0 ? "" : decodeOstaCompressedUnicode(bytes, offset, encodedLength);
}

/** Encodes a 32-byte ECMA-167 entity identifier (regid). */
export function encodeEntityIdentifier(value: UdfEntityIdentifier): Uint8Array {
  assertUintRange(value.flags, 0xff, "entity identifier flags");
  const identifier = encodeAscii(value.identifier, "entity identifier");
  if (identifier.byteLength > 23) {
    throw new RangeError("entity identifier must be at most 23 ASCII bytes");
  }
  if (!(value.identifierSuffix instanceof Uint8Array) || value.identifierSuffix.byteLength !== 8) {
    throw new RangeError("entity identifier suffix must be exactly 8 bytes");
  }
  const bytes = new Uint8Array(UDF_ENTITY_IDENTIFIER_SIZE);
  bytes[0] = value.flags;
  bytes.set(identifier, 1);
  bytes.set(value.identifierSuffix, 24);
  return bytes;
}

/** Decodes a 32-byte ECMA-167 entity identifier (regid). */
export function decodeEntityIdentifier(bytes: Uint8Array, offset = 0): UdfEntityIdentifier {
  ensureLength(bytes, offset, UDF_ENTITY_IDENTIFIER_SIZE, "entity identifier");
  const identifierBytes = bytes.subarray(offset + 1, offset + 24);
  let identifierLength = identifierBytes.byteLength;
  while (identifierLength > 0 && identifierBytes[identifierLength - 1] === 0) {
    identifierLength -= 1;
  }
  for (let index = 0; index < identifierLength; index += 1) {
    if (identifierBytes[index] === 0) {
      throw new Error("entity identifier contains an embedded NUL byte");
    }
  }
  return {
    flags: bytes[offset]!,
    identifier: decodeAscii(identifierBytes.subarray(0, identifierLength), "entity identifier"),
    identifierSuffix: identifierBytesFrom(bytes, offset + 24, 8),
  };
}

/** Alias for the ECMA-167 regid terminology. */
export const encodeRegid = encodeEntityIdentifier;
/** Alias for the ECMA-167 regid terminology. */
export const decodeRegid = decodeEntityIdentifier;

/** Writes an unsigned 64-bit little-endian value. */
export function writeUint64LE(value: bigint, bytes: Uint8Array, offset?: number): number;
export function writeUint64LE(bytes: Uint8Array, offset: number, value: bigint): void;
export function writeUint64LE(first: bigint | Uint8Array, second: Uint8Array | number, third: bigint | number = 0): number | void {
  const bytes = first instanceof Uint8Array ? first : second as Uint8Array;
  const offset = first instanceof Uint8Array ? second as number : third as number;
  const value = first instanceof Uint8Array ? third as bigint : first;
  assertUint64(value);
  ensureLength(bytes, offset, 8, "uint64");
  let remaining = value;
  for (let index = 0; index < 8; index += 1) {
    bytes[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return first instanceof Uint8Array ? undefined : offset + 8;
}

/** Reads an unsigned 64-bit little-endian value. */
export function readUint64LE(bytes: Uint8Array, offset = 0): bigint {
  ensureLength(bytes, offset, 8, "uint64");
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]!);
  }
  return value;
}

/** Encodes an ECMA-167 extent_ad. */
export function encodeExtentAd(value: UdfExtentAd): Uint8Array {
  const bytes = new Uint8Array(UDF_EXTENT_AD_SIZE);
  assertUintRange(value.length, EXTENT_LENGTH_MASK, "extent_ad length");
  if (value.length === 0 && value.location !== 0) {
    throw new RangeError("zero-length extent_ad must have location 0");
  }
  writeUint32LE(bytes, 0, value.length);
  writeUint32LE(bytes, 4, value.location);
  return bytes;
}

/** Decodes an ECMA-167 extent_ad. */
export function decodeExtentAd(bytes: Uint8Array, offset = 0): UdfExtentAd {
  ensureLength(bytes, offset, UDF_EXTENT_AD_SIZE, "extent_ad");
  const length = readUint32LE(bytes, offset);
  const location = readUint32LE(bytes, offset + 4);
  if (length > EXTENT_LENGTH_MASK || (length === 0 && location !== 0)) {
    throw new Error("extent_ad has an invalid length or location");
  }
  return { length, location };
}

/** Encodes an ECMA-167 short_ad. */
export function encodeShortAd(value: UdfShortAd): Uint8Array {
  const bytes = new Uint8Array(UDF_SHORT_AD_SIZE);
  writeExtentLength(bytes, 0, value.length, value.type ?? 0);
  if (value.length === 0 && value.location !== 0) {
    throw new RangeError("zero-length short_ad must have location 0");
  }
  writeUint32LE(bytes, 4, value.location);
  return bytes;
}

/** Decodes an ECMA-167 short_ad. */
export function decodeShortAd(bytes: Uint8Array, offset = 0): UdfShortAd {
  ensureLength(bytes, offset, UDF_SHORT_AD_SIZE, "short_ad");
  const extent = readExtentLength(bytes, offset);
  const location = readUint32LE(bytes, offset + 4);
  assertAllocationExtent(extent.length, location, extent.type, "short_ad");
  return { ...extent, location };
}

/** Encodes an ECMA-167 long_ad. */
export function encodeLongAd(value: UdfLongAd): Uint8Array {
  if (!(value.implementationUse instanceof Uint8Array) || value.implementationUse.byteLength !== 6) {
    throw new RangeError("long_ad implementation use must be exactly 6 bytes");
  }
  assertUintRange(value.partitionReferenceNumber, 0xffff, "long_ad partition reference number");
  const bytes = new Uint8Array(UDF_LONG_AD_SIZE);
  writeExtentLength(bytes, 0, value.length, value.type ?? 0);
  if (value.length === 0 && (value.location !== 0 || value.partitionReferenceNumber !== 0)) {
    throw new RangeError("zero-length long_ad must have location and partition reference number 0");
  }
  writeUint32LE(bytes, 4, value.location);
  writeUint16LE(bytes, 8, value.partitionReferenceNumber);
  bytes.set(value.implementationUse, 10);
  return bytes;
}

/** Decodes an ECMA-167 long_ad. */
export function decodeLongAd(bytes: Uint8Array, offset = 0): UdfLongAd {
  ensureLength(bytes, offset, UDF_LONG_AD_SIZE, "long_ad");
  const extent = readExtentLength(bytes, offset);
  const location = readUint32LE(bytes, offset + 4);
  const partitionReferenceNumber = readUint16LE(bytes, offset + 8);
  assertAllocationExtent(extent.length, location, extent.type, "long_ad", partitionReferenceNumber);
  return {
    ...extent,
    location,
    partitionReferenceNumber,
    implementationUse: identifierBytesFrom(bytes, offset + 10, 6),
  };
}

/**
 * Encodes a Type 1 ECMA-167 timestamp with a specified local GMT offset.
 * `null` and `undefined` produce the all-zero unspecified timestamp.
 */
export function encodeEcmaTimestamp(value: Date | null | undefined, timeZoneOffsetMinutes = 0): Uint8Array {
  const bytes = new Uint8Array(UDF_TIMESTAMP_SIZE);
  if (value === null || value === undefined) {
    return bytes;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("ECMA timestamp requires a valid Date");
  }
  validateTimestampOffset(timeZoneOffsetMinutes);
  const local = new Date(value.getTime() + timeZoneOffsetMinutes * 60_000);
  const year = local.getUTCFullYear();
  if (year < 1 || year > 9999) {
    throw new RangeError("ECMA timestamp year must be from 1 to 9999");
  }
  writeUint16LE(bytes, 0, 0x1000 | (timeZoneOffsetMinutes & 0x0fff));
  writeUint16LE(bytes, 2, year);
  bytes[4] = local.getUTCMonth() + 1;
  bytes[5] = local.getUTCDate();
  bytes[6] = local.getUTCHours();
  bytes[7] = local.getUTCMinutes();
  bytes[8] = local.getUTCSeconds();
  const milliseconds = local.getUTCMilliseconds();
  bytes[9] = Math.floor(milliseconds / 10);
  bytes[10] = (milliseconds % 10) * 10;
  bytes[11] = 0;
  return bytes;
}

/** Decodes an all-zero or Type 1 ECMA-167 timestamp. */
export function decodeEcmaTimestamp(bytes: Uint8Array, offset = 0): Date | null {
  ensureLength(bytes, offset, UDF_TIMESTAMP_SIZE, "ECMA timestamp");
  const timestamp = bytes.subarray(offset, offset + UDF_TIMESTAMP_SIZE);
  if (timestamp.every((byte) => byte === 0)) {
    return null;
  }
  const typeAndTimezone = readUint16LE(bytes, offset);
  if ((typeAndTimezone & 0xf000) !== 0x1000) {
    throw new Error("unsupported ECMA timestamp type; only Type 1 is supported");
  }
  const timeZoneOffsetMinutes = signExtend12(typeAndTimezone & 0x0fff);
  validateTimestampOffset(timeZoneOffsetMinutes);
  const year = readUint16LE(bytes, offset + 2);
  const month = bytes[offset + 4]!;
  const day = bytes[offset + 5]!;
  const hour = bytes[offset + 6]!;
  const minute = bytes[offset + 7]!;
  const second = bytes[offset + 8]!;
  const centiseconds = bytes[offset + 9]!;
  const hundredsOfMicroseconds = bytes[offset + 10]!;
  const microseconds = bytes[offset + 11]!;
  if (year < 1 || year > 9999 || hour > 23 || minute > 59 || second > 59 || centiseconds > 99 || hundredsOfMicroseconds > 99 || microseconds > 99) {
    throw new RangeError("ECMA timestamp contains an out-of-range field");
  }
  const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, centiseconds * 10 + Math.floor(hundredsOfMicroseconds / 10)));
  date.setUTCFullYear(year);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new RangeError("ECMA timestamp contains an invalid calendar date");
  }
  return new Date(date.getTime() - timeZoneOffsetMinutes * 60_000);
}

/** Aliases using the shorter ECMA-167 field name. */
export const encodeTimestamp = encodeEcmaTimestamp;
/** Aliases using the shorter ECMA-167 field name. */
export const decodeTimestamp = decodeEcmaTimestamp;

/**
 * Fills a descriptor's tag after the descriptor body has been written.  The
 * CRC covers the requested prefix of the body, then the tag checksum is added.
 */
export function finalizeUdfDescriptor(descriptor: Uint8Array, options: FinalizeUdfDescriptorOptions): Uint8Array {
  ensureLength(descriptor, 0, UDF_DESCRIPTOR_TAG_SIZE, "UDF descriptor");
  const bodyLength = descriptor.byteLength - UDF_DESCRIPTOR_TAG_SIZE;
  const descriptorCRCLength = options.descriptorCRCLength ?? bodyLength;
  assertUintRange(descriptorCRCLength, 0xffff, "descriptor CRC length");
  if (descriptorCRCLength > bodyLength) {
    throw new RangeError(`descriptor CRC length ${descriptorCRCLength} exceeds descriptor body length ${bodyLength}`);
  }
  const tag = encodeUdfDescriptorTag({
    tagIdentifier: options.tagIdentifier,
    descriptorVersion: options.descriptorVersion ?? UDF_DESCRIPTOR_VERSION,
    tagSerialNumber: options.tagSerialNumber ?? 1,
    descriptorCRC: crc16Ccitt(descriptor.subarray(UDF_DESCRIPTOR_TAG_SIZE, UDF_DESCRIPTOR_TAG_SIZE + descriptorCRCLength)),
    descriptorCRCLength,
    tagLocation: options.tagLocation,
  });
  descriptor.set(tag, 0);
  return descriptor;
}

function unicodeCodeUnits(value: string): number[] {
  const codeUnits: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      throw new RangeError("OSTA compressed Unicode does not support UTF-16 surrogates or supplementary code points");
    }
    codeUnits.push(codeUnit);
  }
  return codeUnits;
}

function assertDstringLength(length: number): void {
  if (!Number.isInteger(length) || length < 1 || length > 0xff) {
    throw new RangeError("dstring length must be an integer from 1 to 255");
  }
}

function encodeAscii(value: string, name: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0 || codeUnit > 0x7f) {
      throw new RangeError(`${name} must contain non-NUL ASCII characters only`);
    }
    bytes[index] = codeUnit;
  }
  return bytes;
}

function decodeAscii(bytes: Uint8Array, name: string): string {
  let value = "";
  for (const byte of bytes) {
    if (byte === 0 || byte > 0x7f) {
      throw new Error(`${name} must contain non-NUL ASCII characters only`);
    }
    value += String.fromCharCode(byte);
  }
  return value;
}

function identifierBytesFrom(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  return Uint8Array.from(bytes.subarray(offset, offset + length));
}

function assertUint64(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new RangeError("uint64 must be an integer from 0 to 18446744073709551615");
  }
}

function writeExtentLength(bytes: Uint8Array, offset: number, length: number, type: number): void {
  assertUintRange(length, EXTENT_LENGTH_MASK, "allocation descriptor length");
  assertUintRange(type, 3, "allocation descriptor type");
  if (length === 0 && type !== 0) {
    throw new RangeError("zero-length allocation descriptor must use extent type 0");
  }
  writeUint32LE(bytes, offset, (length | (type << 30)) >>> 0);
}

function readExtentLength(bytes: Uint8Array, offset: number): { length: number; type: number } {
  const raw = readUint32LE(bytes, offset);
  return { length: raw & EXTENT_LENGTH_MASK, type: (raw & EXTENT_TYPE_MASK) >>> 30 };
}

function assertAllocationExtent(length: number, location: number, type: number, name: string, partitionReferenceNumber?: number): void {
  if (length === 0 && (type !== 0 || location !== 0 || (partitionReferenceNumber !== undefined && partitionReferenceNumber !== 0))) {
    throw new Error(`zero-length ${name} must have type, location, and partition reference number set to 0`);
  }
}

function validateTimestampOffset(value: number): void {
  if (!Number.isInteger(value) || value < -1440 || value > 1440) {
    throw new RangeError("ECMA timestamp GMT offset must be an integer from -1440 to 1440 minutes");
  }
}

function signExtend12(value: number): number {
  return (value & 0x800) === 0 ? value : value - 0x1000;
}

function ensureLength(bytes: Uint8Array, offset: number, length: number, name: string): void {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new RangeError(`need ${length} byte(s) for ${name} at offset ${offset}`);
  }
}
