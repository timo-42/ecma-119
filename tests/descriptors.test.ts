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
    const parsedSupplementary = parsed.descriptors.find((descriptor) => descriptor.kind === "supplementary");

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
    expect(parsedSupplementary?.kind === "supplementary"
      ? parsedSupplementary.rootDirectoryRecord.children[0]
      : undefined).toMatchObject({
      path: "README.TXT",
      identifier: "README.TXT;1",
      size: "descriptor shifted\n".length,
    });
    expect(parsedSupplementary?.kind === "supplementary" && !("children" in parsedSupplementary.rootDirectoryRecord.children[0]!)
      ? new TextDecoder("ascii").decode(parsedSupplementary.rootDirectoryRecord.children[0].data)
      : undefined).toBe("descriptor shifted\n");
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("descriptor shifted\n");
  });

  test("writes primary volume descriptor file identifier fields", () => {
    const applicationUse = Uint8Array.of(1, 2, 3, 4);
    const image = createIsoImage([{
      path: "README.TXT",
      data: "descriptor file identifiers\n",
    }], {
      copyrightFileIdentifier: "COPY.TXT",
      abstractFileIdentifier: "ABSTRACT.TXT",
      bibliographicFileIdentifier: "BIBLIO.TXT",
      volumeDescriptorApplicationUse: applicationUse,
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
      fileStructureVersion: 1,
    });
    expect(primary.applicationUse.subarray(0, applicationUse.byteLength)).toEqual(applicationUse);
    expect(primary.applicationUse.subarray(applicationUse.byteLength).every((byte) => byte === 0)).toBe(true);
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
      volumeDescriptorApplicationUse: Uint8Array.of(9, 9),
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
        systemIdentifier: "ENH_SYS",
        volumeFlags: 1,
        escapeSequences: Uint8Array.of(0x25, 0x2f, 0x45),
        applicationIdentifier: "ENH_APP",
        abstractFileIdentifier: "ENHABS.TXT",
        volumeDescriptorApplicationUse: Uint8Array.of(5, 6, 7),
      }],
    });

    const descriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image, { includeData: true });
    const primary = descriptors[0];
    const enhanced = descriptors[1];
    const parsedEnhanced = parsed.descriptors.find((descriptor) => descriptor.kind === "enhanced");

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
      fileStructureVersion: 1,
    });
    expect(enhanced?.kind === "enhanced" ? enhanced.applicationUse.subarray(0, 3) : undefined).toEqual(Uint8Array.of(5, 6, 7));
    expect(enhanced?.kind === "enhanced" ? enhanced.escapeSequences.subarray(0, 3) : undefined).toEqual(Uint8Array.of(0x25, 0x2f, 0x45));
    expect(primary?.kind === "primary" && enhanced?.kind === "enhanced"
      ? enhanced.typeLPathTableLocation
      : 0).not.toBe(primary?.kind === "primary" ? primary.typeLPathTableLocation : 0);
    expect(primary?.kind === "primary" && enhanced?.kind === "enhanced"
      ? enhanced.rootDirectoryRecord.extent
      : 0).not.toBe(primary?.kind === "primary" ? primary.rootDirectoryRecord.extent : 0);
    const enhancedDir = parsedEnhanced?.kind === "enhanced"
      ? parsedEnhanced.rootDirectoryRecord.children.find((node) => "children" in node && node.path === "DIR")
      : undefined;
    expect(enhancedDir).toMatchObject({
      path: "DIR",
      identifier: "DIR",
    });
    expect(enhancedDir && "children" in enhancedDir ? enhancedDir.children[0] : undefined).toMatchObject({
      path: "DIR/README.TXT",
      identifier: "README.TXT;1",
      size: "enhanced descriptor\n".length,
    });
    expect(enhancedDir && "children" in enhancedDir && !("children" in enhancedDir.children[0]!)
      ? new TextDecoder("ascii").decode(enhancedDir.children[0].data)
      : undefined).toBe("enhanced descriptor\n");
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

  test("validates descriptor unused and reserved zero byte fields", () => {
    const image = createIsoImage([{
      path: "README.TXT",
      data: "descriptor reserved bytes\n",
    }], {
      volumeDescriptorApplicationUse: Uint8Array.of(1, 2, 3),
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
        volumeDescriptorApplicationUse: Uint8Array.of(4, 5, 6),
      }],
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
        volumeDescriptorApplicationUse: Uint8Array.of(7, 8, 9),
      }],
      volumePartition: {
        volumePartitionIdentifier: "PARTITION",
        systemUse: Uint8Array.of(0xaa, 0xbb),
        data: Uint8Array.of(0xcc),
      },
    });

    const descriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "supplementary", "enhanced", "partition", "terminator"]);
    expect(parsed.files.map((file) => file.path)).toEqual(["README.TXT"]);

    const mutations = [
      { sector: 16, offset: 7, code: "pvd.unused", message: /BP 8/i },
      { sector: 16, offset: 72, code: "pvd.unused", message: /BP 73 to 80/i },
      { sector: 16, offset: 88, code: "pvd.unused", message: /BP 89 to 120/i },
      { sector: 16, offset: 882, code: "pvd.unused", message: /BP 883/i },
      { sector: 16, offset: 1395, code: "pvd.reserved", message: /BP 1396 to 2048/i },
      { sector: 17, offset: 72, code: "supplementary.unused", message: /BP 73 to 80/i },
      { sector: 17, offset: 882, code: "supplementary.unused", message: /BP 883/i },
      { sector: 17, offset: 1395, code: "supplementary.reserved", message: /BP 1396 to 2048/i },
      { sector: 18, offset: 72, code: "enhanced.unused", message: /BP 73 to 80/i },
      { sector: 18, offset: 882, code: "enhanced.unused", message: /BP 883/i },
      { sector: 18, offset: 1395, code: "enhanced.reserved", message: /BP 1396 to 2048/i },
      { sector: 19, offset: 7, code: "partition.unused", message: /BP 8/i },
    ];

    for (const mutation of mutations) {
      const mutated = imageWithDescriptorByte(image, mutation.sector, mutation.offset, 0xff);
      expect(validateIsoImage(mutated)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: mutation.code,
            message: expect.stringMatching(mutation.message),
          }),
        ]),
      );
    }
  });

  test("validates primary boot and partition descriptor character fields", () => {
    const image = createIsoImage([{
      path: "COPY.TXT",
      data: "descriptor character fields\n",
    }], {
      systemIdentifier: "PRIMARY SYSTEM",
      volumeIdentifier: "PRIMARY_VOL",
      volumeSetIdentifier: "VOLSET",
      publisherIdentifier: "PUBLISHER/ID",
      dataPreparerIdentifier: "PREPARER",
      applicationIdentifier: "ECMA-119 TEST",
      copyrightFileIdentifier: "COPY.TXT",
      abstractFileIdentifier: "COPY.TXT",
      bibliographicFileIdentifier: "COPY.TXT",
      bootRecord: {
        bootSystemIdentifier: "BOOT SYSTEM",
        bootIdentifier: "BOOT ID",
        bootSystemUse: Uint8Array.of(0x01, 0x02),
      },
      volumePartition: {
        systemIdentifier: "PARTITION SYSTEM",
        volumePartitionIdentifier: "PARTITION",
        systemUse: Uint8Array.of(0x03, 0x04),
        data: Uint8Array.of(0x05),
      },
    });

    const parsed = parseIsoImage(image);
    const descriptors = parseVolumeDescriptors(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.primaryVolumeDescriptor).toMatchObject({
      systemIdentifier: "PRIMARY SYSTEM",
      volumeIdentifier: "PRIMARY_VOL",
      volumeSetIdentifier: "VOLSET",
      publisherIdentifier: "PUBLISHER/ID",
      dataPreparerIdentifier: "PREPARER",
      applicationIdentifier: "ECMA-119 TEST",
      copyrightFileIdentifier: "COPY.TXT;1",
    });
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "boot", "partition", "terminator"]);

    const mutations = [
      { sector: 16, offset: 8, code: "pvd.system_identifier.characters", message: /system identifier/i },
      { sector: 16, offset: 40, code: "pvd.volume_identifier.characters", message: /volume identifier/i },
      { sector: 16, offset: 190, code: "pvd.volume_set_identifier.characters", message: /volume set identifier/i },
      { sector: 16, offset: 318, code: "pvd.publisher_identifier.characters", message: /publisher identifier/i },
      { sector: 16, offset: 446, code: "pvd.data_preparer_identifier.characters", message: /data preparer identifier/i },
      { sector: 16, offset: 574, code: "pvd.application_identifier.characters", message: /application identifier/i },
      { sector: 16, offset: 702, code: "pvd.copyright_file_identifier.characters", message: /copyright file identifier/i },
      { sector: 16, offset: 739, code: "pvd.abstract_file_identifier.characters", message: /abstract file identifier/i },
      { sector: 16, offset: 776, code: "pvd.bibliographic_file_identifier.characters", message: /bibliographic file identifier/i },
      { sector: 17, offset: 7, code: "boot.system_identifier.characters", message: /boot system identifier/i },
      { sector: 17, offset: 39, code: "boot.identifier.characters", message: /boot identifier/i },
      { sector: 18, offset: 8, code: "partition.system_identifier.characters", message: /system identifier/i },
      { sector: 18, offset: 40, code: "partition.volume_partition_identifier.characters", message: /volume partition identifier/i },
    ];

    for (const mutation of mutations) {
      const mutated = imageWithDescriptorByte(image, mutation.sector, mutation.offset, 0x23);
      expect(validateIsoImage(mutated)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: mutation.code,
            message: expect.stringMatching(mutation.message),
          }),
        ]),
      );
    }
  });

  test("omits file data from parsed secondary descriptor trees when includeData is false", () => {
    const image = createIsoImage([{
      path: "DIR/README.TXT",
      data: "secondary no data\n",
    }], {
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }],
      enhancedVolumeDescriptors: [{ volumeIdentifier: "ENHANCED" }],
    });

    const parsed = parseIsoImage(image, { includeData: false });
    const secondaryDescriptors = parsed.descriptors.filter(
      (descriptor) => descriptor.kind === "supplementary" || descriptor.kind === "enhanced",
    );

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files[0]?.data).toBeUndefined();
    expect(secondaryDescriptors).toHaveLength(2);
    for (const descriptor of secondaryDescriptors) {
      const dir = descriptor.rootDirectoryRecord.children.find((node) => "children" in node && node.path === "DIR");
      const file = dir && "children" in dir ? dir.children[0] : undefined;
      expect(file).toMatchObject({
        path: "DIR/README.TXT",
        identifier: "README.TXT;1",
        size: "secondary no data\n".length,
      });
      expect(file && !("children" in file) ? file.data : undefined).toBeUndefined();
    }
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

    expect(() => createIsoImage([], {
      volumeDescriptorApplicationUse: new Uint8Array(513),
    })).toThrow(/application use field exceeds 512 bytes/i);

    expect(() => createIsoImage([], {
      supplementaryVolumeDescriptors: [{
        volumeDescriptorApplicationUse: new Uint8Array(513),
      }],
    })).toThrow(/application use field exceeds 512 bytes/i);
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

function imageWithDescriptorByte(image: Uint8Array, sectorNumber: number, descriptorOffset: number, value: number): Uint8Array {
  const mutated = image.slice();
  mutated[sectorNumber * SECTOR_SIZE + descriptorOffset] = value;
  return mutated;
}
