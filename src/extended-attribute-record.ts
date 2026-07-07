import {
  assertUintRange,
  dateTimeToDate,
  dateToVolumeDescriptorDateTime,
  normalizeACharacters,
  isAString,
  readAscii,
  readAsciiTrimmed,
  readUint16BE,
  readUint16Both,
  readVolumeDescriptorDateTime,
  sectorsForBytes,
  writeAsciiPadded,
  writeUint16BE,
  writeUint16Both,
  writeVolumeDescriptorDateTime,
} from "./binary.js";
import { bytesFromInput } from "./byte-input.js";
import { type ByteInput, type ExtendedAttributeRecord, type ExtendedAttributeRecordInput, SECTOR_SIZE } from "./types.js";

export const EXTENDED_ATTRIBUTE_RECORD_MIN_LENGTH = 250;
const DEFAULT_PERMISSIONS = 0xaaaa;
const REQUIRED_PERMISSION_BITS = 0xaaaa;

export function encodeExtendedAttributeRecord(input: ExtendedAttributeRecordInput = {}, options: { defaultDate?: Date; defaultTimeZoneOffsetMinutes?: number } = {}): Uint8Array {
  const applicationUse = input.applicationUse === undefined ? new Uint8Array() : toBytes(input.applicationUse);
  const escapeSequences = input.escapeSequences === undefined ? new Uint8Array() : toBytes(input.escapeSequences);
  const systemUse = input.systemUse === undefined ? new Uint8Array() : toBytes(input.systemUse);
  const defaultDate = options.defaultDate ?? new Date(0);
  const timeZoneOffsetMinutes = input.timeZoneOffsetMinutes ?? options.defaultTimeZoneOffsetMinutes ?? 0;
  const ownerIdentification = input.ownerIdentification ?? 0;
  const groupIdentification = input.groupIdentification ?? 0;
  const permissions = input.permissions ?? DEFAULT_PERMISSIONS;
  const recordFormat = input.recordFormat ?? 0;
  const recordAttributes = input.recordAttributes ?? 0;
  const recordLength = input.recordLength ?? 0;
  const version = input.version ?? 1;
  const length = EXTENDED_ATTRIBUTE_RECORD_MIN_LENGTH + applicationUse.byteLength + escapeSequences.byteLength;
  const sectors = sectorsForBytes(length);

  validateOwnerGroup(ownerIdentification, groupIdentification);
  validatePermissions(permissions);
  validateStructuredRecordLayout(recordFormat, recordAttributes, recordLength);
  if (version !== 1) {
    throw new RangeError("extended attribute record version must be 1");
  }
  if (systemUse.byteLength > 64) {
    throw new Error("extended attribute record system use field exceeds 64 bytes");
  }
  assertUintRange(applicationUse.byteLength, 0xffff, "application use length");
  assertUintRange(escapeSequences.byteLength, 0xff, "escape sequence length");
  assertUintRange(sectors, 0xff, "extended attribute record length");

  const bytes = new Uint8Array(Math.max(SECTOR_SIZE, sectors * SECTOR_SIZE));
  writeUint16Both(bytes, 0, ownerIdentification);
  writeUint16Both(bytes, 4, groupIdentification);
  writeUint16BE(bytes, 8, permissions);
  writeVolumeDescriptorDateTime(bytes, 10, dateToVolumeDescriptorDateTime(input.createdAt ?? defaultDate, timeZoneOffsetMinutes));
  writeVolumeDescriptorDateTime(bytes, 27, dateToVolumeDescriptorDateTime(input.modifiedAt ?? input.createdAt ?? defaultDate, timeZoneOffsetMinutes));
  writeVolumeDescriptorDateTime(bytes, 44, input.expiresAt === null || input.expiresAt === undefined ? null : dateToVolumeDescriptorDateTime(input.expiresAt, timeZoneOffsetMinutes));
  writeVolumeDescriptorDateTime(bytes, 61, input.effectiveAt === null ? null : dateToVolumeDescriptorDateTime(input.effectiveAt ?? input.createdAt ?? defaultDate, timeZoneOffsetMinutes));
  bytes[78] = checkedByte(recordFormat, "record format");
  bytes[79] = checkedByte(recordAttributes, "record attributes");
  writeUint16Both(bytes, 80, recordLength);
  writeAsciiPadded(bytes, 84, 32, normalizeACharacters(input.systemIdentifier ?? "", "extended attribute system identifier"), 0x20);
  bytes.set(systemUse, 116);
  bytes[180] = version;
  bytes[181] = escapeSequences.byteLength;
  writeUint16Both(bytes, 246, applicationUse.byteLength);
  bytes.set(applicationUse, 250);
  bytes.set(escapeSequences, 250 + applicationUse.byteLength);

  return bytes;
}

