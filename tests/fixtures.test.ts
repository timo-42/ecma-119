import { beforeAll, describe, expect, test } from "vitest";

import {
  PVD_SECTOR,
  SECTOR_SIZE,
  TERMINATOR_SECTOR,
  allZero,
  ascii,
  createFixtureImage,
  findDirectoryRecord,
  findImageCreator,
  findIsoParser,
  findIsoValidator,
  hasEcma119Entry,
  loadEcma119Module,
  readBothEndianUint16,
  readBothEndianUint32,
  readDirectoryRecord,
  readPathTableRecord,
  readUint32BE,
  readUint32LE,
  sector,
  trimRightSpace,
  type ImageFileInput,
  type ImageMetadataInput,
} from "./helpers";

const maybeDescribe = hasEcma119Entry() ? describe : describe.skip;

maybeDescribe("generated ECMA-119 fixture image", () => {
  let createImage: ((files: ImageFileInput[], options: ImageMetadataInput) => unknown) | undefined;
  let parseIsoImage: ((image: Uint8Array, options?: { includeData?: boolean }) => unknown) | undefined;
  let validateIsoImage: ((image: Uint8Array) => unknown) | undefined;
  let image: Uint8Array;
  let primaryVolumeDescriptor: Uint8Array;

  beforeAll(async () => {
    const module = await loadEcma119Module();
    if (module) {
      createImage = findImageCreator(module);
      parseIsoImage = findIsoParser(module);
      validateIsoImage = findIsoValidator(module);
    }

    if (createImage) {
      image = await createFixtureImage(createImage);
      primaryVolumeDescriptor = sector(image, PVD_SECTOR);
    }
  });

  test("exposes the expected public image creation API", () => {
    expect(createImage, "export one of createImage, createIsoImage, createEcma119Image, buildImage, or writeImage").toBeTypeOf(
      "function",
    );
    expect(parseIsoImage, "export parseIsoImage so generated fixtures can be read back").toBeTypeOf("function");
    expect(validateIsoImage, "export validateIsoImage so generated fixtures can be checked after writing").toBeTypeOf("function");
  });

  test("matches required ECMA-119 sector-level fixture structures", ({ skip }) => {
    if (!createImage) {
      skip("cannot generate fixture image until the public image creation API is exported");
    }

    expect(image.length % SECTOR_SIZE).toBe(0);
    expect(image.length).toBeGreaterThan(TERMINATOR_SECTOR * SECTOR_SIZE);
    expect(allZero(image.subarray(0, PVD_SECTOR * SECTOR_SIZE))).toBe(true);

    expect(primaryVolumeDescriptor[0]).toBe(1);
    expect(ascii(primaryVolumeDescriptor, 1, 6)).toBe("CD001");
    expect(primaryVolumeDescriptor[6]).toBe(1);
    expect(trimRightSpace(ascii(primaryVolumeDescriptor, 40, 72))).toBe("ECMA119_FIXTURE");
    expect(readBothEndianUint16(primaryVolumeDescriptor, 128)).toBe(SECTOR_SIZE);

    const volumeSpaceSize = readBothEndianUint32(primaryVolumeDescriptor, 80);
    expect(volumeSpaceSize).toBe(image.length / SECTOR_SIZE);

    const terminator = sector(image, TERMINATOR_SECTOR);

    expect(terminator[0]).toBe(255);
    expect(ascii(terminator, 1, 6)).toBe("CD001");
    expect(terminator[6]).toBe(1);

    const rootRecord = readDirectoryRecord(primaryVolumeDescriptor, 156);

    expect(rootRecord.length).toBe(34);
    expect(rootRecord.flags & 0x02).toBe(0x02);
    expect(rootRecord.fileIdentifier).toEqual(Uint8Array.of(0));
    expect(rootRecord.extent).toBeGreaterThan(TERMINATOR_SECTOR);
    expect(rootRecord.dataLength % SECTOR_SIZE).toBe(0);
    expect(rootRecord.dataLength).toBeGreaterThanOrEqual(SECTOR_SIZE);

    const pathTableSize = readBothEndianUint32(primaryVolumeDescriptor, 132);
    const littleEndianPathTableSector = readUint32LE(primaryVolumeDescriptor, 140);
    const bigEndianPathTableSector = readUint32BE(primaryVolumeDescriptor, 148);

    expect(pathTableSize).toBeGreaterThanOrEqual(10);
    expect(littleEndianPathTableSector).toBeGreaterThan(TERMINATOR_SECTOR);
    expect(bigEndianPathTableSector).toBeGreaterThan(TERMINATOR_SECTOR);

    const littleEndianRoot = readPathTableRecord(
      image.subarray(littleEndianPathTableSector * SECTOR_SIZE, littleEndianPathTableSector * SECTOR_SIZE + pathTableSize),
      0,
    );
    const bigEndianRoot = image.subarray(bigEndianPathTableSector * SECTOR_SIZE, bigEndianPathTableSector * SECTOR_SIZE + 10);

    expect(littleEndianRoot.identifierLength).toBe(1);
    expect(littleEndianRoot.extendedAttributeRecordLength).toBe(0);
    expect(littleEndianRoot.extent).toBe(rootRecord.extent);
    expect(littleEndianRoot.parentDirectoryNumber).toBe(1);
    expect(littleEndianRoot.identifier).toEqual(Uint8Array.of(0));
    expect(bigEndianRoot[0]).toBe(1);
    expect(bigEndianRoot[1]).toBe(0);
    expect(readUint32BE(bigEndianRoot, 2)).toBe(rootRecord.extent);

    const rootDirectory = image.subarray(rootRecord.extent * SECTOR_SIZE, rootRecord.extent * SECTOR_SIZE + rootRecord.dataLength);
    const fileRecord = findDirectoryRecord(rootDirectory, "README.TXT;1");

    expect(fileRecord).toBeDefined();
    expect(fileRecord?.flags ?? 0).toBe(0);
    expect(fileRecord?.extent ?? 0).toBeGreaterThan(rootRecord.extent);
    expect(fileRecord?.dataLength).toBe("hello ecma-119\n".length);

    const fileContent = image.subarray((fileRecord?.extent ?? 0) * SECTOR_SIZE, (fileRecord?.extent ?? 0) * SECTOR_SIZE + 15);
    expect(ascii(fileContent)).toBe("hello ecma-119\n");
  });

  test("reads and validates the generated fixture with the public parser", ({ skip }) => {
    if (!createImage || !parseIsoImage || !validateIsoImage) {
      skip("cannot run generated write-read fixture until writer, parser, and validator APIs are exported");
    }

    expect(validateIsoImage!(image)).toEqual([]);

    const parsed = parseIsoImage!(image, { includeData: true }) as {
      primaryVolumeDescriptor: { volumeIdentifier: string; logicalBlockSize: number };
      descriptors: Array<{ kind: string }>;
      files: Array<{ path: string; identifier: string; size: number; data?: Uint8Array }>;
    };

    expect(parsed.primaryVolumeDescriptor).toMatchObject({
      volumeIdentifier: "ECMA119_FIXTURE",
      logicalBlockSize: SECTOR_SIZE,
    });
    expect(parsed.descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "terminator"]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "README.TXT",
      identifier: "README.TXT;1",
      size: "hello ecma-119\n".length,
    });
    expect(ascii(parsed.files[0]?.data ?? new Uint8Array())).toBe("hello ecma-119\n");
  });

  test("round-trips a generated image with directories, descriptors, and partitions", async ({ skip }) => {
    if (!createImage || !parseIsoImage || !validateIsoImage) {
      skip("cannot run generated write-read fixture until writer, parser, and validator APIs are exported");
    }

    const module = await loadEcma119Module();
    const createIsoImage = module?.createIsoImage as ((input: unknown) => Uint8Array) | undefined;
    if (!createIsoImage) {
      skip("cannot run comprehensive fixture until createIsoImage is exported");
    }

    const binaryPayload = Uint8Array.of(0x00, 0x01, 0xfe, 0xff);
    const partitionPayload = new TextEncoder().encode("partition payload\n");
    const generated = createIsoImage!({
      files: [
        { path: "README.TXT", data: "hello generated\n" },
        { path: "DIR/EMPTY.BIN", data: new Uint8Array() },
        { path: "DIR/BINARY.BIN", data: binaryPayload },
      ],
      volumeIdentifier: "ROUNDTRIP",
      bootRecord: {
        bootSystemIdentifier: "BOOT SYSTEM",
        bootIdentifier: "BOOT ID",
        bootSystemUse: Uint8Array.of(0xba, 0xad),
      },
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP_RT" }],
      enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH_RT" }],
      volumePartition: {
        volumePartitionIdentifier: "PART_RT",
        data: partitionPayload,
      },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    expect(validateIsoImage!(generated)).toEqual([]);

    const parsed = parseIsoImage!(generated, { includeData: true }) as {
      descriptors: Array<{
        kind: string;
        volumeIdentifier?: string;
        bootSystemIdentifier?: string;
        volumePartitionIdentifier?: string;
        data?: Uint8Array;
        rootDirectoryRecord?: {
          children: Array<{ path: string; identifier: string; size?: number; data?: Uint8Array; children?: unknown[] }>;
        };
      }>;
      files: Array<{ path: string; identifier: string; size: number; data?: Uint8Array }>;
    };

    expect(parsed.descriptors.map((descriptor) => descriptor.kind)).toEqual([
      "primary",
      "boot",
      "supplementary",
      "enhanced",
      "partition",
      "terminator",
    ]);
    expect(parsed.descriptors.find((descriptor) => descriptor.kind === "boot")).toMatchObject({
      bootSystemIdentifier: "BOOT SYSTEM",
      bootIdentifier: "BOOT ID",
    });
    expect(parsed.descriptors.find((descriptor) => descriptor.kind === "supplementary")).toMatchObject({
      volumeIdentifier: "SUPP_RT",
    });
    expect(parsed.descriptors.find((descriptor) => descriptor.kind === "enhanced")).toMatchObject({
      volumeIdentifier: "ENH_RT",
    });
    const partition = parsed.descriptors.find((descriptor) => descriptor.kind === "partition");
    expect(partition).toMatchObject({
      volumePartitionIdentifier: "PART_RT",
    });
    expect(partition?.data?.subarray(0, partitionPayload.byteLength)).toEqual(partitionPayload);

    const readme = parsed.files.find((file) => file.path === "README.TXT");
    const empty = parsed.files.find((file) => file.path === "DIR/EMPTY.BIN");
    const binary = parsed.files.find((file) => file.path === "DIR/BINARY.BIN");
    expect(parsed.files.map((file) => file.path).sort()).toEqual(["DIR/BINARY.BIN", "DIR/EMPTY.BIN", "README.TXT"]);
    expect(ascii(readme?.data ?? new Uint8Array())).toBe("hello generated\n");
    expect(empty).toMatchObject({ identifier: "EMPTY.BIN;1", size: 0 });
    expect(empty?.data).toEqual(new Uint8Array());
    expect(binary?.data).toEqual(binaryPayload);

    for (const descriptor of parsed.descriptors.filter(
      (candidate) => candidate.kind === "supplementary" || candidate.kind === "enhanced",
    )) {
      const childPaths = descriptor.rootDirectoryRecord?.children.map((child) => child.path).sort();
      expect(childPaths).toEqual(["DIR", "README.TXT"]);
    }
  });

  test("sizes large directories with sector padding between records", async () => {
    expect(createImage).toBeTypeOf("function");
    const files = Array.from({ length: 132 }, (_, index) => ({
      path: `F${index.toString().padStart(5, "0")}.TXT`,
      data: new TextEncoder().encode(`file ${index}\n`),
    }));

    const largeImage = await createFixtureImage(createImage!, files, { volumeIdentifier: "ECMA119_BIGDIR" });
    const pvd = sector(largeImage, PVD_SECTOR);
    const rootRecord = readDirectoryRecord(pvd, 156);
    const rootDirectory = largeImage.subarray(rootRecord.extent * SECTOR_SIZE, rootRecord.extent * SECTOR_SIZE + rootRecord.dataLength);

    expect(rootRecord.dataLength).toBeGreaterThan(SECTOR_SIZE);
    expect(findDirectoryRecord(rootDirectory, "F00131.TXT;1")).toBeDefined();

    expect(validateIsoImage?.(largeImage)).toEqual([]);
    const parsed = parseIsoImage?.(largeImage, { includeData: false }) as { files?: Array<{ path: string; size: number }> } | undefined;
    expect(parsed?.files).toHaveLength(132);
    expect(parsed?.files?.find((file) => file.path === "F00131.TXT")).toMatchObject({
      path: "F00131.TXT",
      size: "file 131\n".length,
    });
  });

  test("rejects malformed directory cycles instead of recursing indefinitely", async () => {
    const module = await loadEcma119Module();
    const parseIsoImage = module?.parseIsoImage;
    expect(parseIsoImage).toBeTypeOf("function");

    const malformed = image.slice();
    const rootRecord = readDirectoryRecord(primaryVolumeDescriptor, 156);
    const rootOffset = rootRecord.extent * SECTOR_SIZE;
    const childOffset = rootOffset + 68;

    malformed[childOffset + 25] = 0x02;
    malformed.set(primaryVolumeDescriptor.subarray(156 + 2, 156 + 10), childOffset + 2);
    malformed.set(primaryVolumeDescriptor.subarray(156 + 10, 156 + 18), childOffset + 10);

    expect(() => (parseIsoImage as (bytes: Uint8Array) => unknown)(malformed)).toThrow(/cycle|bounds|invalid/i);
  });
});
