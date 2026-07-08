import { describe, expect, test } from "vitest";

import { createIsoImage, parseIsoImage, parseVolumeDescriptors, readUint32LE, validateIsoImage, writeUint16LE, writeUint32LE } from "../src/index";
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
    const parsed = parseIsoImage(image, { includeData: true });
    const bootDescriptors = descriptors.filter((descriptor) => descriptor.kind === "boot");
    const parsedBootDescriptors = parsed.descriptors.filter((descriptor) => descriptor.kind === "boot");

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "boot", "boot", "boot", "terminator"]);
    expect(parsed.descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "boot", "boot", "boot", "terminator"]);
    expect(bootDescriptors).toHaveLength(3);
    expect(parsedBootDescriptors).toHaveLength(3);
    expect(bootDescriptors[0]).toMatchObject({ bootSystemIdentifier: "LEGACY_BOOT", bootIdentifier: "LEGACY" });
    expect(bootDescriptors[1]).toMatchObject({ bootSystemIdentifier: "SECOND_BOOT", bootIdentifier: "SECOND" });
    expect(bootDescriptors[2]).toMatchObject({ bootSystemIdentifier: "THIRD_BOOT", bootIdentifier: "THIRD" });
    expect(parsedBootDescriptors[0]).toMatchObject({ bootSystemIdentifier: "LEGACY_BOOT", bootIdentifier: "LEGACY" });
    expect(parsedBootDescriptors[1]).toMatchObject({ bootSystemIdentifier: "SECOND_BOOT", bootIdentifier: "SECOND" });
    expect(parsedBootDescriptors[2]).toMatchObject({ bootSystemIdentifier: "THIRD_BOOT", bootIdentifier: "THIRD" });
    expect(bootDescriptors[0]?.kind === "boot" ? bootDescriptors[0].bootSystemUse[0] : undefined).toBe(0x01);
    expect(bootDescriptors[1]?.kind === "boot" ? bootDescriptors[1].bootSystemUse.subarray(0, 2) : undefined).toEqual(Uint8Array.of(0x02, 0x03));
    expect(parsed.files[0]?.path).toBe("BOOT.TXT");
  });

  test("parses El Torito boot catalog metadata from a boot record", () => {
    const image = imageWithBootCatalog();
    const descriptorOnlyBoot = parseVolumeDescriptors(image).find((descriptor) => descriptor.kind === "boot");
    const parsed = parseIsoImage(image, { includeData: true });
    const metadataOnly = parseIsoImage(image, { includeData: false });
    const boot = parsed.descriptors.find((descriptor) => descriptor.kind === "boot");
    const metadataOnlyBoot = metadataOnly.descriptors.find((descriptor) => descriptor.kind === "boot");

    if (boot?.kind !== "boot") {
      throw new Error("expected parsed boot descriptor");
    }

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptorOnlyBoot?.kind === "boot" ? descriptorOnlyBoot.bootCatalog : undefined).toBeUndefined();
    expect(boot.bootCatalog).toMatchObject({
      location: image.byteLength / SECTOR_SIZE - 2,
      validationEntry: {
        kind: "validation",
        headerId: 1,
        platformId: 0,
        manufacturer: "ECMA-119 TEST",
        key55: 0x55,
        keyAA: 0xaa,
      },
      initialEntry: {
        kind: "initial",
        bootable: true,
        bootIndicator: 0x88,
        mediaType: 0,
        loadSegment: 0x7c0,
        systemType: 0,
        sectorCount: 4,
        loadRba: image.byteLength / SECTOR_SIZE - 1,
      },
    });
    expect(boot.bootCatalog?.raw.byteLength).toBe(SECTOR_SIZE);
    expect(boot.bootCatalog?.entries.map((entry) => entry.kind)).toEqual(["validation", "initial"]);
    expect(boot.bootCatalog?.initialEntry.data).toEqual(bootImageBytes());
    expect(boot.bootCatalog?.entries[1]?.kind === "initial" ? boot.bootCatalog.entries[1].data : undefined).toEqual(bootImageBytes());
    expect(metadataOnlyBoot?.kind === "boot" ? metadataOnlyBoot.bootCatalog?.initialEntry.data : undefined).toBeUndefined();
    expect(parsed.files.map((file) => file.path)).toEqual(["BOOT.TXT"]);
  });

  test("writes and reads a high-level El Torito boot catalog with sections", () => {
    const initialImage = bootImageBytes();
    const sectionImage = sectionBootImageBytes();
    const image = createIsoImage([{ path: "BOOT.TXT", data: "high-level el torito\n" }], {
      extensions: {
        elTorito: {
          platform: "efi",
          manufacturer: "ECMA-119 TEST",
          initial: {
            data: initialImage,
            loadSegment: 0x7c0,
            systemType: 0,
          },
          sections: [{
            platform: "x86",
            identifier: "BIOS",
            entries: [{
              data: sectionImage,
              bootable: false,
              mediaType: "1.44m",
              loadSegment: 0x1234,
              systemType: 0x42,
              extensions: [{
                selectionCriteria: Uint8Array.of(0x01, 0x02, 0x03),
              }],
            }],
          }],
        },
      },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const descriptorOnlyBoot = parseVolumeDescriptors(image).find((descriptor) => descriptor.kind === "boot");
    const parsed = parseIsoImage(image, { includeData: true });
    const boot = parsed.descriptors.find((descriptor) => descriptor.kind === "boot");

    if (descriptorOnlyBoot?.kind !== "boot" || boot?.kind !== "boot") {
      throw new Error("expected El Torito boot descriptor");
    }

    const catalogLocation = readUint32LE(descriptorOnlyBoot.raw, 71);
    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptorOnlyBoot.bootSystemIdentifier).toBe("EL TORITO SPECIFICATION");
    expect(catalogLocation).toBeGreaterThan(0);
    expect(boot.bootCatalog).toMatchObject({
      location: catalogLocation,
      validationEntry: {
        platformId: 0xef,
        manufacturer: "ECMA-119 TEST",
      },
      initialEntry: {
        bootable: true,
        mediaType: 0,
        loadSegment: 0x7c0,
        systemType: 0,
        sectorCount: 4,
        loadRba: catalogLocation + 1,
      },
    });
    expect(boot.bootCatalog?.entries.map((entry) => entry.kind)).toEqual(["validation", "initial", "section-header", "section", "extension"]);
    expect(boot.bootCatalog?.initialEntry.data).toEqual(initialImage);
    expect(boot.bootCatalog?.entries[2]).toMatchObject({
      kind: "section-header",
      moreHeadersFollow: false,
      platformId: 0,
      sectionEntryCount: 2,
      identifier: "BIOS",
    });
    expect(boot.bootCatalog?.entries[3]).toMatchObject({
      kind: "section",
      bootable: false,
      mediaType: 2,
      loadSegment: 0x1234,
      systemType: 0x42,
      sectorCount: 2,
      loadRba: catalogLocation + 2,
    });
    expect(boot.bootCatalog?.entries[3]?.kind === "section" ? boot.bootCatalog.entries[3].data : undefined).toEqual(sectionImage);
    expect(boot.bootCatalog?.entries[4]?.kind === "extension" ? boot.bootCatalog.entries[4].selectionCriteria.subarray(0, 3) : undefined).toEqual(Uint8Array.of(0x01, 0x02, 0x03));
  });

  test("rejects ambiguous and out-of-range high-level El Torito options", () => {
    expect(() => createIsoImage([{ path: "BOOT.TXT", data: "x" }], {
      bootRecord: { bootSystemIdentifier: "EL TORITO SPECIFICATION" },
      extensions: { elTorito: { initial: bootImageBytes() } },
    })).toThrow(/extensions\.elTorito cannot be combined/i);

    expect(() => createIsoImage([{ path: "BOOT.TXT", data: "x" }], {
      bootRecords: [{ bootSystemIdentifier: "EL TORITO SPECIFICATION" }],
      extensions: { elTorito: { initial: bootImageBytes() } },
    })).toThrow(/extensions\.elTorito cannot be combined/i);

    expect(() => createIsoImage([{ path: "BOOT.TXT", data: "x" }], {
      extensions: { elTorito: { initial: { data: bootImageBytes(), mediaType: 5 } } },
    })).toThrow(/mediaType/i);

    expect(() => createIsoImage([{ path: "BOOT.TXT", data: "x" }], {
      extensions: { elTorito: { initial: { data: bootImageBytes(), loadSegment: 0x10000 } } },
    })).toThrow(/loadSegment/i);

    expect(() => createIsoImage([{ path: "BOOT.TXT", data: "x" }], {
      extensions: { elTorito: { initial: { data: bootImageBytes(), systemType: 0x100 } } },
    })).toThrow(/systemType/i);

    expect(() => createIsoImage([{ path: "BOOT.TXT", data: "x" }], {
      extensions: { elTorito: { initial: { data: bootImageBytes(), loadSectorCount: 0x10000 } } },
    })).toThrow(/loadSectorCount/i);
  });

  test("reports invalid El Torito boot catalog checksums", () => {
    const image = imageWithBootCatalog();
    image[bootCatalogOffset(image) + 4] ^= 0xff;

    expect(() => parseIsoImage(image, { includeData: false })).toThrow(/El Torito boot catalog validation entry checksum must sum to zero/i);
    expect(validateIsoImage(image)).toEqual([
      expect.objectContaining({
        code: "boot.catalog.validation.checksum",
        message: "El Torito boot catalog validation entry checksum must sum to zero",
      }),
    ]);
  });

  test("reports out-of-bounds El Torito boot catalog locations", () => {
    const image = imageWithBootCatalog();
    writeUint32LE(image, 17 * SECTOR_SIZE + 71, image.byteLength / SECTOR_SIZE + 10);

    expect(() => parseIsoImage(image, { includeData: false })).toThrow(/El Torito boot catalog location .* is out of bounds/i);
    expect(validateIsoImage(image)).toEqual([
      expect.objectContaining({
        code: "boot.catalog.location",
        message: expect.stringMatching(/El Torito boot catalog location .* is out of bounds/i),
      }),
    ]);
  });

  test("reports out-of-bounds El Torito boot image extents", () => {
    const image = imageWithBootCatalog();
    const catalogOffset = bootCatalogOffset(image);
    writeUint32LE(image, catalogOffset + 32 + 8, image.byteLength / SECTOR_SIZE + 1);

    expect(() => parseIsoImage(image, { includeData: true })).toThrow(/El Torito initial boot image extent .* is out of bounds/i);
    expect(validateIsoImage(image)).toEqual([
      expect.objectContaining({
        code: "boot.catalog.initial.image_bounds",
        message: expect.stringMatching(/El Torito initial boot image extent .* is out of bounds/i),
      }),
    ]);
  });
});

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return decoder.decode(bytes.subarray(start, end));
}

