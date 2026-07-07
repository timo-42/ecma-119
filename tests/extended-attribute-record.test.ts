import { describe, expect, test } from "vitest";

import {
  createIsoImage,
  decodeDirectoryRecord,
  decodeExtendedAttributeRecord,
  decodePathTable,
  encodeDirectoryRecord,
  encodeExtendedAttributeRecord,
  encodePathTable,
  parseIsoImage,
  parseVolumeDescriptors,
  validateIsoImage,
} from "../src/index";
import { SECTOR_SIZE } from "../src/types";

describe("extended attribute records", () => {
  test("encodes and decodes structured extended attribute record fields", () => {
    const createdAt = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 120));
    const modifiedAt = new Date(Date.UTC(2024, 1, 3, 4, 5, 6, 340));
    const expiresAt = new Date(Date.UTC(2025, 2, 4, 5, 6, 7, 560));
    const effectiveAt = new Date(Date.UTC(2024, 3, 5, 6, 7, 8, 780));
    const systemUse = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    const applicationUse = asciiBytes("application data");
    const escapeSequences = Uint8Array.of(0x25, 0x2f, 0x45);

    const bytes = encodeExtendedAttributeRecord({
      ownerIdentification: 42,
      groupIdentification: 77,
      permissions: 0xaaab,
      createdAt,
      modifiedAt,
      expiresAt,
      effectiveAt,
      recordFormat: 1,
      recordAttributes: 2,
      recordLength: 128,
      systemIdentifier: "EAR_SYSTEM",
      systemUse,
      version: 1,
      applicationUse,
      escapeSequences,
    });
    const decoded = decodeExtendedAttributeRecord(bytes);

    expect(bytes.byteLength).toBe(SECTOR_SIZE);
    expect(decoded).toMatchObject({
      ownerIdentification: 42,
      groupIdentification: 77,
      permissions: 0xaaab,
      recordFormat: 1,
      recordAttributes: 2,
      recordLength: 128,
      systemIdentifier: "EAR_SYSTEM",
      version: 1,
    });
    expect(decoded.createdAt.toISOString()).toBe("2024-01-02T03:04:05.120Z");
    expect(decoded.modifiedAt.toISOString()).toBe("2024-02-03T04:05:06.340Z");
    expect(decoded.expiresAt?.toISOString()).toBe("2025-03-04T05:06:07.560Z");
    expect(decoded.effectiveAt.toISOString()).toBe("2024-04-05T06:07:08.780Z");
    expect(decoded.systemUse.subarray(0, systemUse.byteLength)).toEqual(systemUse);
    expect(decoded.applicationUse).toEqual(applicationUse);
    expect(decoded.escapeSequences).toEqual(escapeSequences);
  });

  test("rejects invalid extended attribute record system identifier characters", () => {
    const bytes = encodeExtendedAttributeRecord({
      systemIdentifier: "VALIDATION",
    });
    bytes[84] = "a".charCodeAt(0);

    expect(() => decodeExtendedAttributeRecord(bytes)).toThrow(/system identifier contains invalid ECMA-119 a-characters/i);
  });

  test("writes structured extended attribute records and parses fields back from the ISO", () => {
    const data = asciiBytes("structured ear data\n");
    const createdAt = new Date(Date.UTC(2024, 4, 6, 7, 8, 9, 100));
    const image = createIsoImage([{
      path: "STRUCT.TXT",
      data,
      date: createdAt,
      extendedAttributeRecord: {
        ownerIdentification: 12,
        groupIdentification: 34,
        permissions: 0xaaaa,
        createdAt,
        modifiedAt: createdAt,
        effectiveAt: createdAt,
        recordFormat: 0,
        recordAttributes: 0,
        recordLength: 0,
        systemIdentifier: "STRUCTURED",
        systemUse: Uint8Array.of(1, 2, 3),
        applicationUse: asciiBytes("app"),
        escapeSequences: Uint8Array.of(0x25, 0x2f, 0x45),
      },
    }]);

    const parsed = parseIsoImage(image, { includeData: true });
    const file = parsed.files[0];
    const record = findRootFileRecord(image, "STRUCT.TXT;1");

    expect(validateIsoImage(image)).toEqual([]);
    expect(record[25]! & 0x18).toBe(0x10);
    expect(file?.data).toEqual(data);
    expect(file?.extendedAttributeRecordLength).toBe(1);
    expect(file?.extendedAttributeRecord?.byteLength).toBe(SECTOR_SIZE);
    expect(file?.extendedAttributeRecordFields).toMatchObject({
      ownerIdentification: 12,
      groupIdentification: 34,
      permissions: 0xaaaa,
      recordFormat: 0,
      recordAttributes: 0,
      recordLength: 0,
      systemIdentifier: "STRUCTURED",
      version: 1,
    });
    expect(file?.extendedAttributeRecordFields?.createdAt.toISOString()).toBe("2024-05-06T07:08:09.100Z");
    expect(file?.extendedAttributeRecordFields?.applicationUse).toEqual(asciiBytes("app"));
    expect(file?.extendedAttributeRecordFields?.escapeSequences).toEqual(Uint8Array.of(0x25, 0x2f, 0x45));
  });

  test("writes directory extended attribute records and parses directory fields back", () => {
    const date = new Date(Date.UTC(2024, 6, 1, 2, 3, 4, 500));
    const image = createIsoImage({
      files: [{
        path: "DIR/FILE.TXT",
        data: "directory ear\n",
      }],
      directories: [{
        path: "DIR",
        date,
        extendedAttributeRecord: {
          ownerIdentification: 1,
          groupIdentification: 1,
          systemIdentifier: "DIR_EAR",
          applicationUse: asciiBytes("dir app"),
        },
      }],
    });

    const parsed = parseIsoImage(image, { includeData: true });
    const directory = parsed.root.children.find((node) => "children" in node && node.path === "DIR");
    const rootRecord = findRootFileRecord(image, "DIR");
    const directoryExtent = readBoth32(rootRecord, 2);
    const pvd = sector(image, 16);
    const pathTableLocation = readUint32LE(pvd, 140);
    const pathTable = image.subarray(pathTableLocation * SECTOR_SIZE, (pathTableLocation + 1) * SECTOR_SIZE);
    const directoryPathTableOffset = 10;

    expect(validateIsoImage(image)).toEqual([]);
    expect(rootRecord[1]).toBe(1);
    expect(rootRecord[25]! & 0x10).toBe(0x10);
    expect(pathTable[directoryPathTableOffset + 1]).toBe(1);
    expect(directory).toMatchObject({
      path: "DIR",
      identifier: "DIR",
      extent: directoryExtent,
      extendedAttributeRecordLength: 1,
    });
    expect(directory && "children" in directory ? directory.extendedAttributeRecord?.byteLength : 0).toBe(SECTOR_SIZE);
    expect(directory && "children" in directory ? directory.extendedAttributeRecordFields?.systemIdentifier : undefined).toBe("DIR_EAR");
    expect(directory && "children" in directory ? directory.extendedAttributeRecordFields?.applicationUse : undefined).toEqual(asciiBytes("dir app"));
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("directory ear\n");
  });

  test("reports directory extended attribute flag mismatches", () => {
    const image = createIsoImage({
      files: [{
        path: "DIR/FILE.TXT",
        data: "directory ear flags\n",
      }],
      directories: [{
        path: "DIR",
        extendedAttributeRecord: {
          ownerIdentification: 1,
          groupIdentification: 1,
          systemIdentifier: "DIR_EAR",
        },
      }],
    });
    const rootDirectory = getRootDirectoryBytes(image);
    const recordOffset = findRootFileRecordOffset(image, "DIR");
    rootDirectory[recordOffset + 25] &= ~0x10;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.file_flags",
          path: "DIR",
          message: expect.stringMatching(/directory record flags/i),
        }),
      ]),
    );
  });

  test("reports file extended attribute flag mismatches", () => {
    const image = createIsoImage([{
      path: "EAR.TXT",
      data: "file ear flags\n",
      extendedAttributeRecord: {
        ownerIdentification: 1,
        groupIdentification: 1,
        recordFormat: 1,
        recordAttributes: 0,
        recordLength: 12,
      },
    }]);
    const rootDirectory = getRootDirectoryBytes(image);
    const recordOffset = findRootFileRecordOffset(image, "EAR.TXT;1");
    rootDirectory[recordOffset + 25] &= ~0x08;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.file_flags",
          path: "EAR.TXT",
          message: expect.stringMatching(/directory record flags/i),
        }),
      ]),
    );
  });

  test("reports directories that set the Record file flag", () => {
    const image = createIsoImage({
      files: [{
        path: "DIR/FILE.TXT",
        data: "directory record bit\n",
      }],
      directories: [{
        path: "DIR",
        extendedAttributeRecord: {
          ownerIdentification: 1,
          groupIdentification: 1,
          systemIdentifier: "DIR_EAR",
        },
      }],
    });
    const rootDirectory = getRootDirectoryBytes(image);
    const recordOffset = findRootFileRecordOffset(image, "DIR");
    rootDirectory[recordOffset + 25] |= 0x08;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_record",
          path: "DIR",
          message: expect.stringMatching(/Record bit/i),
        }),
      ]),
    );
  });

  test("duplicates directory extended attribute records into supplementary hierarchies", () => {
    const image = createIsoImage({
      files: [{
        path: "DIR/FILE.TXT",
        data: "supplementary directory ear\n",
      }],
      directories: [{
        path: "DIR",
        extendedAttributeRecord: {
          systemIdentifier: "DIR_EAR",
        },
      }],
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
    });
    const descriptors = parseVolumeDescriptors(image);
    const parsed = parseIsoImage(image, { includeData: true });
    const supplementary = descriptors.find((descriptor) => descriptor.kind === "supplementary");
    const parsedSupplementary = parsed.descriptors.find((descriptor) => descriptor.kind === "supplementary");

    expect(validateIsoImage(image)).toEqual([]);
    expect(supplementary?.kind).toBe("supplementary");
    if (supplementary?.kind !== "supplementary") {
      throw new Error("missing supplementary descriptor");
    }
    const supplementaryRoot = image.subarray(
      (supplementary.rootDirectoryRecord.extent + supplementary.rootDirectoryRecord.extendedAttributeRecordLength) * SECTOR_SIZE,
      (supplementary.rootDirectoryRecord.extent + supplementary.rootDirectoryRecord.extendedAttributeRecordLength) * SECTOR_SIZE + supplementary.rootDirectoryRecord.size,
    );
    const dirRecord = findDirectoryRecord(supplementaryRoot, "DIR");
    const dirExtent = readBoth32(dirRecord, 2);
    const directoryEar = image.subarray(dirExtent * SECTOR_SIZE, (dirExtent + 1) * SECTOR_SIZE);
    const decoded = decodeExtendedAttributeRecord(directoryEar);

    expect(dirRecord[1]).toBe(1);
    expect(decoded.systemIdentifier).toBe("DIR_EAR");
    const parsedDirectory = parsedSupplementary?.kind === "supplementary"
      ? parsedSupplementary.rootDirectoryRecord.children.find((node) => "children" in node && node.path === "DIR")
      : undefined;
    expect(parsedDirectory && "children" in parsedDirectory ? parsedDirectory.extendedAttributeRecordFields?.systemIdentifier : undefined).toBe("DIR_EAR");
    expect(parsedDirectory && "children" in parsedDirectory ? parsedDirectory.children[0] : undefined).toMatchObject({
      path: "DIR/FILE.TXT",
      identifier: "FILE.TXT;1",
    });
  });

  test("rejects directory extended attribute records that cannot fit in the length byte", () => {
    expect(() => createIsoImage({
      files: [{ path: "DIR/FILE.TXT", data: "x" }],
      directories: [{
        path: "DIR",
        extendedAttributeRecord: new Uint8Array(256 * SECTOR_SIZE),
      }],
    })).toThrow(/255 logical blocks/i);
  });

  test("rejects invalid structured extended attribute field combinations", () => {
    expect(() => encodeExtendedAttributeRecord({
      ownerIdentification: 1,
      groupIdentification: 0,
    })).toThrow(/owner identification and group identification/i);

    expect(() => encodeExtendedAttributeRecord({
      permissions: 0,
    })).toThrow(/permissions bits/i);

    expect(() => encodeExtendedAttributeRecord({
      recordFormat: 0,
      recordLength: 1,
    })).toThrow(/record length must be zero/i);

    expect(() => encodeExtendedAttributeRecord({
      recordFormat: 4,
    })).toThrow(/reserved/i);

    expect(() => encodeExtendedAttributeRecord({
      recordFormat: 128,
    })).toThrow(/system-use record format values 128 through 255/i);

    expect(() => encodeExtendedAttributeRecord({
      recordAttributes: 3,
    })).toThrow(/reserved/i);

    expect(() => encodeExtendedAttributeRecord({
      version: 2,
    })).toThrow(/version must be 1/i);
  });

  test("reports malformed structured fields in raw extended attribute records", () => {
    const image = createIsoImage([{
      path: "BAD_EAR.TXT",
      data: "x",
      extendedAttributeRecord: makeExtendedAttributeRecord("bad reserved"),
    }]);
    const record = findRootFileRecord(image, "BAD_EAR.TXT;1");
    const extent = readBoth32(record, 2);
    sector(image, extent)[182] = 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.reserved_bytes",
          path: "BAD_EAR.TXT",
          message: "extended attribute record reserved bytes at BAD_EAR.TXT must be zero",
        }),
      ]),
    );
    expect(validateIsoImage(image)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.parse",
          path: "BAD_EAR.TXT",
        }),
      ]),
    );
  });

  test.each([
    {
      label: "creation",
      offset: 10,
      code: "extended_attribute_record.creation_date",
      mutate: (bytes: Uint8Array, offset: number) => {
        bytes[offset + 4] = 0x31;
        bytes[offset + 5] = 0x33;
      },
      message: /creation date and time.*month/i,
    },
    {
      label: "modification",
      offset: 27,
      code: "extended_attribute_record.modification_date",
      mutate: (bytes: Uint8Array, offset: number) => {
        bytes[offset + 6] = 0x58;
      },
      message: /modification date and time.*16 decimal digits/i,
    },
    {
      label: "expiration",
      offset: 44,
      code: "extended_attribute_record.expiration_date",
      mutate: (bytes: Uint8Array, offset: number) => {
        bytes[offset + 16] = 4;
      },
      message: /expiration date and time.*zero GMT offset/i,
    },
    {
      label: "effective",
      offset: 61,
      code: "extended_attribute_record.effective_date",
      mutate: (bytes: Uint8Array, offset: number) => {
        bytes[offset + 4] = 0x30;
        bytes[offset + 5] = 0x30;
      },
      message: /effective date and time.*month/i,
    },
  ])("reports targeted malformed $label dates in raw extended attribute records", ({ offset, code, mutate, message }) => {
    const image = createIsoImage([{
      path: "BADDATE.TXT",
      data: "x",
      extendedAttributeRecord: makeExtendedAttributeRecord("bad date"),
    }]);
    const record = findRootFileRecord(image, "BADDATE.TXT;1");
    const extent = readBoth32(record, 2);

    mutate(sector(image, extent), offset);

    const issues = validateIsoImage(image);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code,
          path: "BADDATE.TXT",
          message: expect.stringMatching(message),
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.parse",
          path: "BADDATE.TXT",
        }),
      ]),
    );
  });

  test("reports targeted unspecified required dates in raw extended attribute records", () => {
    const image = createIsoImage([{
      path: "UNSPEC.TXT",
      data: "x",
      extendedAttributeRecord: makeExtendedAttributeRecord("unspecified date"),
    }]);
    const record = findRootFileRecord(image, "UNSPEC.TXT;1");
    const extent = readBoth32(record, 2);
    const ear = sector(image, extent);

    ear.fill(0x30, 10, 26);
    ear[26] = 0;

    const issues = validateIsoImage(image);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.creation_date",
          path: "UNSPEC.TXT",
          message: expect.stringMatching(/creation date and time.*must be specified/i),
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.parse",
          path: "UNSPEC.TXT",
        }),
      ]),
    );
  });

  test.each([
    {
      label: "application use and escape sequence bounds",
      input: { applicationUse: asciiBytes("app"), escapeSequences: Uint8Array.of(0x25) },
      code: "extended_attribute_record.application_use_escape_sequences.bounds",
      message: /application use and escape sequences.*exceed record length/i,
      mutate: (bytes: Uint8Array) => writeBoth16(bytes, 246, 0xffff),
    },
    {
      label: "owner and group pairing",
      input: {},
      code: "extended_attribute_record.owner_group",
      message: /owner identification and group identification.*both be zero or both be nonzero/i,
      mutate: (bytes: Uint8Array) => writeBoth16(bytes, 0, 1),
    },
    {
      label: "permissions",
      input: {},
      code: "extended_attribute_record.permissions",
      message: /permissions.*bits 1,3,5,7,9,11,13,15/i,
      mutate: (bytes: Uint8Array) => {
        bytes[8] = 0;
        bytes[9] = 0;
      },
    },
    {
      label: "reserved record format",
      input: {},
      code: "extended_attribute_record.record_format.reserved",
      message: /record format.*reserved value 4/i,
      mutate: (bytes: Uint8Array) => {
        bytes[78] = 4;
      },
    },
    {
      label: "reserved record attributes",
      input: {},
      code: "extended_attribute_record.record_attributes.reserved",
      message: /record attributes.*reserved value 3/i,
      mutate: (bytes: Uint8Array) => {
        bytes[79] = 3;
      },
    },
    {
      label: "record length for format zero",
      input: {},
      code: "extended_attribute_record.record_length",
      message: /record length.*must be zero when record format is zero/i,
      mutate: (bytes: Uint8Array) => writeBoth16(bytes, 80, 1),
    },
    {
      label: "fixed record length",
      input: { recordFormat: 1, recordLength: 1 },
      code: "extended_attribute_record.record_length",
      message: /record length.*at least one for fixed-length records/i,
      mutate: (bytes: Uint8Array) => writeBoth16(bytes, 80, 0),
    },
    {
      label: "variable record length",
      input: { recordFormat: 2, recordLength: 1 },
      code: "extended_attribute_record.record_length",
      message: /record length.*1 through 32767 for variable-length records/i,
      mutate: (bytes: Uint8Array) => writeBoth16(bytes, 80, 0),
    },
    {
      label: "version",
      input: {},
      code: "extended_attribute_record.version",
      message: /version.*must be 1/i,
      mutate: (bytes: Uint8Array) => {
        bytes[180] = 2;
      },
    },
  ])("reports targeted malformed $label in raw extended attribute records", ({ input, code, message, mutate }) => {
    const data = asciiBytes("malformed scalar ear\n");
    const image = createIsoImage([{
      path: "BADSCAL.TXT",
      data,
      extendedAttributeRecord: {
        systemIdentifier: "VALIDATION",
        ...input,
      },
    }]);
    const record = findRootFileRecord(image, "BADSCAL.TXT;1");
    const extent = readBoth32(record, 2);
    const ear = sector(image, extent);

    mutate(ear);

    const parsed = parseIsoImage(image, { includeData: true });
    expect(parsed.files[0]?.data).toEqual(data);
    expect(parsed.files[0]?.extendedAttributeRecord).toEqual(ear);
    expect(parsed.files[0]?.extendedAttributeRecordFields).toBeUndefined();

    const issues = validateIsoImage(image);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code,
          path: "BADSCAL.TXT",
          message: expect.stringMatching(message),
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.parse",
          path: "BADSCAL.TXT",
        }),
      ]),
    );
  });

  test("preserves opaque raw extended attribute bytes even when structured decoding fails", () => {
    const data = asciiBytes("opaque raw ear\n");
    const extendedAttributeRecord = new Uint8Array(SECTOR_SIZE);
    extendedAttributeRecord.set(asciiBytes("not a structured ECMA-119 EAR"));
    const image = createIsoImage([{
      path: "OPAQUE.TXT",
      data,
      extendedAttributeRecord,
    }]);

    const parsed = parseIsoImage(image, { includeData: true });

    expect(parsed.files[0]?.data).toEqual(data);
    expect(parsed.files[0]?.extendedAttributeRecord).toEqual(extendedAttributeRecord);
    expect(parsed.files[0]?.extendedAttributeRecordFields).toBeUndefined();
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.parse",
          path: "OPAQUE.TXT",
        }),
      ]),
    );
  });

  test("sets the Record file flag for structured record formats", () => {
    const image = createIsoImage([{
      path: "RECORD.TXT",
      data: "x",
      extendedAttributeRecord: {
        recordFormat: 1,
        recordLength: 80,
      },
    }]);
    const record = findRootFileRecord(image, "RECORD.TXT;1");

    expect(record[25]! & 0x08).toBe(0x08);
    expect(validateIsoImage(image)).toEqual([]);
  });

  test("writes raw system-use record format extended attributes and parses fields back", () => {
    const data = asciiBytes("system-use record format\n");
    const extendedAttributeRecord = encodeExtendedAttributeRecord({
      recordFormat: 1,
      recordAttributes: 2,
      recordLength: 80,
      systemIdentifier: "SYS_USE",
    });
    extendedAttributeRecord[78] = 128;
    extendedAttributeRecord[80] = 0x34;
    extendedAttributeRecord[81] = 0x12;
    extendedAttributeRecord[82] = 0x12;
    extendedAttributeRecord[83] = 0x34;
    const image = createIsoImage([{
      path: "SYSUSE.TXT",
      data,
      extendedAttributeRecord,
    }]);

    const record = findRootFileRecord(image, "SYSUSE.TXT;1");
    const parsed = parseIsoImage(image, { includeData: true });
    const file = parsed.files[0];

    expect(record[25]! & 0x08).toBe(0x08);
    expect(validateIsoImage(image)).toEqual([]);
    expect(file?.data).toEqual(data);
    expect(file?.extendedAttributeRecordFields).toMatchObject({
      recordFormat: 128,
      recordAttributes: 2,
      recordLength: 0x1234,
      systemIdentifier: "SYS_USE",
    });
    expect(decodeExtendedAttributeRecord(extendedAttributeRecord)).toMatchObject({
      recordFormat: 128,
      recordAttributes: 2,
      recordLength: 0x1234,
    });
  });

  test("writes raw extended attribute logical blocks before file data and parses them back", () => {
    const data = asciiBytes("file data after ear\n");
    const extendedAttributeRecord = makeExtendedAttributeRecord("writer ear");
    const image = createIsoImage([{
      path: "EAR.TXT",
      data,
      extendedAttributeRecord,
    }]);

    const record = findRootFileRecord(image, "EAR.TXT;1");
    const extent = readBoth32(record, 2);

    expect(record[1]).toBe(1);
    expect(image.subarray(extent * SECTOR_SIZE, extent * SECTOR_SIZE + extendedAttributeRecord.byteLength)).toEqual(extendedAttributeRecord);
    expect(image.subarray((extent + 1) * SECTOR_SIZE, (extent + 1) * SECTOR_SIZE + data.byteLength)).toEqual(data);

    const parsed = parseIsoImage(image, { includeData: true });
    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files[0]).toMatchObject({
      path: "EAR.TXT",
      identifier: "EAR.TXT;1",
      extent,
      extendedAttributeRecordLength: 1,
      size: data.byteLength,
    });
    expect(parsed.files[0]?.extendedAttributeRecord).toEqual(extendedAttributeRecord);
    expect(parsed.files[0]?.data).toEqual(data);
  });

  test("writes interleaved file extended attribute records in the first file unit", () => {
    const data = new Uint8Array(SECTOR_SIZE + 7);
    data.fill(0x31, 0, SECTOR_SIZE);
    data.set(asciiBytes("tailend"), SECTOR_SIZE);
    const extendedAttributeRecord = makeExtendedAttributeRecord("interleaved ear");
    const image = createIsoImage([{
      path: "INTEAR.BIN",
      data,
      interleave: { fileUnitSize: 1, interleaveGapSize: 1 },
      extendedAttributeRecord,
    }]);

    const record = findRootFileRecord(image, "INTEAR.BIN;1");
    const extent = readBoth32(record, 2);

    expect(record[1]).toBe(1);
    expect(record[26]).toBe(1);
    expect(record[27]).toBe(1);
    expect(image.subarray(extent * SECTOR_SIZE, extent * SECTOR_SIZE + extendedAttributeRecord.byteLength)).toEqual(extendedAttributeRecord);
    expect(image.subarray((extent + 1) * SECTOR_SIZE, (extent + 2) * SECTOR_SIZE).every((byte) => byte === 0)).toBe(true);
    expect(image.subarray((extent + 2) * SECTOR_SIZE, (extent + 3) * SECTOR_SIZE)).toEqual(data.subarray(0, SECTOR_SIZE));
    expect(image.subarray((extent + 3) * SECTOR_SIZE, (extent + 4) * SECTOR_SIZE).every((byte) => byte === 0)).toBe(true);
    expect(image.subarray((extent + 4) * SECTOR_SIZE, (extent + 4) * SECTOR_SIZE + 7)).toEqual(data.subarray(SECTOR_SIZE));

    const parsed = parseIsoImage(image, { includeData: true });
    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files[0]).toMatchObject({
      path: "INTEAR.BIN",
      identifier: "INTEAR.BIN;1",
      extent,
      extendedAttributeRecordLength: 1,
      fileUnitSize: 1,
      interleaveGapSize: 1,
      size: data.byteLength,
    });
    expect(parsed.files[0]?.extendedAttributeRecord).toEqual(extendedAttributeRecord);
    expect(parsed.files[0]?.extendedAttributeRecordFields?.systemIdentifier).toBe("ECMA119_TEST");
    expect(parsed.files[0]?.data).toEqual(data);
  });

  test("pads interleaved extended attribute records to the assigned file unit size", () => {
    const data = asciiBytes("after two-sector ear unit");
    const extendedAttributeRecord = makeExtendedAttributeRecord("two unit ear");
    const image = createIsoImage([{
      path: "UNIT2.BIN",
      data,
      interleave: { fileUnitSize: 2, interleaveGapSize: 1 },
      extendedAttributeRecord,
    }]);

    const record = findRootFileRecord(image, "UNIT2.BIN;1");
    const extent = readBoth32(record, 2);

    expect(record[1]).toBe(2);
    expect(record[26]).toBe(2);
    expect(record[27]).toBe(1);
    expect(image.subarray(extent * SECTOR_SIZE, extent * SECTOR_SIZE + extendedAttributeRecord.byteLength)).toEqual(extendedAttributeRecord);
    expect(image.subarray((extent + 1) * SECTOR_SIZE, (extent + 2) * SECTOR_SIZE).every((byte) => byte === 0)).toBe(true);
    expect(image.subarray((extent + 2) * SECTOR_SIZE, (extent + 3) * SECTOR_SIZE).every((byte) => byte === 0)).toBe(true);
    expect(image.subarray((extent + 3) * SECTOR_SIZE, (extent + 3) * SECTOR_SIZE + data.byteLength)).toEqual(data);

    const parsed = parseIsoImage(image, { includeData: true });
    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files[0]).toMatchObject({
      path: "UNIT2.BIN",
      extendedAttributeRecordLength: 2,
      fileUnitSize: 2,
      interleaveGapSize: 1,
      size: data.byteLength,
    });
    expect(parsed.files[0]?.extendedAttributeRecord).toEqual(
      image.slice(extent * SECTOR_SIZE, (extent + 2) * SECTOR_SIZE),
    );
    expect(parsed.files[0]?.data).toEqual(data);
  });

  test("writes interleaved directory extended attribute records in the first file unit", () => {
    const extendedAttributeRecord = makeExtendedAttributeRecord("interleaved dir ear");
    const image = createIsoImage([{
      path: "DIR/FILE.TXT",
      data: "directory interleaved ear\n",
    }], {
      directories: [{
        path: "DIR",
        interleave: { fileUnitSize: 1, interleaveGapSize: 1 },
        extendedAttributeRecord,
      }],
    });

    const record = findRootFileRecord(image, "DIR");
    const extent = readBoth32(record, 2);
    const firstDirectoryUnit = image.subarray((extent + 2) * SECTOR_SIZE, (extent + 3) * SECTOR_SIZE);
    const self = findDirectoryRecord(firstDirectoryUnit, "\0");

    expect(record[1]).toBe(1);
    expect(record[26]).toBe(1);
    expect(record[27]).toBe(1);
    expect(image.subarray(extent * SECTOR_SIZE, extent * SECTOR_SIZE + extendedAttributeRecord.byteLength)).toEqual(extendedAttributeRecord);
    expect(image.subarray((extent + 1) * SECTOR_SIZE, (extent + 2) * SECTOR_SIZE).every((byte) => byte === 0)).toBe(true);
    expect(self[26]).toBe(1);
    expect(self[27]).toBe(1);

    const parsed = parseIsoImage(image, { includeData: true });
    const directory = parsed.root.children.find((node) => "children" in node && node.path === "DIR");
    expect(validateIsoImage(image)).toEqual([]);
    expect(directory).toMatchObject({
      path: "DIR",
      extent,
      extendedAttributeRecordLength: 1,
      fileUnitSize: 1,
      interleaveGapSize: 1,
    });
    expect(directory && "children" in directory ? directory.extendedAttributeRecord : undefined).toEqual(
      image.slice(extent * SECTOR_SIZE, (extent + 1) * SECTOR_SIZE),
    );
    expect(directory && "children" in directory ? directory.extendedAttributeRecordFields?.systemIdentifier : undefined).toBe("ECMA119_TEST");
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("directory interleaved ear\n");
  });

  test("reads extended attribute records from an ISO image not produced by the writer", () => {
    const data = asciiBytes("handmade data\n");
    const extendedAttributeRecord = makeExtendedAttributeRecord("handmade ear");
    const image = handcraftedIsoWithExtendedAttributeRecord(data, extendedAttributeRecord);

    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "HELLO.TXT",
      identifier: "HELLO.TXT;1",
      extent: 21,
      extendedAttributeRecordLength: 1,
      size: data.byteLength,
    });
    expect(parsed.files[0]?.extendedAttributeRecord).toEqual(extendedAttributeRecord);
    expect(parsed.files[0]?.data).toEqual(data);
  });

  test("reports invalid bounds when an extended attribute length pushes data past the image", () => {
    const image = createIsoImage([{
      path: "BROKEN.TXT",
      data: "x",
      extendedAttributeRecord: makeExtendedAttributeRecord("bounds"),
    }]);
    const rootDirectory = getRootDirectoryBytes(image);
    const recordOffset = findRootFileRecordOffset(image, "BROKEN.TXT;1");
    rootDirectory[recordOffset + 1] = 255;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.bounds",
          path: "BROKEN.TXT",
          message: "extended attribute record for BROKEN.TXT has invalid extent bounds",
        }),
      ]),
    );
    expect(validateIsoImage(image)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "image.parse",
        }),
      ]),
    );
  });

  test("reports invalid directory extended attribute bounds before parsing", () => {
    const image = createIsoImage([{
      path: "DIR/FILE.TXT",
      data: "x",
    }], {
      directories: [{
        path: "DIR",
        extendedAttributeRecord: makeExtendedAttributeRecord("directory bounds"),
      }],
    });
    const rootDirectory = getRootDirectoryBytes(image);
    const recordOffset = findRootFileRecordOffset(image, "DIR");
    rootDirectory[recordOffset + 1] = 255;

    const issues = validateIsoImage(image);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.bounds",
          path: "DIR",
          message: "extended attribute record for DIR has invalid extent bounds",
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "image.parse",
        }),
      ]),
    );
  });

  test("rejects extended attribute records that cannot fit in the length byte", () => {
    expect(() => createIsoImage([{
      path: "HUGE.TXT",
      data: "x",
      extendedAttributeRecord: new Uint8Array(256 * SECTOR_SIZE),
    }])).toThrow(/255 logical blocks/i);
  });

  test("low-level encoders reject extended attribute lengths outside the 8-bit field", () => {
    const identifier = asciiBytes("TOO_BIG.TXT;1");
    const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

    expect(() => encodeDirectoryRecord({
      extent: 20,
      extendedAttributeRecordLength: 256,
      dataLength: 1,
      flags: 0,
      identifier,
      date,
    })).toThrow(/0 to 255 logical blocks/i);

    expect(() => encodeDirectoryRecord({
      extent: 20,
      dataLength: 1,
      flags: 0,
      fileUnitSize: 256,
      identifier,
      date,
    })).toThrow(/file unit size/i);

    expect(() => encodeDirectoryRecord({
      extent: 20,
      dataLength: 1,
      flags: 0,
      interleaveGapSize: -1,
      identifier,
      date,
    })).toThrow(/interleave gap size/i);

    expect(() => encodeDirectoryRecord({
      extent: 20,
      dataLength: 1,
      flags: 0,
      volumeSequenceNumber: 0,
      identifier,
      date,
    })).toThrow(/volume sequence number/i);

    expect(() => encodePathTable([{
      identifier: Uint8Array.of(0),
      extent: 20,
      parentDirectoryNumber: 1,
      extendedAttributeRecordLength: 1.5,
    }], "little")).toThrow(/0 to 255 logical blocks/i);

    expect(() => encodePathTable([{
      identifier: Uint8Array.of(0),
      extent: 20,
      parentDirectoryNumber: 0,
    }], "little")).toThrow(/parent directory number/i);
  });

  test("low-level encoders reject invalid identifier lengths", () => {
    const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

    expect(() => encodeDirectoryRecord({
      extent: 20,
      dataLength: 1,
      flags: 0,
      identifier: new Uint8Array(),
      date,
    })).toThrow(/identifier length/i);

    expect(() => encodeDirectoryRecord({
      extent: 20,
      dataLength: 1,
      flags: 0,
      identifier: new Uint8Array(256),
      date,
    })).toThrow(/identifier length/i);

    expect(encodePathTable([{
      identifier: Uint8Array.of(0),
      extent: 20,
      parentDirectoryNumber: 1,
    }], "little")[0]).toBe(1);

    expect(() => encodePathTable([{
      identifier: new Uint8Array(),
      extent: 20,
      parentDirectoryNumber: 1,
    }], "little")).toThrow(/identifier length/i);

    expect(() => encodePathTable([{
      identifier: new Uint8Array(256),
      extent: 20,
      parentDirectoryNumber: 1,
    }], "big")).toThrow(/identifier length/i);
  });

  test("low-level path table decoder rejects malformed layout", () => {
    const valid = encodePathTable([{
      identifier: asciiBytes("DIR"),
      extent: 20,
      parentDirectoryNumber: 1,
    }], "little");

    expect(decodePathTable(valid, "little")).toEqual([
      expect.objectContaining({
        identifier: asciiBytes("DIR"),
        extent: 20,
        parentDirectoryNumber: 1,
      }),
    ]);

    const truncated = valid.subarray(0, valid.byteLength - 1);
    expect(() => decodePathTable(truncated, "little")).toThrow(/invalid length/i);

    const nonzeroPadding = valid.slice();
    nonzeroPadding[8 + "DIR".length] = 0xff;
    expect(() => decodePathTable(nonzeroPadding, "little")).toThrow(/padding byte/i);

    const zeroIdentifierLength = valid.slice();
    zeroIdentifierLength[0] = 0;
    expect(() => decodePathTable(zeroIdentifierLength, "little")).toThrow(/zero identifier length/i);
  });

  test("low-level directory record encoder rejects unsupported file flag bits", () => {
    const identifier = asciiBytes("FLAGS.TXT;1");
    const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
    const input = {
      extent: 20,
      dataLength: 1,
      identifier,
      date,
    };

    expect(encodeDirectoryRecord({
      ...input,
      flags: 0x1f,
    })[25]).toBe(0x1f);

    expect(() => encodeDirectoryRecord({
      ...input,
      flags: 0x20,
    })).toThrow(/reserved/i);

    expect(() => encodeDirectoryRecord({
      ...input,
      flags: 0x40,
    })).toThrow(/reserved/i);

    expect(encodeDirectoryRecord({
      ...input,
      flags: 0x80,
    })[25]).toBe(0x80);

    expect(encodeDirectoryRecord({
      ...input,
      flags: 0x82,
    })[25]).toBe(0x82);
  });

  test("low-level directory record codec preserves interleave metadata bytes", () => {
    const identifier = asciiBytes("INTER.TXT;1");
    const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

    const record = encodeDirectoryRecord({
      extent: 20,
      dataLength: 1,
      flags: 0,
      fileUnitSize: 3,
      interleaveGapSize: 4,
      identifier,
      date,
      volumeSequenceNumber: 1,
    });

    expect(record[26]).toBe(3);
    expect(record[27]).toBe(4);
    expect(decodeDirectoryRecord(record, 0)).toMatchObject({
      fileUnitSize: 3,
      interleaveGapSize: 4,
      volumeSequenceNumber: 1,
    });
  });

  test("low-level directory record codec preserves unspecified recording dates", () => {
    const record = encodeDirectoryRecord({
      extent: 20,
      dataLength: 1,
      flags: 0,
      identifier: asciiBytes("NODATE.TXT;1"),
      date: null,
      volumeSequenceNumber: 1,
    });

    expect([...record.subarray(18, 25)]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(decodeDirectoryRecord(record, 0)).toMatchObject({
      date: null,
    });
  });

  test("low-level directory record decoder rejects malformed layout", () => {
    const identifier = asciiBytes("PADD.TXT;1");
    const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
    const record = encodeDirectoryRecord({
      extent: 20,
      dataLength: 1,
      flags: 0,
      identifier,
      date,
    });

    const invalidIdentifierLength = record.slice();
    invalidIdentifierLength[32] = 0;
    expect(() => decodeDirectoryRecord(invalidIdentifierLength, 0)).toThrow(/identifier length/i);

    const shortRecord = record.slice();
    shortRecord[0] = 33;
    expect(() => decodeDirectoryRecord(shortRecord, 0)).toThrow(/invalid length/i);

    const impossibleIdentifierLength = record.slice();
    impossibleIdentifierLength[32] = 20;
    expect(() => decodeDirectoryRecord(impossibleIdentifierLength, 0)).toThrow(/identifier length/i);

    const nonzeroPadding = record.slice();
    nonzeroPadding[33 + identifier.byteLength] = 0xff;
    expect(() => decodeDirectoryRecord(nonzeroPadding, 0)).toThrow(/padding byte/i);

    expect(() => decodeDirectoryRecord(record, 0, record.byteLength - 1)).toThrow(/invalid length/i);
  });
});

