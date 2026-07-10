import { describe, expect, test } from "vitest";

import { createUdfImage, parseUdfImage, parseUdfVolumeStructures, UDF_DESCRIPTOR_TAG_IDENTIFIER, validateUdfImage } from "../src/udf/index";
import { finalizeUdfDescriptor } from "../src/udf/codec";

describe("UDF 2.01 ECMA-167 images", () => {
  test("writes, validates, and reads nested regular files with OSTA Unicode names", () => {
    const image = createUdfImage([
      { path: "README.TXT", data: "hello UDF\n" },
      { path: "DOCS/CAFÉ.TXT", data: "unicode\n" },
      { path: "DOCS/EMPTY.BIN", data: new Uint8Array() },
    ], {
      volumeIdentifier: "TEST_UDF",
      fileSetIdentifier: "TEST_SET",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsed = parseUdfImage(image, { includeData: true });

    expect(validateUdfImage(image)).toEqual([]);
    expect(parseUdfVolumeStructures(image).map((structure) => structure.identifier)).toEqual(["BEA01", "NSR03", "TEA01"]);
    expect(parsed.primaryVolumeDescriptor).toMatchObject({ volumeIdentifier: "TEST_UDF" });
    expect(parsed.logicalVolumeDescriptor).toMatchObject({ logicalVolumeIdentifier: "TEST_UDF", logicalBlockSize: 2048 });
    expect(parsed.fileSetDescriptor).toMatchObject({ fileSetIdentifier: "TEST_SET" });
    expect(parsed.files.map((file) => file.path)).toEqual(["DOCS/CAFÉ.TXT", "DOCS/EMPTY.BIN", "README.TXT"]);
    expect(parsed.files.map((file) => [file.path, new TextDecoder().decode(file.data)])).toEqual([
      ["DOCS/CAFÉ.TXT", "unicode\n"],
      ["DOCS/EMPTY.BIN", ""],
      ["README.TXT", "hello UDF\n"],
    ]);
    const docs = parsed.root.children.find((node) => node.kind === "directory" && node.name === "DOCS");
    expect(docs?.descriptor.allocationDescriptors).toHaveLength(1);
  });

  test("can omit payload bytes while retaining the UDF tree", () => {
    const image = createUdfImage([{ path: "DATA.BIN", data: Uint8Array.of(1, 2, 3) }]);
    const parsed = parseUdfImage(image, { includeData: false });

    expect(parsed.files[0]).toMatchObject({ path: "DATA.BIN", size: 3 });
    expect(parsed.files[0]?.data).toBeUndefined();
  });

  test("rejects malformed anchors and unsupported writer settings", () => {
    const image = createUdfImage([{ path: "DATA.BIN", data: "x" }]);
    image[256 * 2048] ^= 0xff;

    expect(() => parseUdfImage(image)).toThrow(/descriptor tag identifier mismatch|descriptor tag checksum mismatch/i);
    expect(validateUdfImage(image)).toEqual([expect.objectContaining({ code: "udf.parse" })]);
    expect(() => createUdfImage([], { revision: "2.50" })).toThrow(/revision 2\.01 only/i);
    expect(() => createUdfImage([], { logicalBlockSize: 1024 })).toThrow(/2048-byte logical block size/i);
  });

  test("rejects allocation extents that exceed the selected partition", () => {
    const image = createUdfImage([{ path: "DATA.BIN", data: "x" }]);
    const partitionStart = 274;
    const rootFileEntry = partitionStart + 1;
    const rootOffset = rootFileEntry * 2048;
    const rootLength = 16 + image[rootOffset + 10]! + (image[rootOffset + 11]! << 8);
    const root = image.slice(rootOffset, rootOffset + rootLength);
    root[180] = 0xff;
    root[181] = 0xff;
    root[182] = 0xff;
    root[183] = 0x7f;
    image.set(finalizeUdfDescriptor(root, {
      tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.FILE_ENTRY,
      tagLocation: 1,
    }), rootOffset);

    expect(() => parseUdfImage(image)).toThrow(/allocation descriptor exceeds partition bounds/i);
  });
});
