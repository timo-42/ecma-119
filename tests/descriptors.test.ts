import { describe, expect, test } from "vitest";

import { createIsoImage, encodeDirectoryRecord, parseIsoImage, parseVolumeDescriptors, validateIsoImage, writeUint32Both } from "../src/index";
import { SECTOR_SIZE } from "../src/types";
import {
  PVD_SECTOR,
  TERMINATOR_SECTOR,
  createFixtureImage,
  findDirectoryRecord,
  findImageCreator,
  loadEcma119Module,
  readDirectoryRecord,
  sector,
} from "./helpers";

describe("volume descriptor sequence parsing", () => {
  test("writes and reads zero-length files without reading allocated padding", () => {
    const image = createIsoImage([{
      path: "EMPTY.TXT",
      data: "",
    }], {
      volumeIdentifier: "EMPTY",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
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

  test("writes, validates, and reads no-extension file identifiers with both separators", () => {
    const image = createIsoImage([{
      path: "README",
      data: "no extension\n",
    }], {
      volumeIdentifier: "NO_EXT",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsed = parseIsoImage(image, { includeData: true });
    const root = parsed.primaryVolumeDescriptor.rootDirectoryRecord;
    const rootDirectory = image.subarray(root.extent * SECTOR_SIZE, root.extent * SECTOR_SIZE + root.size);
    const record = findDirectoryRecord(rootDirectory, "README.;1");

    expect(validateIsoImage(image)).toEqual([]);
    expect(record).toBeDefined();
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "README",
      identifier: "README.;1",
      size: "no extension\n".length,
    });
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("no extension\n");
  });

  test("writes, validates, and reads file paths at the ECMA-119 path length limit", () => {
    const directories = [...Array.from({ length: 6 }, () => "D".repeat(31)), "E".repeat(30)];
    const fileName = `${"F".repeat(26)}.TXT`;
    const path = [...directories, fileName].join("/");
    const image = createIsoImage([{ path, data: "max path length\n" }], {
      identifierLevel: 2,
      volumeIdentifier: "PATH_LIMIT",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path,
      identifier: `${"F".repeat(26)}.TXT;1`,
    });
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("max path length\n");
  });

  test("writes, validates, and reads a local volume set member", () => {
    const payload = new TextEncoder().encode("volume member data\n");
    const image = createIsoImage([{
      path: "MEMBER.TXT",
      data: payload,
    }], {
      volumeSetSize: 2,
      volumeSequenceNumber: 2,
      volumeIdentifier: "MEMBER_2",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const descriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image, { includeData: true });
    const root = parsed.primaryVolumeDescriptor.rootDirectoryRecord;
    const rootDirectory = image.subarray(root.extent * SECTOR_SIZE, root.extent * SECTOR_SIZE + root.size);
    const self = readDirectoryRecord(rootDirectory, 0);
    const parent = readDirectoryRecord(rootDirectory, self.length);
    const file = readDirectoryRecord(rootDirectory, self.length + parent.length);

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors[0]).toMatchObject({
      kind: "primary",
      volumeSetSize: 2,
      volumeSequenceNumber: 2,
    });
    expect(parsed.primaryVolumeDescriptor).toMatchObject({
      volumeIdentifier: "MEMBER_2",
      volumeSetSize: 2,
      volumeSequenceNumber: 2,
    });
    expect(parsed.root.volumeSequenceNumber).toBe(2);
    expect(parsed.files[0]).toMatchObject({
      path: "MEMBER.TXT",
      identifier: "MEMBER.TXT;1",
      volumeSequenceNumber: 2,
      size: payload.byteLength,
    });
    expect(parsed.files[0]?.data).toEqual(payload);
    expect(self.volumeSequenceNumber).toBe(2);
    expect(parent.volumeSequenceNumber).toBe(2);
    expect(file.volumeSequenceNumber).toBe(2);
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP_MEMBER" }] },
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH_MEMBER" }] },
    },
  ])("writes, validates, and reads $kind trees on a local volume set member", ({ kind, options }) => {
    const payload = new TextEncoder().encode("secondary volume member data\n");
    const image = createIsoImage([{
      path: "DIR/MEMBER.TXT",
      data: payload,
    }], {
      volumeSetSize: 2,
      volumeSequenceNumber: 2,
      volumeIdentifier: "MEMBER_2",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const parsed = parseIsoImage(image, { includeData: true });
    const descriptor = parsed.descriptors.find((candidate) => candidate.kind === kind);

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptor).toMatchObject({
      kind,
      volumeSetSize: 2,
      volumeSequenceNumber: 2,
    });
    if (descriptor?.kind !== "supplementary" && descriptor?.kind !== "enhanced") {
      throw new Error(`expected ${kind} descriptor`);
    }

    expect(descriptor.rootDirectoryRecord.volumeSequenceNumber).toBe(2);
    const rootDirectory = image.subarray(
      descriptor.rootDirectoryRecord.extent * SECTOR_SIZE,
      descriptor.rootDirectoryRecord.extent * SECTOR_SIZE + descriptor.rootDirectoryRecord.size,
    );
    const self = readDirectoryRecord(rootDirectory, 0);
    const parent = readDirectoryRecord(rootDirectory, self.length);
    const dir = readDirectoryRecord(rootDirectory, self.length + parent.length);
    expect(self.volumeSequenceNumber).toBe(2);
    expect(parent.volumeSequenceNumber).toBe(2);
    expect(dir.volumeSequenceNumber).toBe(2);

    const parsedDir = descriptor.rootDirectoryRecord.children.find((node) => "children" in node && node.path === "DIR");
    const parsedFile = parsedDir && "children" in parsedDir
      ? parsedDir.children.find((node) => node.path === "DIR/MEMBER.TXT")
      : undefined;
    expect(parsedFile).toMatchObject({
      path: "DIR/MEMBER.TXT",
      identifier: "MEMBER.TXT;1",
      volumeSequenceNumber: 2,
      size: payload.byteLength,
    });
    expect(parsedFile && !("children" in parsedFile) ? parsedFile.data : undefined).toEqual(payload);
  });

  test("rejects invalid local volume set member options", () => {
    expect(() => createIsoImage([], { volumeSetSize: 0 })).toThrow(/volumeSetSize/i);
    expect(() => createIsoImage([], { volumeSetSize: 1.5 })).toThrow(/volumeSetSize/i);
    expect(() => createIsoImage([], { volumeSetSize: 0x10000 })).toThrow(/volumeSetSize/i);
    expect(() => createIsoImage([], { volumeSequenceNumber: 0 })).toThrow(/volumeSequenceNumber/i);
    expect(() => createIsoImage([], { volumeSequenceNumber: 1.5 })).toThrow(/volumeSequenceNumber/i);
    expect(() => createIsoImage([], { volumeSequenceNumber: 0x10000 })).toThrow(/volumeSequenceNumber/i);
    expect(() => createIsoImage([], { volumeSetSize: 2, volumeSequenceNumber: 3 })).toThrow(/less than or equal to volumeSetSize/i);
  });

  test("writes, validates, and reads explicit file version numbers", () => {
    const image = createIsoImage([
      { path: "README.TXT", data: "older\n", version: 2 },
      { path: "README.TXT", data: "newer\n", version: 12 },
    ], {
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsed = parseIsoImage(image, { includeData: true });
    const root = parsed.primaryVolumeDescriptor.rootDirectoryRecord;
    const rootDirectory = image.subarray(root.extent * SECTOR_SIZE, root.extent * SECTOR_SIZE + root.size);
    const self = readDirectoryRecord(rootDirectory, 0);
    const parent = readDirectoryRecord(rootDirectory, self.length);
    const firstFile = readDirectoryRecord(rootDirectory, self.length + parent.length);
    const secondFile = readDirectoryRecord(rootDirectory, self.length + parent.length + firstFile.length);

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files.map((file) => file.identifier)).toEqual(["README.TXT;12", "README.TXT;2"]);
    expect(parsed.files.map((file) => file.path)).toEqual(["README.TXT", "README.TXT"]);
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("newer\n");
    expect(new TextDecoder("ascii").decode(parsed.files[1]?.data)).toBe("older\n");
    expect(new TextDecoder("ascii").decode(firstFile.fileIdentifier)).toBe("README.TXT;12");
    expect(new TextDecoder("ascii").decode(secondFile.fileIdentifier)).toBe("README.TXT;2");
  });

  test("rejects invalid explicit file version numbers", () => {
    expect(() => createIsoImage([{ path: "README.TXT", data: "", version: 0 }])).toThrow(/file version number/i);
    expect(() => createIsoImage([{ path: "README.TXT", data: "", version: 1.5 }])).toThrow(/file version number/i);
    expect(() => createIsoImage([{ path: "README.TXT", data: "", version: 32768 }])).toThrow(/file version number/i);
  });

  test("writes, validates, and reads non-interleaved multi-extent files", () => {
    const payload = new TextEncoder().encode("abcdefghijklmn");
    const image = createIsoImage([{
      path: "MULTI.TXT",
      data: payload,
      multiExtent: { sectionSize: 5 },
    }], {
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsed = parseIsoImage(image, { includeData: true });
    const file = parsed.files[0];

    expect(validateIsoImage(image)).toEqual([]);
    expect(file).toMatchObject({
      path: "MULTI.TXT",
      identifier: "MULTI.TXT;1",
      size: payload.byteLength,
      flags: 0x80,
      sections: [
        expect.objectContaining({ size: 5, flags: 0x80, fileUnitSize: 0, interleaveGapSize: 0 }),
        expect.objectContaining({ size: 5, flags: 0x80, fileUnitSize: 0, interleaveGapSize: 0 }),
        expect.objectContaining({ size: 4, flags: 0x00, fileUnitSize: 0, interleaveGapSize: 0 }),
      ],
    });
    expect(file?.data).toEqual(payload);

    const root = parsed.primaryVolumeDescriptor.rootDirectoryRecord;
    const rootDirectory = image.subarray(root.extent * SECTOR_SIZE, root.extent * SECTOR_SIZE + root.size);
    const self = readDirectoryRecord(rootDirectory, 0);
    const parent = readDirectoryRecord(rootDirectory, self.length);
    const first = readDirectoryRecord(rootDirectory, self.length + parent.length);
    const second = readDirectoryRecord(rootDirectory, self.length + parent.length + first.length);
    const third = readDirectoryRecord(rootDirectory, self.length + parent.length + first.length + second.length);
    const decoder = new TextDecoder("ascii");

    expect([first, second, third].map((record) => decoder.decode(record.fileIdentifier))).toEqual([
      "MULTI.TXT;1",
      "MULTI.TXT;1",
      "MULTI.TXT;1",
    ]);
    expect([first.dataLength, second.dataLength, third.dataLength]).toEqual([5, 5, 4]);
    expect([first.flags, second.flags, third.flags]).toEqual([0x80, 0x80, 0x00]);
    expect(first.extent).toBeLessThan(second.extent);
    expect(second.extent).toBeLessThan(third.extent);
  });

  test("writes, validates, and reads secondary descriptor multi-extent files", () => {
    const payload = new TextEncoder().encode("abcdefghijklmn");
    const image = createIsoImage([{
      path: "MULTI.TXT",
      data: payload,
      multiExtent: { sectionSize: 5 },
    }], {
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }],
      enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    for (const kind of ["supplementary", "enhanced"] as const) {
      const descriptor = parsed.descriptors.find((candidate) => candidate.kind === kind);
      if (descriptor?.kind !== kind) {
        throw new Error(`missing ${kind} descriptor`);
      }
      const file = descriptor.rootDirectoryRecord.children.find((node) => node.path === "MULTI.TXT");
      if (!file || "children" in file) {
        throw new Error(`missing ${kind} multi-extent file`);
      }
      expect(file).toMatchObject({
        path: "MULTI.TXT",
        identifier: "MULTI.TXT;1",
        size: payload.byteLength,
        flags: 0x80,
        sections: [
          expect.objectContaining({ size: 5, flags: 0x80, fileUnitSize: 0, interleaveGapSize: 0 }),
          expect.objectContaining({ size: 5, flags: 0x80, fileUnitSize: 0, interleaveGapSize: 0 }),
          expect.objectContaining({ size: 4, flags: 0x00, fileUnitSize: 0, interleaveGapSize: 0 }),
        ],
      });
      expect(file.data).toEqual(payload);
    }
  });

  test("rejects multi-extent directory records", () => {
    const files = Array.from({ length: 70 }, (_, index) => ({
      path: `DIR/M${String(index).padStart(3, "0")}.TXT`,
      data: `multi dir ${index}\n`,
    }));
    const image = createIsoImage(files, {
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsedBefore = parseIsoImage(image);
    const root = parsedBefore.primaryVolumeDescriptor.rootDirectoryRecord;
    const rootDirectory = image.subarray(root.extent * SECTOR_SIZE, root.extent * SECTOR_SIZE + root.size);
    const dirRecordOffset = findDirectoryRecordOffset(rootDirectory, "DIR");
    const dirRecord = readDirectoryRecord(rootDirectory, dirRecordOffset);
    expect(dirRecord.dataLength).toBeGreaterThan(SECTOR_SIZE);

    rootDirectory[dirRecordOffset + 25] = dirRecord.flags | 0x80;
    writeUint32Both(rootDirectory, dirRecordOffset + 10, SECTOR_SIZE);
    rootDirectory.set(encodeDirectoryRecord({
      extent: dirRecord.extent + 1,
      dataLength: dirRecord.dataLength - SECTOR_SIZE,
      flags: 0x02,
      identifier: new TextEncoder().encode("DIR"),
      date: new Date("2024-01-01T00:00:00Z"),
      volumeSequenceNumber: dirRecord.volumeSequenceNumber,
    }), dirRecordOffset + dirRecord.length);

    const issues = validateIsoImage(image);

    expect(() => parseIsoImage(image, { includeData: true })).toThrow(/unsupported multi-extent/i);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.multi_extent_unsupported",
          path: "DIR",
          message: expect.stringMatching(/unsupported multi-extent/i),
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.interleaving_invalid",
          path: "DIR",
        }),
      ]),
    );
  });

  test("rejects invalid multi-extent authoring options", () => {
    expect(() => createIsoImage([{
      path: "BAD.TXT",
      data: "abcdef",
      multiExtent: { sectionSize: 0 },
    }])).toThrow(/sectionSize/i);
    expect(() => createIsoImage([{
      path: "BAD.TXT",
      data: "abcdef",
      multiExtent: { sectionSize: 6 },
    }])).toThrow(/smaller than the file data length/i);
  });

  test("writes, validates, and reads interleaved regular files", () => {
    const payload = new Uint8Array(SECTOR_SIZE + 11);
    payload.fill(0x31, 0, SECTOR_SIZE);
    payload.set(new TextEncoder().encode("second unit"), SECTOR_SIZE);
    const image = createIsoImage([{
      path: "INTER.BIN",
      data: payload,
      interleave: { fileUnitSize: 1, interleaveGapSize: 1 },
    }], {
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsed = parseIsoImage(image, { includeData: true });
    const file = parsed.files[0];

    expect(validateIsoImage(image)).toEqual([]);
    expect(file).toMatchObject({
      path: "INTER.BIN",
      identifier: "INTER.BIN;1",
      size: payload.byteLength,
      fileUnitSize: 1,
      interleaveGapSize: 1,
    });
    expect(file?.data).toEqual(payload);

    const root = parsed.primaryVolumeDescriptor.rootDirectoryRecord;
    const rootDirectory = image.subarray(root.extent * SECTOR_SIZE, root.extent * SECTOR_SIZE + root.size);
    const self = readDirectoryRecord(rootDirectory, 0);
    const parent = readDirectoryRecord(rootDirectory, self.length);
    const record = readDirectoryRecord(rootDirectory, self.length + parent.length);
    const gap = image.subarray((record.extent + 1) * SECTOR_SIZE, (record.extent + 2) * SECTOR_SIZE);
    const secondUnit = image.subarray((record.extent + 2) * SECTOR_SIZE, (record.extent + 2) * SECTOR_SIZE + 11);

    expect(record.fileUnitSize).toBe(1);
    expect(record.interleaveGapSize).toBe(1);
    expect(gap.every((byte) => byte === 0)).toBe(true);
    expect(new TextDecoder("ascii").decode(secondUnit)).toBe("second unit");
  });

  test("rejects interleaved directory authoring", () => {
    expect(() => createIsoImage([{ path: "DIR/FILE.TXT", data: "directory\n" }], {
      directories: [{
        path: "DIR",
        interleave: { fileUnitSize: 1, interleaveGapSize: 1 },
      } as never],
    })).toThrow(/directory records must not be recorded in interleaved mode/i);

    expect(() => createIsoImage([{ path: "ROOT.TXT", data: "root\n" }], {
      directories: [{
        path: "",
        interleave: { fileUnitSize: 1, interleaveGapSize: 1 },
      } as never],
    })).toThrow(/directory records must not be recorded in interleaved mode/i);

    expect(() => createIsoImage([{ path: "DIR/SECOND.TXT", data: "secondary\n" }], {
      directories: [{
        path: "DIR",
        interleave: { fileUnitSize: 1, interleaveGapSize: 1 },
      } as never],
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }],
      enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }],
    })).toThrow(/directory records must not be recorded in interleaved mode/i);
  });

  test("writes, validates, and reads files that are both multi-extent and interleaved", () => {
    const payload = new Uint8Array(SECTOR_SIZE * 2 + 11);
    payload.fill(0x41, 0, SECTOR_SIZE);
    payload.fill(0x42, SECTOR_SIZE, SECTOR_SIZE * 2);
    payload.set(new TextEncoder().encode("final bytes"), SECTOR_SIZE * 2);
    const image = createIsoImage([{
      path: "MIXED.BIN",
      data: payload,
      multiExtent: { sectionSize: SECTOR_SIZE + 3 },
      interleave: { fileUnitSize: 1, interleaveGapSize: 1 },
    }], {
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const parsed = parseIsoImage(image, { includeData: true });
    const file = parsed.files[0];

    expect(validateIsoImage(image)).toEqual([]);
    expect(file).toMatchObject({
      path: "MIXED.BIN",
      identifier: "MIXED.BIN;1",
      size: payload.byteLength,
      fileUnitSize: 1,
      interleaveGapSize: 1,
      sections: [
        expect.objectContaining({ size: SECTOR_SIZE + 3, flags: 0x80, fileUnitSize: 1, interleaveGapSize: 1 }),
        expect.objectContaining({ size: SECTOR_SIZE + 3, flags: 0x80, fileUnitSize: 1, interleaveGapSize: 1 }),
        expect.objectContaining({ size: 5, flags: 0x00, fileUnitSize: 1, interleaveGapSize: 1 }),
      ],
    });
    expect(file?.data).toEqual(payload);
  });

  test("rejects invalid interleaved file authoring options", () => {
    const file = { path: "BAD.BIN", data: "interleaved" };
    expect(() => createIsoImage([{ ...file, interleave: { fileUnitSize: 0, interleaveGapSize: 0 } }])).toThrow(/fileUnitSize/i);
    expect(() => createIsoImage([{ ...file, interleave: { fileUnitSize: 256, interleaveGapSize: 0 } }])).toThrow(/fileUnitSize/i);
    expect(() => createIsoImage([{ ...file, interleave: { fileUnitSize: 1.5, interleaveGapSize: 0 } }])).toThrow(/fileUnitSize/i);
    expect(() => createIsoImage([{ ...file, interleave: { fileUnitSize: 1, interleaveGapSize: -1 } }])).toThrow(/interleaveGapSize/i);
    expect(() => createIsoImage([{ ...file, interleave: { fileUnitSize: 1, interleaveGapSize: 256 } }])).toThrow(/interleaveGapSize/i);
    expect(() => createIsoImage([{ ...file, interleave: { fileUnitSize: 1, interleaveGapSize: 1.5 } }])).toThrow(/interleaveGapSize/i);
    expect(() => createIsoImage([{ path: "EMPTY.BIN", data: "", interleave: { fileUnitSize: 1, interleaveGapSize: 0 } }])).toThrow(/at least one byte/i);
  });

  test("rejects all interleaved directory authoring options", () => {
    const directory = { path: "DIR" };
    expect(() => createIsoImage([], { directories: [{ ...directory, interleave: { fileUnitSize: 0, interleaveGapSize: 0 } } as never] })).toThrow(/directory records must not be recorded in interleaved mode/i);
    expect(() => createIsoImage([], { directories: [{ ...directory, interleave: { fileUnitSize: 256, interleaveGapSize: 0 } } as never] })).toThrow(/directory records must not be recorded in interleaved mode/i);
    expect(() => createIsoImage([], { directories: [{ ...directory, interleave: { fileUnitSize: 1.5, interleaveGapSize: 0 } } as never] })).toThrow(/directory records must not be recorded in interleaved mode/i);
    expect(() => createIsoImage([], { directories: [{ ...directory, interleave: { fileUnitSize: 1, interleaveGapSize: -1 } } as never] })).toThrow(/directory records must not be recorded in interleaved mode/i);
    expect(() => createIsoImage([], { directories: [{ ...directory, interleave: { fileUnitSize: 1, interleaveGapSize: 256 } } as never] })).toThrow(/directory records must not be recorded in interleaved mode/i);
    expect(() => createIsoImage([], { directories: [{ ...directory, interleave: { fileUnitSize: 1, interleaveGapSize: 1.5 } } as never] })).toThrow(/directory records must not be recorded in interleaved mode/i);
  });

  test("rejects interleaved extended attribute records larger than the file unit", () => {
    expect(() => createIsoImage([{
      path: "EAR.BIN",
      data: "interleaved ear",
      interleave: { fileUnitSize: 1, interleaveGapSize: 1 },
      extendedAttributeRecord: new Uint8Array(SECTOR_SIZE + 1),
    }])).toThrow(/file unit size/i);
  });

  test("writes supplementary volume descriptors with separate path tables and directory hierarchy", () => {
    const image = createIsoImage([{
      path: "README.TXT",
      data: "descriptor shifted\n",
    }], {
      volumeIdentifier: "PRIMARY",
      volumeSetIdentifier: "BASE_SET",
      publisherIdentifier: "BASE_PUB",
      dataPreparerIdentifier: "BASE_PREP",
      applicationIdentifier: "BASE_APP",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
        systemIdentifier: "SUP_SYS",
        volumeSetIdentifier: "SUP_SET",
        publisherIdentifier: "SUP_PUB",
        dataPreparerIdentifier: "SUP_PREP",
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
      volumeSetIdentifier: "SUP_SET",
      publisherIdentifier: "SUP_PUB",
      dataPreparerIdentifier: "SUP_PREP",
      applicationIdentifier: "SUP_APP",
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
    const image = createIsoImage([
      {
        path: "README.TXT",
        data: "descriptor file identifiers\n",
      },
      { path: "COPY.TXT", data: "copyright\n" },
      { path: "ABSTRACT.TXT", data: "abstract\n" },
      { path: "BIBLIO.TXT", data: "bibliographic\n" },
    ], {
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

  test("writes primary volume descriptor file identifier fields with explicit versions", () => {
    const image = createIsoImage([
      { path: "COPY.TXT", data: "copyright v2\n", version: 2 },
      { path: "README", data: "abstract v32767\n", version: 32767 },
    ], {
      copyrightFileIdentifier: "COPY.TXT;2",
      abstractFileIdentifier: "README.;32767",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.primaryVolumeDescriptor).toMatchObject({
      copyrightFileIdentifier: "COPY.TXT;2",
      abstractFileIdentifier: "README.;32767",
    });
    expect(parsed.files.map((file) => file.identifier)).toEqual(["COPY.TXT;2", "README.;32767"]);
  });

  test("rejects invalid descriptor file identifier versions", () => {
    expect(() => createIsoImage([{ path: "COPY.TXT", data: "", version: 1 }], {
      copyrightFileIdentifier: "COPY.TXT;0",
    })).toThrow(/file version number/i);
    expect(() => createIsoImage([{ path: "COPY.TXT", data: "", version: 1 }], {
      copyrightFileIdentifier: "COPY.TXT;32768",
    })).toThrow(/file version number/i);
    expect(() => createIsoImage([{ path: "COPY.TXT", data: "", version: 1 }], {
      supplementaryVolumeDescriptors: [{ abstractFileIdentifier: "COPY.TXT;01" }],
    })).toThrow(/file version number/i);
  });

  test("writes, validates, and reads Level 2 primary identifiers", () => {
    const payload = "level two primary identifiers\n";
    const image = createIsoImage([
      {
        path: "LONGDIRECTORYNAME/LONGFILENAME1234567890.TXT",
        data: payload,
      },
      {
        path: "LONGCOPYRIGHTFILENAME.TXT",
        data: "copyright\n",
      },
    ], {
      identifierLevel: 2,
      copyrightFileIdentifier: "LONGCOPYRIGHTFILENAME.TXT",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.primaryVolumeDescriptor.copyrightFileIdentifier).toBe("LONGCOPYRIGHTFILENAME.TXT;1");
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files.find((file) => file.path === "LONGDIRECTORYNAME/LONGFILENAME1234567890.TXT")).toMatchObject({
      path: "LONGDIRECTORYNAME/LONGFILENAME1234567890.TXT",
      identifier: "LONGFILENAME1234567890.TXT;1",
      size: payload.length,
    });
    const file = parsed.files.find((entry) => entry.path === "LONGDIRECTORYNAME/LONGFILENAME1234567890.TXT");
    expect(new TextDecoder("ascii").decode(file?.data)).toBe(payload);
    expect(parsed.root.children.find((entry) => entry.path === "LONGDIRECTORYNAME")).toMatchObject({
      path: "LONGDIRECTORYNAME",
      identifier: "LONGDIRECTORYNAME",
    });
  });

  test("keeps Level 1 identifier authoring as the default", () => {
    expect(() => createIsoImage([{
      path: "LONGDIRECTORYNAME/LONGFILENAME1234567890.TXT",
      data: "default level\n",
    }])).toThrow(/directory identifier exceeds 8 d-characters/i);
    expect(() => createIsoImage([], { identifierLevel: 3 as 1 })).toThrow(/identifierLevel must be 1 or 2/i);
  });

  test("writes optional primary Type L and Type M path table copies", () => {
    const image = createIsoImage([{
      path: "DIR/README.TXT",
      data: "optional primary path tables\n",
    }], {
      volumeIdentifier: "OPTIONAL_PATHS",
      optionalPathTables: true,
    });

    const parsed = parseIsoImage(image, { includeData: true });
    const primary = parsed.primaryVolumeDescriptor;

    expect(validateIsoImage(image)).toEqual([]);
    expect(primary.optionalTypeLPathTableLocation).not.toBe(0);
    expect(primary.optionalTypeMPathTableLocation).not.toBe(0);
    expect(primary.optionalTypeLPathTableLocation).not.toBe(primary.typeLPathTableLocation);
    expect(primary.optionalTypeMPathTableLocation).not.toBe(primary.typeMPathTableLocation);
    expect(primary.pathTables).toMatchObject({
      typeL: [
        expect.objectContaining({ identifier: Uint8Array.of(0), parentDirectoryNumber: 1 }),
        expect.objectContaining({ identifier: new TextEncoder().encode("DIR"), parentDirectoryNumber: 1 }),
      ],
      typeM: [
        expect.objectContaining({ identifier: Uint8Array.of(0), parentDirectoryNumber: 1 }),
        expect.objectContaining({ identifier: new TextEncoder().encode("DIR"), parentDirectoryNumber: 1 }),
      ],
      optionalTypeL: [
        expect.objectContaining({ identifier: Uint8Array.of(0), parentDirectoryNumber: 1 }),
        expect.objectContaining({ identifier: new TextEncoder().encode("DIR"), parentDirectoryNumber: 1 }),
      ],
      optionalTypeM: [
        expect.objectContaining({ identifier: Uint8Array.of(0), parentDirectoryNumber: 1 }),
        expect.objectContaining({ identifier: new TextEncoder().encode("DIR"), parentDirectoryNumber: 1 }),
      ],
    });
    expect(primary.pathTables?.optionalTypeL).toEqual(primary.pathTables?.typeL);
    expect(primary.pathTables?.optionalTypeM).toEqual(primary.pathTables?.typeM);
    expect(pathTableBytes(image, primary.optionalTypeLPathTableLocation, primary.pathTableSize)).toEqual(
      pathTableBytes(image, primary.typeLPathTableLocation, primary.pathTableSize),
    );
    expect(pathTableBytes(image, primary.optionalTypeMPathTableLocation, primary.pathTableSize)).toEqual(
      pathTableBytes(image, primary.typeMPathTableLocation, primary.pathTableSize),
    );
    expect(parsed.files[0]).toMatchObject({
      path: "DIR/README.TXT",
      size: "optional primary path tables\n".length,
    });
  });

  test("writes optional secondary descriptor path table copies with per-descriptor overrides", () => {
    const image = createIsoImage([{
      path: "DIR/README.TXT",
      data: "optional secondary path tables\n",
    }], {
      volumeIdentifier: "PRIMARY",
      optionalPathTables: { typeL: true },
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
        optionalPathTables: { typeM: true },
      }],
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
        optionalPathTables: false,
      }],
    });

    const descriptors = parseVolumeDescriptors(image);
    const primary = descriptors.find((descriptor) => descriptor.kind === "primary");
    const supplementary = descriptors.find((descriptor) => descriptor.kind === "supplementary");
    const enhanced = descriptors.find((descriptor) => descriptor.kind === "enhanced");

    expect(validateIsoImage(image)).toEqual([]);
    expect(primary?.kind === "primary" ? primary.optionalTypeLPathTableLocation : undefined).not.toBe(0);
    expect(primary?.kind === "primary" ? primary.optionalTypeMPathTableLocation : undefined).toBe(0);
    expect(supplementary?.kind === "supplementary" ? supplementary.optionalTypeLPathTableLocation : undefined).toBe(0);
    expect(supplementary?.kind === "supplementary" ? supplementary.optionalTypeMPathTableLocation : undefined).not.toBe(0);
    expect(enhanced?.kind === "enhanced" ? enhanced.optionalTypeLPathTableLocation : undefined).toBe(0);
    expect(enhanced?.kind === "enhanced" ? enhanced.optionalTypeMPathTableLocation : undefined).toBe(0);

    if (supplementary?.kind !== "supplementary") {
      throw new Error("expected supplementary descriptor");
    }
    const parsed = parseIsoImage(image, { includeData: false });
    const parsedPrimary = parsed.primaryVolumeDescriptor;
    const parsedSupplementary = parsed.descriptors.find((descriptor) => descriptor.kind === "supplementary");
    const parsedEnhanced = parsed.descriptors.find((descriptor) => descriptor.kind === "enhanced");

    expect(parsedPrimary.pathTables?.optionalTypeL).toEqual(parsedPrimary.pathTables?.typeL);
    expect(parsedPrimary.pathTables?.optionalTypeM).toBeUndefined();
    expect(parsedSupplementary?.kind === "supplementary" ? parsedSupplementary.pathTables?.optionalTypeL : undefined).toBeUndefined();
    expect(parsedSupplementary?.kind === "supplementary" ? parsedSupplementary.pathTables?.optionalTypeM : undefined).toEqual(
      parsedSupplementary?.kind === "supplementary" ? parsedSupplementary.pathTables?.typeM : undefined,
    );
    expect(parsedEnhanced?.kind === "enhanced" ? parsedEnhanced.pathTables?.optionalTypeL : undefined).toBeUndefined();
    expect(parsedEnhanced?.kind === "enhanced" ? parsedEnhanced.pathTables?.optionalTypeM : undefined).toBeUndefined();
    expect(pathTableBytes(image, supplementary.optionalTypeMPathTableLocation, supplementary.pathTableSize)).toEqual(
      pathTableBytes(image, supplementary.typeMPathTableLocation, supplementary.pathTableSize),
    );
  });

  test("writes enhanced optional path table copies", () => {
    const image = createIsoImage([{
      path: "DIR/README.TXT",
      data: "enhanced optional path tables\n",
    }], {
      volumeIdentifier: "PRIMARY",
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
        optionalPathTables: true,
      }],
    });

    const parsed = parseIsoImage(image, { includeData: true });
    const enhanced = parsed.descriptors.find((descriptor) => descriptor.kind === "enhanced");

    expect(validateIsoImage(image)).toEqual([]);
    if (enhanced?.kind !== "enhanced") {
      throw new Error("expected enhanced descriptor");
    }
    expect(enhanced.optionalTypeLPathTableLocation).not.toBe(0);
    expect(enhanced.optionalTypeMPathTableLocation).not.toBe(0);
    expect(enhanced.optionalTypeLPathTableLocation).not.toBe(enhanced.typeLPathTableLocation);
    expect(enhanced.optionalTypeMPathTableLocation).not.toBe(enhanced.typeMPathTableLocation);
    expect(enhanced.pathTables?.typeL).toHaveLength(2);
    expect(enhanced.pathTables?.typeM).toHaveLength(2);
    expect(enhanced.pathTables?.optionalTypeL).toEqual(enhanced.pathTables?.typeL);
    expect(enhanced.pathTables?.optionalTypeM).toEqual(enhanced.pathTables?.typeM);
    expect(pathTableBytes(image, enhanced.optionalTypeLPathTableLocation, enhanced.pathTableSize)).toEqual(
      pathTableBytes(image, enhanced.typeLPathTableLocation, enhanced.pathTableSize),
    );
    expect(pathTableBytes(image, enhanced.optionalTypeMPathTableLocation, enhanced.pathTableSize)).toEqual(
      pathTableBytes(image, enhanced.typeMPathTableLocation, enhanced.pathTableSize),
    );
    const enhancedDir = enhanced.rootDirectoryRecord.children.find((node) => "children" in node && node.path === "DIR");
    expect(enhancedDir && "children" in enhancedDir ? enhancedDir.children.find((node) => node.path === "DIR/README.TXT") : undefined).toMatchObject({
      path: "DIR/README.TXT",
      size: "enhanced optional path tables\n".length,
    });
  });

  test("writes enhanced volume descriptors with separate path tables and directory hierarchy", () => {
    const image = createIsoImage([
      {
        path: "DIR/README.TXT",
        data: "enhanced descriptor\n",
      },
      { path: "COPY.TXT", data: "copyright\n" },
      { path: "ABSTRACT.TXT", data: "abstract\n" },
      { path: "BIBLIO.TXT", data: "bibliographic\n" },
      { path: "ENHABS.TXT", data: "enhanced abstract\n" },
    ], {
      volumeIdentifier: "PRIMARY",
      copyrightFileIdentifier: "COPY.TXT",
      abstractFileIdentifier: "ABSTRACT.TXT",
      bibliographicFileIdentifier: "BIBLIO.TXT",
      volumeDescriptorApplicationUse: Uint8Array.of(9, 9),
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
        systemIdentifier: "ENH_SYS",
        volumeSetIdentifier: "ENH_SET",
        publisherIdentifier: "ENH_PUB",
        dataPreparerIdentifier: "ENH_PREP",
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
      volumeSetIdentifier: "ENH_SET",
      publisherIdentifier: "ENH_PUB",
      dataPreparerIdentifier: "ENH_PREP",
      applicationIdentifier: "ENH_APP",
    });
    expect(enhanced).toMatchObject({
      copyrightFileIdentifier: "COPY.TXT;1",
      abstractFileIdentifier: "ENHABS.TXT;1",
      bibliographicFileIdentifier: "BIBLIO.TXT;1",
      fileStructureVersion: 2,
    });
    expect(image[17 * SECTOR_SIZE + 881]).toBe(2);
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
    const readme = parsed.files.find((file) => file.path === "DIR/README.TXT");
    expect(parsed.files.map((file) => file.path).sort()).toEqual([
      "ABSTRACT.TXT",
      "BIBLIO.TXT",
      "COPY.TXT",
      "DIR/README.TXT",
      "ENHABS.TXT",
    ]);
    expect(parsed.root.fileUnitSize).toBe(0);
    expect(parsed.root.interleaveGapSize).toBe(0);
    expect(readme).toMatchObject({
      fileUnitSize: 0,
      interleaveGapSize: 0,
      volumeSequenceNumber: 1,
    });
    expect(new TextDecoder("ascii").decode(readme?.data)).toBe("enhanced descriptor\n");
  });

  test("writes secondary descriptor file identifier fields with explicit versions", () => {
    const image = createIsoImage([
      { path: "COPY.TXT", data: "primary copy\n", version: 2 },
      { path: "SUPABS.TXT", data: "supplementary abstract\n", version: 7 },
    ], {
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
        copyrightFileIdentifier: "COPY.TXT;2",
        abstractFileIdentifier: "SUPABS.TXT;7",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsed = parseIsoImage(image, { includeData: true });
    const supplementary = parsed.descriptors.find((descriptor) => descriptor.kind === "supplementary");

    expect(validateIsoImage(image)).toEqual([]);
    expect(supplementary).toMatchObject({
      kind: "supplementary",
      copyrightFileIdentifier: "COPY.TXT;2",
      abstractFileIdentifier: "SUPABS.TXT;7",
    });
    expect(parsed.files.map((file) => file.identifier)).toEqual(["COPY.TXT;2", "SUPABS.TXT;7"]);
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
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "partition", "boot", "terminator"]);

    const mutations = [
      { sector: 16, offset: 8, code: "pvd.system_identifier.characters", message: /system identifier/i, descriptorKind: "primary", parseMessage: /primary volume descriptor system identifier contains invalid ECMA-119 a-characters/i },
      { sector: 16, offset: 40, code: "pvd.volume_identifier.characters", message: /volume identifier/i, descriptorKind: "primary", parseMessage: /primary volume descriptor volume identifier contains invalid ECMA-119 d-characters/i },
      { sector: 16, offset: 190, code: "pvd.volume_set_identifier.characters", message: /volume set identifier/i, descriptorKind: "primary", parseMessage: /primary volume descriptor volume set identifier contains invalid ECMA-119 d-characters/i },
      { sector: 16, offset: 318, code: "pvd.publisher_identifier.characters", message: /publisher identifier/i, descriptorKind: "primary", parseMessage: /primary volume descriptor publisher identifier contains invalid ECMA-119 a-characters/i },
      { sector: 16, offset: 446, code: "pvd.data_preparer_identifier.characters", message: /data preparer identifier/i, descriptorKind: "primary", parseMessage: /primary volume descriptor data preparer identifier contains invalid ECMA-119 a-characters/i },
      { sector: 16, offset: 574, code: "pvd.application_identifier.characters", message: /application identifier/i, descriptorKind: "primary", parseMessage: /primary volume descriptor application identifier contains invalid ECMA-119 a-characters/i },
      { sector: 16, offset: 702, code: "pvd.copyright_file_identifier.characters", message: /copyright file identifier/i, descriptorKind: "primary", parseMessage: /primary volume descriptor copyright file identifier contains invalid ECMA-119 file-characters/i },
      { sector: 16, offset: 739, code: "pvd.abstract_file_identifier.characters", message: /abstract file identifier/i, descriptorKind: "primary", parseMessage: /primary volume descriptor abstract file identifier contains invalid ECMA-119 file-characters/i },
      { sector: 16, offset: 776, code: "pvd.bibliographic_file_identifier.characters", message: /bibliographic file identifier/i, descriptorKind: "primary", parseMessage: /primary volume descriptor bibliographic file identifier contains invalid ECMA-119 file-characters/i },
      { sector: 18, offset: 7, code: "boot.system_identifier.characters", message: /boot system identifier/i, descriptorKind: "boot", parseMessage: /boot system identifier contains invalid ECMA-119 a-characters/i },
      { sector: 18, offset: 39, code: "boot.identifier.characters", message: /boot identifier/i, descriptorKind: "boot", parseMessage: /boot identifier contains invalid ECMA-119 a-characters/i },
      { sector: 17, offset: 8, code: "partition.system_identifier.characters", message: /system identifier/i, descriptorKind: "partition", parseMessage: /volume partition descriptor system identifier contains invalid ECMA-119 a-characters/i },
      { sector: 17, offset: 40, code: "partition.volume_partition_identifier.characters", message: /volume partition identifier/i, descriptorKind: "partition", parseMessage: /volume partition descriptor volume partition identifier contains invalid ECMA-119 d-characters/i },
    ];

    for (const mutation of mutations) {
      const mutated = imageWithDescriptorByte(image, mutation.sector, mutation.offset, 0x23);
      if (mutation.parseMessage) {
        expect(parseVolumeDescriptors(mutated).some((descriptor) => descriptor.kind === mutation.descriptorKind)).toBe(true);
        expect(() => parseIsoImage(mutated)).toThrow(mutation.parseMessage);
      }
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
    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "supplementary", "enhanced", "terminator"]);
    expect(descriptors.map((descriptor) => descriptor.sector)).toEqual([16, 17, 18, 19]);
    expect(parsed.files[0]).toMatchObject({
      path: "README.TXT",
      identifier: "README.TXT;1",
      size: "both descriptors\n".length,
    });
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("both descriptors\n");
  });

  test("writes, validates, and reads per-secondary descriptor date overrides", () => {
    const baseCreatedAt = new Date("2024-01-01T00:00:00Z");
    const supplementaryCreatedAt = new Date("2025-02-03T04:05:06.070Z");
    const supplementaryModifiedAt = new Date("2025-02-04T05:06:07.080Z");
    const supplementaryEffectiveAt = new Date("2025-02-05T06:07:08.090Z");
    const enhancedCreatedAt = new Date("2026-03-04T05:06:07.080Z");
    const enhancedModifiedAt = new Date("2026-03-05T06:07:08.090Z");
    const enhancedEffectiveAt = new Date("2026-03-06T07:08:09.010Z");
    const enhancedExpiresAt = new Date("2027-04-05T06:07:08.090Z");
    const image = createIsoImage([{
      path: "DATES.TXT",
      data: "secondary descriptor dates\n",
    }], {
      createdAt: baseCreatedAt,
      modifiedAt: new Date("2024-01-02T00:00:00Z"),
      effectiveAt: new Date("2024-01-03T00:00:00Z"),
      expiresAt: new Date("2024-12-31T00:00:00Z"),
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
        createdAt: supplementaryCreatedAt,
        modifiedAt: supplementaryModifiedAt,
        effectiveAt: supplementaryEffectiveAt,
        expiresAt: null,
        timeZoneOffsetMinutes: 60,
      }],
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
        createdAt: enhancedCreatedAt,
        modifiedAt: enhancedModifiedAt,
        effectiveAt: enhancedEffectiveAt,
        expiresAt: enhancedExpiresAt,
        timeZoneOffsetMinutes: -120,
      }],
    });

    const parsed = parseIsoImage(image, { includeData: true });
    const descriptors = parsed.descriptors;
    const primary = parsed.primaryVolumeDescriptor;
    const supplementary = descriptors.find((descriptor) => descriptor.kind === "supplementary");
    const enhanced = descriptors.find((descriptor) => descriptor.kind === "enhanced");

    expect(validateIsoImage(image)).toEqual([]);
    expect(primary.createdAt).toEqual(baseCreatedAt);
    expect(supplementary).toMatchObject({
      kind: "supplementary",
      createdAt: supplementaryCreatedAt,
      modifiedAt: supplementaryModifiedAt,
      expiresAt: null,
      effectiveAt: supplementaryEffectiveAt,
    });
    expect(enhanced).toMatchObject({
      kind: "enhanced",
      createdAt: enhancedCreatedAt,
      modifiedAt: enhancedModifiedAt,
      expiresAt: enhancedExpiresAt,
      effectiveAt: enhancedEffectiveAt,
    });
    expect(parsed.files[0]).toMatchObject({
      path: "DATES.TXT",
      data: new TextEncoder().encode("secondary descriptor dates\n"),
    });
  });

  test("writes, validates, and reads all descriptor classes in ECMA-119 sequence order", () => {
    const image = createIsoImage([{
      path: "README.TXT",
      data: "all descriptor classes\n",
    }], {
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }],
      enhancedVolumeDescriptors: [{ volumeIdentifier: "ENHANCED" }],
      volumePartition: {
        volumePartitionIdentifier: "PARTITION",
        data: "partition payload\n",
      },
      bootRecord: {
        bootSystemIdentifier: "BOOT SYSTEM",
        bootIdentifier: "BOOT ID",
      },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const descriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual([
      "primary",
      "supplementary",
      "enhanced",
      "partition",
      "boot",
      "terminator",
    ]);
    expect(descriptors.map((descriptor) => descriptor.sector)).toEqual([16, 17, 18, 19, 20, 21]);
    expect(parsed.descriptors.map((descriptor) => descriptor.kind)).toEqual(descriptors.map((descriptor) => descriptor.kind));
    expect(parsed.files[0]).toMatchObject({
      path: "README.TXT",
      identifier: "README.TXT;1",
      data: new TextEncoder().encode("all descriptor classes\n"),
    });
  });

  test("writes, validates, and reads multiple descriptor set terminators", () => {
    const image = createIsoImage([{
      path: "TERM.TXT",
      data: "multiple terminators\n",
    }], {
      terminatorCount: 2,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const descriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "terminator", "terminator"]);
    expect(descriptors.map((descriptor) => descriptor.sector)).toEqual([16, 17, 18]);
    expect(parsed.descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "terminator", "terminator"]);
    expect(parsed.files[0]).toMatchObject({
      path: "TERM.TXT",
      identifier: "TERM.TXT;1",
      size: "multiple terminators\n".length,
    });
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("multiple terminators\n");
  });

  test("rejects invalid descriptor set terminator counts", () => {
    expect(() => createIsoImage([], { terminatorCount: 0 })).toThrow(/terminatorCount/i);
    expect(() => createIsoImage([], { terminatorCount: 1.5 })).toThrow(/terminatorCount/i);
    expect(() => createIsoImage([], { terminatorCount: 256 })).toThrow(/terminatorCount/i);
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
      supplementaryVolumeDescriptors: [{
        escapeSequences: Uint8Array.of(0x41, 0x42, 0x43),
      }],
    })).toThrow(/escape sequences.*unsupported value/i);

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
      enhancedVolumeDescriptors: [{
        escapeSequences: Uint8Array.of(0x41, 0x42, 0x43),
      }],
    })).toThrow(/escape sequences.*unsupported value/i);

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

  test("parses consecutive handcrafted descriptor set terminators", async () => {
    const module = await loadEcma119Module();
    const createImage = findImageCreator(module!);
    expect(createImage).toBeTypeOf("function");

    const base = await createFixtureImage(createImage!);
    const image = descriptorSequenceFrom(base, [sector(base, TERMINATOR_SECTOR)]);

    const descriptors = parseVolumeDescriptors(image);

    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "terminator", "terminator"]);
    expect(descriptors.map((descriptor) => descriptor.sector)).toEqual([16, 17, 18]);
  });

  test("validateIsoImage checks reserved bytes in every descriptor set terminator", () => {
    const image = createIsoImage([{ path: "TERM.TXT", data: "reserved terminator\n" }], {
      terminatorCount: 2,
    });
    const mutated = imageWithDescriptorByte(image, 18, 7, 0xff);

    expect(validateIsoImage(mutated)).toEqual([
      expect.objectContaining({
        code: "descriptor.terminator_reserved",
        message: expect.stringMatching(/sector 18/i),
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
  descriptor.set(encodeDirectoryRecord({
    extent: 0,
    dataLength: SECTOR_SIZE,
    flags: 0x02,
    identifier: Uint8Array.of(0),
    date: new Date("2024-01-01T00:00:00Z"),
  }), 156);
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

function pathTableBytes(image: Uint8Array, sectorNumber: number, byteLength: number): Uint8Array {
  const start = sectorNumber * SECTOR_SIZE;
  return image.slice(start, start + byteLength);
}

function findDirectoryRecordOffset(directory: Uint8Array, identifier: string): number {
  const expected = new TextEncoder().encode(identifier);
  let offset = 0;
  while (offset < directory.byteLength) {
    const length = directory[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    const identifierLength = directory[offset + 32]!;
    const actual = directory.subarray(offset + 33, offset + 33 + identifierLength);
    if (actual.byteLength === expected.byteLength && actual.every((byte, index) => byte === expected[index])) {
      return offset;
    }
    offset += length;
  }
  throw new Error(`missing directory record ${identifier}`);
}
