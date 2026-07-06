import { describe, expect, test } from "vitest";

import { createIsoImage, validateIsoImage } from "../src/index";
import { SECTOR_SIZE } from "../src/types";
import { readBothEndianUint32, readUint32BE, readUint32LE } from "./helpers";

const PVD_OFFSET = 16 * SECTOR_SIZE;
const TERMINATOR_OFFSET = 17 * SECTOR_SIZE;

describe("validateIsoImage hardening", () => {
  test("reports nonzero terminator reserved bytes without failing parse", () => {
    const image = baselineImage();
    image[TERMINATOR_OFFSET + 7] = 0xff;

    expect(validateIsoImage(image)).toEqual([
      expect.objectContaining({
        code: "descriptor.terminator_reserved",
      }),
    ]);
  });

  test("reports a bad descriptor version as a validation issue", () => {
    const image = baselineImage();
    image[PVD_OFFSET + 6] = 2;

    expect(validateIsoImage(image)).toEqual([
      expect.objectContaining({
        code: "descriptor.sequence",
        message: expect.stringMatching(/^expected primary volume descriptor version 1$/i),
      }),
    ]);
  });

  test("reports a path table parent directory number outside the record range", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested\n" }]);
    const pathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 99;
    image[childParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/path.?table|parent/i),
          message: expect.stringMatching(/parent|range/i),
        }),
      ]),
    );
  });

  test("reports a Type M path table record that points to itself as parent", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested\n" }]);
    const pathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 0;
    image[childParentDirectoryNumberOffset + 1] = 2;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.big.parent",
          message: expect.stringMatching(/Type M path table record 2 parent number 2/i),
        }),
      ]),
    );
  });

  test("reports a path table record that points to itself as parent", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested\n" }]);
    const pathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 2;
    image[childParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.parent",
          message: expect.stringMatching(/parent/i),
        }),
      ]),
    );
    expect(validateIsoImage(image)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "image.parse",
        }),
      ]),
    );
  });

  test("reports a directory record that crosses a sector boundary", () => {
    const image = baselineImage();
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    setRootDirectorySize(image, SECTOR_SIZE * 2);
    const crossingRecordOffset = rootDirectoryOffset + SECTOR_SIZE - 10;
    image[crossingRecordOffset] = 34;
    image[crossingRecordOffset + 32] = 1;
    image[crossingRecordOffset + 33] = "X".charCodeAt(0);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/director|record/i),
          message: expect.stringMatching(/sector|boundar|record/i),
        }),
      ]),
    );
  });

  test("reports a malformed directory record instead of relying on undefined reads", () => {
    const image = baselineImage([{ path: "FILE.TXT", data: "file\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const firstChildRecordOffset = rootDirectoryOffset + 68;
    image[firstChildRecordOffset] = 33;
    image[firstChildRecordOffset + 32] = 20;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/director|record/i),
          message: expect.stringMatching(/malformed|length|identifier|record/i),
        }),
      ]),
    );
  });

  test("reports reserved file flag bits inside nested directories", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirSize = readBothEndianUint32(image, dirRecordOffset + 10);
    const fileRecordOffset = findDirectoryRecordOffset(image, dirExtent * SECTOR_SIZE, dirSize, "FILE.TXT;1");
    image[fileRecordOffset + 25] = 0x20;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_reserved",
          path: "DIR",
          message: expect.stringMatching(/reserved/i),
        }),
      ]),
    );
  });

  test("reports malformed extended attribute records inside nested directories", () => {
    const image = baselineImage([{
      path: "DIR/FILE.TXT",
      data: "nested ear\n",
      extendedAttributeRecord: {
        systemIdentifier: "VALIDATION",
      },
    }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirSize = readBothEndianUint32(image, dirRecordOffset + 10);
    const fileRecordOffset = findDirectoryRecordOffset(image, dirExtent * SECTOR_SIZE, dirSize, "FILE.TXT;1");
    const fileExtent = readBothEndianUint32(image, fileRecordOffset + 2);
    image[fileExtent * SECTOR_SIZE + 182] = 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.parse",
          path: "DIR/FILE.TXT",
          message: expect.stringMatching(/reserved bytes/i),
        }),
      ]),
    );
  });

  test("reports supplementary path table parent issues", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const pathTableOffset = readUint32LE(image, supplementaryDescriptorOffset + 140) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 2;
    image[childParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary_path_table.little.parent",
          message: expect.stringMatching(/parent/i),
        }),
      ]),
    );
  });

  test("reports supplementary Type M path table parent issues", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const pathTableOffset = readUint32BE(image, supplementaryDescriptorOffset + 148) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 0;
    image[childParentDirectoryNumberOffset + 1] = 2;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary_path_table.big.parent",
          message: expect.stringMatching(/Type M path table record 2 parent number 2/i),
        }),
      ]),
    );
  });

  test("reports enhanced path table parent issues", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const enhancedDescriptorOffset = 17 * SECTOR_SIZE;
    const pathTableOffset = readUint32LE(image, enhancedDescriptorOffset + 140) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 2;
    image[childParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "enhanced_path_table.little.parent",
          message: expect.stringMatching(/parent/i),
        }),
      ]),
    );
  });

  test("reports directory record issues inside supplementary hierarchies", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const supplementaryRootRecordOffset = supplementaryDescriptorOffset + 156;
    const supplementaryRootExtent = readBothEndianUint32(image, supplementaryRootRecordOffset + 2);
    const supplementaryRootSize = readBothEndianUint32(image, supplementaryRootRecordOffset + 10);
    const dirRecordOffset = findDirectoryRecordOffset(image, supplementaryRootExtent * SECTOR_SIZE, supplementaryRootSize, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirSize = readBothEndianUint32(image, dirRecordOffset + 10);
    const fileRecordOffset = findDirectoryRecordOffset(image, dirExtent * SECTOR_SIZE, dirSize, "FILE.TXT;1");
    image[fileRecordOffset + 25] = 0x20;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_reserved",
          path: "supplementary:./DIR",
          message: expect.stringMatching(/reserved/i),
        }),
      ]),
    );
  });
});

