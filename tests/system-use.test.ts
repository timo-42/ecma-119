import { describe, expect, test } from "vitest";

import { createIsoImage, parseIsoImage, validateIsoImage } from "../src/index";
import { SECTOR_SIZE } from "../src/types";

describe("directory record System Use", () => {
  test("writes file System Use bytes after the identifier padding and parses them back", () => {
    const data = asciiBytes("opaque payload\n");
    const systemUse = Uint8Array.of(0x53, 0x55, 0x01, 0xfe, 0x00, 0x7f);
    const image = createIsoImage([{
      path: "AB.TXT",
      data,
      systemUse,
    }]);

    const record = findRootFileRecord(image, "AB.TXT;1");
    const identifierLength = record[32]!;
    const systemUseOffset = 33 + identifierLength + ((33 + identifierLength) % 2 === 0 ? 0 : 1);

    expect(identifierLength).toBe(8);
    expect(record.subarray(33, 33 + identifierLength)).toEqual(asciiBytes("AB.TXT;1"));
    expect(record[33 + identifierLength]).toBe(0);
    expect(record.subarray(systemUseOffset)).toEqual(systemUse);

    const parsed = parseIsoImage(image, { includeData: true });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "AB.TXT",
      identifier: "AB.TXT;1",
      size: data.byteLength,
    });
    expect(parsed.files[0]?.data).toEqual(data);
    expect(parsed.files[0]?.systemUse).toEqual(systemUse);
  });

  test("writes directory System Use bytes after the identifier padding and parses them back", () => {
    const systemUse = Uint8Array.of(0x44, 0x49, 0x52, 0x01, 0xfe);
    const image = createIsoImage([{
      path: "DIR/FILE.TXT",
      data: "directory system use\n",
    }], {
      directories: [{
        path: "DIR",
        systemUse,
      }],
    });

    const record = findRootFileRecord(image, "DIR");
    const identifierLength = record[32]!;
    const systemUseOffset = 33 + identifierLength + ((33 + identifierLength) % 2 === 0 ? 0 : 1);

    expect(validateIsoImage(image)).toEqual([]);
    expect(identifierLength).toBe(3);
    expect(record.subarray(33, 33 + identifierLength)).toEqual(asciiBytes("DIR"));
    expect(systemUseOffset).toBe(33 + identifierLength);
    expect(record.subarray(systemUseOffset)).toEqual(systemUse);

    const parsed = parseIsoImage(image, { includeData: true });
    const directory = parsed.root.children.find((entry) => entry.identifier === "DIR");

    expect(directory).toMatchObject({
      path: "DIR",
      identifier: "DIR",
      flags: 0x02,
    });
    expect(directory?.systemUse).toEqual(systemUse);
    expect(parsed.files[0]?.path).toBe("DIR/FILE.TXT");
  });

  test("rejects file System Use bytes that would make a directory record exceed 255 bytes", () => {
    const tooLong = new Uint8Array(214);

    expect(() => createIsoImage([{
      path: "AB.TXT",
      data: "x",
      systemUse: tooLong,
    }])).toThrow(/directory record|system use|255/i);
  });

  test("rejects directory System Use bytes that would make a directory record exceed 255 bytes", () => {
    const tooLong = new Uint8Array(220);

    expect(() => createIsoImage([], {
      directories: [{
        path: "DIR",
        systemUse: tooLong,
      }],
    })).toThrow(/directory record|system use|255/i);
  });

  test("preserves System Use bytes from handcrafted directory records", () => {
    const data = asciiBytes("handcrafted system use\n");
    const systemUse = Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x11);
    const image = handcraftedIsoWithSystemUse(data, systemUse);

    const parsed = parseIsoImage(image, { includeData: true });

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "HELLO.TXT",
      identifier: "HELLO.TXT;1",
      size: data.byteLength,
    });
    expect(parsed.files[0]?.data).toEqual(data);
    expect(parsed.files[0]?.systemUse).toEqual(systemUse);
  });

  test("preserves directory System Use bytes from handcrafted directory records", () => {
    const systemUse = Uint8Array.of(0xda, 0x7a, 0x10, 0x20, 0x30);
    const image = handcraftedIsoWithDirectorySystemUse(systemUse);

    const parsed = parseIsoImage(image, { includeData: true });
    const directory = parsed.root.children.find((entry) => entry.identifier === "DIR");

    expect(validateIsoImage(image)).toEqual([]);
    expect(directory).toMatchObject({
      path: "DIR",
      identifier: "DIR",
      flags: 0x02,
    });
    expect(directory?.systemUse).toEqual(systemUse);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe("DIR/HELLO.TXT");
    expect(parsed.files[0]?.data).toEqual(asciiBytes("directory handmade\n"));
  });

  test("preserves System Use bytes from mutated writer records", () => {
    const systemUse = Uint8Array.of(0x45, 0x52, 0x02, 0x99);
    const image = createIsoImage([{ path: "MUTATE.TXT", data: "mutated\n" }]);
    const rootDirectory = getRootDirectoryBytes(image);
    const recordOffset = findRootFileRecordOffset(image, "MUTATE.TXT;1");
    const recordLength = rootDirectory[recordOffset]!;
    const mutated = new Uint8Array(recordLength + systemUse.byteLength);

    mutated.set(rootDirectory.subarray(recordOffset, recordOffset + recordLength));
    mutated[0] = mutated.byteLength;
    mutated.set(systemUse, recordLength);
    rootDirectory.copyWithin(recordOffset + mutated.byteLength, recordOffset + recordLength);
    rootDirectory.set(mutated, recordOffset);
    patchRootDirectorySize(image, SECTOR_SIZE);

    const parsed = parseIsoImage(image, { includeData: true });

    expect(parsed.files[0]?.path).toBe("MUTATE.TXT");
    expect(parsed.files[0]?.data).toEqual(asciiBytes("mutated\n"));
    expect(parsed.files[0]?.systemUse).toEqual(systemUse);
  });

  test("validateIsoImage reports nonzero file identifier padding before System Use", () => {
    const image = createIsoImage([{
      path: "AB.TXT",
      data: "x",
      systemUse: Uint8Array.of(0x53, 0x55),
    }]);
    const rootDirectory = getRootDirectoryBytes(image);
    const recordOffset = findRootFileRecordOffset(image, "AB.TXT;1");
    const identifierLength = rootDirectory[recordOffset + 32]!;
    const paddingOffset = recordOffset + 33 + identifierLength;
    rootDirectory[paddingOffset] = 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.record_padding",
          message: expect.stringMatching(/padding/i),
        }),
      ]),
    );
  });
});

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

