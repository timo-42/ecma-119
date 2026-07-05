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
  let image: Uint8Array;
  let primaryVolumeDescriptor: Uint8Array;

  beforeAll(async () => {
    const module = await loadEcma119Module();
    if (module) {
      createImage = findImageCreator(module);
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
});
