import { SECTOR_SIZE } from "./types.js";

const ASCII_ENCODER = new TextEncoder();
const ASCII_DECODER = new TextDecoder("ascii");

export type DirectoryDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  timeZoneOffsetMinutes: number;
};

export type VolumeDescriptorDateTime = DirectoryDateTime & {
  hundredths: number;
};

export function assertUintRange(value: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an integer from 0 to ${max}`);
  }
}

export function writeUint16LE(value: number, bytes: Uint8Array, offset?: number): number;
export function writeUint16LE(bytes: Uint8Array, offset: number, value: number): void;
export function writeUint16LE(first: number | Uint8Array, second: Uint8Array | number, third = 0): number | void {
  const args = normalizeWriteArgs(first, second, third, 2, "uint16");
  args.bytes[args.offset] = args.value & 0xff;
  args.bytes[args.offset + 1] = (args.value >>> 8) & 0xff;
  return args.returnsOffset ? args.offset + 2 : undefined;
}

export function writeUint16BE(value: number, bytes: Uint8Array, offset?: number): number;
export function writeUint16BE(bytes: Uint8Array, offset: number, value: number): void;
export function writeUint16BE(first: number | Uint8Array, second: Uint8Array | number, third = 0): number | void {
  const args = normalizeWriteArgs(first, second, third, 2, "uint16");
  args.bytes[args.offset] = (args.value >>> 8) & 0xff;
  args.bytes[args.offset + 1] = args.value & 0xff;
  return args.returnsOffset ? args.offset + 2 : undefined;
}

export function writeUint16Both(bytes: Uint8Array, offset: number, value: number): void {
  writeUint16LE(bytes, offset, value);
  writeUint16BE(bytes, offset + 2, value);
}

export function writeBothEndianUint16(value: number, bytes: Uint8Array, offset?: number): number;
export function writeBothEndianUint16(bytes: Uint8Array, offset: number, value: number): void;
export function writeBothEndianUint16(first: number | Uint8Array, second: Uint8Array | number, third = 0): number | void {
  if (first instanceof Uint8Array) {
    writeUint16Both(first, second as number, third);
    return undefined;
  }
  const value = first;
  const bytes = second as Uint8Array;
  const offset = third;
  writeUint16Both(bytes, offset, value);
  return offset + 4;
}

export function readUint16LE(bytes: Uint8Array, offset = 0): number {
  ensureLength(bytes, offset, 2);
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

export function readUint16BE(bytes: Uint8Array, offset = 0): number {
  ensureLength(bytes, offset, 2);
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

export function readUint16Both(bytes: Uint8Array, offset = 0): number {
  const little = readUint16LE(bytes, offset);
  const big = readUint16BE(bytes, offset + 2);
  if (little !== big) {
    throw new Error(`both-endian uint16 mismatch at ${offset}: ${little} !== ${big}`);
  }
  return little;
}

export const readBothEndianUint16 = readUint16Both;

export function writeUint32LE(value: number, bytes: Uint8Array, offset?: number): number;
export function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void;
export function writeUint32LE(first: number | Uint8Array, second: Uint8Array | number, third = 0): number | void {
  const args = normalizeWriteArgs(first, second, third, 4, "uint32");
  args.bytes[args.offset] = args.value & 0xff;
  args.bytes[args.offset + 1] = (args.value >>> 8) & 0xff;
  args.bytes[args.offset + 2] = (args.value >>> 16) & 0xff;
  args.bytes[args.offset + 3] = (args.value >>> 24) & 0xff;
  return args.returnsOffset ? args.offset + 4 : undefined;
}

export function writeUint32BE(value: number, bytes: Uint8Array, offset?: number): number;
export function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void;
export function writeUint32BE(first: number | Uint8Array, second: Uint8Array | number, third = 0): number | void {
  const args = normalizeWriteArgs(first, second, third, 4, "uint32");
  args.bytes[args.offset] = (args.value >>> 24) & 0xff;
  args.bytes[args.offset + 1] = (args.value >>> 16) & 0xff;
  args.bytes[args.offset + 2] = (args.value >>> 8) & 0xff;
  args.bytes[args.offset + 3] = args.value & 0xff;
  return args.returnsOffset ? args.offset + 4 : undefined;
}

export function writeUint32Both(bytes: Uint8Array, offset: number, value: number): void {
  writeUint32LE(bytes, offset, value);
  writeUint32BE(bytes, offset + 4, value);
}

export function writeBothEndianUint32(value: number, bytes: Uint8Array, offset?: number): number;
export function writeBothEndianUint32(bytes: Uint8Array, offset: number, value: number): void;
export function writeBothEndianUint32(first: number | Uint8Array, second: Uint8Array | number, third = 0): number | void {
  if (first instanceof Uint8Array) {
    writeUint32Both(first, second as number, third);
    return undefined;
  }
  const value = first;
  const bytes = second as Uint8Array;
  const offset = third;
  writeUint32Both(bytes, offset, value);
  return offset + 8;
}

export function readUint32LE(bytes: Uint8Array, offset = 0): number {
  ensureLength(bytes, offset, 4);
  return (
    bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24)
  ) >>> 0;
}

export function readUint32BE(bytes: Uint8Array, offset = 0): number {
  ensureLength(bytes, offset, 4);
  return (
    (bytes[offset]! << 24)
    | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8)
    | bytes[offset + 3]!
  ) >>> 0;
}

export function readUint32Both(bytes: Uint8Array, offset = 0): number {
  const little = readUint32LE(bytes, offset);
  const big = readUint32BE(bytes, offset + 4);
  if (little !== big) {
    throw new Error(`both-endian uint32 mismatch at ${offset}: ${little} !== ${big}`);
  }
  return little;
}

export const readBothEndianUint32 = readUint32Both;

export function writeAsciiPadded(bytes: Uint8Array, offset: number, length: number, value: string, filler = 0x20): void {
  if (!isAscii(value)) {
    throw new Error(`value contains non-ASCII characters: ${value}`);
  }
  if (value.length > length) {
    throw new Error(`value is too long for ${length}-byte field: ${value}`);
  }
  bytes.fill(filler, offset, offset + length);
  bytes.set(ASCII_ENCODER.encode(value), offset);
}

export function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return ASCII_DECODER.decode(bytes.subarray(offset, offset + length));
}

export function readAsciiTrimmed(bytes: Uint8Array, offset: number, length: number): string {
  return readAscii(bytes, offset, length).replace(/[ \0]+$/u, "");
}

export function isAscii(value: string): boolean {
  return /^[\x00-\x7f]*$/u.test(value);
}

export function isDCharacter(value: string): boolean {
  return /^[A-Z0-9_]$/u.test(value);
}

export function isDString(value: string): boolean {
  return /^[A-Z0-9_]*$/u.test(value);
}

export function isACharacter(value: string): boolean {
  return /^[A-Z0-9_ !"%&'()*+,\-.\/:;<=>?]$/u.test(value);
}

export function isAString(value: string): boolean {
  return /^[A-Z0-9_ !"%&'()*+,\-.\/:;<=>?]*$/u.test(value);
}

export function normalizeDCharacters(value: string, field: string): string {
  const normalized = value.toUpperCase();
  if (!isDString(normalized)) {
    throw new Error(`${field} must contain only ECMA-119 d-characters: A-Z, 0-9, and underscore`);
  }
  return normalized;
}

export function normalizeACharacters(value: string, field: string): string {
  const normalized = value.toUpperCase();
  if (!isAString(normalized)) {
    throw new Error(`${field} must contain only ECMA-119 a-characters`);
  }
  return normalized;
}

export function sectorsForBytes(length: number): number {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError("length must be a non-negative integer");
  }
  return Math.ceil(length / SECTOR_SIZE);
}

export function sectorOffset(sector: number): number {
  return sector * SECTOR_SIZE;
}

export function encodeDirectoryDate(date: Date | null | undefined, timeZoneOffsetMinutes = 0): Uint8Array {
  const bytes = new Uint8Array(7);
  writeDirectoryDateTime(date ? dateToDirectoryDateTime(date, timeZoneOffsetMinutes) : null, bytes);
  return bytes;
}

export function decodeDirectoryDate(bytes: Uint8Array, offset: number): Date | null {
  const value = readDirectoryDateTime(bytes, offset);
  return value ? dateTimeToDate(value) : null;
}

export function encodeVolumeDate(date: Date | null | undefined, timeZoneOffsetMinutes = 0): Uint8Array {
  const bytes = new Uint8Array(17);
  writeVolumeDescriptorDateTime(date ? dateToVolumeDescriptorDateTime(date, timeZoneOffsetMinutes) : null, bytes);
  return bytes;
}

export function decodeVolumeDate(bytes: Uint8Array, offset: number): Date | null {
  const value = readVolumeDescriptorDateTime(bytes, offset);
  return value ? dateTimeToDate(value) : null;
}

export function dateToDirectoryDateTime(date: Date, timeZoneOffsetMinutes = 0): DirectoryDateTime {
  validateOffset(timeZoneOffsetMinutes);
  const local = new Date(date.getTime() + timeZoneOffsetMinutes * 60_000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    timeZoneOffsetMinutes,
  };
}

export function dateToVolumeDescriptorDateTime(date: Date, timeZoneOffsetMinutes = 0): VolumeDescriptorDateTime {
  return {
    ...dateToDirectoryDateTime(date, timeZoneOffsetMinutes),
    hundredths: Math.trunc(date.getUTCMilliseconds() / 10),
  };
}

export function dateTimeToDate(value: DirectoryDateTime | VolumeDescriptorDateTime): Date {
  validateDateTime(value);
  const local = new Date(
    Date.UTC(
      2000,
      value.month - 1,
      value.day,
      value.hour,
      value.minute,
      value.second,
      "hundredths" in value ? value.hundredths * 10 : 0,
    ),
  );
  local.setUTCFullYear(value.year);
  return new Date(local.getTime() - value.timeZoneOffsetMinutes * 60_000);
}

export function writeDirectoryDateTime(value: DirectoryDateTime | null, bytes: Uint8Array, offset?: number): number;
export function writeDirectoryDateTime(bytes: Uint8Array, offset: number, value: DirectoryDateTime | null): void;
export function writeDirectoryDateTime(first: DirectoryDateTime | Uint8Array | null, second: Uint8Array | number, third: DirectoryDateTime | null | number = 0): number | void {
  const bytes = first instanceof Uint8Array ? first : second as Uint8Array;
  const offset = first instanceof Uint8Array ? second as number : third as number;
  const value = first instanceof Uint8Array ? third as DirectoryDateTime | null : first;
  ensureLength(bytes, offset, 7);
  if (value === null) {
    bytes.fill(0, offset, offset + 7);
    return first instanceof Uint8Array ? undefined : offset + 7;
  }
  validateDateTime(value);
  bytes[offset] = clampYearSince1900(value.year);
  bytes[offset + 1] = value.month;
  bytes[offset + 2] = value.day;
  bytes[offset + 3] = value.hour;
  bytes[offset + 4] = value.minute;
  bytes[offset + 5] = value.second;
  bytes[offset + 6] = encodeOffset(value.timeZoneOffsetMinutes);
  return first instanceof Uint8Array ? undefined : offset + 7;
}

export function readDirectoryDateTime(bytes: Uint8Array, offset = 0): DirectoryDateTime | null {
  ensureLength(bytes, offset, 7);
  if (allZero(bytes.subarray(offset, offset + 7))) {
    return null;
  }
  const value = {
    year: 1900 + bytes[offset]!,
    month: bytes[offset + 1]!,
    day: bytes[offset + 2]!,
    hour: bytes[offset + 3]!,
    minute: bytes[offset + 4]!,
    second: bytes[offset + 5]!,
    timeZoneOffsetMinutes: decodeOffset(bytes[offset + 6]!),
  };
  validateDateTime(value);
  return value;
}

export function writeVolumeDescriptorDateTime(value: VolumeDescriptorDateTime | null, bytes: Uint8Array, offset?: number): number;
export function writeVolumeDescriptorDateTime(bytes: Uint8Array, offset: number, value: VolumeDescriptorDateTime | null): void;
export function writeVolumeDescriptorDateTime(first: VolumeDescriptorDateTime | Uint8Array | null, second: Uint8Array | number, third: VolumeDescriptorDateTime | null | number = 0): number | void {
  const bytes = first instanceof Uint8Array ? first : second as Uint8Array;
  const offset = first instanceof Uint8Array ? second as number : third as number;
  const value = first instanceof Uint8Array ? third as VolumeDescriptorDateTime | null : first;
  ensureLength(bytes, offset, 17);
  if (value === null) {
    bytes.fill(0x30, offset, offset + 16);
    bytes[offset + 16] = 0;
    return first instanceof Uint8Array ? undefined : offset + 17;
  }
  validateDateTime(value);
  validateVolumeDescriptorDateYear(value.year);
  const text = [
    value.year.toString().padStart(4, "0"),
    value.month.toString().padStart(2, "0"),
    value.day.toString().padStart(2, "0"),
    value.hour.toString().padStart(2, "0"),
    value.minute.toString().padStart(2, "0"),
    value.second.toString().padStart(2, "0"),
    value.hundredths.toString().padStart(2, "0"),
  ].join("");
  bytes.set(ASCII_ENCODER.encode(text), offset);
  bytes[offset + 16] = encodeOffset(value.timeZoneOffsetMinutes);
  return first instanceof Uint8Array ? undefined : offset + 17;
}

export function readVolumeDescriptorDateTime(bytes: Uint8Array, offset = 0): VolumeDescriptorDateTime | null {
  ensureLength(bytes, offset, 17);
  const text = readAscii(bytes, offset, 16);
  if (/^0{16}$/u.test(text)) {
    return null;
  }
  const value = {
    year: Number.parseInt(text.slice(0, 4), 10),
    month: Number.parseInt(text.slice(4, 6), 10),
    day: Number.parseInt(text.slice(6, 8), 10),
    hour: Number.parseInt(text.slice(8, 10), 10),
    minute: Number.parseInt(text.slice(10, 12), 10),
    second: Number.parseInt(text.slice(12, 14), 10),
    hundredths: Number.parseInt(text.slice(14, 16), 10),
    timeZoneOffsetMinutes: decodeOffset(bytes[offset + 16]!),
  };
  validateDateTime(value);
  validateVolumeDescriptorDateYear(value.year);
  return value;
}

function normalizeWriteArgs(first: number | Uint8Array, second: Uint8Array | number, third: number, width: number, name: string): { bytes: Uint8Array; offset: number; value: number; returnsOffset: boolean } {
  if (first instanceof Uint8Array) {
    const offset = second as number;
    assertUintRange(third, name === "uint16" ? 0xffff : 0xffffffff, name);
    ensureLength(first, offset, width);
    return { bytes: first, offset, value: third, returnsOffset: false };
  }
  const bytes = second as Uint8Array;
  const offset = third;
  assertUintRange(first, name === "uint16" ? 0xffff : 0xffffffff, name);
  ensureLength(bytes, offset, width);
  return { bytes, offset, value: first, returnsOffset: true };
}

function ensureLength(bytes: Uint8Array, offset: number, width: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + width > bytes.byteLength) {
    throw new RangeError(`need ${width} byte(s) at offset ${offset}`);
  }
}

function validateDateTime(value: DirectoryDateTime | VolumeDescriptorDateTime): void {
  validateOffset(value.timeZoneOffsetMinutes);
  const checks: Array<[string, number, number, number]> = [
    ["month", value.month, 1, 12],
    ["day", value.day, 1, 31],
    ["hour", value.hour, 0, 23],
    ["minute", value.minute, 0, 59],
    ["second", value.second, 0, 59],
  ];
  for (const [name, current, min, max] of checks) {
    if (!Number.isInteger(current) || current < min || current > max) {
      throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
    }
  }
  if ("hundredths" in value && (!Number.isInteger(value.hundredths) || value.hundredths < 0 || value.hundredths > 99)) {
    throw new RangeError("hundredths must be an integer from 0 to 99");
  }
  const roundTrip = new Date(Date.UTC(2000, value.month - 1, value.day, value.hour, value.minute, value.second));
  roundTrip.setUTCFullYear(value.year);
  if (
    roundTrip.getUTCFullYear() !== value.year
    || roundTrip.getUTCMonth() + 1 !== value.month
    || roundTrip.getUTCDate() !== value.day
  ) {
    throw new RangeError("day is not valid for the supplied month and year");
  }
}

function validateVolumeDescriptorDateYear(year: number): void {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError("volume descriptor date year must be an integer from 1 to 9999");
  }
}

function validateOffset(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes % 15 !== 0) {
    throw new RangeError("time zone offset must be divisible by 15 minutes");
  }
  const intervals = minutes / 15;
  if (intervals < -48 || intervals > 52) {
    throw new RangeError("time zone offset must be between -12:00 and +13:00");
  }
}

function encodeOffset(minutes: number): number {
  validateOffset(minutes);
  return (minutes / 15) & 0xff;
}

function decodeOffset(byte: number): number {
  return (byte > 127 ? byte - 256 : byte) * 15;
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function clampYearSince1900(year: number): number {
  const value = year - 1900;
  if (value < 0 || value > 255) {
    throw new RangeError("ECMA-119 directory dates support years 1900 through 2155");
  }
  return value;
}
