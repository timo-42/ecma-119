import { describe, expect, test } from "vitest";

import { createIsoImage, parseIsoImage, validateIsoImage } from "../src/index";
import { SECTOR_SIZE } from "../src/types";

describe("directory record file flags", () => {
  test("writes hidden and associated flags for files", () => {
    const image = createIsoImage([{
      path: "FLAGS.TXT",
      data: "file flags\n",
      hidden: true,
      associated: true,
    }]);

    const record = findRootRecord(image, "FLAGS.TXT;1");
    const parsed = parseIsoImage(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(record[25]).toBe(0x05);
    expect(parsed.files[0]).toMatchObject({
      path: "FLAGS.TXT",
      flags: 0x05,
    });
  });

  test("writes hidden flags for directories", () => {
    const image = createIsoImage([{
      path: "DIR/FILE.TXT",
      data: "directory flags\n",
    }], {
      directories: [{
        path: "DIR",
        hidden: true,
      }],
    });

    const record = findRootRecord(image, "DIR");
    const parsed = parseIsoImage(image);
    const directory = parsed.root.children.find((node) => node.identifier === "DIR");

    expect(validateIsoImage(image)).toEqual([]);
    expect(record[25]).toBe(0x03);
    expect(directory).toMatchObject({
      path: "DIR",
      flags: 0x03,
    });
  });

  test("preserves file input flags when structured extended attribute records set Record and Protection", () => {
    const image = createIsoImage([{
      path: "EAR.TXT",
      data: "file ear flags\n",
      hidden: true,
      associated: true,
      extendedAttributeRecord: {
        ownerIdentification: 1,
        groupIdentification: 1,
        recordFormat: 1,
        recordAttributes: 0,
        recordLength: 12,
      },
    }]);

    const record = findRootRecord(image, "EAR.TXT;1");
    const parsed = parseIsoImage(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(record[25]).toBe(0x1d);
    expect(parsed.files[0]).toMatchObject({
      path: "EAR.TXT",
      flags: 0x1d,
    });
  });

  test("preserves directory input flags and only applies EAR Protection to directories", () => {
    const image = createIsoImage([{
      path: "DIR/FILE.TXT",
      data: "directory ear flags\n",
    }], {
      directories: [{
        path: "DIR",
        hidden: true,
        extendedAttributeRecord: {
          ownerIdentification: 1,
          groupIdentification: 1,
          recordFormat: 1,
          recordAttributes: 0,
          recordLength: 12,
        },
      }],
    });

    const record = findRootRecord(image, "DIR");
    const parsed = parseIsoImage(image);
    const directory = parsed.root.children.find((node) => node.identifier === "DIR");

    expect(validateIsoImage(image)).toEqual([]);
    expect(record[25]).toBe(0x13);
    expect(directory).toMatchObject({
      path: "DIR",
      flags: 0x13,
    });
  });

  test("rejects associated directory inputs", () => {
    expect(() => createIsoImage([{
      path: "DIR/FILE.TXT",
      data: "directory associated flag\n",
    }], {
      directories: [{
        path: "DIR",
        associated: true,
      }],
    })).toThrow(/directory records must not set the Associated File bit/i);
  });
});

function findRootRecord(image: Uint8Array, identifier: string): Uint8Array {
  const root = rootDirectoryBytes(image);
  const expected = asciiBytes(identifier);
  let offset = 0;

  while (offset < root.byteLength) {
    const length = root[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    const identifierLength = root[offset + 32]!;
    const actual = root.subarray(offset + 33, offset + 33 + identifierLength);
    if (bytesEqual(actual, expected)) {
      return root.slice(offset, offset + length);
    }
    offset += length;
  }

  throw new Error(`missing directory record for ${identifier}`);
}

function rootDirectoryBytes(image: Uint8Array): Uint8Array {
  const pvdOffset = 16 * SECTOR_SIZE;
  const extent = readUint32LE(image, pvdOffset + 156 + 2);
  const size = readUint32LE(image, pvdOffset + 156 + 10);
  return image.subarray(extent * SECTOR_SIZE, extent * SECTOR_SIZE + size);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
