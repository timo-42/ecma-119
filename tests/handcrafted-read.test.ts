import { describe, expect, test } from "vitest";

import { parseIsoImage, parseIsoVolumeSet, parseVolumeDescriptors, validateIsoImage } from "../src/index";
import { SECTOR_SIZE } from "../src/types";

describe("handcrafted ISO reader fixture", () => {
  test("reads a minimal ECMA-119 image not produced by createIsoImage", () => {
    const image = handcraftedIso();
    const parsed = parseIsoImage(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.primaryVolumeDescriptor.volumeIdentifier).toBe("HANDMADE");
    expect(parsed.descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "terminator"]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "HELLO.TXT",
      identifier: "HELLO.TXT;1",
      size: 15,
    });
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("hello handmade\n");
  });

  test("reads hidden and associated flags from an image not produced by createIsoImage", () => {
    const image = handcraftedIso({ fileFlags: 0x05 });
    const parsed = parseIsoImage(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files[0]).toMatchObject({
      path: "HELLO.TXT",
      identifier: "HELLO.TXT;1",
      flags: 0x05,
    });
  });

  test("reads a zero-length file from an image not produced by createIsoImage", () => {
    const image = handcraftedIso({ filePayload: new Uint8Array(), fileIdentifier: "EMPTY.TXT;1" });
    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "EMPTY.TXT",
      identifier: "EMPTY.TXT;1",
      size: 0,
    });
    expect(parsed.files[0]?.data).toEqual(new Uint8Array());
  });

  test("reads a multi-sector file from an image not produced by createIsoImage", () => {
    const filePayload = new Uint8Array(SECTOR_SIZE + 17);
    for (let index = 0; index < filePayload.byteLength; index += 1) {
      filePayload[index] = index % 251;
    }
    const image = handcraftedIso({ filePayload, fileIdentifier: "LARGE.BIN;1" });
    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "LARGE.BIN",
      identifier: "LARGE.BIN;1",
      size: filePayload.byteLength,
    });
    expect(parsed.files[0]?.data).toEqual(filePayload);
  });

  test("reads Level 2 primary file identifiers from an image not produced by createIsoImage", () => {
    const filePayload = new TextEncoder().encode("handmade level two\n");
    const image = handcraftedIso({
      fileIdentifier: "LONGFILENAME1234567890.TXT;1",
      filePayload,
    });
    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "LONGFILENAME1234567890.TXT",
      identifier: "LONGFILENAME1234567890.TXT;1",
      size: filePayload.byteLength,
    });
    expect(parsed.files[0]?.data).toEqual(filePayload);
  });

  test("reads a non-interleaved multi-extent file from an image not produced by createIsoImage", () => {
    const image = handcraftedMultiExtentIso();
    const parsed = parseIsoImage(image, { includeData: true });
    const expectedData = new TextEncoder().encode("first section second section\n");

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "MULTI.BIN",
      identifier: "MULTI.BIN;1",
      size: expectedData.byteLength,
      flags: 0x80,
      sections: [
        expect.objectContaining({ extent: 21, size: "first section ".length, flags: 0x80 }),
        expect.objectContaining({ extent: 22, size: "second section\n".length, flags: 0 }),
      ],
    });
    expect(parsed.files[0]?.data).toEqual(expectedData);
  });

  test("reads an interleaved file from an image not produced by createIsoImage", () => {
    const image = handcraftedInterleavedIso();
    const parsed = parseIsoImage(image, { includeData: true });
    const firstUnit = new Uint8Array(SECTOR_SIZE);
    firstUnit.fill(0x31);
    const secondUnit = new TextEncoder().encode("second unit\n");
    const expectedData = new Uint8Array(firstUnit.byteLength + secondUnit.byteLength);
    expectedData.set(firstUnit);
    expectedData.set(secondUnit, firstUnit.byteLength);

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "INTER.BIN",
      identifier: "INTER.BIN;1",
      size: expectedData.byteLength,
      fileUnitSize: 1,
      interleaveGapSize: 1,
    });
    expect(parsed.files[0]?.data).toEqual(expectedData);
  });

  test("reads a nested directory hierarchy and path tables from an image not produced by createIsoImage", () => {
    const image = handcraftedNestedIso();
    const parsed = parseIsoImage(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "DIR/CHILD.TXT",
      identifier: "CHILD.TXT;1",
      size: 13,
    });
    expect(parsed.primaryVolumeDescriptor.pathTables).toMatchObject({
      typeL: [
        expect.objectContaining({ identifier: Uint8Array.of(0), extent: 20, parentDirectoryNumber: 1 }),
        expect.objectContaining({ identifier: new TextEncoder().encode("DIR"), extent: 21, parentDirectoryNumber: 1 }),
      ],
      typeM: [
        expect.objectContaining({ identifier: Uint8Array.of(0), extent: 20, parentDirectoryNumber: 1 }),
        expect.objectContaining({ identifier: new TextEncoder().encode("DIR"), extent: 21, parentDirectoryNumber: 1 }),
      ],
    });
    expect(parsed.primaryVolumeDescriptor.pathTables?.optionalTypeL).toBeUndefined();
    expect(parsed.primaryVolumeDescriptor.pathTables?.optionalTypeM).toBeUndefined();
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("hello nested\n");
  });

  test("reads unresolved external-volume records from an image not produced by createIsoImage", () => {
    const systemUse = Uint8Array.of(0x45, 0x58, 0x54, 0x01);
    const image = handcraftedExternalVolumeIso(systemUse);
    const parsed = parseIsoImage(image, { includeData: true });
    const file = parsed.files.find((entry) => entry.identifier === "EXT.TXT;1");
    const directory = parsed.root.children.find((entry) => "children" in entry && entry.identifier === "EXTDIR");

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.primaryVolumeDescriptor).toMatchObject({
      volumeSetSize: 2,
      volumeSequenceNumber: 2,
      pathTableSize: 24,
    });
    expect(file).toMatchObject({
      path: "EXT.TXT",
      identifier: "EXT.TXT;1",
      extent: 99,
      size: 12,
      volumeSequenceNumber: 1,
      external: true,
    });
    expect(file?.data).toBeUndefined();
    expect(file?.systemUse).toEqual(systemUse);
    expect(directory).toMatchObject({
      path: "EXTDIR",
      identifier: "EXTDIR",
      extent: 98,
      size: SECTOR_SIZE,
      volumeSequenceNumber: 1,
      external: true,
      children: [],
    });
    expect(parsed.primaryVolumeDescriptor.pathTables).toMatchObject({
      typeL: [
        expect.objectContaining({ identifier: Uint8Array.of(0), extent: 20, parentDirectoryNumber: 1 }),
        expect.objectContaining({ identifier: asciiBytes("EXTDIR"), extent: 98, parentDirectoryNumber: 1 }),
      ],
      typeM: [
        expect.objectContaining({ identifier: Uint8Array.of(0), extent: 20, parentDirectoryNumber: 1 }),
        expect.objectContaining({ identifier: asciiBytes("EXTDIR"), extent: 98, parentDirectoryNumber: 1 }),
      ],
    });
  });

  test("resolves external regular file data from supplied volume set members", () => {
    const data = asciiBytes("externaldata");
    const volumeOne = handcraftedExternalPayloadVolumeIso(data);
    const volumeTwo = handcraftedExternalVolumeIso(Uint8Array.of(0x45, 0x58, 0x54, 0x01));
    const unresolved = parseIsoImage(volumeTwo, { includeData: true }).files.find((entry) => entry.identifier === "EXT.TXT;1");

    const volumeSet = parseIsoVolumeSet([volumeOne, volumeTwo], { includeData: true });
    const resolved = volumeSet.images[1]?.files.find((entry) => entry.identifier === "EXT.TXT;1");
    const resolvedDirectory = volumeSet.images[1]?.root.children.find((entry) => "children" in entry && entry.identifier === "EXTDIR");
    const resolvedDirectoryChild = resolvedDirectory && "children" in resolvedDirectory
      ? resolvedDirectory.children[0]
      : undefined;
    const metadataOnlyVolumeSet = parseIsoVolumeSet([volumeOne, volumeTwo], { includeData: false });
    const metadataOnlyChild = metadataOnlyVolumeSet.images[1]?.files.find((entry) => entry.path === "EXTDIR/CHILD.TXT");

    expect(validateIsoImage(volumeOne)).toEqual([]);
    expect(validateIsoImage(volumeTwo)).toEqual([]);
    expect(unresolved).toMatchObject({ external: true, volumeSequenceNumber: 1 });
    expect(unresolved?.data).toBeUndefined();
    expect(resolved).toMatchObject({
      path: "EXT.TXT",
      identifier: "EXT.TXT;1",
      size: data.byteLength,
      volumeSequenceNumber: 1,
      external: true,
    });
    expect(resolved?.data).toEqual(data);
    expect(resolvedDirectory).toMatchObject({
      path: "EXTDIR",
      identifier: "EXTDIR",
      extent: 98,
      volumeSequenceNumber: 1,
      external: true,
    });
    expect(resolvedDirectoryChild).toMatchObject({
      path: "EXTDIR/CHILD.TXT",
      identifier: "CHILD.TXT;1",
      size: data.byteLength,
      volumeSequenceNumber: 1,
      external: true,
    });
    expect(resolvedDirectoryChild && !("children" in resolvedDirectoryChild) ? resolvedDirectoryChild.data : undefined).toEqual(data);
    expect(volumeSet.files.find((entry) => entry.identifier === "EXT.TXT;1")?.data).toEqual(data);
    expect(volumeSet.files.find((entry) => entry.path === "EXTDIR/CHILD.TXT")?.data).toEqual(data);
    expect(metadataOnlyChild).toMatchObject({
      path: "EXTDIR/CHILD.TXT",
      external: true,
    });
    expect(metadataOnlyChild?.data).toBeUndefined();
  });

  test("resolves aliased external directories independently", () => {
    const data = asciiBytes("externaldata");
    const volumeOne = handcraftedExternalPayloadVolumeIso(data);
    const volumeTwo = handcraftedExternalVolumeIso(Uint8Array.of(0x45, 0x58, 0x54, 0x01));
    const rootDirectoryOffset = 20 * SECTOR_SIZE;
    const externalDirectoryRecord = findDirectoryRecordOffset(volumeTwo, rootDirectoryOffset, SECTOR_SIZE, "EXTDIR");
    const aliasDirectory = directoryRecord({
      extent: 98,
      size: SECTOR_SIZE,
      flags: 0x02,
      identifier: asciiBytes("ZTDIR"),
      date: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)),
      volumeSequenceNumber: 1,
    });
    volumeTwo.set(aliasDirectory, externalDirectoryRecord + volumeTwo[externalDirectoryRecord]!);

    const volumeSet = parseIsoVolumeSet([volumeOne, volumeTwo], { includeData: true });

    expect(validateIsoImage(volumeTwo)).toEqual([]);
    expect(volumeSet.files.find((entry) => entry.path === "EXTDIR/CHILD.TXT")?.data).toEqual(data);
    expect(volumeSet.files.find((entry) => entry.path === "ZTDIR/CHILD.TXT")?.data).toEqual(data);
  });

  test("terminates cross-volume external directory cycles", () => {
    const volumeOne = handcraftedExternalPayloadVolumeIso(asciiBytes("externaldata"));
    const volumeTwo = handcraftedExternalVolumeIso(Uint8Array.of(0x45, 0x58, 0x54, 0x01));
    const externalDirectoryRecord = findDirectoryRecordOffset(volumeTwo, 20 * SECTOR_SIZE, SECTOR_SIZE, "EXTDIR");
    writeBoth32(volumeTwo, externalDirectoryRecord + 2, 96);
    writeUint32LE(volumeTwo, 18 * SECTOR_SIZE + 12, 96);
    writeUint32BE(volumeTwo, 19 * SECTOR_SIZE + 12, 96);
    writeCycleDirectoryA(volumeOne, 96, 20, 2);
    writeCycleDirectoryB(volumeTwo, 21, 96, 1);

    const volumeSet = parseIsoVolumeSet([volumeOne, volumeTwo], { includeData: false });
    const externalDirectory = volumeSet.images[1]?.root.children.find((entry) => "children" in entry && entry.path === "EXTDIR");
    const loopDirectory = externalDirectory && "children" in externalDirectory
      ? externalDirectory.children.find((entry) => "children" in entry && entry.path === "EXTDIR/LOOP")
      : undefined;
    const backEdge = loopDirectory && "children" in loopDirectory
      ? loopDirectory.children.find((entry) => "children" in entry && entry.path === "EXTDIR/LOOP/BACK")
      : undefined;

    expect(validateIsoImage(volumeOne)).toEqual([]);
    expect(validateIsoImage(volumeTwo)).toEqual([]);
    expect(externalDirectory).toMatchObject({
      path: "EXTDIR",
      extent: 96,
      volumeSequenceNumber: 1,
      external: true,
    });
    expect(loopDirectory).toMatchObject({
      path: "EXTDIR/LOOP",
      extent: 21,
      volumeSequenceNumber: 2,
      external: true,
    });
    expect(backEdge).toMatchObject({
      path: "EXTDIR/LOOP/BACK",
      extent: 96,
      volumeSequenceNumber: 1,
      external: true,
      children: [],
    });
  });

  test("rejects external regular file data outside the referenced volume member", () => {
    const volumeOne = handcraftedExternalPayloadVolumeIso(asciiBytes("externaldata"));
    const volumeTwo = handcraftedExternalVolumeIso(Uint8Array.of(0x45, 0x58, 0x54, 0x01));
    const externalFileRecord = findDirectoryRecordOffset(volumeTwo, 20 * SECTOR_SIZE, SECTOR_SIZE, "EXT.TXT;1");
    writeBoth32(volumeTwo, externalFileRecord + 2, 100);

    expect(validateIsoImage(volumeTwo)).toEqual([]);
    expect(() => parseIsoVolumeSet([volumeOne, volumeTwo], { includeData: true })).toThrow(/invalid extent bounds for EXT\.TXT/i);
  });

  test("rejects external directory data outside the referenced volume member", () => {
    const volumeOne = handcraftedExternalPayloadVolumeIso(asciiBytes("externaldata"));
    const volumeTwo = handcraftedExternalVolumeIso(Uint8Array.of(0x45, 0x58, 0x54, 0x01));
    const externalDirectoryRecord = findDirectoryRecordOffset(volumeTwo, 20 * SECTOR_SIZE, SECTOR_SIZE, "EXTDIR");
    writeBoth32(volumeTwo, externalDirectoryRecord + 2, 100);
    writeUint32LE(volumeTwo, 18 * SECTOR_SIZE + 12, 100);
    writeUint32BE(volumeTwo, 19 * SECTOR_SIZE + 12, 100);

    expect(validateIsoImage(volumeTwo)).toEqual([]);
    expect(() => parseIsoVolumeSet([volumeOne, volumeTwo], { includeData: true })).toThrow(/invalid extent bounds for EXTDIR/i);
  });

  test("rejects inconsistent supplied volume set members", () => {
    const volumeOne = handcraftedExternalPayloadVolumeIso(asciiBytes("externaldata"));
    const volumeTwo = handcraftedExternalVolumeIso(Uint8Array.of(0x45, 0x58, 0x54, 0x01));
    const mismatchedSetIdentifier = handcraftedExternalVolumeIso(Uint8Array.of(0x45, 0x58, 0x54, 0x01));
    writeAscii(sector(mismatchedSetIdentifier, 16), 190, 128, "OTHER_SET", 0x20);

    expect(() => parseIsoVolumeSet([volumeTwo], { includeData: false })).toThrow(
      /volume set member 2 declares volume set size 2; expected 1/i,
    );
    expect(() => parseIsoVolumeSet([volumeOne, volumeOne], { includeData: false })).toThrow(
      /duplicate volume set member sequence number 1/i,
    );
    expect(validateIsoImage(mismatchedSetIdentifier)).toEqual([]);
    expect(() => parseIsoVolumeSet([volumeOne, mismatchedSetIdentifier], { includeData: false })).toThrow(
      /volume set member 2 declares volume set identifier "OTHER_SET"; expected <empty>/i,
    );
  });

  test("reads boot and partition descriptors from an image not produced by createIsoImage", () => {
    const image = handcraftedBootPartitionIso();
    const descriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image, { includeData: true });
    const partition = parsed.descriptors.find((descriptor) => descriptor.kind === "partition");

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "partition", "boot", "terminator"]);
    expect(parsed.descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "partition", "boot", "terminator"]);
    expect(descriptors.find((descriptor) => descriptor.kind === "boot")).toMatchObject({
      kind: "boot",
      bootSystemIdentifier: "HAND BOOT SYSTEM",
      bootIdentifier: "HAND BOOT ID",
    });
    expect(partition).toMatchObject({
      kind: "partition",
      systemIdentifier: "HAND PART SYSTEM",
      volumePartitionIdentifier: "HAND_PART",
      volumePartitionLocation: 24,
      volumePartitionSize: 1,
    });
    expect(partition?.kind === "partition" ? partition.data?.subarray(0, "hand partition\n".length) : undefined).toEqual(
      new TextEncoder().encode("hand partition\n"),
    );
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "HAND.TXT",
      identifier: "HAND.TXT;1",
      size: "hand file\n".length,
    });
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("hand file\n");
  });

  test.each([
    { kind: "supplementary" as const, descriptorVersion: 1, fileStructureVersion: 1, volumeIdentifier: "SUP_HAND" },
    { kind: "enhanced" as const, descriptorVersion: 2, fileStructureVersion: 2, volumeIdentifier: "ENH_HAND" },
  ])("reads a handcrafted $kind descriptor hierarchy and path tables", ({ kind, descriptorVersion, fileStructureVersion, volumeIdentifier }) => {
    const image = handcraftedSecondaryDescriptorIso({ kind, descriptorVersion, fileStructureVersion, volumeIdentifier });
    const volumeDescriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image, { includeData: true });
    const parsedDescriptor = parsed.descriptors.find((descriptor) => descriptor.kind === kind);

    expect(validateIsoImage(image)).toEqual([]);
    expect(volumeDescriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", kind, "terminator"]);
    expect(parsed.descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", kind, "terminator"]);
    expect(parsed.files).toEqual([]);
    expect(volumeDescriptors.find((descriptor) => descriptor.kind === kind)).toMatchObject({
      kind,
      type: 2,
      version: descriptorVersion,
      volumeIdentifier,
      pathTableSize: 22,
      typeLPathTableLocation: 23,
      typeMPathTableLocation: 24,
    });
    expect(parsedDescriptor).toMatchObject({
      kind,
      type: 2,
      version: descriptorVersion,
      volumeIdentifier,
      fileStructureVersion,
      applicationIdentifier: "_SUPAPP.TXT;1",
      copyrightFileIdentifier: "SUPCPY.TXT;1",
      abstractFileIdentifier: "SUPDOC.TXT;1",
      bibliographicFileIdentifier: "SUPBIB.TXT;1",
      typeLPathTableLocation: 23,
      typeMPathTableLocation: 24,
    });
    expect(parsedDescriptor?.kind === kind ? parsedDescriptor.rootDirectoryRecord.extent : undefined).toBe(25);
    expect(parsedDescriptor?.kind === kind ? parsedDescriptor.rootDirectoryRecord.children[0] : undefined).toMatchObject({
      path: "ALT",
      identifier: "ALT",
      extent: 26,
    });

    const childDirectory = parsedDescriptor?.kind === kind && "children" in parsedDescriptor.rootDirectoryRecord.children[0]!
      ? parsedDescriptor.rootDirectoryRecord.children[0]
      : undefined;
    expect(childDirectory && "children" in childDirectory ? childDirectory.children[0] : undefined).toMatchObject({
      path: "ALT/SECOND.TXT",
      identifier: "SECOND.TXT;1",
      extent: 27,
      size: "hello secondary\n".length,
    });
    expect(childDirectory && "children" in childDirectory && !("children" in childDirectory.children[0]!)
      ? new TextDecoder("ascii").decode(childDirectory.children[0].data)
      : undefined).toBe("hello secondary\n");

    for (const expected of [
      { identifier: "SUPAPP.TXT;1", path: "SUPAPP.TXT", extent: 28, payload: "secondary application reference\n" },
      { identifier: "SUPBIB.TXT;1", path: "SUPBIB.TXT", extent: 29, payload: "secondary bibliographic reference\n" },
      { identifier: "SUPCPY.TXT;1", path: "SUPCPY.TXT", extent: 30, payload: "secondary copyright reference\n" },
      { identifier: "SUPDOC.TXT;1", path: "SUPDOC.TXT", extent: 31, payload: "secondary abstract reference\n" },
    ]) {
      const rootFile = parsedDescriptor?.kind === kind
        ? parsedDescriptor.rootDirectoryRecord.children.find((node) => !("children" in node) && node.identifier === expected.identifier)
        : undefined;
      expect(rootFile).toMatchObject({
        path: expected.path,
        identifier: expected.identifier,
        extent: expected.extent,
        size: expected.payload.length,
      });
      expect(rootFile && !("children" in rootFile) ? new TextDecoder("ascii").decode(rootFile.data) : undefined).toBe(expected.payload);
    }
  });

  test.each([
    { kind: "supplementary" as const, descriptorVersion: 1 as const, fileStructureVersion: 1 as const, volumeIdentifier: "SUP_EXT" },
    { kind: "enhanced" as const, descriptorVersion: 2 as const, fileStructureVersion: 2 as const, volumeIdentifier: "ENH_EXT" },
  ])("resolves external directories and files in $kind descriptor trees across volume sets", ({ kind, descriptorVersion, fileStructureVersion, volumeIdentifier }) => {
    const data = asciiBytes("externaldata");
    const volumeOne = handcraftedExternalPayloadVolumeIso(data);
    const volumeTwo = handcraftedSecondaryDescriptorIso({
      kind,
      descriptorVersion,
      fileStructureVersion,
      volumeIdentifier,
      volumeSetSize: 2,
      volumeSequenceNumber: 2,
    });
    writeExternalSecondaryDirectoryExtent(volumeOne, 96, 25, data, 2);
    const secondaryRootOffset = 25 * SECTOR_SIZE;
    const externalDirectoryRecord = findDirectoryRecordOffset(volumeTwo, secondaryRootOffset, SECTOR_SIZE, "ALT");
    writeBoth32(volumeTwo, externalDirectoryRecord + 2, 96);
    writeBoth16(volumeTwo, externalDirectoryRecord + 28, 1);
    writeUint32LE(volumeTwo, 23 * SECTOR_SIZE + 12, 96);
    writeUint32BE(volumeTwo, 24 * SECTOR_SIZE + 12, 96);
    const externalFileRecord = findDirectoryRecordOffset(volumeTwo, secondaryRootOffset, SECTOR_SIZE, "SUPAPP.TXT;1");
    writeBoth32(volumeTwo, externalFileRecord + 2, 99);
    writeBoth32(volumeTwo, externalFileRecord + 10, data.byteLength);
    writeBoth16(volumeTwo, externalFileRecord + 28, 1);

    const unresolved = parseIsoImage(volumeTwo, { includeData: true }).descriptors.find((descriptor) => descriptor.kind === kind);
    const volumeSet = parseIsoVolumeSet([volumeOne, volumeTwo], { includeData: true });
    const metadataOnlyVolumeSet = parseIsoVolumeSet([volumeOne, volumeTwo], { includeData: false });
    const resolved = volumeSet.images[1]?.descriptors.find((descriptor) => descriptor.kind === kind);
    const metadataOnlyResolved = metadataOnlyVolumeSet.images[1]?.descriptors.find((descriptor) => descriptor.kind === kind);
    const resolvedDirectory = resolved?.kind === kind
      ? resolved.rootDirectoryRecord.children.find((entry) => "children" in entry && entry.path === "ALT")
      : undefined;
    const metadataOnlyDirectory = metadataOnlyResolved?.kind === kind
      ? metadataOnlyResolved.rootDirectoryRecord.children.find((entry) => "children" in entry && entry.path === "ALT")
      : undefined;
    const resolvedFile = resolvedDirectory && "children" in resolvedDirectory
      ? resolvedDirectory.children.find((entry) => entry.path === "ALT/CHILD.TXT")
      : undefined;
    const metadataOnlyFile = metadataOnlyDirectory && "children" in metadataOnlyDirectory
      ? metadataOnlyDirectory.children.find((entry) => entry.path === "ALT/CHILD.TXT")
      : undefined;
    const resolvedRootFile = resolved?.kind === kind
      ? resolved.rootDirectoryRecord.children.find((entry) => !("children" in entry) && entry.identifier === "SUPAPP.TXT;1")
      : undefined;
    const metadataOnlyRootFile = metadataOnlyResolved?.kind === kind
      ? metadataOnlyResolved.rootDirectoryRecord.children.find((entry) => !("children" in entry) && entry.identifier === "SUPAPP.TXT;1")
      : undefined;

    expect(validateIsoImage(volumeOne)).toEqual([]);
    expect(validateIsoImage(volumeTwo)).toEqual([]);
    expect(unresolved?.kind === kind ? unresolved.rootDirectoryRecord.children.find((entry) => entry.path === "ALT") : undefined).toMatchObject({
      volumeSequenceNumber: 1,
      external: true,
      children: [],
    });
    expect(resolvedDirectory).toMatchObject({
      path: "ALT",
      extent: 96,
      volumeSequenceNumber: 1,
      external: true,
    });
    expect(resolvedFile).toMatchObject({
      path: "ALT/CHILD.TXT",
      identifier: "CHILD.TXT;1",
      volumeSequenceNumber: 1,
      external: true,
      size: data.byteLength,
    });
    expect(resolvedFile && !("children" in resolvedFile) ? resolvedFile.data : undefined).toEqual(data);
    expect(metadataOnlyFile).toMatchObject({
      path: "ALT/CHILD.TXT",
      volumeSequenceNumber: 1,
      external: true,
      size: data.byteLength,
    });
    expect(metadataOnlyFile && !("children" in metadataOnlyFile) ? metadataOnlyFile.data : undefined).toBeUndefined();
    expect(resolvedRootFile).toMatchObject({
      path: "SUPAPP.TXT",
      identifier: "SUPAPP.TXT;1",
      volumeSequenceNumber: 1,
      external: true,
      size: data.byteLength,
    });
    expect(resolvedRootFile && !("children" in resolvedRootFile) ? resolvedRootFile.data : undefined).toEqual(data);
    expect(metadataOnlyRootFile).toMatchObject({
      path: "SUPAPP.TXT",
      identifier: "SUPAPP.TXT;1",
      volumeSequenceNumber: 1,
      external: true,
      size: data.byteLength,
    });
    expect(metadataOnlyRootFile && !("children" in metadataOnlyRootFile) ? metadataOnlyRootFile.data : undefined).toBeUndefined();
  });
});