function handcraftedIsoWithSystemUse(data: Uint8Array, systemUse: Uint8Array): Uint8Array {
  const image = new Uint8Array(24 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const rootDirectory = sector(image, 20);
  const fileData = sector(image, 21);
  const pathTableL = sector(image, 18);
  const pathTableM = sector(image, 19);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

  fileData.set(data);
  writePathTableRoot(pathTableL, "little", 20);
  writePathTableRoot(pathTableM, "big", 20);

  let offset = 0;
  const self = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date });
  const parent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const file = directoryRecord({ extent: 21, size: data.byteLength, flags: 0, identifier: asciiBytes("HELLO.TXT;1"), date, systemUse });
  rootDirectory.set(self, offset);
  offset += self.byteLength;
  rootDirectory.set(parent, offset);
  offset += parent.byteLength;
  rootDirectory.set(file, offset);

  pvd[0] = 1;
  writeAscii(pvd, 1, 5, "CD001", 0);
  pvd[6] = 1;
  writeAscii(pvd, 8, 32, "HANDMADE_SYSTEM", 0x20);
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

function handcraftedIsoWithDirectorySystemUse(systemUse: Uint8Array): Uint8Array {
  const image = new Uint8Array(25 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const rootDirectory = sector(image, 20);
  const childDirectory = sector(image, 21);
  const fileData = sector(image, 22);
  const pathTableL = sector(image, 18);
  const pathTableM = sector(image, 19);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const filePayload = asciiBytes("directory handmade\n");

  fileData.set(filePayload);
  writePathTable(pathTableL, "little", [
    { identifier: Uint8Array.of(0), extent: 20, parent: 1 },
    { identifier: asciiBytes("DIR"), extent: 21, parent: 1 },
  ]);
  writePathTable(pathTableM, "big", [
    { identifier: Uint8Array.of(0), extent: 20, parent: 1 },
    { identifier: asciiBytes("DIR"), extent: 21, parent: 1 },
  ]);

  const rootSelf = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date });
  const rootParent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const childRecord = directoryRecord({ extent: 21, size: SECTOR_SIZE, flags: 0x02, identifier: asciiBytes("DIR"), date, systemUse });
  let offset = 0;
  rootDirectory.set(rootSelf, offset);
  offset += rootSelf.byteLength;
  rootDirectory.set(rootParent, offset);
  offset += rootParent.byteLength;
  rootDirectory.set(childRecord, offset);

  const childSelf = directoryRecord({ extent: 21, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date, systemUse });
  const childParent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const file = directoryRecord({ extent: 22, size: filePayload.byteLength, flags: 0, identifier: asciiBytes("HELLO.TXT;1"), date });
  offset = 0;
  childDirectory.set(childSelf, offset);
  offset += childSelf.byteLength;
  childDirectory.set(childParent, offset);
  offset += childParent.byteLength;
  childDirectory.set(file, offset);

  pvd[0] = 1;
  writeAscii(pvd, 1, 5, "CD001", 0);
  pvd[6] = 1;
  writeAscii(pvd, 8, 32, "HANDMADE_SYSTEM", 0x20);
  writeAscii(pvd, 40, 32, "HANDMADE", 0x20);
  writeBoth32(pvd, 80, 25);
  writeBoth16(pvd, 120, 1);
  writeBoth16(pvd, 124, 1);
  writeBoth16(pvd, 128, SECTOR_SIZE);
  writeBoth32(pvd, 132, 22);
  writeUint32LE(pvd, 140, 18);
  writeUint32BE(pvd, 148, 19);
  pvd.set(rootSelf, 156);
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