function baselineImage(files = [{ path: "README.TXT", data: "hello ecma-119\n" }]): Uint8Array {
  return createIsoImage(files, {
    volumeIdentifier: "VALIDATION",
    createdAt: new Date("2024-01-01T00:00:00Z"),
  });
}

function rootDirectoryExtent(image: Uint8Array): number {
  return readBothEndianUint32(image, PVD_OFFSET + 156 + 2);
}

function setRootDirectorySize(image: Uint8Array, size: number): void {
  writeUint32Both(image, PVD_OFFSET + 156 + 10, size);
}

function findDirectoryRecordOffset(image: Uint8Array, directoryOffset: number, directorySize: number, identifier: string): number {
  const expected = new TextEncoder().encode(identifier);
  let offset = directoryOffset;
  const end = directoryOffset + directorySize;
  while (offset < end) {
    const length = image[offset];
    if (length === 0) {
      offset = Math.ceil((offset - directoryOffset + 1) / SECTOR_SIZE) * SECTOR_SIZE + directoryOffset;
      continue;
    }
    const identifierLength = image[offset + 32];
    const actual = image.subarray(offset + 33, offset + 33 + identifierLength);
    if (bytesEqual(actual, expected)) {
      return offset;
    }
    offset += length;
  }
  throw new Error(`missing directory record ${identifier}`);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function writeUint32Both(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
  bytes[offset + 4] = (value >>> 24) & 0xff;
  bytes[offset + 5] = (value >>> 16) & 0xff;
  bytes[offset + 6] = (value >>> 8) & 0xff;
  bytes[offset + 7] = value & 0xff;
}