function handcraftedIso(options: { fileFlags?: number; fileIdentifier?: string; filePayload?: Uint8Array } = {}): Uint8Array {
  const image = new Uint8Array(24 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const rootDirectory = sector(image, 20);
  const pathTableL = sector(image, 18);
  const pathTableM = sector(image, 19);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const filePayload = options.filePayload ?? new TextEncoder().encode("hello handmade\n");
  const fileIdentifier = options.fileIdentifier ?? "HELLO.TXT;1";

  image.subarray(21 * SECTOR_SIZE, 21 * SECTOR_SIZE + filePayload.byteLength).set(filePayload);
  writePathTableRoot(pathTableL, "little", 20);
  writePathTableRoot(pathTableM, "big", 20);

  let offset = 0;
  const self = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date });
  const parent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const file = directoryRecord({ extent: 21, size: filePayload.byteLength, flags: options.fileFlags ?? 0, identifier: asciiBytes(fileIdentifier), date });
  rootDirectory.set(self, offset);
  offset += self.byteLength;
  rootDirectory.set(parent, offset);
  offset += parent.byteLength;
  rootDirectory.set(file, offset);

  pvd[0] = 1;
  writeAscii(pvd, 1, 5, "CD001", 0);
  pvd[6] = 1;
  writeAscii(pvd, 8, 32, "HANDMADE_SYSTEM", 0x20);
  writeAscii(pvd, 40, 32, "HANDMADE", 0x20);
  writeBoth32(pvd, 80, 24);
  writeBoth16(pvd, 120, 1);
  writeBoth16(pvd, 124, 1);
  writeBoth16(pvd, 128, SECTOR_SIZE);
  writeBoth32(pvd, 132, 10);
  writeUint32LE(pvd, 140, 18);
  writeUint32BE(pvd, 148, 19);
  pvd.set(self, 156);
  writeAscii(pvd, 190, 128, "", 0x20);
  writeAscii(pvd, 318, 128, "", 0x20);
  writeAscii(pvd, 446, 128, "", 0x20);
  writeAscii(pvd, 574, 128, "HANDCRAFTED TEST", 0x20);
  writeAscii(pvd, 702, 37, "", 0x20);
  writeAscii(pvd, 739, 37, "", 0x20);
  writeAscii(pvd, 776, 37, "", 0x20);
  pvd.set(volumeDate(date), 813);
  pvd.set(volumeDate(date), 830);
  pvd.set(volumeDate(null), 847);
  pvd.set(volumeDate(date), 864);
  pvd[881] = 1;

  const terminator = sector(image, 17);
  terminator[0] = 255;
  writeAscii(terminator, 1, 5, "CD001", 0);
  terminator[6] = 1;

  return image;
}

