import { describe, expect, test } from "vitest";

import { createIsoImage, parseIsoImage, parseVolumeDescriptors, validateIsoImage } from "../src/index";
import { SECTOR_SIZE } from "../src/types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("ascii");

describe("boot volume descriptor writing", () => {
  test("writes an optional boot descriptor without breaking file extents", () => {
    const bootSystemIdentifier = "BOOT SYSTEM IDENTIFIER 123456789";
    const bootIdentifier = "BOOT IDENTIFIER FIELD 1234567890";
    const bootSystemUse = Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x01, 0x02);
    const fileContents = encoder.encode("boot descriptor extent check\n");

    const image = createIsoImage(
      [{ path: "BOOT.TXT", data: fileContents }],
      {
        volumeIdentifier: "BOOT_DESCRIPTOR",
        bootRecord: {
          bootSystemIdentifier,
          bootIdentifier,
          bootSystemUse,
        },
      },
    );

    const descriptors = parseVolumeDescriptors(image);
    const terminatorIndex = descriptors.findIndex((descriptor) => descriptor.kind === "terminator");
    const bootIndex = descriptors.findIndex((descriptor) => descriptor.kind === "boot");

    expect(validateIsoImage(image)).toEqual([]);
    expect(terminatorIndex).toBeGreaterThan(-1);
    expect(bootIndex).toBeGreaterThan(-1);
    expect(bootIndex).toBeLessThan(terminatorIndex);

    const boot = descriptors[bootIndex]!;
    expect(boot).toMatchObject({
      type: 0,
      kind: "boot",
      identifier: "CD001",
      version: 1,
      bootSystemIdentifier,
      bootIdentifier,
    });
    expect(boot.raw.byteLength).toBe(SECTOR_SIZE);
    expect(boot.raw[0]).toBe(0);
    expect(ascii(boot.raw, 1, 6)).toBe("CD001");
    expect(boot.raw[6]).toBe(1);
    expect(ascii(boot.raw, 7, 39)).toBe(bootSystemIdentifier);
    expect(ascii(boot.raw, 39, 71)).toBe(bootIdentifier);
    expect(boot.raw.subarray(71, 71 + bootSystemUse.byteLength)).toEqual(bootSystemUse);

    if (boot.kind !== "boot") {
      throw new Error("expected parser to classify descriptor as boot");
    }
    expect(boot.bootSystemUse.subarray(0, bootSystemUse.byteLength)).toEqual(bootSystemUse);

    const parsed = parseIsoImage(image, { includeData: true });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "BOOT.TXT",
      identifier: "BOOT.TXT;1",
      size: fileContents.byteLength,
    });
    expect(parsed.files[0]?.data).toEqual(fileContents);
  });

  test("accepts maximum boot system use and rejects invalid boot descriptor inputs", () => {
    const maxBootUse = new Uint8Array(1977).fill(0xa5);
    const maxImage = createIsoImage(
      [{ path: "MAXBOOT.TXT", data: "ok" }],
      {
        bootRecord: {
          bootSystemIdentifier: "",
          bootIdentifier: "",
          bootSystemUse: maxBootUse,
        },
      },
    );
    const boot = parseVolumeDescriptors(maxImage).find((descriptor) => descriptor.kind === "boot");

    expect(validateIsoImage(maxImage)).toEqual([]);
    expect(boot?.raw.subarray(71)).toEqual(maxBootUse);
    expect(ascii(boot!.raw, 7, 39)).toBe(" ".repeat(32));
    expect(ascii(boot!.raw, 39, 71)).toBe(" ".repeat(32));
    expect(parseIsoImage(maxImage).files.map((file) => file.path)).toEqual(["MAXBOOT.TXT"]);

    expect(() => createIsoImage([{ path: "TOO_BIG.TXT", data: "x" }], {
      bootRecord: {
        bootSystemUse: new Uint8Array(1978),
      },
    })).toThrow(/boot system use/i);

    expect(() => createIsoImage([{ path: "BADBOOT.TXT", data: "x" }], {
      bootRecord: {
        bootSystemIdentifier: "invalid#identifier",
      },
    })).toThrow(/a-characters/i);
  });

  test("writes multiple boot descriptors", () => {
    const image = createIsoImage(
      [{ path: "BOOT.TXT", data: "multiple boot records\n" }],
      {
        bootRecord: {
          bootSystemIdentifier: "LEGACY_BOOT",
          bootIdentifier: "LEGACY",
          bootSystemUse: Uint8Array.of(0x01),
        },
        bootRecords: [
          {
            bootSystemIdentifier: "SECOND_BOOT",
            bootIdentifier: "SECOND",
            bootSystemUse: Uint8Array.of(0x02, 0x03),
          },
          {
            bootSystemIdentifier: "THIRD_BOOT",
            bootIdentifier: "THIRD",
          },
        ],
      },
    );
    const descriptors = parseVolumeDescriptors(image);
    const bootDescriptors = descriptors.filter((descriptor) => descriptor.kind === "boot");

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "boot", "boot", "boot", "terminator"]);
    expect(bootDescriptors).toHaveLength(3);
    expect(bootDescriptors[0]).toMatchObject({ bootSystemIdentifier: "LEGACY_BOOT", bootIdentifier: "LEGACY" });
    expect(bootDescriptors[1]).toMatchObject({ bootSystemIdentifier: "SECOND_BOOT", bootIdentifier: "SECOND" });
    expect(bootDescriptors[2]).toMatchObject({ bootSystemIdentifier: "THIRD_BOOT", bootIdentifier: "THIRD" });
    expect(bootDescriptors[0]?.kind === "boot" ? bootDescriptors[0].bootSystemUse[0] : undefined).toBe(0x01);
    expect(bootDescriptors[1]?.kind === "boot" ? bootDescriptors[1].bootSystemUse.subarray(0, 2) : undefined).toEqual(Uint8Array.of(0x02, 0x03));
    expect(parseIsoImage(image, { includeData: true }).files[0]?.path).toBe("BOOT.TXT");
  });
});

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return decoder.decode(bytes.subarray(start, end));
}