export function decodeExtendedAttributeRecord(bytes: Uint8Array): ExtendedAttributeRecord {
  if (bytes.byteLength < EXTENDED_ATTRIBUTE_RECORD_MIN_LENGTH) {
    throw new Error("extended attribute record must be at least 250 bytes");
  }
  const escapeSequenceLength = bytes[181]!;
  const applicationUseLength = readUint16Both(bytes, 246);
  const tailEnd = EXTENDED_ATTRIBUTE_RECORD_MIN_LENGTH + applicationUseLength + escapeSequenceLength;
  if (tailEnd > bytes.byteLength) {
    throw new Error("extended attribute record application use and escape sequences exceed record length");
  }
  if (!allZero(bytes.subarray(182, 246))) {
    throw new Error("extended attribute record reserved bytes must be zero");
  }
  const ownerIdentification = readUint16Both(bytes, 0);
  const groupIdentification = readUint16Both(bytes, 4);
  const permissions = readUint16BE(bytes, 8);
  const recordFormat = bytes[78]!;
  const recordAttributes = bytes[79]!;
  const recordLength = readUint16Both(bytes, 80);
  const version = bytes[180]!;
  const systemIdentifier = readAsciiTrimmed(bytes, 84, 32);
  validateOwnerGroup(ownerIdentification, groupIdentification);
  validatePermissions(permissions);
  validateDecodedRecordLayout(recordFormat, recordAttributes, recordLength);
  if (!isAString(readAscii(bytes, 84, 32))) {
    throw new Error("extended attribute record system identifier contains invalid ECMA-119 a-characters");
  }
  if (version !== 1) {
    throw new Error("extended attribute record version must be 1");
  }
  const createdAt = readRequiredDate(bytes, 10, "creation");
  const modifiedAt = readRequiredDate(bytes, 27, "modification");
  const effectiveAtValue = readVolumeDescriptorDateTime(bytes, 61);
  const expiresAtValue = readVolumeDescriptorDateTime(bytes, 44);

  return {
    ownerIdentification,
    groupIdentification,
    permissions,
    createdAt,
    modifiedAt,
    expiresAt: expiresAtValue ? dateTimeToDate(expiresAtValue) : null,
    effectiveAt: effectiveAtValue ? dateTimeToDate(effectiveAtValue) : null,
    recordFormat,
    recordAttributes,
    recordLength,
    systemIdentifier,
    systemUse: bytes.slice(116, 180),
    version,
    applicationUse: bytes.slice(250, 250 + applicationUseLength),
    escapeSequences: bytes.slice(250 + applicationUseLength, tailEnd),
  };
}

export function extendedAttributeRecordFileFlags(record: ExtendedAttributeRecord): number {
  let flags = 0;
  if (record.recordFormat !== 0) {
    flags |= 0x08;
  }
  if (
    record.ownerIdentification !== 0
    || record.groupIdentification !== 0
    || (record.permissions & 0x5555) !== 0
  ) {
    flags |= 0x10;
  }
  return flags;
}

function validateOwnerGroup(ownerIdentification: number, groupIdentification: number): void {
  assertUintRange(ownerIdentification, 0xffff, "owner identification");
  assertUintRange(groupIdentification, 0xffff, "group identification");
  if ((ownerIdentification === 0) !== (groupIdentification === 0)) {
    throw new Error("owner identification and group identification must both be zero or both be nonzero");
  }
}

function validatePermissions(permissions: number): void {
  assertUintRange(permissions, 0xffff, "permissions");
  if ((permissions & REQUIRED_PERMISSION_BITS) !== REQUIRED_PERMISSION_BITS) {
    throw new Error("extended attribute record permissions bits 1,3,5,7,9,11,13,15 must be set");
  }
}

function validateStructuredRecordLayout(recordFormat: number, recordAttributes: number, recordLength: number): void {
  validateDecodedRecordLayout(recordFormat, recordAttributes, recordLength);
}

function validateDecodedRecordLayout(recordFormat: number, recordAttributes: number, recordLength: number): void {
  assertUintRange(recordFormat, 0xff, "record format");
  assertUintRange(recordAttributes, 0xff, "record attributes");
  assertUintRange(recordLength, 0xffff, "record length");
  if (recordFormat > 3 && recordFormat < 128) {
    throw new Error("record format values 4 through 127 are reserved");
  }
  if (recordAttributes > 2) {
    throw new Error("record attributes values 3 through 255 are reserved");
  }
  if (recordFormat === 0 && recordLength !== 0) {
    throw new Error("record length must be zero when record format is zero");
  }
  if (recordFormat === 1 && recordLength < 1) {
    throw new Error("record length must be at least one for fixed-length records");
  }
  if ((recordFormat === 2 || recordFormat === 3) && (recordLength < 1 || recordLength > 32767)) {
    throw new Error("record length must be 1 through 32767 for variable-length records");
  }
}

function readRequiredDate(bytes: Uint8Array, offset: number, name: string): Date {
  const value = readVolumeDescriptorDateTime(bytes, offset);
  if (!value) {
    throw new Error(`extended attribute record ${name} date must be specified`);
  }
  return dateTimeToDate(value);
}

function checkedByte(value: number, name: string): number {
  assertUintRange(value, 0xff, name);
  return value;
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function toBytes(data: ByteInput): Uint8Array {
  return bytesFromInput(data);
}