function handcraftedBootPartitionIso(): Uint8Array {
  const image = new Uint8Array(25 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const partition = sector(image, 17);
  const boot = sector(image, 18);
  const terminator = sector(image, 19);
  const pathTableL = sector(image, 20);
  const pathTableM = sector(image, 21);
  const rootDirectory = sector(image, 22);
  const fileData = sector(image, 23);
  const partitionData = sector(image, 24);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const filePayload = new TextEncoder().encode("hand file\n");
  const partitionPayload = new TextEncoder().encode("hand partition\n");

  fileData.set(filePayload);
  partitionData.set(partitionPayload);
  writePathTableRoot(pathTableL, "little", 22);
  writePathTableRoot(pathTableM, "big", 22);

  const self = directoryRecord({ extent: 22, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date });
  const parent = directoryRecord({ extent: 22, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const file = directoryRecord({ extent: 23, size: filePayload.byteLength, flags: 0, identifier: asciiBytes("HAND.TXT;1"), date });
  rootDirectory.set(self, 0);
  rootDirectory.set(parent, self.byteLength);
  rootDirectory.set(file, self.byteLength + parent.byteLength);

  writePrimaryDescriptor(pvd, {
    volumeIdentifier: "HAND_BOOT_PART",
    rootDirectoryRecord: self,
    pathTableSize: 10,
    typeLPathTableLocation: 20,
    typeMPathTableLocation: 21,
    volumeSpaceSize: 25,
    date,
  });

  boot[0] = 0;
  writeAscii(boot, 1, 5, "CD001", 0);
  boot[6] = 1;
  writeAscii(boot, 7, 32, "HAND BOOT SYSTEM", 0x20);
  writeAscii(boot, 39, 32, "HAND BOOT ID", 0x20);
  boot.set(Uint8Array.of(0xca, 0xfe), 71);

  partition[0] = 3;
  writeAscii(partition, 1, 5, "CD001", 0);
  partition[6] = 1;
  writeAscii(partition, 8, 32, "HAND PART SYSTEM", 0x20);
  writeAscii(partition, 40, 32, "HAND_PART", 0x20);
  writeBoth32(partition, 72, 24);
  writeBoth32(partition, 80, 1);
  partition.set(Uint8Array.of(0xde, 0xad), 88);

  terminator[0] = 255;
  writeAscii(terminator, 1, 5, "CD001", 0);
  terminator[6] = 1;

  return image;
}

function handcraftedMultiExtentIso(): Uint8Array {
  const image = new Uint8Array(24 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const pathTableL = sector(image, 18);
  const pathTableM = sector(image, 19);
  const rootDirectory = sector(image, 20);
  const firstFileData = sector(image, 21);
  const secondFileData = sector(image, 22);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const firstPayload = new TextEncoder().encode("first section ");
  const secondPayload = new TextEncoder().encode("second section\n");

  firstFileData.set(firstPayload);
  secondFileData.set(secondPayload);
  writePathTableRoot(pathTableL, "little", 20);
  writePathTableRoot(pathTableM, "big", 20);

  const self = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date });
  const parent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const firstSection = directoryRecord({ extent: 21, size: firstPayload.byteLength, flags: 0x80, identifier: asciiBytes("MULTI.BIN;1"), date });
  const secondSection = directoryRecord({ extent: 22, size: secondPayload.byteLength, flags: 0, identifier: asciiBytes("MULTI.BIN;1"), date });
  rootDirectory.set(self, 0);
  rootDirectory.set(parent, self.byteLength);
  rootDirectory.set(firstSection, self.byteLength + parent.byteLength);
  rootDirectory.set(secondSection, self.byteLength + parent.byteLength + firstSection.byteLength);

  writePrimaryDescriptor(pvd, {
    volumeIdentifier: "MULTI_EXTENT",
    rootDirectoryRecord: self,
    pathTableSize: 10,
    typeLPathTableLocation: 18,
    typeMPathTableLocation: 19,
    volumeSpaceSize: 24,
    date,
  });

  const terminator = sector(image, 17);
  terminator[0] = 255;
  writeAscii(terminator, 1, 5, "CD001", 0);
  terminator[6] = 1;

  return image;
}

function handcraftedInterleavedIso(): Uint8Array {
  const image = new Uint8Array(25 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const pathTableL = sector(image, 18);
  const pathTableM = sector(image, 19);
  const rootDirectory = sector(image, 20);
  const firstFileUnit = sector(image, 21);
  const gap = sector(image, 22);
  const secondFileUnit = sector(image, 23);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const firstPayload = new Uint8Array(SECTOR_SIZE);
  const secondPayload = new TextEncoder().encode("second unit\n");

  firstPayload.fill(0x31);
  firstFileUnit.set(firstPayload);
  gap.fill(0xa5);
  secondFileUnit.set(secondPayload);
  writePathTableRoot(pathTableL, "little", 20);
  writePathTableRoot(pathTableM, "big", 20);

  const self = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date });
  const parent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const file = directoryRecord({
    extent: 21,
    size: firstPayload.byteLength + secondPayload.byteLength,
    flags: 0,
    identifier: asciiBytes("INTER.BIN;1"),
    date,
    fileUnitSize: 1,
    interleaveGapSize: 1,
  });
  rootDirectory.set(self, 0);
  rootDirectory.set(parent, self.byteLength);
  rootDirectory.set(file, self.byteLength + parent.byteLength);

  writePrimaryDescriptor(pvd, {
    volumeIdentifier: "INTERLEAVED",
    rootDirectoryRecord: self,
    pathTableSize: 10,
    typeLPathTableLocation: 18,
    typeMPathTableLocation: 19,
    volumeSpaceSize: 25,
    date,
  });

  const terminator = sector(image, 17);
  terminator[0] = 255;
  writeAscii(terminator, 1, 5, "CD001", 0);
  terminator[6] = 1;

  return image;
}

function handcraftedNestedIso(): Uint8Array {
  const image = new Uint8Array(24 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const pathTableL = sector(image, 18);
  const pathTableM = sector(image, 19);
  const rootDirectory = sector(image, 20);
  const childDirectory = sector(image, 21);
  const fileData = sector(image, 22);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const filePayload = new TextEncoder().encode("hello nested\n");

  fileData.set(filePayload);
  writePathTableRoot(pathTableL, "little", 20);
  writePathTableDirectory(pathTableL, 10, "little", asciiBytes("DIR"), 21, 1);
  writePathTableRoot(pathTableM, "big", 20);
  writePathTableDirectory(pathTableM, 10, "big", asciiBytes("DIR"), 21, 1);

  const rootSelf = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date });
  const rootParent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const dir = directoryRecord({ extent: 21, size: SECTOR_SIZE, flags: 0x02, identifier: asciiBytes("DIR"), date });
  rootDirectory.set(rootSelf, 0);
  rootDirectory.set(rootParent, rootSelf.byteLength);
  rootDirectory.set(dir, rootSelf.byteLength + rootParent.byteLength);

  const childSelf = directoryRecord({ extent: 21, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date });
  const childParent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const childFile = directoryRecord({ extent: 22, size: filePayload.byteLength, flags: 0, identifier: asciiBytes("CHILD.TXT;1"), date });
  childDirectory.set(childSelf, 0);
  childDirectory.set(childParent, childSelf.byteLength);
  childDirectory.set(childFile, childSelf.byteLength + childParent.byteLength);

  pvd[0] = 1;
  writeAscii(pvd, 1, 5, "CD001", 0);
  pvd[6] = 1;
  writeAscii(pvd, 8, 32, "HANDMADE_SYSTEM", 0x20);
  writeAscii(pvd, 40, 32, "NESTED", 0x20);
  writeBoth32(pvd, 80, 24);
  writeBoth16(pvd, 120, 1);
  writeBoth16(pvd, 124, 1);
  writeBoth16(pvd, 128, SECTOR_SIZE);
  writeBoth32(pvd, 132, 22);
  writeUint32LE(pvd, 140, 18);
  writeUint32BE(pvd, 148, 19);
  pvd.set(rootSelf, 156);
  writeAscii(pvd, 190, 128, "", 0x20);
  writeAscii(pvd, 318, 128, "", 0x20);
  writeAscii(pvd, 446, 128, "", 0x20);
  writeAscii(pvd, 574, 128, "HANDCRAFTED TEST", 0x20);
  writeAscii(pvd, 702, 37, "", 0x20);
  writeAscii(pvd, 739, 37, "", 0x20);
  writeAscii(pvd, 776, 37, "", 0x20);
  pvd.set(volumeDate(date), 813);
  pvd.set(volumeDate(date), 830);
  pvd.set(volumeDate(null), 847);
  pvd.set(volumeDate(date), 864);
  pvd[881] = 1;

  const terminator = sector(image, 17);
  terminator[0] = 255;
  writeAscii(terminator, 1, 5, "CD001", 0);
  terminator[6] = 1;

  return image;
}

