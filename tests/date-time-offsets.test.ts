import { describe, expect, test } from "vitest";

import { createIsoImage, encodeExtendedAttributeRecord, parseIsoImage, parseVolumeDescriptors, validateIsoImage } from "../src/index";
import { SECTOR_SIZE } from "../src/types";

const PVD_OFFSET = 16 * SECTOR_SIZE;
const SUPPLEMENTARY_OFFSET = 17 * SECTOR_SIZE;

describe("ECMA-119 date/time zone offsets", () => {
  test("writes global time zone offsets into volume and directory date fields", () => {
    const date = new Date(Date.UTC(2026, 6, 5, 23, 2, 3, 450));
    const image = createIsoImage([{
      path: "FILE.TXT",
      data: "offset\n",
      date,
    }], {
      createdAt: date,
      modifiedAt: date,
      effectiveAt: date,
      timeZoneOffsetMinutes: 120,
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
    });
    const descriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image);
    const primary = descriptors.find((descriptor) => descriptor.kind === "primary");
    const supplementary = descriptors.find((descriptor) => descriptor.kind === "supplementary");
    const rootDirectory = getRootDirectoryBytes(image);
    const fileRecord = findDirectoryRecord(rootDirectory, "FILE.TXT;1");

    expect(validateIsoImage(image)).toEqual([]);
    expect(image[PVD_OFFSET + 813 + 16]).toBe(8);
    expect(image[PVD_OFFSET + 830 + 16]).toBe(8);
    expect(image[PVD_OFFSET + 864 + 16]).toBe(8);
    expect(image[PVD_OFFSET + 156 + 18 + 6]).toBe(8);
    expect(image[SUPPLEMENTARY_OFFSET + 813 + 16]).toBe(8);
    expect(image[SUPPLEMENTARY_OFFSET + 156 + 18 + 6]).toBe(8);
    expect(rootDirectory[18 + 6]).toBe(8);
    expect(fileRecord[18 + 6]).toBe(8);
    expect(primary?.kind === "primary" ? primary.createdAt?.toISOString() : undefined).toBe("2026-07-05T23:02:03.450Z");
    expect(supplementary?.kind).toBe("supplementary");
    expect(parsed.files[0]?.date.toISOString()).toBe("2026-07-05T23:02:03.000Z");
  });

  test("allows file and directory date offsets to override the global offset", () => {
    const date = new Date(Date.UTC(2026, 6, 6, 2, 0, 0));
    const image = createIsoImage([{
      path: "DIR/FILE.TXT",
      data: "per entry offset\n",
      date,
      timeZoneOffsetMinutes: -300,
    }], {
      directories: [{
        path: "DIR",
        date,
        timeZoneOffsetMinutes: 60,
      }],
      createdAt: date,
      timeZoneOffsetMinutes: 120,
    });
    const parsed = parseIsoImage(image);
    const rootDirectory = getRootDirectoryBytes(image);
    const directoryRecord = findDirectoryRecord(rootDirectory, "DIR");
    const childDirectory = image.subarray(readUint32Both(directoryRecord, 2) * SECTOR_SIZE);
    const fileRecord = findDirectoryRecord(childDirectory, "FILE.TXT;1");

    expect(validateIsoImage(image)).toEqual([]);
    expect(directoryRecord[18 + 6]).toBe(4);
    expect(childDirectory[18 + 6]).toBe(4);
    expect(fileRecord[18 + 6]).toBe(0xec);
    expect(parsed.root.children[0]?.date.toISOString()).toBe("2026-07-06T02:00:00.000Z");
    expect(parsed.files[0]?.date.toISOString()).toBe("2026-07-06T02:00:00.000Z");
  });

  test("writes time zone offsets into structured extended attribute record dates", () => {
    const date = new Date(Date.UTC(2026, 6, 5, 23, 2, 3, 450));
    const direct = encodeExtendedAttributeRecord({
      createdAt: date,
      modifiedAt: date,
      expiresAt: date,
      effectiveAt: date,
      timeZoneOffsetMinutes: 120,
    });
    const image = createIsoImage([{
      path: "EAR.TXT",
      data: "ear offset\n",
      date,
      extendedAttributeRecord: {
        createdAt: date,
        modifiedAt: date,
        expiresAt: date,
        effectiveAt: date,
      },
    }], {
      timeZoneOffsetMinutes: -300,
    });
    const rootDirectory = getRootDirectoryBytes(image);
    const fileRecord = findDirectoryRecord(rootDirectory, "EAR.TXT;1");
    const ear = image.subarray(readUint32Both(fileRecord, 2) * SECTOR_SIZE, (readUint32Both(fileRecord, 2) + 1) * SECTOR_SIZE);
    const parsed = parseIsoImage(image, { includeData: true });
    const file = parsed.files[0];

    expect(validateIsoImage(image)).toEqual([]);
    expect(direct[10 + 16]).toBe(8);
    expect(direct[27 + 16]).toBe(8);
    expect(direct[44 + 16]).toBe(8);
    expect(direct[61 + 16]).toBe(8);
    expect(ear[10 + 16]).toBe(0xec);
    expect(ear[27 + 16]).toBe(0xec);
    expect(ear[44 + 16]).toBe(0xec);
    expect(ear[61 + 16]).toBe(0xec);
    expect(file?.extendedAttributeRecordFields?.createdAt.toISOString()).toBe("2026-07-05T23:02:03.450Z");
    expect(file?.extendedAttributeRecordFields?.modifiedAt.toISOString()).toBe("2026-07-05T23:02:03.450Z");
    expect(file?.extendedAttributeRecordFields?.expiresAt?.toISOString()).toBe("2026-07-05T23:02:03.450Z");
    expect(file?.extendedAttributeRecordFields?.effectiveAt?.toISOString()).toBe("2026-07-05T23:02:03.450Z");
  });

  test("rejects invalid time zone offsets", () => {
    expect(() => createIsoImage([], {
      timeZoneOffsetMinutes: 7,
    })).toThrow(/divisible by 15/i);

    expect(() => createIsoImage([], {
      timeZoneOffsetMinutes: 795,
    })).toThrow(/between -12:00 and \+13:00/i);

    expect(() => encodeExtendedAttributeRecord({
      timeZoneOffsetMinutes: 7,
    })).toThrow(/divisible by 15/i);
  });

  test("rejects unrepresentable volume descriptor date years", () => {
    const validCreatedAt = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
    const unrepresentable = new Date(Date.UTC(10000, 0, 1, 0, 0, 0));

    expect(() => createIsoImage([{ path: "DATE.TXT", data: "date\n" }], {
      createdAt: validCreatedAt,
      modifiedAt: unrepresentable,
    })).toThrow(/year.*1 to 9999/i);

    expect(() => encodeExtendedAttributeRecord({
      createdAt: unrepresentable,
    })).toThrow(/year.*1 to 9999/i);
  });

  test("writes and parses the maximum volume descriptor date year", () => {
    const createdAt = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
    const date = new Date(Date.UTC(9999, 11, 31, 23, 59, 59));
    const image = createIsoImage([{ path: "MAXYEAR.TXT", data: "max year\n" }], {
      createdAt,
      modifiedAt: date,
      effectiveAt: date,
      expiresAt: date,
    });
    const primary = parseVolumeDescriptors(image).find((descriptor) => descriptor.kind === "primary");

    expect(validateIsoImage(image)).toEqual([]);
    expect(primary?.kind === "primary" ? primary.modifiedAt?.toISOString() : undefined).toBe("9999-12-31T23:59:59.000Z");
    expect(parseIsoImage(image).files.map((file) => file.path)).toEqual(["MAXYEAR.TXT"]);
  });
});

function getRootDirectoryBytes(image: Uint8Array): Uint8Array {
  const extent = readUint32LE(image, PVD_OFFSET + 156 + 2);
  const size = readUint32LE(image, PVD_OFFSET + 156 + 10);
  return image.subarray(extent * SECTOR_SIZE, extent * SECTOR_SIZE + size);
}

function findDirectoryRecord(directory: Uint8Array, identifier: string): Uint8Array {
  const expected = asciiBytes(identifier);
  let offset = 0;

  while (offset < directory.byteLength) {
    const length = directory[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    const identifierLength = directory[offset + 32]!;
    const actual = directory.subarray(offset + 33, offset + 33 + identifierLength);
    if (bytesEqual(actual, expected)) {
      return directory.slice(offset, offset + length);
    }
    offset += length;
  }

  throw new Error(`missing directory record for ${identifier}`);
}

function readUint32Both(bytes: Uint8Array, offset: number): number {
  const little = readUint32LE(bytes, offset);
  const big = readUint32BE(bytes, offset + 4);
  if (little !== big) {
    throw new Error(`both-endian uint32 mismatch: ${little} !== ${big}`);
  }
  return little;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