function handcraftedIsoWithExtendedAttributeRecord(data: Uint8Array, extendedAttributeRecord: Uint8Array): Uint8Array {
  const image = new Uint8Array(24 * SECTOR_SIZE);
  const pvd = sector(image, 16);
  const rootDirectory = sector(image, 20);
  const pathTableL = sector(image, 18);
  const pathTableM = sector(image, 19);
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

  sector(image, 21).set(extendedAttributeRecord);
  sector(image, 22).set(data);
  writePathTableRoot(pathTableL, "little", 20);
  writePathTableRoot(pathTableM, "big", 20);

  let offset = 0;
  const self = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(0), date });
  const parent = directoryRecord({ extent: 20, size: SECTOR_SIZE, flags: 0x02, identifier: Uint8Array.of(1), date });
  const file = directoryRecord({
    extent: 21,
    extendedAttributeRecordLength: 1,
    size: data.byteLength,
    flags: 0,
    identifier: asciiBytes("HELLO.TXT;1"),
    date,
  });
  rootDirectory.set(self, offset);
  offset += self.byteLength;
  rootDirectory.set(parent, offset);
  offset += parent.byteLength;
  rootDirectory.set(file, offset);

  pvd[0] = 1;
  writeAscii(pvd, 1, 5, "CD001", 0);
  pvd[6] = 1;
  writeAscii(pvd, 8, 32, "HANDMADE_EAR", 0x20);
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