function handcraftedExternalVolumeIso(systemUse: Uint8Array): Uint8Array {
  const image = new Uint8Array(22 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const pathTableL = sector(image, 18);
  const pathTableM = sector(image, 19);
  const rootDirectory = sector(image, 20);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

  writePathTableRoot(pathTableL, "little", 20);
  writePathTableDirectory(pathTableL, 10, "little", asciiBytes("EXTDIR"), 98, 1);
  writePathTableRoot(pathTableM, "big", 20);
  writePathTableDirectory(pathTableM, 10, "big", asciiBytes("EXTDIR"), 98, 1);

  const self = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date, volumeSequenceNumber: 2 });
  const parent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date, volumeSequenceNumber: 2 });
  const externalFile = directoryRecord({
    extent: 99,
    size: 12,
    flags: 0,
    identifier: asciiBytes("EXT.TXT;1"),
    date,
    volumeSequenceNumber: 1,
    systemUse,
  });
  const externalDirectory = directoryRecord({
    extent: 98,
    size: SECTOR_SIZE,
    flags: 0x02,
    identifier: asciiBytes("EXTDIR"),
    date,
    volumeSequenceNumber: 1,
  });
  rootDirectory.set(self, 0);
  rootDirectory.set(parent, self.byteLength);
  rootDirectory.set(externalFile, self.byteLength + parent.byteLength);
  rootDirectory.set(externalDirectory, self.byteLength + parent.byteLength + externalFile.byteLength);

  writePrimaryDescriptor(pvd, {
    volumeIdentifier: "EXTERNAL",
    rootDirectoryRecord: self,
    pathTableSize: 24,
    typeLPathTableLocation: 18,
    typeMPathTableLocation: 19,
    volumeSpaceSize: 22,
    volumeSetSize: 2,
    volumeSequenceNumber: 2,
    date,
  });

  const terminator = sector(image, 17);
  terminator[0] = 255;
  writeAscii(terminator, 1, 5, "CD001", 0);
  terminator[6] = 1;

  return image;
}