function imageWithBootCatalog(): Uint8Array {
  const base = createIsoImage([{ path: "BOOT.TXT", data: "boot catalog metadata\n" }], {
    bootRecord: {
      bootSystemIdentifier: "EL TORITO SPECIFICATION",
    },
    createdAt: new Date("2024-01-01T00:00:00Z"),
  });
  const catalogSector = base.byteLength / SECTOR_SIZE;
  const bootImage = bootImageBytes();
  const bootImageSector = catalogSector + 1;
  const image = new Uint8Array(base.byteLength + SECTOR_SIZE + bootImage.byteLength);
  image.set(base);
  writeUint32LE(image, 17 * SECTOR_SIZE + 71, catalogSector);
  image.set(bootCatalogSector(bootImageSector), catalogSector * SECTOR_SIZE);
  image.set(bootImage, bootImageSector * SECTOR_SIZE);
  return image;
}

function bootCatalogSector(bootImageSector: number): Uint8Array {
  const bytes = new Uint8Array(SECTOR_SIZE);
  bytes[0] = 0x01;
  bytes[1] = 0x00;
  bytes.set(encoder.encode("ECMA-119 TEST"), 4);
  bytes[30] = 0x55;
  bytes[31] = 0xaa;
  writeUint16LE(bytes, 28, bootCatalogChecksumWord(bytes.subarray(0, 32)));

  const initial = 32;
  bytes[initial] = 0x88;
  bytes[initial + 1] = 0;
  writeUint16LE(bytes, initial + 2, 0x7c0);
  bytes[initial + 4] = 0;
  writeUint16LE(bytes, initial + 6, 4);
  writeUint32LE(bytes, initial + 8, bootImageSector);
  return bytes;
}

function bootImageBytes(): Uint8Array {
  const bytes = new Uint8Array(512 * 4);
  bytes.set(encoder.encode("boot image payload\n"));
  bytes[512 * 4 - 1] = 0xa5;
  return bytes;
}

function sectionBootImageBytes(): Uint8Array {
  const bytes = new Uint8Array(512 * 2);
  bytes.set(encoder.encode("section boot image\n"));
  bytes[512 * 2 - 1] = 0x5a;
  return bytes;
}

function bootCatalogOffset(image: Uint8Array): number {
  return (image.byteLength / SECTOR_SIZE - 2) * SECTOR_SIZE;
}

function bootCatalogChecksumWord(entry: Uint8Array): number {
  let sum = 0;
  for (let offset = 0; offset < 32; offset += 2) {
    if (offset === 28) {
      continue;
    }
    sum = (sum + entry[offset]! + (entry[offset + 1]! << 8)) & 0xffff;
  }
  return (-sum) & 0xffff;
}