function makeExtendedAttributeRecord(label: string): Uint8Array {
  const bytes = new Uint8Array(SECTOR_SIZE);
  writeBoth16(bytes, 0, 0);
  writeBoth16(bytes, 4, 0);
  writeUint16BE(bytes, 8, 0xaaaa);
  bytes.set(volumeDate(new Date(Date.UTC(2024, 0, 1, 0, 0, 0))), 10);
  bytes.set(volumeDate(new Date(Date.UTC(2024, 0, 1, 0, 0, 0))), 27);
  bytes.set(volumeDate(null), 44);
  bytes.set(volumeDate(new Date(Date.UTC(2024, 0, 1, 0, 0, 0))), 61);
  writeBoth16(bytes, 80, 0);
  writeAscii(bytes, 84, 32, "ECMA119_TEST", 0x20);
  bytes.set(asciiBytes(label), 116);
  bytes[180] = 1;
  writeBoth16(bytes, 246, 0);
  return bytes;
}

function getRootDirectoryBytes(image: Uint8Array): Uint8Array {
  const pvd = sector(image, 16);
  const extent = readUint32LE(pvd, 156 + 2);
  const size = readUint32LE(pvd, 156 + 10);
  return image.subarray(extent * SECTOR_SIZE, extent * SECTOR_SIZE + size);
}

