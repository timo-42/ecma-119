import { assertUintRange, readUint16LE, readUint32LE, writeUint16LE, writeUint32LE } from "./binary.js";

/** ECMA-167, Part 3, 7.2 descriptor tag length in bytes. */
export const UDF_DESCRIPTOR_TAG_SIZE = 16;

/** Descriptor version written by ECMA-167 third-edition originating systems. */
export const UDF_DESCRIPTOR_VERSION = 3;

/** Descriptor versions accepted by ECMA-167 third-edition receiving systems. */
export const UDF_DESCRIPTOR_COMPATIBLE_VERSIONS = [2, 3] as const;

/** ECMA-167 descriptor tag identifiers from Parts 3 and 4. */
export const UDF_DESCRIPTOR_TAG_IDENTIFIER = {
  UNSPECIFIED: 0,
  PRIMARY_VOLUME_DESCRIPTOR: 1,
  ANCHOR_VOLUME_DESCRIPTOR_POINTER: 2,
  VOLUME_DESCRIPTOR_POINTER: 3,
  IMPLEMENTATION_USE_VOLUME_DESCRIPTOR: 4,
  PARTITION_DESCRIPTOR: 5,
  LOGICAL_VOLUME_DESCRIPTOR: 6,
  UNALLOCATED_SPACE_DESCRIPTOR: 7,
  TERMINATING_DESCRIPTOR: 8,
  LOGICAL_VOLUME_INTEGRITY_DESCRIPTOR: 9,
  FILE_SET_DESCRIPTOR: 256,
  FILE_IDENTIFIER_DESCRIPTOR: 257,
  ALLOCATION_EXTENT_DESCRIPTOR: 258,
  INDIRECT_ENTRY: 259,
  TERMINAL_ENTRY: 260,
  FILE_ENTRY: 261,
  EXTENDED_ATTRIBUTE_HEADER_DESCRIPTOR: 262,
  UNALLOCATED_SPACE_ENTRY: 263,
  SPACE_BITMAP_DESCRIPTOR: 264,
  PARTITION_INTEGRITY_ENTRY: 265,
  EXTENDED_FILE_ENTRY: 266,
} as const;

export type UdfDescriptorTagIdentifier =
  (typeof UDF_DESCRIPTOR_TAG_IDENTIFIER)[keyof typeof UDF_DESCRIPTOR_TAG_IDENTIFIER];

/** The complete 16-byte ECMA-167 descriptor tag. */
export type UdfDescriptorTag = {
  tagIdentifier: number;
  descriptorVersion: number;
  tagChecksum: number;
  reserved: number;
  tagSerialNumber: number;
  descriptorCRC: number;
  descriptorCRCLength: number;
  tagLocation: number;
};

/** Fields needed to encode a conforming descriptor tag. */
export type UdfDescriptorTagInput = Omit<UdfDescriptorTag, "tagChecksum" | "reserved">;

export type UdfDescriptorTagValidationOptions = {
  expectedTagIdentifier?: number | readonly number[];
  expectedDescriptorVersion?: number | readonly number[];
  expectedTagLocation?: number;
};

/**
 * Calculates the ECMA-167 tag checksum: the modulo-256 sum of tag bytes
 * 0-3 and 5-15. The stored checksum byte at offset 4 is excluded.
 */
export function descriptorTagChecksum(bytes: Uint8Array, offset = 0): number {
  ensureTagLength(bytes, offset);
  let checksum = 0;
  for (let index = 0; index < UDF_DESCRIPTOR_TAG_SIZE; index += 1) {
    if (index !== 4) {
      checksum = (checksum + bytes[offset + index]!) & 0xff;
    }
  }
  return checksum;
}

/** Calculates the ECMA-167 CRC-16/CCITT checksum using an initial value of zero. */
export function crc16Ccitt(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) === 0 ? crc << 1 : (crc << 1) ^ 0x1021;
      crc &= 0xffff;
    }
  }
  return crc;
}

/** Encodes a descriptor tag in its 16-byte little-endian representation. */
export function encodeUdfDescriptorTag(tag: UdfDescriptorTagInput): Uint8Array {
  assertTagInput(tag);
  const bytes = new Uint8Array(UDF_DESCRIPTOR_TAG_SIZE);
  writeUint16LE(bytes, 0, tag.tagIdentifier);
  writeUint16LE(bytes, 2, tag.descriptorVersion);
  bytes[5] = 0;
  writeUint16LE(bytes, 6, tag.tagSerialNumber);
  writeUint16LE(bytes, 8, tag.descriptorCRC);
  writeUint16LE(bytes, 10, tag.descriptorCRCLength);
  writeUint32LE(bytes, 12, tag.tagLocation);
  bytes[4] = descriptorTagChecksum(bytes);
  return bytes;
}

