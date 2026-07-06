import { describe, expect, test } from "vitest";

import { createIsoImage, encodeDirectoryRecord, encodePathTable, parseIsoImage, validateIsoImage } from "../src/index";
import { SECTOR_SIZE } from "../src/types";

describe("extended attribute records", () => {
  test("writes raw extended attribute logical blocks before file data and parses them back", () => {
    const data = asciiBytes("file data after ear\n");
    const extendedAttributeRecord = makeExtendedAttributeRecord("writer ear");
    const image = createIsoImage([{
      path: "EAR.TXT",
      data,
      extendedAttributeRecord,
    }]);

    const record = findRootFileRecord(image, "EAR.TXT;1");
    const extent = readBoth32(record, 2);

    expect(record[1]).toBe(1);
    expect(image.subarray(extent * SECTOR_SIZE, extent * SECTOR_SIZE + extendedAttributeRecord.byteLength)).toEqual(extendedAttributeRecord);
    expect(image.subarray((extent + 1) * SECTOR_SIZE, (extent + 1) * SECTOR_SIZE + data.byteLength)).toEqual(data);

    const parsed = parseIsoImage(image, { includeData: true });
    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files[0]).toMatchObject({
      path: "EAR.TXT",
      identifier: "EAR.TXT;1",
      extent,
      extendedAttributeRecordLength: 1,
      size: data.byteLength,
    });
    expect(parsed.files[0]?.extendedAttributeRecord).toEqual(extendedAttributeRecord);
    expect(parsed.files[0]?.data).toEqual(data);
  });

  test("reads extended attribute records from an ISO image not produced by the writer", () => {
    const data = asciiBytes("handmade data\n");
    const extendedAttributeRecord = makeExtendedAttributeRecord("handmade ear");
    const image = handcraftedIsoWithExtendedAttributeRecord(data, extendedAttributeRecord);

    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "HELLO.TXT",
      identifier: "HELLO.TXT;1",
      extent: 21,
      extendedAttributeRecordLength: 1,
      size: data.byteLength,
    });
    expect(parsed.files[0]?.extendedAttributeRecord).toEqual(extendedAttributeRecord);
    expect(parsed.files[0]?.data).toEqual(data);
  });

  test("reports invalid bounds when an extended attribute length pushes data past the image", () => {
    const image = createIsoImage([{
      path: "BROKEN.TXT",
      data: "x",
      extendedAttributeRecord: makeExtendedAttributeRecord("bounds"),
    }]);
    const rootDirectory = getRootDirectoryBytes(image);
    const recordOffset = findRootFileRecordOffset(image, "BROKEN.TXT;1");
    rootDirectory[recordOffset + 1] = 255;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "image.parse",
          message: expect.stringMatching(/bounds/i),
        }),
      ]),
    );
  });

  test("rejects extended attribute records that cannot fit in the length byte", () => {
    expect(() => createIsoImage([{
      path: "HUGE.TXT",
      data: "x",
      extendedAttributeRecord: new Uint8Array(256 * SECTOR_SIZE),
    }])).toThrow(/255 logical blocks/i);
  });

  test("low-level encoders reject extended attribute lengths outside the 8-bit field", () => {
    const identifier = asciiBytes("TOO_BIG.TXT;1");
    const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

    expect(() => encodeDirectoryRecord({
      extent: 20,
      extendedAttributeRecordLength: 256,
      dataLength: 1,
      flags: 0,
      identifier,
      date,
    })).toThrow(/0 to 255 logical blocks/i);

    expect(() => encodePathTable([{
      identifier: Uint8Array.of(0),
      extent: 20,
      parentDirectoryNumber: 1,
      extendedAttributeRecordLength: 1.5,
    }], "little")).toThrow(/0 to 255 logical blocks/i);
  });
});

function handcraftedIsoWithExtendedAttributeRecord(data: Uint8Array, extendedAttributeRecord: Uint8Array): Uint8Array {
  const image = new Uint8Array(24 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const rootDirectory = sector(image, 20);
  const pathTableL = sector(image, 18);
  const pathTableM = sector(image, 19);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

  sector(image, 21).set(extendedAttributeRecord);
  sector(image, 22).set(data);
  writePathTableRoot(pathTableL, "little", 20);
  writePathTableRoot(pathTableM, "big", 20);

  let offset = 0;
  const self = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date });
  const parent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const file = directoryRecord({
    extent: 21,
    extendedAttributeRecordLength: 1,
    size: data.byteLength,
    flags: 0,
    identifier: asciiBytes("HELLO.TXT;1"),
    date,
  });
  rootDirectory.set(self, offset);
  offset += self.byteLength;
  rootDirectory.set(parent, offset);
  offset += parent.byteLength;
  rootDirectory.set(file, offset);

  pvd[0] = 1;
  writeAscii(pvd, 1, 5, "CD001", 0);
  pvd[6] = 1;
  writeAscii(pvd, 8, 32, "HANDMADE_EAR", 0x20);
  writeAscii(pvd, 40, 32, "HANDMADE", 0x20);
  writeBoth32(pvd, 80, 24);
  writeBoth16(pvd, 120, 1);
  writeBoth16(pvd, 124, 1);
  writeBoth16(pvd, 128, SECTOR_SIZE);
  writeBoth32(pvd, 132, 10);
  writeUint32LE(pvd, 140, 18);
  writeUint32BE(pvd, 148, 19);
  pvd.set(self, 156);
  writeAscii(pvd, 574, 128, "HANDCRAFTED TEST", 0x20);
  pvd.set(volumeDate(date), 813);
  pvd.set(volumeDate(date), 830);
  pvd.set(volumeDate(null), 847);
  pvd.set(volumeDate(date), 864);
  pvd[881] = 1;

  const terminator = sector(image, 17);
  terminator[0] = 255;
  writeAscii(terminator, 1, 5, "CD001", 0);
  terminator[6] = 1;

  return image;
}

