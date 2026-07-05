import { describe, expect, test } from "vitest";

import { createIsoImage, validateIsoImage } from "../src/index";
import { SECTOR_SIZE } from "../src/types";
import { readBothEndianUint32, readUint32LE } from "./helpers";

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

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^(image\.parse|descriptor\.)/),
          message: expect.stringMatching(/version/i),
        }),
      ]),
    );
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
