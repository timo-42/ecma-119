import { describe, expect, test } from "vitest";

import { parseIsoImage, parseVolumeDescriptors, validateIsoImage, writeUint32Both } from "../src/index";
import { SECTOR_SIZE } from "../src/types";
import {
  PVD_SECTOR,
  TERMINATOR_SECTOR,
  createFixtureImage,
  findImageCreator,
  loadEcma119Module,
  sector,
} from "./helpers";

describe("volume descriptor sequence parsing", () => {
  test("scans descriptors until the terminator instead of requiring it at sector 17", async () => {
    const module = await loadEcma119Module();
    const createImage = findImageCreator(module!);
    expect(createImage).toBeTypeOf("function");

    const base = await createFixtureImage(createImage!);
    const shifted = new Uint8Array(base.byteLength + SECTOR_SIZE);
    shifted.set(base.subarray(0, TERMINATOR_SECTOR * SECTOR_SIZE));
    shifted.set(makeBootDescriptor(), TERMINATOR_SECTOR * SECTOR_SIZE);
    shifted.set(base.subarray(TERMINATOR_SECTOR * SECTOR_SIZE), (TERMINATOR_SECTOR + 1) * SECTOR_SIZE);

    const descriptors = parseVolumeDescriptors(shifted);

    expect(descriptors.map((descriptor) => descriptor.type)).toEqual([1, 0, 255]);
    expect(descriptors[0]).toMatchObject({ identifier: "CD001", version: 1, sector: PVD_SECTOR });
    expect(descriptors[1]).toMatchObject({ identifier: "CD001", version: 1, sector: TERMINATOR_SECTOR });
    expect(descriptors[1]?.raw).toBeInstanceOf(Uint8Array);
    expect(descriptors[1]?.raw.byteLength).toBe(SECTOR_SIZE);
    expect(descriptors[2]).toMatchObject({ identifier: "CD001", version: 1, sector: TERMINATOR_SECTOR + 1 });

    expect(() => parseIsoImage(shifted)).toThrow();
  });

  test("validateIsoImage reports a missing descriptor set terminator", async () => {
    const module = await loadEcma119Module();
    const createImage = findImageCreator(module!);
    expect(createImage).toBeTypeOf("function");

    const base = await createFixtureImage(createImage!);
    const missingTerminator = base.slice();
    sector(missingTerminator, TERMINATOR_SECTOR).fill(0);

    expect(() => parseVolumeDescriptors(missingTerminator)).toThrow(/terminator/i);
    expect(validateIsoImage(missingTerminator)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "descriptor.sequence",
        message: expect.stringMatching(/terminator/i),
      }),
    ]));
  });

  test("classifies supplementary, enhanced, partition, and unknown descriptors", async () => {
    const module = await loadEcma119Module();
    const createImage = findImageCreator(module!);
    expect(createImage).toBeTypeOf("function");

    const base = await createFixtureImage(createImage!);
    const image = descriptorSequenceFrom(base, [
      makeSupplementaryDescriptor(1),
      makeSupplementaryDescriptor(2),
      makePartitionDescriptor(),
      makeUnknownDescriptor(),
    ]);

    const descriptors = parseVolumeDescriptors(image);

    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual([
      "primary",
      "supplementary",
      "enhanced",
      "partition",
      "unknown",
      "terminator",
    ]);
    expect(descriptors[1]).toMatchObject({
      type: 2,
      version: 1,
      volumeFlags: 0,
      systemIdentifier: "TEST_SYSTEM",
      volumeIdentifier: "SUPPLEMENTARY",
    });
    expect(descriptors[2]).toMatchObject({
      type: 2,
      version: 2,
      volumeIdentifier: "ENHANCED",
    });
    expect(descriptors[3]).toMatchObject({
      type: 3,
      version: 1,
      systemIdentifier: "TEST_SYSTEM",
      volumePartitionIdentifier: "PARTITION",
      volumePartitionLocation: 123,
      volumePartitionSize: 456,
    });
    expect(descriptors[4]).toMatchObject({
      type: 254,
      kind: "unknown",
      version: 7,
    });
  });
});

function descriptorSequenceFrom(base: Uint8Array, extraDescriptors: Uint8Array[]): Uint8Array {
  const image = new Uint8Array((2 + extraDescriptors.length) * SECTOR_SIZE);
  image.set(sector(base, PVD_SECTOR), 0);
  for (const [index, descriptor] of extraDescriptors.entries()) {
    image.set(descriptor, (index + 1) * SECTOR_SIZE);
  }
  image.set(sector(base, TERMINATOR_SECTOR), (extraDescriptors.length + 1) * SECTOR_SIZE);
  const shifted = new Uint8Array((PVD_SECTOR + 2 + extraDescriptors.length) * SECTOR_SIZE);
  shifted.set(image, PVD_SECTOR * SECTOR_SIZE);
  return shifted;
}

function makeBootDescriptor(): Uint8Array {
  const descriptor = new Uint8Array(SECTOR_SIZE);
  descriptor[0] = 0;
  descriptor.set(new TextEncoder().encode("CD001"), 1);
  descriptor[6] = 1;
  descriptor.set(new TextEncoder().encode("ECMA119 TEST BOOT DESCRIPTOR"), 7);
  return descriptor;
}

function makeSupplementaryDescriptor(version: 1 | 2): Uint8Array {
  const descriptor = makeDescriptor(2, version);
  descriptor[7] = 0;
  writeAscii(descriptor, 8, 32, "TEST_SYSTEM");
  writeAscii(descriptor, 40, 32, version === 1 ? "SUPPLEMENTARY" : "ENHANCED");
  descriptor.set(new TextEncoder().encode("%/@"), 88);
  return descriptor;
}

function makePartitionDescriptor(): Uint8Array {
  const descriptor = makeDescriptor(3, 1);
  writeAscii(descriptor, 8, 32, "TEST_SYSTEM");
  writeAscii(descriptor, 40, 32, "PARTITION");
  writeUint32Both(descriptor, 72, 123);
  writeUint32Both(descriptor, 80, 456);
  return descriptor;
}

function makeUnknownDescriptor(): Uint8Array {
  return makeDescriptor(254, 7);
}

function makeDescriptor(type: number, version: number): Uint8Array {
  const descriptor = new Uint8Array(SECTOR_SIZE);
  descriptor[0] = type;
  descriptor.set(new TextEncoder().encode("CD001"), 1);
  descriptor[6] = version;
  return descriptor;
}

function writeAscii(bytes: Uint8Array, offset: number, length: number, value: string): void {
  bytes.fill(0x20, offset, offset + length);
  bytes.set(new TextEncoder().encode(value), offset);
}