function makeExtendedAttributeRecord(label: string): Uint8Array {
  const bytes = new Uint8Array(SECTOR_SIZE);
  writeBoth16(bytes, 0, 0);
  writeBoth16(bytes, 4, 0);
  writeBoth16(bytes, 8, 0);
  bytes.set(volumeDate(new Date(Date.UTC(2024, 0, 1, 0, 0, 0))), 10);
  bytes.set(volumeDate(new Date(Date.UTC(2024, 0, 1, 0, 0, 0))), 27);
  bytes.set(volumeDate(null), 44);
  bytes.set(volumeDate(new Date(Date.UTC(2024, 0, 1, 0, 0, 0))), 61);
  writeBoth16(bytes, 80, 0);
  writeAscii(bytes, 84, 32, "ECMA119_TEST", 0x20);
  bytes.set(asciiBytes(label), 116);
  bytes[180] = 1;
  writeBoth16(bytes, 246, 0);
  return bytes;
}

function getRootDirectoryBytes(image: Uint8Array): Uint8Array {
  const pvd = sector(image, 16);
  const extent = readUint32LE(pvd, 156 + 2);
  const size = readUint32LE(pvd, 156 + 10);
  return image.subarray(extent * SECTOR_SIZE, extent * SECTOR_SIZE + size);
}

function findRootFileRecord(image: Uint8Array, identifier: string): Uint8Array {
  const rootDirectory = getRootDirectoryBytes(image);
  const offset = findRootFileRecordOffset(image, identifier);
  return rootDirectory.slice(offset, offset + rootDirectory[offset]!);
}

function findRootFileRecordOffset(image: Uint8Array, identifier: string): number {
  const rootDirectory = getRootDirectoryBytes(image);
  const expected = asciiBytes(identifier);
  let offset = 0;

  while (offset < rootDirectory.byteLength) {
    const length = rootDirectory[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    const identifierLength = rootDirectory[offset + 32]!;
    const actual = rootDirectory.subarray(offset + 33, offset + 33 + identifierLength);
    if (bytesEqual(actual, expected)) {
      return offset;
    }
    offset += length;
  }

  throw new Error(`missing directory record for ${identifier}`);
}

function sector(image: Uint8Array, sectorNumber: number): Uint8Array {
  return image.subarray(sectorNumber * SECTOR_SIZE, (sectorNumber + 1) * SECTOR_SIZE);
}

function directoryRecord(input: {
  extent: number;
  extendedAttributeRecordLength?: number;
  size: number;
  flags: number;
  identifier: Uint8Array;
  date: Date;
}): Uint8Array {
  const baseLength = 33 + input.identifier.byteLength;
  const length = baseLength + (baseLength % 2 === 0 ? 0 : 1);
  const bytes = new Uint8Array(length);
  bytes[0] = length;
  bytes[1] = input.extendedAttributeRecordLength ?? 0;
  writeBoth32(bytes, 2, input.extent);
  writeBoth32(bytes, 10, input.size);
  bytes.set(directoryDate(input.date), 18);
  bytes[25] = input.flags;
  writeBoth16(bytes, 28, 1);
  bytes[32] = input.identifier.byteLength;
  bytes.set(input.identifier, 33);
  return bytes;
}

function writePathTableRoot(bytes: Uint8Array, endian: "little" | "big", extent: number): void {
  bytes[0] = 1;
  bytes[1] = 0;
  if (endian === "little") {
    writeUint32LE(bytes, 2, extent);
    writeUint16LE(bytes, 6, 1);
  } else {
    writeUint32BE(bytes, 2, extent);
    writeUint16BE(bytes, 6, 1);
  }
  bytes[8] = 0;
}

function directoryDate(date: Date): Uint8Array {
  return Uint8Array.of(
    date.getUTCFullYear() - 1900,
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    0,
  );
}

function volumeDate(date: Date | null): Uint8Array {
  const bytes = new Uint8Array(17);
  if (!date) {
    bytes.fill(0x30, 0, 16);
    return bytes;
  }
  bytes.set(asciiBytes([
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
    date.getUTCHours().toString().padStart(2, "0"),
    date.getUTCMinutes().toString().padStart(2, "0"),
    date.getUTCSeconds().toString().padStart(2, "0"),
    "00",
  ].join("")));
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, length: number, value: string, filler: number): void {
  bytes.fill(filler, offset, offset + length);
  bytes.set(asciiBytes(value), offset);
}

function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function readBoth32(bytes: Uint8Array, offset: number): number {
  const little = readUint32LE(bytes, offset);
  const big = readUint32BE(bytes, offset + 4);
  if (little !== big) {
    throw new Error("both-endian uint32 mismatch");
  }
  return little;
}

function writeBoth16(bytes: Uint8Array, offset: number, value: number): void {
  writeUint16LE(bytes, offset, value);
  writeUint16BE(bytes, offset + 2, value);
}

function writeBoth32(bytes: Uint8Array, offset: number, value: number): void {
  writeUint32LE(bytes, offset, value);
  writeUint32BE(bytes, offset + 4, value);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 24)
    | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8)
    | bytes[offset + 3]!
  ) >>> 0;
}

function writeUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