function findRootFileRecord(image: Uint8Array, identifier: string): Uint8Array {
  const rootDirectory = getRootDirectoryBytes(image);
  const offset = findRootFileRecordOffset(image, identifier);
  return rootDirectory.slice(offset, offset + rootDirectory[offset]!);
}

function findDirectoryRecord(directory: Uint8Array, identifier: string): Uint8Array {
  const expected = asciiBytes(identifier);
  let offset = 0;

  while (offset < directory.byteLength) {
    const length = directory[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    const identifierLength = directory[offset + 32]!;
    const actual = directory.subarray(offset + 33, offset + 33 + identifierLength);
    if (bytesEqual(actual, expected)) {
      return directory.slice(offset, offset + length);
    }
    offset += length;
  }

  throw new Error(`missing directory record for ${identifier}`);
}

function findRootFileRecordOffset(image: Uint8Array, identifier: string): number {
  const rootDirectory = getRootDirectoryBytes(image);
  const expected = asciiBytes(identifier);
  let offset = 0;

  while (offset < rootDirectory.byteLength) {
    const length = rootDirectory[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    const identifierLength = rootDirectory[offset + 32]!;
    const actual = rootDirectory.subarray(offset + 33, offset + 33 + identifierLength);
    if (bytesEqual(actual, expected)) {
      return offset;
    }
    offset += length;
  }

  throw new Error(`missing directory record for ${identifier}`);
}

function sector(image: Uint8Array, sectorNumber: number): Uint8Array {
  return image.subarray(sectorNumber * SECTOR_SIZE, (sectorNumber + 1) * SECTOR_SIZE);
}

function directoryRecord(input: {
  extent: number;
  extendedAttributeRecordLength?: number;
  size: number;
  flags: number;
  identifier: Uint8Array;
  date: Date;
}): Uint8Array {
  const baseLength = 33 + input.identifier.byteLength;
  const length = baseLength + (baseLength % 2 === 0 ? 0 : 1);
  const bytes = new Uint8Array(length);
  bytes[0] = length;
  bytes[1] = input.extendedAttributeRecordLength ?? 0;
  writeBoth32(bytes, 2, input.extent);
  writeBoth32(bytes, 10, input.size);
  bytes.set(directoryDate(input.date), 18);
  bytes[25] = input.flags;
  writeBoth16(bytes, 28, 1);
  bytes[32] = input.identifier.byteLength;
  bytes.set(input.identifier, 33);
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function readBoth32(bytes: Uint8Array, offset: number): number {
  const little = readUint32LE(bytes, offset);
  const big = readUint32BE(bytes, offset + 4);
  if (little !== big) {
    throw new Error("both-endian uint32 mismatch");
  }
  return little;
}

function writeBoth16(bytes: Uint8Array, offset: number, value: number): void {
  writeUint16LE(bytes, offset, value);
  writeUint16BE(bytes, offset + 2, value);
}

function writeBoth32(bytes: Uint8Array, offset: number, value: number): void {
  writeUint32LE(bytes, offset, value);
  writeUint32BE(bytes, offset + 4, value);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 24)
    | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8)
    | bytes[offset + 3]!
  ) >>> 0;
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