function sector(image: Uint8Array, sectorNumber: number): Uint8Array {
  return image.subarray(sectorNumber * SECTOR_SIZE, (sectorNumber + 1) * SECTOR_SIZE);
}

function directoryRecord(input: {
  extent: number;
  size: number;
  flags: number;
  identifier: Uint8Array;
  date: Date;
  systemUse?: Uint8Array;
}): Uint8Array {
  const baseLength = 33 + input.identifier.byteLength;
  const identifierPadding = baseLength % 2 === 0 ? 0 : 1;
  const systemUse = input.systemUse ?? new Uint8Array();
  const length = baseLength + identifierPadding + systemUse.byteLength;
  const bytes = new Uint8Array(length);
  bytes[0] = length;
  writeBoth32(bytes, 2, input.extent);
  writeBoth32(bytes, 10, input.size);
  bytes.set(directoryDate(input.date), 18);
  bytes[25] = input.flags;
  writeBoth16(bytes, 28, 1);
  bytes[32] = input.identifier.byteLength;
  bytes.set(input.identifier, 33);
  bytes.set(systemUse, baseLength + identifierPadding);
  return bytes;
}

function patchRootDirectorySize(image: Uint8Array, size: number): void {
  const pvd = sector(image, 16);
  writeBoth32(pvd, 156 + 10, size);
  const rootDirectory = getRootDirectoryBytes(image);
  writeBoth32(rootDirectory, 10, size);
  const parentOffset = rootDirectory[0]!;
  writeBoth32(rootDirectory, parentOffset + 10, size);
}

function writePathTableRoot(bytes: Uint8Array, endian: "little" | "big", extent: number): void {
  writePathTable(bytes, endian, [{ identifier: Uint8Array.of(0), extent, parent: 1 }]);
}

function writePathTable(
  bytes: Uint8Array,
  endian: "little" | "big",
  records: Array<{ identifier: Uint8Array; extent: number; parent: number }>,
): void {
  let offset = 0;
  for (const record of records) {
    bytes[offset] = record.identifier.byteLength;
    bytes[offset + 1] = 0;
    if (endian === "little") {
      writeUint32LE(bytes, offset + 2, record.extent);
      writeUint16LE(bytes, offset + 6, record.parent);
    } else {
      writeUint32BE(bytes, offset + 2, record.extent);
      writeUint16BE(bytes, offset + 6, record.parent);
    }
    bytes.set(record.identifier, offset + 8);
    offset += 8 + record.identifier.byteLength + (record.identifier.byteLength % 2 === 0 ? 0 : 1);
  }
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
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function writeBoth16(bytes: Uint8Array, offset: number, value: number): void {
  writeUint16LE(bytes, offset, value);
  writeUint16BE(bytes, offset + 2, value);
}

function writeBoth32(bytes: Uint8Array, offset: number, value: number): void {
  writeUint32LE(bytes, offset, value);
  writeUint32BE(bytes, offset + 4, value);
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