function handcraftedExternalPayloadVolumeIso(data: Uint8Array): Uint8Array {
  const image = new Uint8Array(100 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const pathTableL = sector(image, 18);
  const pathTableM = sector(image, 19);
  const rootDirectory = sector(image, 20);
  const externalDirectory = sector(image, 98);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

  writePathTableRoot(pathTableL, "little", 20);
  writePathTableRoot(pathTableM, "big", 20);

  const self = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date, volumeSequenceNumber: 1 });
  const parent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date, volumeSequenceNumber: 1 });
  rootDirectory.set(self, 0);
  rootDirectory.set(parent, self.byteLength);
  const externalSelf = directoryRecord({ extent: 98, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date, volumeSequenceNumber: 1 });
  const externalParent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date, volumeSequenceNumber: 2 });
  const externalChild = directoryRecord({ extent: 99, size: data.byteLength, flags: 0, identifier: asciiBytes("CHILD.TXT;1"), date, volumeSequenceNumber: 1 });
  externalDirectory.set(externalSelf, 0);
  externalDirectory.set(externalParent, externalSelf.byteLength);
  externalDirectory.set(externalChild, externalSelf.byteLength + externalParent.byteLength);
  image.set(data, 99 * SECTOR_SIZE);

  writePrimaryDescriptor(pvd, {
    volumeIdentifier: "EXTVOL1",
    rootDirectoryRecord: self,
    pathTableSize: 10,
    typeLPathTableLocation: 18,
    typeMPathTableLocation: 19,
    volumeSpaceSize: 100,
    volumeSetSize: 2,
    volumeSequenceNumber: 1,
    date,
  });

  const terminator = sector(image, 17);
  terminator[0] = 255;
  writeAscii(terminator, 1, 5, "CD001", 0);
  terminator[6] = 1;

  return image;
}

