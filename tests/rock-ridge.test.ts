import { describe, expect, test } from "vitest";

import { createIsoImage, encodeRockRidgeSystemUse, parseIsoImage, parseRockRidgeMetadata, parseSuspEntries, parseVolumeDescriptors, validateIsoImage, writeUint32Both } from "../src/index";
import { SECTOR_SIZE } from "../src/types";

describe("Rock Ridge extension metadata", () => {
  test("writes and reads inline Rock Ridge metadata without replacing ECMA-119 paths", () => {
    const modifiedAt = new Date("2024-01-02T03:04:05Z");
    const image = createIsoImage([{
      path: "README.TXT",
      data: "rock ridge\n",
      rockRidge: {
        name: "readme.txt",
        mode: 0o100644,
        links: 1,
        uid: 1000,
        gid: 1000,
        serial: 7,
        timestamps: { modifiedAt },
      },
    }], {
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const parsed = parseIsoImage(image, { includeData: true });
    const file = parsed.files[0];

    expect(validateIsoImage(image)).toEqual([]);
    expect(file).toMatchObject({
      path: "README.TXT",
      identifier: "README.TXT;1",
      rockRidge: {
        name: "readme.txt",
        posix: {
          mode: 0o100644,
          links: 1,
          uid: 1000,
          gid: 1000,
          serial: 7,
        },
      },
    });
    expect(file?.rockRidge?.timestamps?.modifiedAt?.toISOString()).toBe("2024-01-02T03:04:05.000Z");
    expect(parsed.root.rockRidge?.entries.map((entry) => entry.signature)).toEqual(["SP", "ER"]);
    expect(parsed.root.rockRidge?.susp?.skipBytes).toBe(0);
    expect(parsed.root.rockRidge?.susp?.extensions?.[0]).toMatchObject({
      identifier: "RRIP_1991A",
      version: 1,
    });
    expect(new TextDecoder("ascii").decode(file?.data)).toBe("rock ridge\n");
  });

  test("combines root Rock Ridge metadata with SUSP discovery entries", () => {
    const image = createIsoImage([{ path: "CHILD.TXT", data: "child\n", rockRidge: { name: "child.txt" } }], {
      directories: [{
        path: "",
        rockRidge: { name: "root" },
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.root.rockRidge?.entries.map((entry) => entry.signature)).toEqual(["SP", "ER", "NM"]);
    expect(parsed.root.rockRidge?.name).toBe("root");
    expect(parsed.files[0]?.rockRidge?.name).toBe("child.txt");
  });

  test("parses supported SUSP and RRIP entries from raw system use bytes", () => {
    const systemUse = encodeRockRidgeSystemUse({
      name: "link",
      mode: 0o120777,
      links: 1,
      uid: 5,
      gid: 6,
      serial: 9,
      symlink: "target/file",
      device: { major: 8, minor: 1 },
      childLinkExtent: 30,
      parentLinkExtent: 31,
      relocated: true,
    });

    const metadata = parseRockRidgeMetadata(systemUse);

    expect(metadata).toMatchObject({
      name: "link",
      posix: {
        mode: 0o120777,
        links: 1,
        uid: 5,
        gid: 6,
        serial: 9,
      },
      symlink: {
        target: "target/file",
      },
      device: { major: 8, minor: 1 },
      childLinkExtent: 30,
      parentLinkExtent: 31,
      relocated: true,
    });
    expect(metadata?.entries.map((entry) => entry.signature)).toEqual(["PX", "NM", "SL", "PN", "CL", "PL", "RE"]);
  });

  test("reads continuation area entries referenced by CE", () => {
    const image = new Uint8Array(SECTOR_SIZE * 2);
    const continuation = encodeRockRidgeSystemUse({ name: "continued.txt" });
    image.set(continuation, SECTOR_SIZE);
    const ce = new Uint8Array(28);
    ce[0] = 0x43;
    ce[1] = 0x45;
    ce[2] = 28;
    ce[3] = 1;
    writeUint32Both(ce, 4, 1);
    writeUint32Both(ce, 12, 0);
    writeUint32Both(ce, 20, continuation.byteLength);

    const entries = parseSuspEntries(ce, { image });
    const metadata = parseRockRidgeMetadata(ce, { image });

    expect(entries.map((entry) => `${entry.signature}:${entry.source}`)).toEqual(["CE:system-use", "NM:continuation"]);
    expect(metadata?.name).toBe("continued.txt");
  });

  test("rejects malformed SUSP entries and conflicting raw/structured authoring", () => {
    expect(() => parseSuspEntries(Uint8Array.of(0x4e, 0x4d, 0x03, 0x01))).toThrow(/invalid length/i);
    expect(() => createIsoImage([{
      path: "BAD.TXT",
      data: "bad\n",
      systemUse: Uint8Array.of(0x53, 0x55),
      rockRidge: { name: "bad.txt" },
    }])).toThrow(/cannot combine raw systemUse with structured rockRidge/i);
  });

  test("rejects non-ASCII Rock Ridge names and symlink targets", () => {
    expect(() => encodeRockRidgeSystemUse({ name: "café.txt" })).toThrow(/ASCII/i);
    expect(() => encodeRockRidgeSystemUse({ symlink: "café.txt" })).toThrow(/ASCII/i);
    expect(() => parseRockRidgeMetadata(Uint8Array.of(
      0x4e, 0x4d, 0x0e, 0x01, 0x00,
      0x63, 0x61, 0x66, 0xc3, 0xa9, 0x2e, 0x74, 0x78, 0x74,
    ))).toThrow(/ASCII bytes/i);
  });

  test("throws while parsing ISO images with malformed Rock Ridge text", () => {
    const image = createIsoImage([{
      path: "BAD.TXT",
      data: "bad\n",
      systemUse: Uint8Array.of(
        0x4e, 0x4d, 0x0e, 0x01, 0x00,
        0x63, 0x61, 0x66, 0xc3, 0xa9, 0x2e, 0x74, 0x78, 0x74,
      ),
    }], {
      directories: [{
        path: "",
        rockRidge: { name: "root" },
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    expect(() => parseIsoImage(image)).toThrow(/ASCII bytes/i);
  });

  test("preserves unknown SUSP entries after root discovery", () => {
    const unknownEntry = Uint8Array.of(0x5a, 0x5a, 0x04, 0x01);
    const image = createIsoImage([{
      path: "UNKNOWN.TXT",
      data: "unknown\n",
      systemUse: unknownEntry,
    }], {
      directories: [{
        path: "",
        rockRidge: { name: "root" },
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const parsed = parseIsoImage(image);

    expect(parsed.files[0]?.systemUse).toEqual(unknownEntry);
    expect(parsed.files[0]?.rockRidge?.entries).toEqual([
      expect.objectContaining({
        signature: "ZZ",
        length: 4,
        version: 1,
        offset: 0,
      }),
    ]);
    expect(parsed.files[0]?.rockRidge?.rawEntries).toHaveLength(1);
  });

  test("throws for malformed unknown SUSP entries after root discovery", () => {
    const image = createIsoImage([{
      path: "BADSUSP.TXT",
      data: "bad\n",
      systemUse: Uint8Array.of(0x5a, 0x5a, 0x03, 0x01),
    }], {
      directories: [{
        path: "",
        rockRidge: { name: "root" },
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    expect(() => parseIsoImage(image)).toThrow(/invalid length/i);
  });

  test("preserves opaque System Use without SUSP discovery", () => {
    const systemUse = Uint8Array.of(0x5a, 0x5a, 0x03, 0x01);
    const image = createIsoImage([{
      path: "OPAQUE.TXT",
      data: "opaque\n",
      systemUse,
    }], {
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const parsed = parseIsoImage(image);

    expect(parsed.files[0]?.systemUse).toEqual(systemUse);
    expect(parsed.files[0]?.rockRidge).toBeUndefined();
  });

  test("uses root SUSP skip length when parsing child Rock Ridge metadata", () => {
    const skipped = Uint8Array.of(0xaa, 0xbb);
    const childSystemUse = concat(skipped, encodeRockRidgeSystemUse({ name: "skip.txt" }));
    const image = createIsoImage([{
      path: "SKIP.TXT",
      data: "skip\n",
      systemUse: childSystemUse,
    }], {
      directories: [{
        path: "",
        rockRidge: { name: "root" },
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const primary = parseVolumeDescriptors(image).find((descriptor) => descriptor.kind === "primary");
    if (primary?.kind !== "primary") {
      throw new Error("expected primary descriptor");
    }
    const rootOffset = primary.rootDirectoryRecord.extent * SECTOR_SIZE;
    const selfRecordSystemUseOffset = rootOffset + directoryRecordSystemUseOffset(1);
    const spSkipByteOffset = selfRecordSystemUseOffset + 4 + 2;
    image[spSkipByteOffset] = skipped.byteLength;

    const parsed = parseIsoImage(image, { includeData: true });

    expect(parsed.root.rockRidge?.susp?.skipBytes).toBe(skipped.byteLength);
    expect(parsed.files[0]?.systemUse?.subarray(0, 2)).toEqual(skipped);
    expect(parsed.files[0]?.rockRidge?.name).toBe("skip.txt");
    expect(parsed.files[0]?.rockRidge?.entries[0]?.offset).toBe(skipped.byteLength);
  });
});

function directoryRecordSystemUseOffset(identifierLength: number): number {
  const base = 33 + identifierLength;
  return base + (base % 2 === 0 ? 0 : 1);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(left.byteLength + right.byteLength);
  bytes.set(left);
  bytes.set(right, left.byteLength);
  return bytes;
}
