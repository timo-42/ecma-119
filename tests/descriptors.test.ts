import { describe, expect, test } from "vitest";

import { createIsoImage, parseIsoImage, parseVolumeDescriptors, validateIsoImage, writeUint32Both } from "../src/index";
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
  test("writes supplementary volume descriptors with separate path tables and directory hierarchy", () => {
    const image = createIsoImage([{
      path: "README.TXT",
      data: "descriptor shifted\n",
    }], {
      volumeIdentifier: "PRIMARY",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
        systemIdentifier: "SUP_SYS",
        volumeFlags: 1,
        escapeSequences: Uint8Array.of(0x25, 0x2f, 0x40),
        applicationIdentifier: "SUP_APP",
      }],
    });

    const descriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image, { includeData: true });
    const primary = descriptors[0];
    const supplementary = descriptors[1];

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "supplementary", "terminator"]);
    expect(descriptors.map((descriptor) => descriptor.sector)).toEqual([16, 17, 18]);
    expect(supplementary).toMatchObject({
      type: 2,
      kind: "supplementary",
      version: 1,
      volumeFlags: 1,
      systemIdentifier: "SUP_SYS",
      volumeIdentifier: "SUPP",
    });
    expect(supplementary?.kind === "supplementary" ? supplementary.escapeSequences.subarray(0, 3) : undefined).toEqual(Uint8Array.of(0x25, 0x2f, 0x40));
    expect(primary?.kind === "primary" && supplementary?.kind === "supplementary"
      ? supplementary.typeLPathTableLocation
      : 0).not.toBe(primary?.kind === "primary" ? primary.typeLPathTableLocation : 0);
    expect(primary?.kind === "primary" && supplementary?.kind === "supplementary"
      ? supplementary.rootDirectoryRecord.extent
      : 0).not.toBe(primary?.kind === "primary" ? primary.rootDirectoryRecord.extent : 0);
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("descriptor shifted\n");
  });

  test("writes primary volume descriptor file identifier fields", () => {
    const image = createIsoImage([{
      path: "README.TXT",
      data: "descriptor file identifiers\n",
    }], {
      copyrightFileIdentifier: "COPY.TXT",
      abstractFileIdentifier: "ABSTRACT.TXT",
      bibliographicFileIdentifier: "BIBLIO.TXT",
    });

    const parsed = parseIsoImage(image);
    const primary = parsed.primaryVolumeDescriptor;

    expect(validateIsoImage(image)).toEqual([]);
    expect(primary).toMatchObject({
      copyrightFileIdentifier: "COPY.TXT;1",
      abstractFileIdentifier: "ABSTRACT.TXT;1",
      bibliographicFileIdentifier: "BIBLIO.TXT;1",
      optionalTypeLPathTableLocation: 0,
      optionalTypeMPathTableLocation: 0,
    });
  });

  test("writes enhanced volume descriptors with separate path tables and directory hierarchy", () => {
    const image = createIsoImage([{
      path: "DIR/README.TXT",
      data: "enhanced descriptor\n",
    }], {
      volumeIdentifier: "PRIMARY",
      copyrightFileIdentifier: "COPY.TXT",
      abstractFileIdentifier: "ABSTRACT.TXT",
      bibliographicFileIdentifier: "BIBLIO.TXT",
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
        systemIdentifier: "ENH_SYS",
        volumeFlags: 1,
        escapeSequences: Uint8Array.of(0x25, 0x2f, 0x45),
        applicationIdentifier: "ENH_APP",
        abstractFileIdentifier: "ENHABS.TXT",
      }],
    });

    const descriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image, { includeData: true });
    const primary = descriptors[0];
    const enhanced = descriptors[1];

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "enhanced", "terminator"]);
    expect(descriptors.map((descriptor) => descriptor.sector)).toEqual([16, 17, 18]);
    expect(enhanced).toMatchObject({
      type: 2,
      kind: "enhanced",
      version: 2,
      volumeFlags: 1,
      systemIdentifier: "ENH_SYS",
      volumeIdentifier: "ENHANCED",
    });
    expect(enhanced).toMatchObject({
      copyrightFileIdentifier: "COPY.TXT;1",
      abstractFileIdentifier: "ENHABS.TXT;1",
      bibliographicFileIdentifier: "BIBLIO.TXT;1",
    });
    expect(enhanced?.kind === "enhanced" ? enhanced.escapeSequences.subarray(0, 3) : undefined).toEqual(Uint8Array.of(0x25, 0x2f, 0x45));
    expect(primary?.kind === "primary" && enhanced?.kind === "enhanced"
      ? enhanced.typeLPathTableLocation
      : 0).not.toBe(primary?.kind === "primary" ? primary.typeLPathTableLocation : 0);
    expect(primary?.kind === "primary" && enhanced?.kind === "enhanced"
      ? enhanced.rootDirectoryRecord.extent
      : 0).not.toBe(primary?.kind === "primary" ? primary.rootDirectoryRecord.extent : 0);
    expect(parsed.files.map((file) => file.path)).toEqual(["DIR/README.TXT"]);
    expect(parsed.root.fileUnitSize).toBe(0);
    expect(parsed.root.interleaveGapSize).toBe(0);
    expect(parsed.files[0]).toMatchObject({
      fileUnitSize: 0,
      interleaveGapSize: 0,
      volumeSequenceNumber: 1,
    });
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("enhanced descriptor\n");
  });

  test("writes supplementary and enhanced descriptors in descriptor order", () => {
    const image = createIsoImage([{
      path: "README.TXT",
      data: "both descriptors\n",
    }], {
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }],
      enhancedVolumeDescriptors: [{ volumeIdentifier: "ENHANCED" }],
    });

    const descriptors = parseVolumeDescriptors(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "supplementary", "enhanced", "terminator"]);
    expect(descriptors.map((descriptor) => descriptor.sector)).toEqual([16, 17, 18, 19]);
  });

  test("validates supplementary descriptor option bounds", () => {
    expect(() => createIsoImage([], {
      supplementaryVolumeDescriptors: [{
        volumeFlags: 2,
      }],
    })).toThrow(/flags bits/i);

    expect(() => createIsoImage([], {
      supplementaryVolumeDescriptors: [{
        escapeSequences: new Uint8Array(33),
      }],
    })).toThrow(/escape sequences/i);

    expect(() => createIsoImage([], {
      enhancedVolumeDescriptors: [{
        volumeFlags: 2,
      }],
    })).toThrow(/flags bits/i);

    expect(() => createIsoImage([], {
      enhancedVolumeDescriptors: [{
        escapeSequences: new Uint8Array(33),
      }],
    })).toThrow(/escape sequences/i);

    expect(() => createIsoImage([], {
      copyrightFileIdentifier: "TOOLONGNAME.TXT",
    })).toThrow(/file name exceeds/i);

    expect(() => createIsoImage([], {
      supplementaryVolumeDescriptors: [{
        abstractFileIdentifier: "BAD-NAME.TXT",
      }],
    })).toThrow(/d-characters/i);
  });

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
    const issues = validateIsoImage(missingTerminator);
    expect(issues).toEqual([
      expect.objectContaining({
        code: "descriptor.sequence",
        message: expect.stringMatching(/terminator/i),
      }),
    ]);
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