function writeExternalSecondaryDirectoryExtent(
  image: Uint8Array,
  directorySector: number,
  parentExtent: number,
  data: Uint8Array,
  parentVolumeSequenceNumber: number,
): void {
  const directory = sector(image, directorySector);
  directory.fill(0);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const self = directoryRecord({ extent: directorySector, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date, volumeSequenceNumber: 1 });
  const parent = directoryRecord({ extent: parentExtent, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date, volumeSequenceNumber: parentVolumeSequenceNumber });
  const child = directoryRecord({ extent: 99, size: data.byteLength, flags: 0, identifier: asciiBytes("CHILD.TXT;1"), date, volumeSequenceNumber: 1 });
  directory.set(self, 0);
  directory.set(parent, self.byteLength);
  directory.set(child, self.byteLength + parent.byteLength);
}

function writeCycleDirectoryA(image: Uint8Array, directorySector: number, parentExtent: number, parentVolumeSequenceNumber: number): void {
  const directory = sector(image, directorySector);
  directory.fill(0);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const self = directoryRecord({ extent: directorySector, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date, volumeSequenceNumber: 1 });
  const parent = directoryRecord({ extent: parentExtent, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date, volumeSequenceNumber: parentVolumeSequenceNumber });
  const loop = directoryRecord({ extent: 21, size: SECTOR_SIZE, flags: 0x02, identifier: asciiBytes("LOOP"), date, volumeSequenceNumber: 2 });
  directory.set(self, 0);
  directory.set(parent, self.byteLength);
  directory.set(loop, self.byteLength + parent.byteLength);
}

function writeCycleDirectoryB(image: Uint8Array, directorySector: number, parentExtent: number, parentVolumeSequenceNumber: number): void {
  const directory = sector(image, directorySector);
  directory.fill(0);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const self = directoryRecord({ extent: directorySector, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date, volumeSequenceNumber: 2 });
  const parent = directoryRecord({ extent: parentExtent, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date, volumeSequenceNumber: parentVolumeSequenceNumber });
  const back = directoryRecord({ extent: parentExtent, size: SECTOR_SIZE, flags: 0x02, identifier: asciiBytes("BACK"), date, volumeSequenceNumber: parentVolumeSequenceNumber });
  directory.set(self, 0);
  directory.set(parent, self.byteLength);
  directory.set(back, self.byteLength + parent.byteLength);
}