/** Decodes a 16-byte little-endian ECMA-167 descriptor tag. */
export function decodeUdfDescriptorTag(bytes: Uint8Array, offset = 0): UdfDescriptorTag {
  ensureTagLength(bytes, offset);
  return {
    tagIdentifier: readUint16LE(bytes, offset),
    descriptorVersion: readUint16LE(bytes, offset + 2),
    tagChecksum: bytes[offset + 4]!,
    reserved: bytes[offset + 5]!,
    tagSerialNumber: readUint16LE(bytes, offset + 6),
    descriptorCRC: readUint16LE(bytes, offset + 8),
    descriptorCRCLength: readUint16LE(bytes, offset + 10),
    tagLocation: readUint32LE(bytes, offset + 12),
  };
}

/**
 * Decodes and validates a descriptor beginning with an ECMA-167 tag.
 * The descriptor body follows the 16-byte tag and is used for CRC validation.
 */
export function validateUdfDescriptorTag(descriptor: Uint8Array, options: UdfDescriptorTagValidationOptions = {}): UdfDescriptorTag {
  const tag = decodeUdfDescriptorTag(descriptor);
  assertExpectedValue("identifier", tag.tagIdentifier, options.expectedTagIdentifier);

  const expectedVersions = options.expectedDescriptorVersion ?? UDF_DESCRIPTOR_COMPATIBLE_VERSIONS;
  assertExpectedValue("version", tag.descriptorVersion, expectedVersions);

  if (tag.reserved !== 0) {
    throw new Error(`descriptor tag reserved byte must be 0; got ${formatHex(tag.reserved, 2)}`);
  }

  const expectedChecksum = descriptorTagChecksum(descriptor);
  if (tag.tagChecksum !== expectedChecksum) {
    throw new Error(`descriptor tag checksum mismatch: expected ${formatHex(expectedChecksum, 2)}, got ${formatHex(tag.tagChecksum, 2)}`);
  }

  const body = descriptor.subarray(UDF_DESCRIPTOR_TAG_SIZE);
  if (tag.descriptorCRCLength > body.byteLength) {
    throw new Error(`descriptor CRC length ${tag.descriptorCRCLength} exceeds available descriptor body length ${body.byteLength}`);
  }
  const expectedCRC = crc16Ccitt(body.subarray(0, tag.descriptorCRCLength));
  if (tag.descriptorCRC !== expectedCRC) {
    throw new Error(`descriptor CRC mismatch: expected ${formatHex(expectedCRC, 4)}, got ${formatHex(tag.descriptorCRC, 4)}`);
  }

  if (options.expectedTagLocation !== undefined && tag.tagLocation !== options.expectedTagLocation) {
    throw new Error(`descriptor tag location mismatch: expected ${options.expectedTagLocation}, got ${tag.tagLocation}`);
  }

  return tag;
}

function assertTagInput(tag: UdfDescriptorTagInput): void {
  assertUintRange(tag.tagIdentifier, 0xffff, "descriptor tag identifier");
  assertUintRange(tag.descriptorVersion, 0xffff, "descriptor version");
  assertUintRange(tag.tagSerialNumber, 0xffff, "descriptor tag serial number");
  assertUintRange(tag.descriptorCRC, 0xffff, "descriptor CRC");
  assertUintRange(tag.descriptorCRCLength, 0xffff, "descriptor CRC length");
  assertUintRange(tag.tagLocation, 0xffffffff, "descriptor tag location");
}

function ensureTagLength(bytes: Uint8Array, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + UDF_DESCRIPTOR_TAG_SIZE > bytes.byteLength) {
    throw new RangeError(`need ${UDF_DESCRIPTOR_TAG_SIZE} bytes for a descriptor tag at offset ${offset}`);
  }
}

function assertExpectedValue(field: string, actual: number, expected: number | readonly number[] | undefined): void {
  if (expected === undefined) {
    return;
  }
  const accepted = typeof expected === "number" ? [expected] : expected;
  if (!accepted.includes(actual)) {
    throw new Error(`descriptor tag ${field} mismatch: expected ${accepted.join(" or ")}, got ${actual}`);
  }
}

function formatHex(value: number, width: number): string {
  return `0x${value.toString(16).padStart(width, "0")}`;
}
