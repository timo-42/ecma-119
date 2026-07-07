import { describe, expect, test } from 'vitest';

import {
  dateTimeToDate,
  encodeDirectoryDate,
  encodeVolumeDate,
  dateToDirectoryDateTime,
  dateToVolumeDescriptorDateTime,
  isACharacter,
  isAString,
  isDCharacter,
  isDString,
  readBothEndianUint16,
  readBothEndianUint32,
  readDirectoryDateTime,
  readUint16BE,
  readUint16LE,
  readUint32BE,
  readUint32LE,
  readVolumeDescriptorDateTime,
  writeBothEndianUint16,
  writeBothEndianUint32,
  writeDirectoryDateTime,
  writeUint16BE,
  writeUint16LE,
  writeUint32BE,
  writeUint32LE,
  writeVolumeDescriptorDateTime,
} from '../src/binary';

describe('ECMA-119 binary helpers', () => {
  test('reads and writes 16-bit integer byte orders', () => {
    const bytes = new Uint8Array(10);

    writeUint16LE(bytes, 1, 0x1234);
    expect([...bytes.slice(1, 3)]).toEqual([0x34, 0x12]);
    expect(readUint16LE(bytes, 1)).toBe(0x1234);

    writeUint16BE(bytes, 3, 0xabcd);
    expect([...bytes.slice(3, 5)]).toEqual([0xab, 0xcd]);
    expect(readUint16BE(bytes, 3)).toBe(0xabcd);
  });

  test('reads and writes 32-bit integer byte orders', () => {
    const bytes = new Uint8Array(12);

    writeUint32LE(bytes, 0, 0x89abcdef);
    expect([...bytes.slice(0, 4)]).toEqual([0xef, 0xcd, 0xab, 0x89]);
    expect(readUint32LE(bytes, 0)).toBe(0x89abcdef);

    writeUint32BE(bytes, 4, 0x01234567);
    expect([...bytes.slice(4, 8)]).toEqual([0x01, 0x23, 0x45, 0x67]);
    expect(readUint32BE(bytes, 4)).toBe(0x01234567);
  });

  test('reads and writes both-endian integers and rejects disagreements', () => {
    const uint16 = new Uint8Array(4);
    writeBothEndianUint16(uint16, 0, 0x4567);
    expect([...uint16]).toEqual([0x67, 0x45, 0x45, 0x67]);
    expect(readBothEndianUint16(uint16, 0)).toBe(0x4567);

    const uint32 = new Uint8Array(8);
    writeBothEndianUint32(uint32, 0, 0x89abcdef);
    expect([...uint32]).toEqual([0xef, 0xcd, 0xab, 0x89, 0x89, 0xab, 0xcd, 0xef]);
    expect(readBothEndianUint32(uint32, 0)).toBe(0x89abcdef);

    expect(() => readBothEndianUint16(new Uint8Array([1, 0, 0, 2]), 0)).toThrow(/mismatch/);
    expect(() => readBothEndianUint32(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 2]), 0)).toThrow(/mismatch/);
  });

  test('validates integer ranges and target bounds', () => {
    expect(() => writeUint16LE(new Uint8Array(2), 0, 0x10000)).toThrow(/uint16/);
    expect(() => writeUint32BE(new Uint8Array(4), 0, -1)).toThrow(/uint32/);
    expect(() => readUint32LE(new Uint8Array(3), 0)).toThrow(/need 4 byte/);
  });

  test('reads and writes directory date/time fields', () => {
    const value = {
      year: 2026,
      month: 7,
      day: 6,
      hour: 1,
      minute: 2,
      second: 3,
      timeZoneOffsetMinutes: 120,
    };
    const bytes = new Uint8Array(7);

    writeDirectoryDateTime(bytes, 0, value);
    expect([...bytes]).toEqual([126, 7, 6, 1, 2, 3, 8]);
    expect(readDirectoryDateTime(bytes, 0)).toEqual(value);
    expect(dateTimeToDate(value).toISOString()).toBe('2026-07-05T23:02:03.000Z');

    writeDirectoryDateTime(bytes, 0, null);
    expect([...bytes]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(readDirectoryDateTime(bytes, 0)).toBeNull();
  });

  test('converts Date values to ECMA-119 date/time components with explicit offsets', () => {
    const date = new Date(Date.UTC(2026, 6, 5, 23, 2, 3, 450));

    expect(dateToDirectoryDateTime(date, 120)).toEqual({
      year: 2026,
      month: 7,
      day: 6,
      hour: 1,
      minute: 2,
      second: 3,
      timeZoneOffsetMinutes: 120,
    });

    expect(dateToVolumeDescriptorDateTime(date, -60)).toEqual({
      year: 2026,
      month: 7,
      day: 5,
      hour: 22,
      minute: 2,
      second: 3,
      hundredths: 45,
      timeZoneOffsetMinutes: -60,
    });
  });

  test('encodes Date wrappers with explicit offsets', () => {
    const date = new Date(Date.UTC(2026, 6, 5, 23, 2, 3, 450));

    expect([...encodeDirectoryDate(date, 120)]).toEqual([126, 7, 6, 1, 2, 3, 8]);
    expect([...encodeDirectoryDate(null)]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(String.fromCharCode(...encodeVolumeDate(date, -60).slice(0, 16))).toBe('2026070522020345');
    expect(encodeVolumeDate(date, -60)[16]).toBe(0xfc);
  });

  test('reads and writes volume descriptor date/time fields', () => {
    const value = {
      year: 2019,
      month: 6,
      day: 1,
      hour: 12,
      minute: 34,
      second: 56,
      hundredths: 78,
      timeZoneOffsetMinutes: -300,
    };
    const bytes = new Uint8Array(17);

    writeVolumeDescriptorDateTime(bytes, 0, value);
    expect(String.fromCharCode(...bytes.slice(0, 16))).toBe('2019060112345678');
    expect(bytes[16]).toBe(0xec);
    expect(readVolumeDescriptorDateTime(bytes, 0)).toEqual(value);
  });

  test('enforces four-digit volume descriptor date/time years', () => {
    const bytes = new Uint8Array(17);
    const boundary = {
      year: 9999,
      month: 12,
      day: 31,
      hour: 23,
      minute: 59,
      second: 59,
      hundredths: 99,
      timeZoneOffsetMinutes: 780,
    };

    writeVolumeDescriptorDateTime(bytes, 0, boundary);
    expect(String.fromCharCode(...bytes.slice(0, 16))).toBe('9999123123595999');
    expect(readVolumeDescriptorDateTime(bytes, 0)).toEqual(boundary);

    writeVolumeDescriptorDateTime(bytes, 0, {
      ...boundary,
      year: 1,
      month: 1,
      day: 1,
    });
    expect(String.fromCharCode(...bytes.slice(0, 16))).toBe('0001010123595999');
    expect(readVolumeDescriptorDateTime(bytes, 0)).toEqual({
      ...boundary,
      year: 1,
      month: 1,
      day: 1,
    });
    expect(dateTimeToDate(readVolumeDescriptorDateTime(bytes, 0)!).toISOString()).toBe('0001-01-01T10:59:59.990Z');

    expect(() => writeVolumeDescriptorDateTime(new Uint8Array(17), 0, {
      ...boundary,
      year: 0,
    })).toThrow(/year.*1 to 9999/i);
    expect(() => readVolumeDescriptorDateTime(Uint8Array.from([
      ...'0000010100000000'.split('').map((char) => char.charCodeAt(0)),
      0,
    ]), 0)).toThrow(/year.*1 to 9999/i);
    expect(() => writeVolumeDescriptorDateTime(new Uint8Array(17), 0, {
      ...boundary,
      year: 10000,
    })).toThrow(/year.*1 to 9999/i);
  });

  test('handles unspecified volume descriptor date/time fields', () => {
    const bytes = new Uint8Array(17);

    writeVolumeDescriptorDateTime(bytes, 0, null);
    expect(String.fromCharCode(...bytes.slice(0, 16))).toBe('0000000000000000');
    expect(bytes[16]).toBe(0);
    expect(readVolumeDescriptorDateTime(bytes, 0)).toBeNull();

    bytes[16] = 1;
    expect(() => readVolumeDescriptorDateTime(bytes, 0)).toThrow(/unspecified.*zero GMT offset/i);
  });

  test('rejects non-decimal volume descriptor date/time fields', () => {
    expect(() => readVolumeDescriptorDateTime(Uint8Array.from([
      ...'20241X0100000000'.split('').map((char) => char.charCodeAt(0)),
      0,
    ]), 0)).toThrow(/16 decimal digits/i);
  });

  test('rejects invalid date/time fields', () => {
    expect(() => writeDirectoryDateTime(new Uint8Array(7), 0, {
      year: 2025,
      month: 2,
      day: 29,
      hour: 0,
      minute: 0,
      second: 0,
      timeZoneOffsetMinutes: 0,
    })).toThrow(/day/);

    expect(() => writeVolumeDescriptorDateTime(new Uint8Array(17), 0, {
      year: 2026,
      month: 7,
      day: 6,
      hour: 0,
      minute: 0,
      second: 0,
      hundredths: 100,
      timeZoneOffsetMinutes: 0,
    })).toThrow(/hundredths/);

    expect(() => writeDirectoryDateTime(new Uint8Array(7), 0, {
      year: 2026,
      month: 7,
      day: 6,
      hour: 0,
      minute: 0,
      second: 0,
      timeZoneOffsetMinutes: 7,
    })).toThrow(/divisible by 15/);
  });

  test('validates ECMA-119 D-characters and A-characters', () => {
    expect(isDCharacter('A')).toBe(true);
    expect(isDCharacter('9')).toBe(true);
    expect(isDCharacter('_')).toBe(true);
    expect(isDCharacter('a')).toBe(false);
    expect(isDString('README_1')).toBe(true);
    expect(isDString('README-1')).toBe(false);

    expect(isACharacter(' ')).toBe(true);
    expect(isACharacter('?')).toBe(true);
    expect(isACharacter('#')).toBe(false);
    expect(isACharacter('$')).toBe(false);
    expect(isAString('VOL_ID 1.0?')).toBe(true);
    expect(isAString('vol_id')).toBe(false);
  });
});