function handcraftedSecondaryDescriptorIso(input: {
  kind: "supplementary" | "enhanced";
  descriptorVersion: 1 | 2;
  fileStructureVersion: 1 | 2;
  volumeIdentifier: string;
  volumeSetSize?: number;
  volumeSequenceNumber?: number;
}): Uint8Array {
  const image = new Uint8Array(34 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const secondaryDescriptor = sector(image, 17);
  const terminator = sector(image, 18);
  const primaryPathTableL = sector(image, 19);
  const primaryPathTableM = sector(image, 20);
  const primaryRootDirectory = sector(image, 21);
  const secondaryPathTableL = sector(image, 23);
  const secondaryPathTableM = sector(image, 24);
  const secondaryRootDirectory = sector(image, 25);
  const secondaryChildDirectory = sector(image, 26);
  const secondaryFileData = sector(image, 27);
  const secondaryApplicationFileData = sector(image, 28);
  const secondaryBibliographicFileData = sector(image, 29);
  const secondaryCopyrightFileData = sector(image, 30);
  const secondaryAbstractFileData = sector(image, 31);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const filePayload = new TextEncoder().encode("hello secondary\n");
  const applicationPayload = new TextEncoder().encode("secondary application reference\n");
  const bibliographicPayload = new TextEncoder().encode("secondary bibliographic reference\n");
  const copyrightPayload = new TextEncoder().encode("secondary copyright reference\n");
  const abstractPayload = new TextEncoder().encode("secondary abstract reference\n");
  const volumeSetSize = input.volumeSetSize ?? 1;
  const volumeSequenceNumber = input.volumeSequenceNumber ?? 1;

  secondaryFileData.set(filePayload);
  secondaryApplicationFileData.set(applicationPayload);
  secondaryBibliographicFileData.set(bibliographicPayload);
  secondaryCopyrightFileData.set(copyrightPayload);
  secondaryAbstractFileData.set(abstractPayload);

  writePathTableRoot(primaryPathTableL, "little", 21);
  writePathTableRoot(primaryPathTableM, "big", 21);
  writePathTableRoot(secondaryPathTableL, "little", 25);
  writePathTableDirectory(secondaryPathTableL, 10, "little", asciiBytes("ALT"), 26, 1);
  writePathTableRoot(secondaryPathTableM, "big", 25);
  writePathTableDirectory(secondaryPathTableM, 10, "big", asciiBytes("ALT"), 26, 1);

  const primaryRootSelf = directoryRecord({ extent: 21, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date, volumeSequenceNumber });
  const primaryRootParent = directoryRecord({ extent: 21, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date, volumeSequenceNumber });
  primaryRootDirectory.set(primaryRootSelf, 0);
  primaryRootDirectory.set(primaryRootParent, primaryRootSelf.byteLength);

  const secondaryRootSelf = directoryRecord({ extent: 25, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date, volumeSequenceNumber });
  const secondaryRootParent = directoryRecord({ extent: 25, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date, volumeSequenceNumber });
  const secondaryChild = directoryRecord({ extent: 26, size: SECTOR_SIZE, flags: 0x02, identifier: asciiBytes("ALT"), date, volumeSequenceNumber });
  const secondaryApplicationFile = directoryRecord({ extent: 28, size: applicationPayload.byteLength, flags: 0, identifier: asciiBytes("SUPAPP.TXT;1"), date, volumeSequenceNumber });
  const secondaryBibliographicFile = directoryRecord({ extent: 29, size: bibliographicPayload.byteLength, flags: 0, identifier: asciiBytes("SUPBIB.TXT;1"), date, volumeSequenceNumber });
  const secondaryCopyrightFile = directoryRecord({ extent: 30, size: copyrightPayload.byteLength, flags: 0, identifier: asciiBytes("SUPCPY.TXT;1"), date, volumeSequenceNumber });
  const secondaryAbstractFile = directoryRecord({ extent: 31, size: abstractPayload.byteLength, flags: 0, identifier: asciiBytes("SUPDOC.TXT;1"), date, volumeSequenceNumber });
  secondaryRootDirectory.set(secondaryRootSelf, 0);
  secondaryRootDirectory.set(secondaryRootParent, secondaryRootSelf.byteLength);
  secondaryRootDirectory.set(secondaryChild, secondaryRootSelf.byteLength + secondaryRootParent.byteLength);
  let secondaryRootOffset = secondaryRootSelf.byteLength + secondaryRootParent.byteLength + secondaryChild.byteLength;
  for (const record of [secondaryApplicationFile, secondaryBibliographicFile, secondaryCopyrightFile, secondaryAbstractFile]) {
    secondaryRootDirectory.set(record, secondaryRootOffset);
    secondaryRootOffset += record.byteLength;
  }

  const childSelf = directoryRecord({ extent: 26, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date, volumeSequenceNumber });
  const childParent = directoryRecord({ extent: 25, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date, volumeSequenceNumber });
  const childFile = directoryRecord({ extent: 27, size: filePayload.byteLength, flags: 0, identifier: asciiBytes("SECOND.TXT;1"), date, volumeSequenceNumber });
  secondaryChildDirectory.set(childSelf, 0);
  secondaryChildDirectory.set(childParent, childSelf.byteLength);
  secondaryChildDirectory.set(childFile, childSelf.byteLength + childParent.byteLength);

  writePrimaryDescriptor(pvd, {
    volumeIdentifier: "PRIMARY",
    rootDirectoryRecord: primaryRootSelf,
    pathTableSize: 10,
    typeLPathTableLocation: 19,
    typeMPathTableLocation: 20,
    volumeSpaceSize: 34,
    volumeSetSize,
    volumeSequenceNumber,
    date,
  });

  writeSecondaryDescriptor(secondaryDescriptor, {
    descriptorVersion: input.descriptorVersion,
    fileStructureVersion: input.fileStructureVersion,
    volumeIdentifier: input.volumeIdentifier,
    rootDirectoryRecord: secondaryRootSelf,
    pathTableSize: 22,
    typeLPathTableLocation: 23,
    typeMPathTableLocation: 24,
    volumeSpaceSize: 34,
    volumeSetSize,
    volumeSequenceNumber,
    applicationIdentifier: "_SUPAPP.TXT;1",
    copyrightFileIdentifier: "SUPCPY.TXT;1",
    abstractFileIdentifier: "SUPDOC.TXT;1",
    bibliographicFileIdentifier: "SUPBIB.TXT;1",
    date,
  });

  terminator[0] = 255;
  writeAscii(terminator, 1, 5, "CD001", 0);
  terminator[6] = 1;

  return image;
}

function writePrimaryDescriptor(
  bytes: Uint8Array,
  input: {
    volumeIdentifier: string;
    rootDirectoryRecord: Uint8Array;
    pathTableSize: number;
    typeLPathTableLocation: number;
    typeMPathTableLocation: number;
    volumeSpaceSize: number;
    volumeSetSize?: number;
    volumeSequenceNumber?: number;
    date: Date;
  },
): void {
  bytes[0] = 1;
  writeAscii(bytes, 1, 5, "CD001", 0);
  bytes[6] = 1;
  writeAscii(bytes, 8, 32, "HANDMADE_SYSTEM", 0x20);
  writeAscii(bytes, 40, 32, input.volumeIdentifier, 0x20);
  writeBoth32(bytes, 80, input.volumeSpaceSize);
  writeBoth16(bytes, 120, input.volumeSetSize ?? 1);
  writeBoth16(bytes, 124, input.volumeSequenceNumber ?? 1);
  writeBoth16(bytes, 128, SECTOR_SIZE);
  writeBoth32(bytes, 132, input.pathTableSize);
  writeUint32LE(bytes, 140, input.typeLPathTableLocation);
  writeUint32BE(bytes, 148, input.typeMPathTableLocation);
  bytes.set(input.rootDirectoryRecord, 156);
  writeDescriptorTextFields(bytes, input.date);
  bytes[881] = 1;
}

function writeSecondaryDescriptor(
  bytes: Uint8Array,
  input: {
    descriptorVersion: 1 | 2;
    fileStructureVersion: 1 | 2;
    volumeIdentifier: string;
    rootDirectoryRecord: Uint8Array;
    pathTableSize: number;
    typeLPathTableLocation: number;
    typeMPathTableLocation: number;
    volumeSpaceSize: number;
    volumeSetSize?: number;
    volumeSequenceNumber?: number;
    applicationIdentifier?: string;
    copyrightFileIdentifier?: string;
    abstractFileIdentifier?: string;
    bibliographicFileIdentifier?: string;
    date: Date;
  },
): void {
  bytes[0] = 2;
  writeAscii(bytes, 1, 5, "CD001", 0);
  bytes[6] = input.descriptorVersion;
  bytes[7] = 0;
  writeAscii(bytes, 8, 32, "HANDMADE_SYSTEM", 0x20);
  writeAscii(bytes, 40, 32, input.volumeIdentifier, 0x20);
  writeBoth32(bytes, 80, input.volumeSpaceSize);
  bytes.set(input.descriptorVersion === 2 ? Uint8Array.of(0x25, 0x2f, 0x45) : Uint8Array.of(0x25, 0x2f, 0x40), 88);
  writeBoth16(bytes, 120, input.volumeSetSize ?? 1);
  writeBoth16(bytes, 124, input.volumeSequenceNumber ?? 1);
  writeBoth16(bytes, 128, SECTOR_SIZE);
  writeBoth32(bytes, 132, input.pathTableSize);
  writeUint32LE(bytes, 140, input.typeLPathTableLocation);
  writeUint32BE(bytes, 148, input.typeMPathTableLocation);
  bytes.set(input.rootDirectoryRecord, 156);
  writeDescriptorTextFields(bytes, input.date, {
    applicationIdentifier: input.applicationIdentifier,
    copyrightFileIdentifier: input.copyrightFileIdentifier,
    abstractFileIdentifier: input.abstractFileIdentifier,
    bibliographicFileIdentifier: input.bibliographicFileIdentifier,
  });
  bytes[881] = input.fileStructureVersion;
}

function writeDescriptorTextFields(
  bytes: Uint8Array,
  date: Date,
  options: {
    applicationIdentifier?: string;
    copyrightFileIdentifier?: string;
    abstractFileIdentifier?: string;
    bibliographicFileIdentifier?: string;
  } = {},
): void {
  writeAscii(bytes, 190, 128, "", 0x20);
  writeAscii(bytes, 318, 128, "", 0x20);
  writeAscii(bytes, 446, 128, "", 0x20);
  writeAscii(bytes, 574, 128, options.applicationIdentifier ?? "HANDCRAFTED TEST", 0x20);
  writeAscii(bytes, 702, 37, options.copyrightFileIdentifier ?? "", 0x20);
  writeAscii(bytes, 739, 37, options.abstractFileIdentifier ?? "", 0x20);
  writeAscii(bytes, 776, 37, options.bibliographicFileIdentifier ?? "", 0x20);
  bytes.set(volumeDate(date), 813);
  bytes.set(volumeDate(date), 830);
  bytes.set(volumeDate(null), 847);
  bytes.set(volumeDate(date), 864);
}

function sector(image: Uint8Array, sectorNumber: number): Uint8Array {
  return image.subarray(sectorNumber * SECTOR_SIZE, (sectorNumber + 1) * SECTOR_SIZE);
}

function directoryRecord(input: {
  extent: number;
  size: number;
  flags: number;
  identifier: Uint8Array;
  date: Date;
  fileUnitSize?: number;
  interleaveGapSize?: number;
  volumeSequenceNumber?: number;
  systemUse?: Uint8Array;
}): Uint8Array {
  const baseLength = 33 + input.identifier.byteLength;
  const systemUse = input.systemUse ?? new Uint8Array();
  const length = baseLength + (baseLength % 2 === 0 ? 0 : 1) + systemUse.byteLength;
  const bytes = new Uint8Array(length);
  bytes[0] = length;
  writeBoth32(bytes, 2, input.extent);
  writeBoth32(bytes, 10, input.size);
  bytes.set(directoryDate(input.date), 18);
  bytes[25] = input.flags;
  bytes[26] = input.fileUnitSize ?? 0;
  bytes[27] = input.interleaveGapSize ?? 0;
  writeBoth16(bytes, 28, input.volumeSequenceNumber ?? 1);
  bytes[32] = input.identifier.byteLength;
  bytes.set(input.identifier, 33);
  bytes.set(systemUse, baseLength + (baseLength % 2 === 0 ? 0 : 1));
  return bytes;
}

function writePathTableRoot(bytes: Uint8Array, endian: "little" | "big", extent: number): void {
  bytes[0] = 1;
  bytes[1] = 0;
  if (endian === "little") {
    writeUint32LE(bytes, 2, extent);
    writeUint16LE(bytes, 6, 1);
  } else {
    writeUint32BE(bytes, 2, extent);
    writeUint16BE(bytes, 6, 1);
  }
  bytes[8] = 0;
}

function writePathTableDirectory(bytes: Uint8Array, offset: number, endian: "little" | "big", identifier: Uint8Array, extent: number, parentDirectoryNumber: number): void {
  bytes[offset] = identifier.byteLength;
  bytes[offset + 1] = 0;
  if (endian === "little") {
    writeUint32LE(bytes, offset + 2, extent);
    writeUint16LE(bytes, offset + 6, parentDirectoryNumber);
  } else {
    writeUint32BE(bytes, offset + 2, extent);
    writeUint16BE(bytes, offset + 6, parentDirectoryNumber);
  }
  bytes.set(identifier, offset + 8);
}

function directoryDate(date: Date): Uint8Array {
  return Uint8Array.of(
    date.getUTCFullYear() - 1900,
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    0,
  );
}

function volumeDate(date: Date | null): Uint8Array {
  const bytes = new Uint8Array(17);
  if (!date) {
    bytes.fill(0x30, 0, 16);
    return bytes;
  }
  bytes.set(asciiBytes([
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
    date.getUTCHours().toString().padStart(2, "0"),
    date.getUTCMinutes().toString().padStart(2, "0"),
    date.getUTCSeconds().toString().padStart(2, "0"),
    "00",
  ].join("")));
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, length: number, value: string, filler: number): void {
  bytes.fill(filler, offset, offset + length);
  bytes.set(asciiBytes(value), offset);
}

function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function findDirectoryRecordOffset(image: Uint8Array, directoryOffset: number, directorySize: number, identifier: string): number {
  const expected = asciiBytes(identifier);
  let offset = directoryOffset;
  const end = directoryOffset + directorySize;
  while (offset < end) {
    const length = image[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset - directoryOffset + 1) / SECTOR_SIZE) * SECTOR_SIZE + directoryOffset;
      continue;
    }
    const identifierLength = image[offset + 32]!;
    const actual = image.subarray(offset + 33, offset + 33 + identifierLength);
    if (actual.byteLength === expected.byteLength && actual.every((byte, index) => byte === expected[index])) {
      return offset;
    }
    offset += length;
  }
  throw new Error(`missing directory record ${identifier}`);
}

function writeBoth16(bytes: Uint8Array, offset: number, value: number): void {
  writeUint16LE(bytes, offset, value);
  writeUint16BE(bytes, offset + 2, value);
}

function writeBoth32(bytes: Uint8Array, offset: number, value: number): void {
  writeUint32LE(bytes, offset, value);
  writeUint32BE(bytes, offset + 4, value);
}

function writeUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
