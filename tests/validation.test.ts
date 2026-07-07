import { describe, expect, test } from "vitest";

import { createIsoImage, decodePathTable, encodeExtendedAttributeRecord, parseIsoImage, parseVolumeDescriptors, validateIsoImage, type VolumePartitionDescriptor } from "../src/index";
import { SECTOR_SIZE } from "../src/types";
import { readBothEndianUint32, readUint32BE, readUint32LE } from "./helpers";

const PVD_OFFSET = 16 * SECTOR_SIZE;
const TERMINATOR_OFFSET = 17 * SECTOR_SIZE;

describe("validateIsoImage hardening", () => {
  test("reports nonzero terminator reserved bytes without failing parse", () => {
    const image = baselineImage();
    image[TERMINATOR_OFFSET + 7] = 0xff;

    expect(validateIsoImage(image)).toEqual([
      expect.objectContaining({
        code: "descriptor.terminator_reserved",
      }),
    ]);
  });

  test("reports malformed descriptor standard identifiers with targeted issues", () => {
    const image = baselineImage();
    image[PVD_OFFSET + 1] = "X".charCodeAt(0);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.identifier",
          message: "primary volume descriptor at sector 16 must use CD001 standard identifier",
        }),
        expect.objectContaining({
          code: "descriptor.sequence",
          message: expect.stringMatching(/expected CD001 descriptor identifier/i),
        }),
      ]),
    );
  });

  test("reports a bad descriptor version as a targeted validation issue", () => {
    const image = baselineImage();
    image[PVD_OFFSET + 6] = 2;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.version",
          message: "primary volume descriptor at sector 16 must use version 1",
        }),
        expect.objectContaining({
          code: "descriptor.sequence",
          message: expect.stringMatching(/^expected primary volume descriptor version 1$/i),
        }),
      ]),
    );
  });

  test.each([
    { fieldOffset: 80, bytes: 4, code: "pvd.volume_space_size.endian_mismatch", label: "volume space size" },
    { fieldOffset: 120, bytes: 2, code: "pvd.volume_set_size.endian_mismatch", label: "volume set size" },
    { fieldOffset: 124, bytes: 2, code: "pvd.volume_sequence_number.endian_mismatch", label: "volume sequence number" },
    { fieldOffset: 128, bytes: 2, code: "pvd.logical_block_size.endian_mismatch", label: "logical block size" },
    { fieldOffset: 132, bytes: 4, code: "pvd.path_table_size.endian_mismatch", label: "path table size" },
  ])("reports PVD both-endian mismatches for $label", ({ fieldOffset, bytes, code, label }) => {
    const image = baselineImage();
    image[PVD_OFFSET + fieldOffset + (bytes * 2) - 1] ^= 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code,
          message: expect.stringContaining(`primary volume descriptor ${label} must store matching little- and big-endian values`),
        }),
        expect.objectContaining({
          code: "descriptor.sequence",
          message: expect.stringMatching(/both-endian uint(16|32) mismatch/i),
        }),
      ]),
    );
  });

  test("reports PVD both-endian mismatches when a boot descriptor precedes the PVD", () => {
    const image = createIsoImage([{ path: "README.TXT", data: "boot before pvd\n" }], {
      bootRecord: { bootSystemIdentifier: "BOOT" },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const bootOffset = 17 * SECTOR_SIZE;
    const shiftedPvdOffset = bootOffset;
    const pvd = image.slice(PVD_OFFSET, PVD_OFFSET + SECTOR_SIZE);
    const boot = image.slice(bootOffset, bootOffset + SECTOR_SIZE);
    image.set(boot, PVD_OFFSET);
    image.set(pvd, shiftedPvdOffset);
    image[shiftedPvdOffset + 80 + 7] ^= 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.volume_space_size.endian_mismatch",
          message: expect.stringContaining("at sector 17"),
        }),
        expect.objectContaining({
          code: "descriptor.sequence",
          message: expect.stringMatching(/both-endian uint32 mismatch/i),
        }),
      ]),
    );
  });

  test.each([
    { sector: 17, code: "boot.version", message: "boot record descriptor at sector 17 must use version 1" },
    { sector: 18, code: "secondary.version", message: "supplementary or enhanced volume descriptor at sector 18 must use version 1 or 2" },
    { sector: 20, code: "partition.version", message: "volume partition descriptor at sector 20 must use version 1" },
    { sector: 21, code: "terminator.version", message: "volume descriptor set terminator descriptor at sector 21 must use version 1" },
  ])("reports invalid descriptor version bytes for $code", ({ sector, code, message }) => {
    const image = createIsoImage([{ path: "README.TXT", data: "descriptor versions\n" }], {
      bootRecord: { bootSystemIdentifier: "BOOT" },
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }],
      enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }],
      volumePartition: {
        volumePartitionIdentifier: "PARTITION",
        data: "partition\n",
      },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    image[sector * SECTOR_SIZE + 6] = 3;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code, message }),
        expect.objectContaining({
          code: "descriptor.sequence",
          message: expect.stringMatching(/expected .* version/i),
        }),
      ]),
    );
  });

  test("reports unknown volume descriptors as outside the supported profile", () => {
    const image = createIsoImage([{ path: "README.TXT", data: "unknown descriptor\n" }], {
      bootRecord: {
        bootSystemIdentifier: "BOOT",
      },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const unknownDescriptorOffset = TERMINATOR_OFFSET;
    image[unknownDescriptorOffset] = 254;
    image[unknownDescriptorOffset + 6] = 7;

    expect(parseVolumeDescriptors(image).map((descriptor) => descriptor.kind)).toEqual(["primary", "unknown", "terminator"]);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "descriptor.unknown",
          message: "volume descriptor type 254 at sector 17 is outside the supported profile",
        }),
      ]),
    );
  });

  test("reports duplicate primary volume descriptors", () => {
    const image = createIsoImage([{ path: "README.TXT", data: "duplicate primary descriptor\n" }], {
      bootRecord: {
        bootSystemIdentifier: "BOOT",
      },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    image.set(image.subarray(PVD_OFFSET, PVD_OFFSET + SECTOR_SIZE), TERMINATOR_OFFSET);

    expect(parseVolumeDescriptors(image).map((descriptor) => descriptor.kind)).toEqual(["primary", "primary", "terminator"]);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "descriptor.primary_duplicate",
          message: "volume descriptor sequence contains 2 primary volume descriptors; the supported profile requires exactly one",
        }),
      ]),
    );
  });

  test("accepts multiple boot record descriptors", () => {
    const image = createIsoImage([{ path: "README.TXT", data: "duplicate boot descriptor\n" }], {
      bootRecord: {
        bootSystemIdentifier: "BOOT",
      },
      volumePartition: {
        volumePartitionIdentifier: "PARTITION",
        data: "partition\n",
      },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const bootDescriptorOffset = 17 * SECTOR_SIZE;
    const partitionDescriptorOffset = 18 * SECTOR_SIZE;
    image.set(image.subarray(bootDescriptorOffset, bootDescriptorOffset + SECTOR_SIZE), partitionDescriptorOffset);

    expect(parseVolumeDescriptors(image).map((descriptor) => descriptor.kind)).toEqual(["primary", "boot", "boot", "terminator"]);
    expect(validateIsoImage(image)).toEqual([]);
  });

  test("accepts the deepest valid primary directory hierarchy with write-read validation", () => {
    const path = "A/B/C/D/E/F/G/README.TXT";
    const image = baselineImage([{ path, data: "valid depth\n" }]);

    expect(validateIsoImage(image)).toEqual([]);
    expect(parseIsoImage(image).files[0]).toMatchObject({ path });
  });

  test("rejects explicit directory inputs that exceed primary hierarchy depth", () => {
    expect(() => createIsoImage({
      files: [],
      directories: [{ path: "A/B/C/D/E/F/G/H" }],
      volumeIdentifier: "DEPTH",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    })).toThrow(/hierarchy depth must not exceed 8/i);
  });

  test("reports primary hierarchy depth violations in external images", () => {
    const image = baselineImage([{ path: "A/B/C/D/E/F/G/H.TXT", data: "mutated directory\n" }]);
    const recordOffset = findDirectoryRecordOffsetByPath(image, ["A", "B", "C", "D", "E", "F", "G", "H.TXT;1"]);
    image[recordOffset + 25] |= 0x02;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.hierarchy_depth",
          path: "A/B/C/D/E/F/G/H.TXT",
          message: "primary directory hierarchy depth must not exceed 8 levels",
        }),
      ]),
    );
  });

  test("does not apply the primary hierarchy depth rule to supplementary descriptors", () => {
    const image = createIsoImage([{ path: "A/B/C/D/E/F/G/H.TXT", data: "supplementary depth\n" }], {
      volumeIdentifier: "DEPTH",
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const recordOffset = findDirectoryRecordOffsetByPath(
      image,
      ["A", "B", "C", "D", "E", "F", "G", "H.TXT;1"],
      supplementaryDescriptorOffset + 156,
    );
    image[recordOffset + 25] |= 0x02;

    expect(validateIsoImage(image)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.hierarchy_depth",
        }),
      ]),
    );
  });

  test("reports a path table parent directory number outside the record range", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested\n" }]);
    const pathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 99;
    image[childParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/path.?table|parent/i),
          message: expect.stringMatching(/parent|range/i),
        }),
      ]),
    );
  });

  test("reports a Type M path table record that points to itself as parent", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested\n" }]);
    const pathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 0;
    image[childParentDirectoryNumberOffset + 1] = 2;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.big.parent",
          message: expect.stringMatching(/Type M path table record 2 parent number 2/i),
        }),
      ]),
    );
  });

  test("reports zero path table parent directory numbers as range issues", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "path parent zero\n" }]);
    const littlePathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childLittleParentDirectoryNumberOffset = littlePathTableOffset + rootPathTableRecordLength + 6;
    const childBigParentDirectoryNumberOffset = bigPathTableOffset + rootPathTableRecordLength + 6;
    image[childLittleParentDirectoryNumberOffset] = 0;
    image[childLittleParentDirectoryNumberOffset + 1] = 0;
    image[childBigParentDirectoryNumberOffset] = 0;
    image[childBigParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.parent_directory_number.range",
          message: expect.stringMatching(/record 2 parent directory number must be at least 1/i),
        }),
        expect.objectContaining({
          code: "path_table.big.parent_directory_number.range",
          message: expect.stringMatching(/record 2 parent directory number must be at least 1/i),
        }),
      ]),
    );
  });

  test("writes path table records in ECMA-119 breadth-first order", () => {
    const image = baselineImage([
      { path: "A/AA/FILE.TXT", data: "nested a\n" },
      { path: "B/FILE.TXT", data: "nested b\n" },
    ]);
    const pathTableSize = readBothEndianUint32(image, PVD_OFFSET + 132);
    const pathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const records = decodePathTable(image.subarray(pathTableOffset, pathTableOffset + pathTableSize), "little");
    const textDecoder = new TextDecoder("ascii");

    expect(validateIsoImage(image)).toEqual([]);
    expect(records.map((record) => record.identifier[0] === 0 ? "." : textDecoder.decode(record.identifier))).toEqual([".", "A", "B", "AA"]);
    expect(records.map((record) => record.parentDirectoryNumber)).toEqual([1, 1, 1, 2]);
    expect(parseIsoImage(image).files.map((file) => file.path).sort()).toEqual(["A/AA/FILE.TXT", "B/FILE.TXT"]);
  });

  test("writes and reads maximum-length primary path table directory identifiers", () => {
    const directory = "A".repeat(31);
    const image = createIsoImage([{ path: `${directory}/FILE.TXT`, data: "max path table identifier\n" }], {
      volumeIdentifier: "VALIDATION",
      identifierLevel: 2,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const pathTableSize = readBothEndianUint32(image, PVD_OFFSET + 132);
    const pathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const records = decodePathTable(image.subarray(pathTableOffset, pathTableOffset + pathTableSize), "little");

    expect(validateIsoImage(image)).toEqual([]);
    expect(records[1]?.identifier).toEqual(new TextEncoder().encode(directory));
    expect(parseIsoImage(image).files.map((file) => file.path)).toEqual([`${directory}/FILE.TXT`]);
  });

  test("reports supplementary path table directory identifiers longer than 31 bytes", () => {
    const directory = "S".repeat(31);
    const image = createIsoImage([{ path: `${directory}/FILE.TXT`, data: "supp path table identifier length\n" }], {
      volumeIdentifier: "VALIDATION",
      identifierLevel: 2,
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const littlePathTableOffset = readUint32LE(image, supplementaryDescriptorOffset + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, supplementaryDescriptorOffset + 148) * SECTOR_SIZE;
    const childRecordOffset = 10;
    image[littlePathTableOffset + childRecordOffset] = 32;
    image[littlePathTableOffset + childRecordOffset + 8 + 31] = "S".charCodeAt(0);
    image[bigPathTableOffset + childRecordOffset] = 32;
    image[bigPathTableOffset + childRecordOffset + 8 + 31] = "S".charCodeAt(0);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary_path_table.little.identifier.length",
          message: "Type L path table record 2 directory identifier length must not exceed 31 bytes",
        }),
        expect.objectContaining({
          code: "supplementary_path_table.big.identifier.length",
          message: "Type M path table record 2 directory identifier length must not exceed 31 bytes",
        }),
      ]),
    );
  });

  test("reports enhanced path table directory identifiers longer than 207 bytes", () => {
    const directory = "E".repeat(31);
    const image = createIsoImage([{ path: `${directory}/FILE.TXT`, data: "enhanced path table identifier length\n" }], {
      volumeIdentifier: "VALIDATION",
      identifierLevel: 2,
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const enhancedDescriptorOffset = 17 * SECTOR_SIZE;
    const identifier = new TextEncoder().encode("E".repeat(208));
    const pathTableSize = 10 + 8 + identifier.byteLength;
    const littlePathTableOffset = readUint32LE(image, enhancedDescriptorOffset + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, enhancedDescriptorOffset + 148) * SECTOR_SIZE;
    writePathTableRecord(image, littlePathTableOffset + 10, "little", identifier, 1, rootDirectoryExtentAt(image, enhancedDescriptorOffset), 0);
    writePathTableRecord(image, bigPathTableOffset + 10, "big", identifier, 1, rootDirectoryExtentAt(image, enhancedDescriptorOffset), 0);
    writeUint32Both(image, enhancedDescriptorOffset + 132, pathTableSize);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "enhanced_path_table.little.identifier.length",
          message: "Type L path table record 2 directory identifier length must not exceed 207 bytes",
        }),
        expect.objectContaining({
          code: "enhanced_path_table.big.identifier.length",
          message: "Type M path table record 2 directory identifier length must not exceed 207 bytes",
        }),
      ]),
    );
  });

  test("reports path table records with hierarchy levels out of ECMA-119 order", () => {
    const image = baselineImage([
      { path: "A/AA/FILE.TXT", data: "nested a\n" },
      { path: "B/FILE.TXT", data: "nested b\n" },
    ]);
    const littlePathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    const recordLength = 10;
    const thirdRecordOffset = recordLength * 2;
    const fourthRecordOffset = recordLength * 3;
    swapBytes(image, littlePathTableOffset + thirdRecordOffset, littlePathTableOffset + fourthRecordOffset, recordLength);
    swapBytes(image, bigPathTableOffset + thirdRecordOffset, bigPathTableOffset + fourthRecordOffset, recordLength);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.order.level",
          message: expect.stringMatching(/ordered by hierarchy level/i),
        }),
        expect.objectContaining({
          code: "path_table.big.order.level",
          message: expect.stringMatching(/ordered by hierarchy level/i),
        }),
      ]),
    );
  });

  test("reports path table records with parent numbers out of ECMA-119 order", () => {
    const image = baselineImage([
      { path: "A/AA/FILE.TXT", data: "nested aa\n" },
      { path: "B/BB/FILE.TXT", data: "nested bb\n" },
    ]);
    const littlePathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    const recordLength = 10;
    const fourthRecordOffset = recordLength * 3;
    const fifthRecordOffset = recordLength * 4;
    swapBytes(image, littlePathTableOffset + fourthRecordOffset, littlePathTableOffset + fifthRecordOffset, recordLength);
    swapBytes(image, bigPathTableOffset + fourthRecordOffset, bigPathTableOffset + fifthRecordOffset, recordLength);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.order.parent",
          message: expect.stringMatching(/parent directory number/i),
        }),
        expect.objectContaining({
          code: "path_table.big.order.parent",
          message: expect.stringMatching(/parent directory number/i),
        }),
      ]),
    );
  });

  test("reports path table records with sibling identifiers out of ECMA-119 order", () => {
    const image = baselineImage([
      { path: "A/FILE.TXT", data: "nested a\n" },
      { path: "B/FILE.TXT", data: "nested b\n" },
    ]);
    const littlePathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    const recordLength = 10;
    const secondRecordOffset = recordLength;
    const thirdRecordOffset = recordLength * 2;
    swapBytes(image, littlePathTableOffset + secondRecordOffset, littlePathTableOffset + thirdRecordOffset, recordLength);
    swapBytes(image, bigPathTableOffset + secondRecordOffset, bigPathTableOffset + thirdRecordOffset, recordLength);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.order.identifier",
          message: expect.stringMatching(/directory identifier/i),
        }),
        expect.objectContaining({
          code: "path_table.big.order.identifier",
          message: expect.stringMatching(/directory identifier/i),
        }),
      ]),
    );
  });

  test("writes directory records in ECMA-119 file identifier order", () => {
    const image = baselineImage([
      { path: "A_.TXT", data: "underscore sorts after digits\n" },
      { path: "A", data: "short name\n" },
      { path: "A0.TXT", data: "digit extension\n" },
    ]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;

    expect(validateIsoImage(image)).toEqual([]);
    expect(directoryRecordIdentifiers(image, rootDirectoryOffset, SECTOR_SIZE)).toEqual([
      "\u0000",
      "\u0001",
      "A.;1",
      "A0.TXT;1",
      "A_.TXT;1",
    ]);
  });

  test("reports no-extension primary file identifiers that omit separator 1", () => {
    const image = baselineImage([{ path: "A", data: "missing separator\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "A.;1");
    image[fileRecordOffset + 32] = 3;
    image.set(new TextEncoder().encode("A;1"), fileRecordOffset + 33);
    image[fileRecordOffset + 36] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_identifier.characters",
          path: "A",
          message: expect.stringMatching(/primary file identifier/i),
        }),
      ]),
    );
  });

  test("reports directory records that are out of ECMA-119 file identifier order", () => {
    const image = baselineImage([
      { path: "A.TXT", data: "a\n" },
      { path: "B.TXT", data: "b\n" },
    ]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const aOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "A.TXT;1");
    const bOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "B.TXT;1");
    expect(image[aOffset]).toBe(image[bOffset]);
    swapBytes(image, aOffset, bOffset, image[aOffset]!);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.record_order",
          path: "A.TXT",
          message: expect.stringMatching(/ECMA-119 file identifier ordering/i),
        }),
      ]),
    );
  });

  test("reports associated file records that are not sorted before non-associated records with the same identifier", () => {
    const image = baselineImage([
      { path: "A.TXT", data: "a\n" },
      { path: "B.TXT", data: "b\n" },
    ]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const aOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "A.TXT;1");
    const bOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "B.TXT;1");
    const identifierLength = image[aOffset + 32]!;
    image.set(image.subarray(aOffset + 33, aOffset + 33 + identifierLength), bOffset + 33);
    image[bOffset + 25] |= 0x04;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.record_order",
          path: "A.TXT",
          message: expect.stringMatching(/ECMA-119 file identifier ordering/i),
        }),
      ]),
    );
  });

  test("reports duplicate ordinary directory records in the same directory", () => {
    const image = baselineImage([
      { path: "A.TXT", data: "a\n" },
      { path: "B.TXT", data: "b\n" },
    ]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const aOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "A.TXT;1");
    const bOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "B.TXT;1");
    copyDirectoryRecordIdentifier(image, aOffset, bOffset);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.record_duplicate",
          path: "A.TXT",
          message: "directory records at . contain duplicate file identifier entries",
        }),
      ]),
    );
  });

  test("does not report associated and non-associated records with the same identifier as duplicates", () => {
    const image = baselineImage([
      { path: "A.TXT", data: "a\n" },
      { path: "B.TXT", data: "b\n" },
    ]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const aOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "A.TXT;1");
    const bOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "B.TXT;1");
    copyDirectoryRecordIdentifier(image, aOffset, bOffset);
    image[bOffset + 25] |= 0x04;

    expect(validateIsoImage(image)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.record_duplicate",
        }),
      ]),
    );
  });

  test("reports duplicate ordinary directory records inside nested directories", () => {
    const image = baselineImage([
      { path: "DIR/A.TXT", data: "a\n" },
      { path: "DIR/B.TXT", data: "b\n" },
    ]);
    const aOffset = findDirectoryRecordOffsetByPath(image, ["DIR", "A.TXT;1"]);
    const bOffset = findDirectoryRecordOffsetByPath(image, ["DIR", "B.TXT;1"]);
    copyDirectoryRecordIdentifier(image, aOffset, bOffset);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.record_duplicate",
          path: "DIR/A.TXT",
          message: "directory records at DIR contain duplicate file identifier entries",
        }),
      ]),
    );
  });

  test("reports Type L and Type M path table mirror mismatches", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "mirror mismatch\n" }]);
    const pathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    writeUint32BE(image, pathTableOffset + rootPathTableRecordLength + 2, 0xffff);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.mirror.mismatch",
          message: expect.stringMatching(/Type L and Type M path table record 2/i),
        }),
      ]),
    );
  });

  test("reports malformed path table record layout", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "path table layout\n" }]);
    const pathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const pathTableSize = readBothEndianUint32(image, PVD_OFFSET + 132);
    const childRecordOffset = pathTableOffset + 10;
    image[childRecordOffset] = pathTableSize;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.record_length",
          message: expect.stringMatching(/invalid length/i),
        }),
      ]),
    );
  });

  test.each([
    {
      label: "Type L",
      offset: 140,
      readLocation: readUint32LE,
      validationCode: "path_table.little.record_length",
    },
    {
      label: "Type M",
      offset: 148,
      readLocation: readUint32BE,
      validationCode: "path_table.big.record_length",
    },
  ])("rejects malformed mandatory $label path tables during parsing", ({ label, offset, readLocation, validationCode }) => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "parse mandatory path table\n" }]);
    expect(parseIsoImage(image).files.map((file) => file.path)).toEqual(["DIR/FILE.TXT"]);

    const pathTableOffset = readLocation(image, PVD_OFFSET + offset) * SECTOR_SIZE;
    image[pathTableOffset + 10] = 0;

    expect(() => parseIsoImage(image)).toThrow(
      new RegExp(`primary volume descriptor ${label} path table is invalid: .*zero identifier length`, "i"),
    );
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: validationCode,
          message: expect.stringMatching(/zero identifier length/i),
        }),
      ]),
    );
  });

  test("reports zero-length records inside declared path table data", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "path table zero\n" }]);
    const pathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const childRecordOffset = pathTableOffset + 10;
    image[childRecordOffset] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.record_length",
          message: expect.stringMatching(/zero identifier length/i),
        }),
      ]),
    );
  });

  test("reports nonzero path table identifier padding", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "path table padding\n" }]);
    const littlePathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    const childRecordOffset = 10;
    image[littlePathTableOffset + childRecordOffset + 8 + "DIR".length] = 0xff;
    image[bigPathTableOffset + childRecordOffset + 8 + "DIR".length] = 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.record_padding",
          message: expect.stringMatching(/padding byte/i),
        }),
        expect.objectContaining({
          code: "path_table.big.record_padding",
          message: expect.stringMatching(/padding byte/i),
        }),
      ]),
    );
  });

  test("reports primary path table directory identifiers outside primary d-character rules", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "path table chars\n" }]);
    const littlePathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    const childIdentifierOffset = 10 + 8;
    image[littlePathTableOffset + childIdentifierOffset] = "#".charCodeAt(0);
    image[bigPathTableOffset + childIdentifierOffset] = "#".charCodeAt(0);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.identifier.characters",
          message: expect.stringMatching(/primary d-characters/i),
        }),
        expect.objectContaining({
          code: "path_table.big.identifier.characters",
          message: expect.stringMatching(/primary d-characters/i),
        }),
      ]),
    );

    const tooLong = baselineImage([{ path: "DIR/FILE.TXT", data: "path table length\n" }]);
    appendPrimaryPathTableRecord(tooLong, "D".repeat(32), 1, rootDirectoryExtent(tooLong), 0);
    expect(validateIsoImage(tooLong)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.identifier.characters",
          message: expect.stringMatching(/primary d-characters/i),
        }),
      ]),
    );
  });

  test("reports path table records that disagree with the directory hierarchy", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "hierarchy mismatch\n" }]);
    const littlePathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    writeUint32LE(image, littlePathTableOffset + 2, 0xffff);
    writeUint32BE(image, bigPathTableOffset + 2, 0xffff);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.hierarchy.record",
          message: expect.stringMatching(/extent fields/i),
        }),
      ]),
    );
  });

  test("reports path table directories missing from the directory hierarchy", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "missing path table\n" }]);
    writeUint32Both(image, PVD_OFFSET + 132, 10);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.hierarchy.missing",
          message: expect.stringMatching(/missing/i),
        }),
      ]),
    );
  });

  test("reports extra path table directories not present in the directory hierarchy", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "extra path table\n" }]);
    appendPrimaryPathTableRecord(image, "EXT", 1, rootDirectoryExtent(image), 0);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.hierarchy.extra",
          message: expect.stringMatching(/extra/i),
        }),
      ]),
    );
  });

  test("reports duplicate path table directory paths", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "duplicate path table\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    appendPrimaryPathTableRecord(image, "DIR", 1, readBothEndianUint32(image, dirRecordOffset + 2), image[dirRecordOffset + 1]!);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.hierarchy.duplicate",
          message: expect.stringMatching(/duplicate/i),
        }),
      ]),
    );
  });

  test("reports optional Type L path table issues when the optional location is present", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested\n" }]);
    writeUint32LE(image, PVD_OFFSET + 144, 0xffff);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.optional.little.bounds",
          message: expect.stringMatching(/Type L path table extent is out of bounds/i),
        }),
      ]),
    );
  });

  test("reports optional Type L path tables that differ from the mandatory copy and hierarchy", () => {
    const image = withOptionalPathTableCopy(
      baselineImage([{ path: "DIR/FILE.TXT", data: "optional l path table\n" }]),
      PVD_OFFSET,
      "little",
      (result, optionalPathTableOffset) => {
        writeUint32LE(result, optionalPathTableOffset + 10 + 2, 0xffff);
      },
    );

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.optional.little.mismatch",
          message: expect.stringMatching(/optional Type L path table record 2 does not match/i),
        }),
        expect.objectContaining({
          code: "path_table.optional.little.hierarchy.record",
          message: expect.stringMatching(/optional Type L path table directory record does not match/i),
        }),
      ]),
    );
  });

  test("reports optional Type M path tables that differ from the mandatory copy", () => {
    const image = withOptionalPathTableCopy(
      baselineImage([{ path: "DIR/FILE.TXT", data: "optional m path table\n" }]),
      PVD_OFFSET,
      "big",
      (result, optionalPathTableOffset) => {
        writeUint32BE(result, optionalPathTableOffset + 10 + 2, 0xffff);
      },
    );

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.optional.big.mismatch",
          message: expect.stringMatching(/optional Type M path table record 2 does not match/i),
        }),
        expect.objectContaining({
          code: "path_table.optional.big.hierarchy.record",
          message: expect.stringMatching(/optional Type M path table directory record does not match/i),
        }),
      ]),
    );
  });

  test.each([
    {
      label: "Type L",
      endian: "little" as const,
      offset: 144,
      readLocation: readUint32LE,
      validationCode: "path_table.optional.little.record_length",
    },
    {
      label: "Type M",
      endian: "big" as const,
      offset: 152,
      readLocation: readUint32BE,
      validationCode: "path_table.optional.big.record_length",
    },
  ])("rejects malformed optional $label path tables during parsing", ({ label, endian, offset, readLocation, validationCode }) => {
    const image = withOptionalPathTableCopy(
      baselineImage([{ path: "DIR/FILE.TXT", data: "parse optional path table\n" }]),
      PVD_OFFSET,
      endian,
      () => {},
    );
    expect(parseIsoImage(image).files.map((file) => file.path)).toEqual(["DIR/FILE.TXT"]);

    const optionalPathTableOffset = readLocation(image, PVD_OFFSET + offset) * SECTOR_SIZE;
    image[optionalPathTableOffset + 10] = 0;

    expect(() => parseIsoImage(image)).toThrow(
      new RegExp(`primary volume descriptor optional ${label} path table is invalid: .*zero identifier length`, "i"),
    );
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: validationCode,
          message: expect.stringMatching(/zero identifier length/i),
        }),
      ]),
    );
  });

  test("reports unsupported primary file structure versions", () => {
    const image = baselineImage([{ path: "README.TXT", data: "file structure version\n" }]);
    image[PVD_OFFSET + 881] = 2;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.file_structure_version",
          message: "primary volume descriptor file structure version must be 1",
        }),
      ]),
    );
  });

  test("reports primary volume space smaller than descriptor sequence", () => {
    const image = createIsoImage([{ path: "README.TXT", data: "descriptor sequence\n" }], {
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }],
      enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    setPrimaryVolumeSpaceSize(image, 17);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expectVolumeSpaceLowerBoundIssue(),
      ]),
    );
  });

  test("reports primary volume space smaller than primary path tables", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "path table\n" }]);
    const typeMPathTableLocation = readUint32BE(image, PVD_OFFSET + 148);
    const pathTableSize = readBothEndianUint32(image, PVD_OFFSET + 132);
    setPrimaryVolumeSpaceSize(image, typeMPathTableLocation + Math.ceil(pathTableSize / SECTOR_SIZE) - 1);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expectVolumeSpaceLowerBoundIssue(),
      ]),
    );
  });

  test("reports primary volume space smaller than file extended attribute record and data", () => {
    const image = baselineImage([{
      path: "EAR.TXT",
      data: "file ear lower bound\n",
      extendedAttributeRecord: {
        systemIdentifier: "VALIDATION",
      },
    }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "EAR.TXT;1");
    const fileExtent = readBothEndianUint32(image, fileRecordOffset + 2);
    const fileExtendedAttributeRecordLength = image[fileRecordOffset + 1]!;
    setPrimaryVolumeSpaceSize(image, fileExtent + fileExtendedAttributeRecordLength);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expectVolumeSpaceLowerBoundIssue(),
      ]),
    );
  });

  test("reports primary volume space smaller than directory extended attribute record and directory data", () => {
    const image = createIsoImage({
      files: [{ path: "DIR/FILE.TXT", data: "directory ear lower bound\n" }],
      directories: [{
        path: "DIR",
        extendedAttributeRecord: {
          systemIdentifier: "VALIDATION",
        },
      }],
    });
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirExtendedAttributeRecordLength = image[dirRecordOffset + 1]!;
    setPrimaryVolumeSpaceSize(image, dirExtent + dirExtendedAttributeRecordLength);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expectVolumeSpaceLowerBoundIssue(),
      ]),
    );
  });

  test("reports primary volume space smaller than supplementary directory tree", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "supp lower bound\n" }], {
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const supplementaryRootExtent = readBothEndianUint32(image, supplementaryDescriptorOffset + 156 + 2);
    setPrimaryVolumeSpaceSize(image, supplementaryRootExtent);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expectVolumeSpaceLowerBoundIssue(),
      ]),
    );
  });

  test("reports primary volume space smaller than volume partition extent", () => {
    const image = createIsoImage([{ path: "README.TXT", data: "partition lower bound\n" }], {
      volumePartition: {
        volumePartitionIdentifier: "PARTITION",
        data: "partition payload\n",
      },
    });
    const partition = parseVolumeDescriptors(image).find(
      (descriptor): descriptor is VolumePartitionDescriptor => descriptor.kind === "partition",
    );
    expect(partition).toBeDefined();
    setPrimaryVolumeSpaceSize(image, partition!.volumePartitionLocation + partition!.volumePartitionSize - 1);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expectVolumeSpaceLowerBoundIssue(),
      ]),
    );
  });

  test("reports a path table record that points to itself as parent", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested\n" }]);
    const pathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 2;
    image[childParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.parent",
          message: expect.stringMatching(/parent/i),
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

  test("reports a directory record that crosses a sector boundary", () => {
    const image = baselineImage();
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    setRootDirectorySize(image, SECTOR_SIZE * 2);
    const crossingRecordOffset = rootDirectoryOffset + SECTOR_SIZE - 10;
    image[crossingRecordOffset] = 34;
    image[crossingRecordOffset + 32] = 1;
    image[crossingRecordOffset + 33] = "X".charCodeAt(0);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/director|record/i),
          message: expect.stringMatching(/sector|boundar|record/i),
        }),
      ]),
    );
  });

  test("reports a malformed directory record instead of relying on undefined reads", () => {
    const image = baselineImage([{ path: "FILE.TXT", data: "file\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const firstChildRecordOffset = rootDirectoryOffset + 68;
    image[firstChildRecordOffset] = 33;
    image[firstChildRecordOffset + 32] = 20;

    expect(() => parseIsoImage(image)).toThrow(/invalid length/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/director|record/i),
          message: expect.stringMatching(/malformed|length|identifier|record/i),
        }),
      ]),
    );
  });

  test.each([
    { fieldOffset: 2, code: "directory.extent.endian_mismatch", label: "location of extent", message: /both-endian uint32/i },
    { fieldOffset: 10, code: "directory.data_length.endian_mismatch", label: "data length", message: /both-endian uint32/i },
    { fieldOffset: 28, code: "directory.volume_sequence_number.endian_mismatch", label: "volume sequence number", message: /both-endian uint16/i },
  ])("reports directory record both-endian mismatches for $label", ({ fieldOffset, code, label, message }) => {
    const image = baselineImage([{ path: "FILE.TXT", data: "file\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "FILE.TXT;1");
    image[fileRecordOffset + fieldOffset + (fieldOffset === 28 ? 3 : 7)] ^= 0xff;
    const issues = validateIsoImage(image);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code,
          path: "FILE.TXT",
          message: expect.stringContaining(`directory record ${label} at FILE.TXT must store matching little- and big-endian values`),
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.record_malformed",
          message,
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "image.parse",
          message,
        }),
      ]),
    );
  });

  test("reports descriptor root directory record both-endian mismatches before descriptor parsing", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root mismatch\n" }]);
    image[PVD_OFFSET + 156 + 2 + 7] ^= 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.extent.endian_mismatch",
          path: ".",
          message: expect.stringContaining("directory record location of extent at . must store matching little- and big-endian values"),
        }),
        expect.objectContaining({
          code: "descriptor.sequence",
          message: expect.stringMatching(/both-endian uint32 mismatch/i),
        }),
      ]),
    );
  });

  test("reports a missing directory self record when a directory starts with padding", () => {
    const image = baselineImage();
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    image[rootDirectoryOffset] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.self_record.missing",
          path: ".",
          message: expect.stringMatching(/self record is missing/i),
        }),
      ]),
    );
  });

  test("reports reserved file flag bits inside nested directories", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirSize = readBothEndianUint32(image, dirRecordOffset + 10);
    const fileRecordOffset = findDirectoryRecordOffset(image, dirExtent * SECTOR_SIZE, dirSize, "FILE.TXT;1");
    image[fileRecordOffset + 25] = 0x20;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_reserved",
          path: "DIR",
          message: expect.stringMatching(/reserved/i),
        }),
      ]),
    );
  });

  test("reports primary directory record identifiers outside primary rules", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "identifier rules\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const childDirectoryOffset = dirExtent * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, childDirectoryOffset, SECTOR_SIZE, "FILE.TXT;1");

    image[dirRecordOffset + 33] = "#".charCodeAt(0);
    image[fileRecordOffset + 33] = "#".charCodeAt(0);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.directory_identifier.characters",
          message: expect.stringMatching(/primary d-characters/i),
        }),
        expect.objectContaining({
          code: "directory.file_identifier.characters",
          message: expect.stringMatching(/primary file identifier/i),
        }),
      ]),
    );
  });

  test("reports invalid primary file identifier versions", () => {
    const image = baselineImage([{ path: "README.TXT", data: "bad version\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    const identifierLength = image[fileRecordOffset + 32]!;
    image[fileRecordOffset + 33 + identifierLength - 1] = "0".charCodeAt(0);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_identifier.characters",
          message: expect.stringMatching(/primary file identifier/i),
        }),
      ]),
    );
  });

  test("does not apply primary Level 1 record identifier rules to supplementary hierarchies", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "supp identifier\n" }], {
      supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }],
    });
    const supplementary = parseVolumeDescriptors(image).find((descriptor) => descriptor.kind === "supplementary");
    if (!supplementary || supplementary.kind !== "supplementary") {
      throw new Error("missing supplementary descriptor");
    }
    const rootDirectoryOffset = supplementary.rootDirectoryRecord.extent * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    image[dirRecordOffset + 33] = "#".charCodeAt(0);

    const issues = validateIsoImage(image);

    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^directory\.(directory_identifier|file_identifier)\.characters$/),
        }),
      ]),
    );
  });

  test("reports primary descriptor root directory record identifier mismatches", () => {
    const image = baselineImage();
    image[PVD_OFFSET + 156 + 33] = 1;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.root_directory_record.identifier",
          message: expect.stringMatching(/root directory record/i),
        }),
      ]),
    );
  });

  test("reports malformed extended attribute records inside nested directories", () => {
    const image = baselineImage([{
      path: "DIR/FILE.TXT",
      data: "nested ear\n",
      extendedAttributeRecord: {
        systemIdentifier: "VALIDATION",
      },
    }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirSize = readBothEndianUint32(image, dirRecordOffset + 10);
    const fileRecordOffset = findDirectoryRecordOffset(image, dirExtent * SECTOR_SIZE, dirSize, "FILE.TXT;1");
    const fileExtent = readBothEndianUint32(image, fileRecordOffset + 2);
    image[fileExtent * SECTOR_SIZE + 182] = 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.parse",
          path: "DIR/FILE.TXT",
          message: expect.stringMatching(/reserved bytes/i),
        }),
      ]),
    );
  });

  test("reports malformed primary descriptor root extended attribute records", () => {
    const image = withDescriptorRootExtendedAttributeRecord(baselineImage(), PVD_OFFSET, encodeExtendedAttributeRecord({
      systemIdentifier: "VALIDATION",
    }));
    const rootExtent = rootDirectoryExtent(image);
    image[rootExtent * SECTOR_SIZE + 182] = 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.parse",
          path: ".",
          message: expect.stringMatching(/reserved bytes/i),
        }),
      ]),
    );
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      path: "supplementary:.",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      path: "enhanced:.",
    },
  ])("reports malformed $kind descriptor root extended attribute records", ({ options, path }) => {
    const image = withDescriptorRootExtendedAttributeRecord(createIsoImage([{ path: "FILE.TXT", data: "secondary root ear\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    }), 17 * SECTOR_SIZE, encodeExtendedAttributeRecord({
      systemIdentifier: "VALIDATION",
    }));
    const rootExtent = rootDirectoryExtentAt(image, 17 * SECTOR_SIZE);
    image[rootExtent * SECTOR_SIZE + 182] = 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.parse",
          path,
          message: expect.stringMatching(/reserved bytes/i),
        }),
      ]),
    );
  });

  test("reports primary descriptor root extended attribute flag mismatches", () => {
    const image = withDescriptorRootExtendedAttributeRecord(baselineImage(), PVD_OFFSET, encodeExtendedAttributeRecord({
      ownerIdentification: 1,
      groupIdentification: 1,
      systemIdentifier: "VALIDATION",
    }));

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.file_flags",
          path: ".",
          message: "directory record flags for . do not match associated extended attribute record fields",
        }),
      ]),
    );
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      path: "supplementary:.",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      path: "enhanced:.",
    },
  ])("reports $kind descriptor root extended attribute flag mismatches", ({ options, path }) => {
    const image = withDescriptorRootExtendedAttributeRecord(createIsoImage([{ path: "FILE.TXT", data: "secondary root ear flags\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    }), 17 * SECTOR_SIZE, encodeExtendedAttributeRecord({
      ownerIdentification: 1,
      groupIdentification: 1,
      systemIdentifier: "VALIDATION",
    }));

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "extended_attribute_record.file_flags",
          path,
          message: `directory record flags for ${path} do not match associated extended attribute record fields`,
        }),
      ]),
    );
  });

  test("reports root directory self record identifier mismatches", () => {
    const image = baselineImage();
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    image[rootDirectoryOffset + 33] = 1;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.self_record.identifier",
          path: ".",
          message: expect.stringMatching(/self record/i),
        }),
      ]),
    );
  });

  test("reports root directory parent record extent mismatches", () => {
    const image = baselineImage();
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const parentRecordOffset = rootDirectoryOffset + image[rootDirectoryOffset]!;
    writeUint32Both(image, parentRecordOffset + 2, rootDirectoryExtent(image) + 1);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.parent_record.extent",
          path: ".",
          message: expect.stringMatching(/parent record/i),
        }),
      ]),
    );
  });

  test("reports nested directory parent record extent mismatches", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested parent\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirSize = readBothEndianUint32(image, dirRecordOffset + 10);
    const dirDirectoryOffset = dirExtent * SECTOR_SIZE;
    const parentRecordOffset = dirDirectoryOffset + image[dirDirectoryOffset]!;
    writeUint32Both(image, parentRecordOffset + 2, dirExtent);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.parent_record.extent",
          path: "DIR",
          message: expect.stringMatching(/parent directory extent fields/i),
        }),
      ]),
    );
    expect(dirSize).toBeGreaterThan(0);
  });

  test("reports nested directory self record size mismatches", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested self\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirSize = readBothEndianUint32(image, dirRecordOffset + 10);
    const dirDirectoryOffset = dirExtent * SECTOR_SIZE;
    writeUint32Both(image, dirDirectoryOffset + 10, dirSize + 1);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.self_record.extent",
          path: "DIR",
          message: expect.stringMatching(/current directory extent fields/i),
        }),
      ]),
    );
  });

  test("reports nested directory data lengths that are not logical block multiples", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "nested alignment\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirDirectoryOffset = dirExtent * SECTOR_SIZE;
    writeUint32Both(image, dirRecordOffset + 10, SECTOR_SIZE - 1);
    writeUint32Both(image, dirDirectoryOffset + 10, SECTOR_SIZE - 1);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.data_length_alignment",
          path: "DIR",
          message: "directory data length at DIR must be a positive multiple of the logical block size",
        }),
      ]),
    );
  });

  test("reports descriptor root directory data lengths that are not logical block multiples", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root alignment\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    writeUint32Both(image, PVD_OFFSET + 156 + 10, SECTOR_SIZE - 1);
    writeUint32Both(image, rootDirectoryOffset + 10, SECTOR_SIZE - 1);
    writeUint32Both(image, rootDirectoryOffset + image[rootDirectoryOffset]! + 10, SECTOR_SIZE - 1);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.data_length_alignment",
          path: ".",
          message: "directory data length at . must be a positive multiple of the logical block size",
        }),
      ]),
    );
  });

  test("reports directory self record extended attribute length mismatches", () => {
    const image = createIsoImage({
      files: [{ path: "DIR/FILE.TXT", data: "dir ear self\n" }],
      directories: [{
        path: "DIR",
        extendedAttributeRecord: {
          systemIdentifier: "VALIDATION",
        },
      }],
    });
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirDirectoryOffset = (dirExtent + image[dirRecordOffset + 1]!) * SECTOR_SIZE;
    image[dirDirectoryOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.self_record.extent",
          path: "DIR",
          message: expect.stringMatching(/current directory extent fields/i),
        }),
      ]),
    );
  });

  test("accepts interleaved regular file record fields", () => {
    const image = baselineImage([{ path: "README.TXT", data: "interleaved metadata\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    image[fileRecordOffset + 26] = 1;
    image[fileRecordOffset + 27] = 2;

    expect(validateIsoImage(image)).toEqual([]);
    expect(parseIsoImage(image).files[0]).toMatchObject({
      path: "README.TXT",
      fileUnitSize: 1,
      interleaveGapSize: 2,
    });
  });

  test("reports invalid interleaved file fields without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "invalid interleaved metadata\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    image[fileRecordOffset + 26] = 0;
    image[fileRecordOffset + 27] = 2;

    expect(() => parseIsoImage(image)).toThrow(/invalid interleaved file section fields/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.interleaving_invalid",
          path: "README.TXT",
          message: expect.stringMatching(/invalid interleaved/i),
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

  test("reports interleaved extended attribute record lengths that do not match the file unit size", () => {
    const image = baselineImage([{
      path: "EAR.TXT",
      data: "invalid interleaved ear length\n",
      extendedAttributeRecord: new Uint8Array(SECTOR_SIZE),
    }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "EAR.TXT;1");
    image[fileRecordOffset + 26] = 2;
    image[fileRecordOffset + 27] = 1;

    expect(() => parseIsoImage(image)).toThrow(/expected file unit size 2/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.interleaved_ear_length",
          path: "EAR.TXT",
          message: expect.stringMatching(/expected file unit size 2/i),
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

  test("accepts interleaved descriptor root directory fields", () => {
    const files = Array.from({ length: 80 }, (_, index) => ({
      path: `F${index.toString().padStart(3, "0")}.TXT`,
      data: `file ${index}\n`,
    }));
    const image = withInterleavedPrimaryRootDirectory(baselineImage(files), 1, 1);

    const parsed = parseIsoImage(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.root).toMatchObject({
      fileUnitSize: 1,
      interleaveGapSize: 1,
    });
    expect(parsed.files.map((file) => file.path)).toEqual(files.map((file) => file.path));
  });

  test("reports invalid interleaved descriptor root directory fields without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root invalid interleaved metadata\n" }]);
    image[PVD_OFFSET + 156 + 26] = 0;
    image[PVD_OFFSET + 156 + 27] = 2;

    expect(() => parseIsoImage(image)).toThrow(/invalid interleaved file section fields/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.interleaving_invalid",
          path: ".",
          message: expect.stringMatching(/invalid interleaved/i),
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

  test("reports reserved descriptor root file flag bits without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root reserved flags\n" }]);
    image[PVD_OFFSET + 156 + 25] |= 0x20;

    expect(() => parseIsoImage(image)).toThrow(/reserved file flag bits/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_reserved",
          path: ".",
          message: expect.stringMatching(/reserved file flag bits/i),
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

  test.each([
    {
      kind: "supplementary",
      descriptorOffset: 17 * SECTOR_SIZE,
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      path: "supplementary:.",
    },
    {
      kind: "enhanced",
      descriptorOffset: 17 * SECTOR_SIZE,
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      path: "enhanced:.",
    },
  ])("reports reserved $kind descriptor root file flag bits", ({ descriptorOffset, options, path }) => {
    const image = createIsoImage([{ path: "README.TXT", data: "secondary root reserved flags\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    image[descriptorOffset + 156 + 25] |= 0x40;

    expect(() => parseIsoImage(image)).toThrow(/reserved file flag bits/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_reserved",
          path,
          message: expect.stringMatching(/reserved file flag bits/i),
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

  test("reports multi-extent file records missing their final section without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "multi extent flag\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    image[fileRecordOffset + 25] |= 0x80;

    expect(() => parseIsoImage(image)).toThrow(/missing its final file section/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.multi_extent_final_missing",
          path: "README.TXT",
          message: expect.stringMatching(/missing its final file section/i),
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

  test("reports multi-extent file records followed by a different file identifier", () => {
    const image = baselineImage([
      { path: "README.TXT", data: "first section\n" },
      { path: "ZZZ.TXT", data: "different file\n" },
    ]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    image[fileRecordOffset + 25] |= 0x80;

    expect(() => parseIsoImage(image)).toThrow(/not followed by a matching file section/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.multi_extent_sequence",
          path: "README.TXT",
          message: expect.stringMatching(/not followed by a matching file section/i),
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

  test.each([
    { flag: 0x01, label: "Hidden" },
    { flag: 0x08, label: "Record" },
  ])("reports multi-extent file records followed by a section with mismatched $label flag", ({ flag }) => {
    const image = baselineImage([{ path: "README.TXT", data: "first section\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    const fileRecordLength = image[fileRecordOffset]!;
    const continuationRecordOffset = fileRecordOffset + fileRecordLength;
    image.copyWithin(continuationRecordOffset, fileRecordOffset, fileRecordOffset + fileRecordLength);
    image[fileRecordOffset + 25] |= 0x80;
    image[continuationRecordOffset + 25] |= flag;

    expect(() => parseIsoImage(image)).toThrow(/not followed by a matching file section/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.multi_extent_sequence",
          path: "README.TXT",
          message: expect.stringMatching(/not followed by a matching file section/i),
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

  test("reports unsupported multi-extent descriptor root records without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root multi extent flag\n" }]);
    image[PVD_OFFSET + 156 + 25] |= 0x80;

    expect(() => parseIsoImage(image)).toThrow(/unsupported multi-extent/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.multi_extent_unsupported",
          path: ".",
          message: expect.stringMatching(/unsupported multi-extent/i),
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

  test("does not treat associated file flags as reserved or multi-extent", () => {
    const image = baselineImage([{ path: "README.TXT", data: "associated file flag\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    image[fileRecordOffset + 25] |= 0x04;

    expect(validateIsoImage(image)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/reserved|multi_extent/i),
        }),
      ]),
    );
    expect(parseIsoImage(image).files[0]).toMatchObject({
      path: "README.TXT",
      flags: 0x04,
    });
  });

  test.each([
    { flag: 0x08, label: "Record" },
    { flag: 0x10, label: "Protection" },
    { flag: 0x18, label: "Record and Protection" },
  ])("reports file $label flags without an extended attribute record", ({ flag }) => {
    const image = baselineImage([{ path: "README.TXT", data: "missing file ear\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    image[fileRecordOffset + 25] |= flag;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_extended_attribute_missing",
          path: "README.TXT",
          message: "file record at README.TXT sets Record or Protection flags without an extended attribute record",
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
    expect(parseIsoImage(image).files[0]).toMatchObject({
      path: "README.TXT",
      flags: flag,
      extendedAttributeRecordLength: 0,
    });
  });

  test("allows file Record and Protection flags when they match an extended attribute record", () => {
    const image = baselineImage([{
      path: "README.TXT",
      data: "matching file ear\n",
      extendedAttributeRecord: {
        ownerIdentification: 1,
        groupIdentification: 1,
        recordFormat: 1,
        recordAttributes: 1,
        recordLength: 1,
        systemIdentifier: "VALIDATION",
      },
    }]);
    const parsed = parseIsoImage(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.files[0]).toMatchObject({
      path: "README.TXT",
      flags: 0x18,
      extendedAttributeRecordLength: 1,
    });
  });

  test("reports nested file Record flags without an extended attribute record", () => {
    const image = baselineImage([{ path: "DIR/README.TXT", data: "nested missing ear\n" }]);
    const fileRecordOffset = findDirectoryRecordOffsetByPath(image, ["DIR", "README.TXT;1"]);
    image[fileRecordOffset + 25] |= 0x08;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_extended_attribute_missing",
          path: "DIR/README.TXT",
          message: "file record at DIR/README.TXT sets Record or Protection flags without an extended attribute record",
        }),
      ]),
    );
  });

  test("reports associated directory record flags", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "associated directory flag\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const directoryRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    image[directoryRecordOffset + 25] |= 0x04;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_directory",
          path: "DIR",
          message: "directory record at DIR identifies a directory and must not set Associated File or Record bits",
        }),
      ]),
    );
  });

  test("reports record-bit directory records without extended attribute records", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "record directory flag\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const directoryRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    image[directoryRecordOffset + 25] |= 0x08;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_directory",
          path: "DIR",
          message: "directory record at DIR identifies a directory and must not set Associated File or Record bits",
        }),
      ]),
    );
  });

  test("reports protected directory records without extended attribute records", () => {
    const image = baselineImage([{ path: "DIR/FILE.TXT", data: "protected directory flag\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const directoryRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    image[directoryRecordOffset + 25] |= 0x10;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_extended_attribute_missing",
          path: "DIR",
          message: "directory record at DIR sets Protection flag without an extended attribute record",
        }),
      ]),
    );
    expect(parseIsoImage(image).root.children[0]).toMatchObject({
      path: "DIR",
      flags: 0x12,
      extendedAttributeRecordLength: 0,
    });
  });

  test("allows protected directory records when they match an extended attribute record", () => {
    const image = createIsoImage({
      files: [{ path: "DIR/FILE.TXT", data: "protected directory ear\n" }],
      directories: [{
        path: "DIR",
        extendedAttributeRecord: {
          ownerIdentification: 1,
          groupIdentification: 1,
          systemIdentifier: "VALIDATION",
        },
      }],
    });
    const parsed = parseIsoImage(image);

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.root.children[0]).toMatchObject({
      path: "DIR",
      flags: 0x12,
      extendedAttributeRecordLength: 1,
    });
  });

  test("reports descriptor root associated directory flags", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root associated directory flag\n" }]);
    image[PVD_OFFSET + 156 + 25] |= 0x04;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_directory",
          path: ".",
          message: "directory record at . identifies a directory and must not set Associated File or Record bits",
        }),
      ]),
    );
  });

  test("reports protected descriptor root records without extended attribute records", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root protection flag\n" }]);
    image[PVD_OFFSET + 156 + 25] |= 0x10;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_extended_attribute_missing",
          path: ".",
          message: "directory record at . sets Protection flag without an extended attribute record",
        }),
      ]),
    );
  });

  test("accepts primary volume set sizes larger than one when records stay on the local volume", () => {
    const image = baselineImage([{ path: "README.TXT", data: "multi-volume descriptor\n" }]);
    writeUint16Both(image, PVD_OFFSET + 120, 2);

    const parsed = parseIsoImage(image, { includeData: true });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.primaryVolumeDescriptor.volumeSetSize).toBe(2);
    expect(parsed.primaryVolumeDescriptor.volumeSequenceNumber).toBe(1);
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("multi-volume descriptor\n");
  });

  test("reports zero primary volume set sizes as range issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "zero volume set\n" }]);
    writeUint16Both(image, PVD_OFFSET + 120, 0);

    expect(() => parseIsoImage(image)).toThrow(/volume set size must be at least 1/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.volume_set_size.range",
          message: "primary volume descriptor volume set size must be at least 1",
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

  test("reports primary volume sequence numbers greater than the volume set size before path table parsing", () => {
    const image = baselineImage([{ path: "README.TXT", data: "multi-volume descriptor\n" }]);
    writeUint16Both(image, PVD_OFFSET + 124, 2);
    writeUint32Both(image, PVD_OFFSET + 140, 0xffff);

    expect(() => parseIsoImage(image)).toThrow(/volume sequence number must be less than or equal to volume set size/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.volume_sequence_number.bounds",
          message: "primary volume descriptor volume sequence number must be less than or equal to volume set size",
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

  test("reports zero primary volume sequence numbers as range issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "zero volume sequence\n" }]);
    writeUint16Both(image, PVD_OFFSET + 124, 0);
    writeUint32Both(image, PVD_OFFSET + 140, 0xffff);

    expect(() => parseIsoImage(image)).toThrow(/volume sequence number must be at least 1/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.volume_sequence_number.range",
          message: "primary volume descriptor volume sequence number must be at least 1",
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

  test("reports external descriptor root volume sequence numbers without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root sequence\n" }]);
    writeUint16Both(image, PVD_OFFSET + 156 + 28, 2);

    expect(() => parseIsoImage(image)).toThrow(/external volume sequence number 2/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.volume_sequence_unsupported",
          path: ".",
          message: expect.stringMatching(/external volume sequence number 2/i),
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

  test("reports zero descriptor root volume sequence numbers as range issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root zero sequence\n" }]);
    writeUint16Both(image, PVD_OFFSET + 156 + 28, 0);

    expect(() => parseIsoImage(image)).toThrow(/invalid volume sequence number 0/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.volume_sequence_number.range",
          path: ".",
          message: "directory record at . has invalid volume sequence number 0",
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

  test("reports external child directory record volume sequence numbers without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "child sequence\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    writeUint16Both(image, fileRecordOffset + 28, 2);

    expect(() => parseIsoImage(image)).toThrow(/external volume sequence number 2/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.volume_sequence_unsupported",
          path: "README.TXT",
          message: expect.stringMatching(/external volume sequence number 2/i),
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

  test("does not traverse external child directory extents on local volume set members", () => {
    const image = createIsoImage([
      { path: "DIR/FILE.TXT", data: "nested\n" },
      { path: "README.TXT", data: "not a directory\n" },
    ], {
      volumeSetSize: 2,
      volumeSequenceNumber: 2,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const dirRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "DIR");
    const readmeRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    const readmeExtent = readBothEndianUint32(image, readmeRecordOffset + 2);
    image[dirRecordOffset + 1] = 1;
    writeUint32Both(image, dirRecordOffset + 2, readmeExtent);
    writeUint16Both(image, dirRecordOffset + 28, 1);

    expect(() => parseIsoImage(image)).toThrow(/external volume sequence number 1/i);
    const issues = validateIsoImage(image);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.volume_sequence_unsupported",
          path: "DIR",
          message: expect.stringMatching(/external volume sequence number 1/i),
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "directory.record_malformed" }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "directory.self_record.missing" }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "extended_attribute_record.parse" }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "image.parse" }),
      ]),
    );
  });

  test("does not traverse external descriptor root extents on local volume set members", () => {
    const image = createIsoImage([
      { path: "DIR/FILE.TXT", data: "nested\n" },
      { path: "README.TXT", data: "not a directory\n" },
    ], {
      volumeSetSize: 2,
      volumeSequenceNumber: 2,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const readmeRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    const readmeExtent = readBothEndianUint32(image, readmeRecordOffset + 2);
    image[PVD_OFFSET + 156 + 1] = 1;
    writeUint32Both(image, PVD_OFFSET + 156 + 2, readmeExtent);
    writeUint16Both(image, PVD_OFFSET + 156 + 28, 1);

    expect(() => parseIsoImage(image)).toThrow(/external volume sequence number 1/i);
    const issues = validateIsoImage(image);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.volume_sequence_unsupported",
          path: ".",
          message: expect.stringMatching(/external volume sequence number 1/i),
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "path_table.hierarchy.record" }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "directory.record_malformed" }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "directory.self_record.missing" }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "extended_attribute_record.parse" }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "image.parse" }),
      ]),
    );
  });

  test("reports zero child directory record volume sequence numbers as range issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "child zero sequence\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    writeUint16Both(image, fileRecordOffset + 28, 0);

    expect(() => parseIsoImage(image)).toThrow(/invalid volume sequence number 0/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.volume_sequence_number.range",
          path: "README.TXT",
          message: "directory record at README.TXT has invalid volume sequence number 0",
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

  test("reports supplementary path table parent issues", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const pathTableOffset = readUint32LE(image, supplementaryDescriptorOffset + 140) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 2;
    image[childParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary_path_table.little.parent",
          message: expect.stringMatching(/parent/i),
        }),
      ]),
    );
  });

  test("reports supplementary Type M path table parent issues", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const pathTableOffset = readUint32BE(image, supplementaryDescriptorOffset + 148) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 0;
    image[childParentDirectoryNumberOffset + 1] = 2;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary_path_table.big.parent",
          message: expect.stringMatching(/Type M path table record 2 parent number 2/i),
        }),
      ]),
    );
  });

  test("reports zero supplementary path table parent directory numbers as range issues", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "supp parent zero\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const littlePathTableOffset = readUint32LE(image, supplementaryDescriptorOffset + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, supplementaryDescriptorOffset + 148) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childLittleParentDirectoryNumberOffset = littlePathTableOffset + rootPathTableRecordLength + 6;
    const childBigParentDirectoryNumberOffset = bigPathTableOffset + rootPathTableRecordLength + 6;
    image[childLittleParentDirectoryNumberOffset] = 0;
    image[childLittleParentDirectoryNumberOffset + 1] = 0;
    image[childBigParentDirectoryNumberOffset] = 0;
    image[childBigParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary_path_table.little.parent_directory_number.range",
          message: expect.stringMatching(/record 2 parent directory number must be at least 1/i),
        }),
        expect.objectContaining({
          code: "supplementary_path_table.big.parent_directory_number.range",
          message: expect.stringMatching(/record 2 parent directory number must be at least 1/i),
        }),
      ]),
    );
  });

  test("reports supplementary path table hierarchy mismatches", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "supp hierarchy\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const littlePathTableOffset = readUint32LE(image, supplementaryDescriptorOffset + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, supplementaryDescriptorOffset + 148) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    writeUint32LE(image, littlePathTableOffset + rootPathTableRecordLength + 2, 0xffff);
    writeUint32BE(image, bigPathTableOffset + rootPathTableRecordLength + 2, 0xffff);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary_path_table.hierarchy.record",
          message: expect.stringMatching(/extent fields/i),
        }),
      ]),
    );
  });

  test("reports supplementary optional Type M path table issues when the optional location is present", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    writeUint32BE(image, supplementaryDescriptorOffset + 152, 0xffff);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary_path_table.optional.big.bounds",
          message: expect.stringMatching(/Type M path table extent is out of bounds/i),
        }),
      ]),
    );
  });

  test("reports supplementary optional path tables that differ from the mandatory copy and hierarchy", () => {
    const image = withOptionalPathTableCopy(
      createIsoImage([{ path: "DIR/FILE.TXT", data: "supp optional path table\n" }], {
        volumeIdentifier: "VALIDATION",
        supplementaryVolumeDescriptors: [{
          volumeIdentifier: "SUPP",
        }],
        createdAt: new Date("2024-01-01T00:00:00Z"),
      }),
      17 * SECTOR_SIZE,
      "big",
      (result, optionalPathTableOffset) => {
        writeUint32BE(result, optionalPathTableOffset + 10 + 2, 0xffff);
      },
    );

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary_path_table.optional.big.mismatch",
          message: expect.stringMatching(/optional Type M path table record 2 does not match/i),
        }),
        expect.objectContaining({
          code: "supplementary_path_table.optional.big.hierarchy.record",
          message: expect.stringMatching(/optional Type M path table directory record does not match/i),
        }),
      ]),
    );
  });

  test("reports unsupported supplementary file structure versions", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    image[supplementaryDescriptorOffset + 881] = 2;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary.file_structure_version",
          message: "supplementary volume descriptor file structure version must be 1",
        }),
      ]),
    );
  });

  test("reports unsupported enhanced file structure versions", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const enhancedDescriptorOffset = 17 * SECTOR_SIZE;
    image[enhancedDescriptorOffset + 881] = 1;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "enhanced.file_structure_version",
          message: "enhanced volume descriptor file structure version must be 2",
        }),
      ]),
    );
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      codePrefix: "supplementary",
      label: "supplementary volume",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      codePrefix: "enhanced",
      label: "enhanced volume",
    },
  ])("reports $kind descriptor both-endian numeric mismatches", ({ options, codePrefix, label }) => {
    const fields = [
      { fieldOffset: 80, bytes: 4, code: "volume_space_size", fieldLabel: "volume space size" },
      { fieldOffset: 120, bytes: 2, code: "volume_set_size", fieldLabel: "volume set size" },
      { fieldOffset: 124, bytes: 2, code: "volume_sequence_number", fieldLabel: "volume sequence number" },
      { fieldOffset: 128, bytes: 2, code: "logical_block_size", fieldLabel: "logical block size" },
      { fieldOffset: 132, bytes: 4, code: "path_table_size", fieldLabel: "path table size" },
    ];

    for (const field of fields) {
      const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "secondary both endian\n" }], {
        volumeIdentifier: "VALIDATION",
        ...options,
        createdAt: new Date("2024-01-01T00:00:00Z"),
      });
      const secondaryDescriptorOffset = 17 * SECTOR_SIZE;
      image[secondaryDescriptorOffset + field.fieldOffset + (field.bytes * 2) - 1] ^= 0xff;

      expect(validateIsoImage(image)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: `${codePrefix}.${field.code}.endian_mismatch`,
            message: expect.stringContaining(`${label} descriptor ${field.fieldLabel} must store matching little- and big-endian values`),
          }),
          expect.objectContaining({
            code: "descriptor.sequence",
            message: expect.stringMatching(/both-endian uint(16|32) mismatch/i),
          }),
        ]),
      );
    }
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      codePrefix: "supplementary",
      identifierByte: 1,
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      codePrefix: "enhanced",
      identifierByte: 1,
    },
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      codePrefix: "supplementary",
      identifierByte: ".".charCodeAt(0),
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      codePrefix: "enhanced",
      identifierByte: ".".charCodeAt(0),
    },
  ])("reports $kind descriptor root directory record identifier byte $identifierByte mismatches", ({ options, codePrefix, identifierByte }) => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "secondary root identifier\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const descriptorOffset = 17 * SECTOR_SIZE;
    image[descriptorOffset + 156 + 33] = identifierByte;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: `${codePrefix}.root_directory_record.identifier`,
          path: ".",
          message: `${codePrefix} volume descriptor root directory record must use identifier 0`,
        }),
      ]),
    );
  });

  test("reports primary descriptor file references missing from the root directory", () => {
    const image = createIsoImage([{ path: "COPY.TXT", data: "root reference\n" }], {
      publisherIdentifier: "_MISSING.TXT;1",
      copyrightFileIdentifier: "COPY.TXT",
      abstractFileIdentifier: "ABSENT.TXT",
      bibliographicFileIdentifier: "BIBLIO.TXT",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    expect(parseIsoImage(image).primaryVolumeDescriptor).toMatchObject({
      publisherIdentifier: "_MISSING.TXT;1",
      copyrightFileIdentifier: "COPY.TXT;1",
      abstractFileIdentifier: "ABSENT.TXT;1",
      bibliographicFileIdentifier: "BIBLIO.TXT;1",
    });
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.publisher_identifier.file_reference",
          message: expect.stringMatching(/publisher identifier references MISSING\.TXT;1.*root directory/i),
        }),
        expect.objectContaining({
          code: "pvd.abstract_file_identifier.file_reference",
          message: expect.stringMatching(/abstract file identifier references ABSENT\.TXT;1.*root directory/i),
        }),
        expect.objectContaining({
          code: "pvd.bibliographic_file_identifier.file_reference",
          message: expect.stringMatching(/bibliographic file identifier references BIBLIO\.TXT;1.*root directory/i),
        }),
      ]),
    );
  });

  test("accepts descriptor file references that resolve to root directory files", () => {
    const image = createIsoImage([
      { path: "COPY.TXT", data: "copyright\n" },
      { path: "PUB.TXT", data: "publisher\n" },
      { path: "PREP.TXT", data: "preparer\n" },
      { path: "APP.TXT", data: "application\n" },
    ], {
      publisherIdentifier: "_PUB.TXT;1",
      dataPreparerIdentifier: "_PREP.TXT;1",
      applicationIdentifier: "_APP.TXT;1",
      copyrightFileIdentifier: "COPY.TXT",
      abstractFileIdentifier: "",
      bibliographicFileIdentifier: "",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    expect(validateIsoImage(image)).toEqual([]);
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP", escapeSequences: Uint8Array.of(0x25, 0x2f, 0x40) }] },
      codePrefix: "supplementary",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH", escapeSequences: Uint8Array.of(0x25, 0x2f, 0x45) }] },
      codePrefix: "enhanced",
    },
  ])("reports $kind escape sequence bytes after zero padding", ({ options, codePrefix }) => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "escape sequence padding\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const secondaryDescriptorOffset = 17 * SECTOR_SIZE;
    image[secondaryDescriptorOffset + 91] = 0;
    image[secondaryDescriptorOffset + 92] = 0x41;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: `${codePrefix}.escape_sequences.padding`,
          message: expect.stringMatching(/zero after the last escape sequence byte/i),
        }),
      ]),
    );
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      codePrefix: "supplementary",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      codePrefix: "enhanced",
    },
  ])("reports $kind escape sequence fields that start after BP 89", ({ options, codePrefix }) => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "escape sequence start\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const secondaryDescriptorOffset = 17 * SECTOR_SIZE;
    image[secondaryDescriptorOffset + 88] = 0;
    image[secondaryDescriptorOffset + 89] = 0x25;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: `${codePrefix}.escape_sequences.start`,
          message: expect.stringMatching(/must start at BP 89/i),
        }),
      ]),
    );
  });

  test.each([
    { kind: "supplementary", options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] } },
    { kind: "enhanced", options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] } },
  ])("accepts all-zero $kind escape sequence fields", ({ options }) => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "zero escape sequence field\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const secondaryDescriptorOffset = 17 * SECTOR_SIZE;

    expect(image.subarray(secondaryDescriptorOffset + 88, secondaryDescriptorOffset + 120).every((byte) => byte === 0)).toBe(true);
    expect(validateIsoImage(image)).toEqual([]);
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      codePrefix: "supplementary",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      codePrefix: "enhanced",
    },
  ])("reports invalid $kind descriptor character fields", ({ options, codePrefix }) => {
    const fields = [
      { offset: 8, code: "system_identifier.characters", label: "system identifier", byte: 0x7b },
      { offset: 40, code: "volume_identifier.characters", label: "volume identifier", byte: 0x7b },
      { offset: 190, code: "volume_set_identifier.characters", label: "volume set identifier", byte: 0x7b },
      { offset: 318, code: "publisher_identifier.characters", label: "publisher identifier", byte: 0x7b },
      { offset: 446, code: "data_preparer_identifier.characters", label: "data preparer identifier", byte: 0x7b },
      { offset: 574, code: "application_identifier.characters", label: "application identifier", byte: 0x7b },
      { offset: 702, code: "copyright_file_identifier.characters", label: "copyright file identifier", byte: 0x2a },
      { offset: 739, code: "abstract_file_identifier.characters", label: "abstract file identifier", byte: 0x2a },
      { offset: 776, code: "bibliographic_file_identifier.characters", label: "bibliographic file identifier", byte: 0x2a },
    ];

    for (const field of fields) {
      const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "secondary descriptor characters\n" }], {
        volumeIdentifier: "VALIDATION",
        ...options,
        createdAt: new Date("2024-01-01T00:00:00Z"),
      });
      const secondaryDescriptorOffset = 17 * SECTOR_SIZE;
      image[secondaryDescriptorOffset + field.offset] = field.byte;

      expect(validateIsoImage(image)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: `${codePrefix}.${field.code}`,
            message: expect.stringMatching(new RegExp(`${field.label} contains invalid ECMA-119`, "i")),
          }),
        ]),
      );
    }
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP", abstractFileIdentifier: "SUPABS.TXT" }] },
      codePrefix: "supplementary",
      code: "abstract_file_identifier.file_reference",
      reference: "SUPABS.TXT;1",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH", applicationIdentifier: "_ENHAPP.TXT;1" }] },
      codePrefix: "enhanced",
      code: "application_identifier.file_reference",
      reference: "ENHAPP.TXT;1",
    },
  ])("reports $kind descriptor file references missing from the root directory", ({ options, codePrefix, code, reference }) => {
    const image = createIsoImage([{ path: "COPY.TXT", data: "secondary descriptor file references\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: `${codePrefix}.${code}`,
          message: expect.stringMatching(new RegExp(`${reference}.*root directory`, "i")),
        }),
      ]),
    );
  });

  test("reports enhanced path table parent issues", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const enhancedDescriptorOffset = 17 * SECTOR_SIZE;
    const pathTableOffset = readUint32LE(image, enhancedDescriptorOffset + 140) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childParentDirectoryNumberOffset = pathTableOffset + rootPathTableRecordLength + 6;
    image[childParentDirectoryNumberOffset] = 2;
    image[childParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "enhanced_path_table.little.parent",
          message: expect.stringMatching(/parent/i),
        }),
      ]),
    );
  });

  test("reports zero enhanced path table parent directory numbers as range issues", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "enhanced parent zero\n" }], {
      volumeIdentifier: "VALIDATION",
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENHANCED",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const enhancedDescriptorOffset = 17 * SECTOR_SIZE;
    const littlePathTableOffset = readUint32LE(image, enhancedDescriptorOffset + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, enhancedDescriptorOffset + 148) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    const childLittleParentDirectoryNumberOffset = littlePathTableOffset + rootPathTableRecordLength + 6;
    const childBigParentDirectoryNumberOffset = bigPathTableOffset + rootPathTableRecordLength + 6;
    image[childLittleParentDirectoryNumberOffset] = 0;
    image[childLittleParentDirectoryNumberOffset + 1] = 0;
    image[childBigParentDirectoryNumberOffset] = 0;
    image[childBigParentDirectoryNumberOffset + 1] = 0;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "enhanced_path_table.little.parent_directory_number.range",
          message: expect.stringMatching(/record 2 parent directory number must be at least 1/i),
        }),
        expect.objectContaining({
          code: "enhanced_path_table.big.parent_directory_number.range",
          message: expect.stringMatching(/record 2 parent directory number must be at least 1/i),
        }),
      ]),
    );
  });

  test.each([
    {
      kind: "supplementary",
      descriptorOffset: 17 * SECTOR_SIZE,
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      path: "supplementary:.",
      size: 0,
    },
    {
      kind: "supplementary",
      descriptorOffset: 17 * SECTOR_SIZE,
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      path: "supplementary:.",
      size: SECTOR_SIZE - 1,
    },
    {
      kind: "enhanced",
      descriptorOffset: 17 * SECTOR_SIZE,
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      path: "enhanced:.",
      size: 0,
    },
    {
      kind: "enhanced",
      descriptorOffset: 17 * SECTOR_SIZE,
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      path: "enhanced:.",
      size: SECTOR_SIZE - 1,
    },
  ])("reports $kind root directory data lengths of $size", ({ descriptorOffset, options, path, size }) => {
    const image = createIsoImage([{ path: "README.TXT", data: "secondary root alignment\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const rootDirectoryOffset = readBothEndianUint32(image, descriptorOffset + 156 + 2) * SECTOR_SIZE;
    writeUint32Both(image, descriptorOffset + 156 + 10, size);
    writeUint32Both(image, rootDirectoryOffset + 10, size);
    writeUint32Both(image, rootDirectoryOffset + image[rootDirectoryOffset]! + 10, size);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.data_length_alignment",
          path,
          message: `directory data length at ${path} must be a positive multiple of the logical block size`,
        }),
      ]),
    );
  });

  test("reports directory record issues inside supplementary hierarchies", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const supplementaryRootRecordOffset = supplementaryDescriptorOffset + 156;
    const supplementaryRootExtent = readBothEndianUint32(image, supplementaryRootRecordOffset + 2);
    const supplementaryRootSize = readBothEndianUint32(image, supplementaryRootRecordOffset + 10);
    const dirRecordOffset = findDirectoryRecordOffset(image, supplementaryRootExtent * SECTOR_SIZE, supplementaryRootSize, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirSize = readBothEndianUint32(image, dirRecordOffset + 10);
    const fileRecordOffset = findDirectoryRecordOffset(image, dirExtent * SECTOR_SIZE, dirSize, "FILE.TXT;1");
    image[fileRecordOffset + 25] = 0x20;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.file_flags_reserved",
          path: "supplementary:./DIR",
          message: expect.stringMatching(/reserved/i),
        }),
      ]),
    );
  });

  test.each([
    {
      kind: "supplementary",
      descriptorOffset: 17 * SECTOR_SIZE,
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      expectedPathPrefix: "supplementary:./DIR",
    },
    {
      kind: "enhanced",
      descriptorOffset: 17 * SECTOR_SIZE,
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      expectedPathPrefix: "enhanced:./DIR",
    },
  ])("reports special child identifiers inside $kind hierarchies", ({ descriptorOffset, options, expectedPathPrefix }) => {
    for (const specialIdentifier of [0, 1]) {
      const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "special child identifier\n" }], {
        volumeIdentifier: "VALIDATION",
        ...options,
        createdAt: new Date("2024-01-01T00:00:00Z"),
      });
      const recordOffset = findDirectoryRecordOffsetByPath(
        image,
        ["DIR", "FILE.TXT;1"],
        descriptorOffset + 156,
      );
      image[recordOffset + 32] = 1;
      image[recordOffset + 33] = specialIdentifier;
      image[recordOffset + 34] = 0;

      expect(validateIsoImage(image)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "directory.record_identifier.special",
            path: specialIdentifier === 0 ? `${expectedPathPrefix}/.` : `${expectedPathPrefix}/..`,
            message: expect.stringMatching(new RegExp(`special identifier ${specialIdentifier}`)),
          }),
        ]),
      );
    }
  });

  test("reports supplementary directory parent record extent mismatches", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "supp dotdot\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    const supplementaryRootExtent = readBothEndianUint32(image, supplementaryDescriptorOffset + 156 + 2);
    const supplementaryRootSize = readBothEndianUint32(image, supplementaryDescriptorOffset + 156 + 10);
    const dirRecordOffset = findDirectoryRecordOffset(image, supplementaryRootExtent * SECTOR_SIZE, supplementaryRootSize, "DIR");
    const dirExtent = readBothEndianUint32(image, dirRecordOffset + 2);
    const dirDirectoryOffset = dirExtent * SECTOR_SIZE;
    const parentRecordOffset = dirDirectoryOffset + image[dirDirectoryOffset]!;
    writeUint32Both(image, parentRecordOffset + 2, dirExtent);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.parent_record.extent",
          path: "supplementary:./DIR",
          message: expect.stringMatching(/parent directory extent fields/i),
        }),
      ]),
    );
  });

  test("accepts supplementary volume set sizes larger than one when records stay on the local volume", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    writeUint16Both(image, supplementaryDescriptorOffset + 120, 2);

    expect(validateIsoImage(image)).toEqual([]);
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      codePrefix: "supplementary",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      codePrefix: "enhanced",
    },
  ])("reports $kind volume space sizes that exceed the image length", ({ options, codePrefix }) => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "secondary volume space\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const secondaryDescriptorOffset = 17 * SECTOR_SIZE;
    writeUint32Both(image, secondaryDescriptorOffset + 80, image.length / SECTOR_SIZE + 1);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: `${codePrefix}.volume_space_size`,
          message: `${codePrefix} volume space size exceeds image length`,
        }),
      ]),
    );
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      codePrefix: "supplementary",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      codePrefix: "enhanced",
    },
  ])("reports $kind volume space sizes smaller than referenced sectors", ({ options, codePrefix }) => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "secondary volume lower bound\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const secondaryDescriptorOffset = 17 * SECTOR_SIZE;
    writeUint32Both(image, secondaryDescriptorOffset + 80, 17);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: `${codePrefix}.volume_space_size.lower_bound`,
          message: expect.stringMatching(new RegExp(`^${codePrefix} volume space size 17 is smaller than referenced sector end`, "i")),
        }),
      ]),
    );
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      codePrefix: "supplementary",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      codePrefix: "enhanced",
    },
  ])("reports zero $kind volume set sizes as range issues", ({ options, codePrefix }) => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "secondary zero set\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const secondaryDescriptorOffset = 17 * SECTOR_SIZE;
    writeUint16Both(image, secondaryDescriptorOffset + 120, 0);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: `${codePrefix}.volume_set_size.range`,
          message: `${codePrefix} volume descriptor volume set size must be at least 1`,
        }),
      ]),
    );
  });

  test.each([
    {
      kind: "supplementary",
      options: { supplementaryVolumeDescriptors: [{ volumeIdentifier: "SUPP" }] },
      codePrefix: "supplementary",
    },
    {
      kind: "enhanced",
      options: { enhancedVolumeDescriptors: [{ volumeIdentifier: "ENH" }] },
      codePrefix: "enhanced",
    },
  ])("reports zero $kind volume sequence numbers as range issues", ({ options, codePrefix }) => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "secondary zero sequence\n" }], {
      volumeIdentifier: "VALIDATION",
      ...options,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const secondaryDescriptorOffset = 17 * SECTOR_SIZE;
    writeUint16Both(image, secondaryDescriptorOffset + 124, 0);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: `${codePrefix}.volume_sequence_number.range`,
          message: `${codePrefix} volume descriptor volume sequence number must be at least 1`,
        }),
      ]),
    );
  });

  test("reports supplementary volume sequence numbers greater than the volume set size", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    writeUint16Both(image, supplementaryDescriptorOffset + 124, 2);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary.volume_sequence_number.bounds",
          message: "supplementary volume descriptor volume sequence number must be less than or equal to volume set size",
        }),
      ]),
    );
  });

  test("reports enhanced volume sequence numbers greater than the volume set size", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      enhancedVolumeDescriptors: [{
        volumeIdentifier: "ENH",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const enhancedDescriptorOffset = 17 * SECTOR_SIZE;
    writeUint16Both(image, enhancedDescriptorOffset + 124, 2);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "enhanced.volume_sequence_number.bounds",
          message: "enhanced volume descriptor volume sequence number must be less than or equal to volume set size",
        }),
      ]),
    );
  });
});

function baselineImage(files = [{ path: "README.TXT", data: "hello ecma-119\n" }]): Uint8Array {
  return createIsoImage(files, {
    volumeIdentifier: "VALIDATION",
    createdAt: new Date("2024-01-01T00:00:00Z"),
  });
}

function rootDirectoryExtent(image: Uint8Array): number {
  return rootDirectoryExtentAt(image, PVD_OFFSET);
}

function rootDirectoryExtentAt(image: Uint8Array, descriptorOffset: number): number {
  return readBothEndianUint32(image, descriptorOffset + 156 + 2);
}

function rootDirectorySizeAt(image: Uint8Array, descriptorOffset: number): number {
  return readBothEndianUint32(image, descriptorOffset + 156 + 10);
}

function descriptorVolumeSpaceSize(image: Uint8Array, descriptorOffset: number): number {
  return readBothEndianUint32(image, descriptorOffset + 80);
}

function setDescriptorVolumeSpaceSize(image: Uint8Array, descriptorOffset: number, size: number): void {
  writeUint32Both(image, descriptorOffset + 80, size);
}

function setRootDirectorySize(image: Uint8Array, size: number): void {
  writeUint32Both(image, PVD_OFFSET + 156 + 10, size);
}

function setPrimaryVolumeSpaceSize(image: Uint8Array, size: number): void {
  writeUint32Both(image, PVD_OFFSET + 80, size);
}

function withOptionalPathTableCopy(
  image: Uint8Array,
  descriptorOffset: number,
  endian: "little" | "big",
  mutate: (image: Uint8Array, optionalPathTableOffset: number) => void,
): Uint8Array {
  const optionalSector = image.byteLength / SECTOR_SIZE;
  const result = new Uint8Array(image.byteLength + SECTOR_SIZE);
  result.set(image);

  const pathTableSize = readBothEndianUint32(result, descriptorOffset + 132);
  const mandatoryLocation = endian === "little"
    ? readUint32LE(result, descriptorOffset + 140)
    : readUint32BE(result, descriptorOffset + 148);
  const mandatoryPathTableOffset = mandatoryLocation * SECTOR_SIZE;
  const optionalPathTableOffset = optionalSector * SECTOR_SIZE;
  result.set(result.subarray(mandatoryPathTableOffset, mandatoryPathTableOffset + pathTableSize), optionalPathTableOffset);

  if (endian === "little") {
    writeUint32LE(result, descriptorOffset + 144, optionalSector);
  } else {
    writeUint32BE(result, descriptorOffset + 152, optionalSector);
  }

  const requiredVolumeSpaceSize = optionalSector + Math.ceil(pathTableSize / SECTOR_SIZE);
  setDescriptorVolumeSpaceSize(result, PVD_OFFSET, Math.max(descriptorVolumeSpaceSize(result, PVD_OFFSET), requiredVolumeSpaceSize));
  if (descriptorOffset !== PVD_OFFSET) {
    setDescriptorVolumeSpaceSize(result, descriptorOffset, Math.max(descriptorVolumeSpaceSize(result, descriptorOffset), requiredVolumeSpaceSize));
  }

  mutate(result, optionalPathTableOffset);
  return result;
}

function withDescriptorRootExtendedAttributeRecord(image: Uint8Array, descriptorOffset: number, extendedAttributeRecord: Uint8Array): Uint8Array {
  const rootExtent = rootDirectoryExtentAt(image, descriptorOffset);
  const rootSize = rootDirectorySizeAt(image, descriptorOffset);
  const rootDirectory = image.slice(rootExtent * SECTOR_SIZE, rootExtent * SECTOR_SIZE + rootSize);
  const oldSectorCount = image.byteLength / SECTOR_SIZE;
  const newRootExtent = oldSectorCount;
  const result = new Uint8Array(image.byteLength + 2 * SECTOR_SIZE);
  result.set(image);
  result.set(extendedAttributeRecord.subarray(0, SECTOR_SIZE), newRootExtent * SECTOR_SIZE);
  result.set(rootDirectory, (newRootExtent + 1) * SECTOR_SIZE);

  setDescriptorVolumeSpaceSize(result, PVD_OFFSET, Math.max(descriptorVolumeSpaceSize(result, PVD_OFFSET), oldSectorCount + 2));
  setDescriptorVolumeSpaceSize(result, descriptorOffset, Math.max(descriptorVolumeSpaceSize(result, descriptorOffset), oldSectorCount + 2));
  writeDirectoryRecordExtentFields(result, descriptorOffset + 156, newRootExtent, 1);
  const littlePathTableOffset = readUint32LE(result, descriptorOffset + 140) * SECTOR_SIZE;
  const bigPathTableOffset = readUint32BE(result, descriptorOffset + 148) * SECTOR_SIZE;
  result[littlePathTableOffset + 1] = 1;
  writeUint32LE(result, littlePathTableOffset + 2, newRootExtent);
  result[bigPathTableOffset + 1] = 1;
  writeUint32BE(result, bigPathTableOffset + 2, newRootExtent);

  const rootDirectoryOffset = (newRootExtent + 1) * SECTOR_SIZE;
  const parentRecordOffset = rootDirectoryOffset + result[rootDirectoryOffset]!;
  writeDirectoryRecordExtentFields(result, rootDirectoryOffset, newRootExtent, 1);
  writeDirectoryRecordExtentFields(result, parentRecordOffset, newRootExtent, 1);
  return result;
}

function withInterleavedPrimaryRootDirectory(image: Uint8Array, fileUnitSize: number, interleaveGapSize: number): Uint8Array {
  const rootExtent = rootDirectoryExtent(image);
  const rootSize = rootDirectorySizeAt(image, PVD_OFFSET);
  const rootDirectory = image.slice(rootExtent * SECTOR_SIZE, rootExtent * SECTOR_SIZE + rootSize);
  const oldSectorCount = image.byteLength / SECTOR_SIZE;
  const newRootExtent = oldSectorCount;
  const storageSectors = interleavedStorageSectors(rootSize, fileUnitSize, interleaveGapSize);
  const result = new Uint8Array(image.byteLength + storageSectors * SECTOR_SIZE);
  result.set(image);

  writeDirectoryRecordExtentFields(rootDirectory, 0, newRootExtent, 0);
  writeDirectoryRecordInterleaveFields(rootDirectory, 0, fileUnitSize, interleaveGapSize);
  const parentRecordOffset = rootDirectory[0]!;
  writeDirectoryRecordExtentFields(rootDirectory, parentRecordOffset, newRootExtent, 0);
  writeDirectoryRecordInterleaveFields(rootDirectory, parentRecordOffset, fileUnitSize, interleaveGapSize);
  writeInterleavedBytes(result, newRootExtent, rootDirectory, fileUnitSize, interleaveGapSize);

  writeDirectoryRecordExtentFields(result, PVD_OFFSET + 156, newRootExtent, 0);
  writeDirectoryRecordInterleaveFields(result, PVD_OFFSET + 156, fileUnitSize, interleaveGapSize);
  const littlePathTableOffset = readUint32LE(result, PVD_OFFSET + 140) * SECTOR_SIZE;
  const bigPathTableOffset = readUint32BE(result, PVD_OFFSET + 148) * SECTOR_SIZE;
  writeUint32LE(result, littlePathTableOffset + 2, newRootExtent);
  writeUint32BE(result, bigPathTableOffset + 2, newRootExtent);
  setPrimaryVolumeSpaceSize(result, newRootExtent + storageSectors);
  return result;
}

function writeDirectoryRecordExtentFields(image: Uint8Array, offset: number, extent: number, extendedAttributeRecordLength: number): void {
  image[offset + 1] = extendedAttributeRecordLength;
  writeUint32Both(image, offset + 2, extent);
}

function writeDirectoryRecordInterleaveFields(image: Uint8Array, offset: number, fileUnitSize: number, interleaveGapSize: number): void {
  image[offset + 26] = fileUnitSize;
  image[offset + 27] = interleaveGapSize;
}

function interleavedStorageSectors(byteLength: number, fileUnitSize: number, interleaveGapSize: number): number {
  const unitBytes = fileUnitSize * SECTOR_SIZE;
  const units = Math.ceil(byteLength / unitBytes);
  return units === 0 ? 0 : (units - 1) * (fileUnitSize + interleaveGapSize) + Math.ceil((byteLength - (units - 1) * unitBytes) / SECTOR_SIZE);
}

function writeInterleavedBytes(image: Uint8Array, extent: number, bytes: Uint8Array, fileUnitSize: number, interleaveGapSize: number): void {
  const unitBytes = fileUnitSize * SECTOR_SIZE;
  const strideBytes = (fileUnitSize + interleaveGapSize) * SECTOR_SIZE;
  let sourceOffset = 0;
  let targetOffset = extent * SECTOR_SIZE;
  while (sourceOffset < bytes.byteLength) {
    const chunk = Math.min(unitBytes, bytes.byteLength - sourceOffset);
    image.set(bytes.subarray(sourceOffset, sourceOffset + chunk), targetOffset);
    sourceOffset += chunk;
    targetOffset += strideBytes;
  }
}

function expectVolumeSpaceLowerBoundIssue(): ReturnType<typeof expect.objectContaining> {
  return expect.objectContaining({
    code: "pvd.volume_space_size.lower_bound",
    message: expect.stringMatching(/smaller than referenced sector end/i),
  });
}

function appendPrimaryPathTableRecord(image: Uint8Array, identifier: string, parentDirectoryNumber: number, extent: number, extendedAttributeRecordLength: number): void {
  const identifierBytes = new TextEncoder().encode(identifier);
  const currentSize = readBothEndianUint32(image, PVD_OFFSET + 132);
  const recordLength = 8 + identifierBytes.byteLength + (identifierBytes.byteLength % 2 === 0 ? 0 : 1);
  const littleOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE + currentSize;
  const bigOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE + currentSize;
  writePathTableRecord(image, littleOffset, "little", identifierBytes, parentDirectoryNumber, extent, extendedAttributeRecordLength);
  writePathTableRecord(image, bigOffset, "big", identifierBytes, parentDirectoryNumber, extent, extendedAttributeRecordLength);
  writeUint32Both(image, PVD_OFFSET + 132, currentSize + recordLength);
}

function writePathTableRecord(
  image: Uint8Array,
  offset: number,
  endian: "little" | "big",
  identifier: Uint8Array,
  parentDirectoryNumber: number,
  extent: number,
  extendedAttributeRecordLength: number,
): void {
  image[offset] = identifier.byteLength;
  image[offset + 1] = extendedAttributeRecordLength;
  if (endian === "little") {
    writeUint32LE(image, offset + 2, extent);
    image[offset + 6] = parentDirectoryNumber & 0xff;
    image[offset + 7] = (parentDirectoryNumber >>> 8) & 0xff;
  } else {
    writeUint32BE(image, offset + 2, extent);
    image[offset + 6] = (parentDirectoryNumber >>> 8) & 0xff;
    image[offset + 7] = parentDirectoryNumber & 0xff;
  }
  image.set(identifier, offset + 8);
}

function findDirectoryRecordOffset(image: Uint8Array, directoryOffset: number, directorySize: number, identifier: string): number {
  const expected = new TextEncoder().encode(identifier);
  let offset = directoryOffset;
  const end = directoryOffset + directorySize;
  while (offset < end) {
    const length = image[offset];
    if (length === 0) {
      offset = Math.ceil((offset - directoryOffset + 1) / SECTOR_SIZE) * SECTOR_SIZE + directoryOffset;
      continue;
    }
    const identifierLength = image[offset + 32];
    const actual = image.subarray(offset + 33, offset + 33 + identifierLength);
    if (bytesEqual(actual, expected)) {
      return offset;
    }
    offset += length;
  }
  throw new Error(`missing directory record ${identifier}`);
}

function directoryRecordIdentifiers(image: Uint8Array, directoryOffset: number, directorySize: number): string[] {
  const decoder = new TextDecoder("ascii");
  const identifiers: string[] = [];
  let offset = directoryOffset;
  const end = directoryOffset + directorySize;
  while (offset < end) {
    const length = image[offset];
    if (length === 0) {
      break;
    }
    const identifierLength = image[offset + 32]!;
    identifiers.push(decoder.decode(image.subarray(offset + 33, offset + 33 + identifierLength)));
    offset += length;
  }
  return identifiers;
}

function findDirectoryRecordOffsetByPath(image: Uint8Array, identifiers: string[], rootRecordOffset = PVD_OFFSET + 156): number {
  let directoryOffset = readBothEndianUint32(image, rootRecordOffset + 2) * SECTOR_SIZE;
  let directorySize = readBothEndianUint32(image, rootRecordOffset + 10);
  for (const [index, identifier] of identifiers.entries()) {
    const recordOffset = findDirectoryRecordOffset(image, directoryOffset, directorySize, identifier);
    if (index === identifiers.length - 1) {
      return recordOffset;
    }
    directoryOffset = readBothEndianUint32(image, recordOffset + 2) * SECTOR_SIZE;
    directorySize = readBothEndianUint32(image, recordOffset + 10);
  }
  throw new Error("directory path must contain at least one identifier");
}

function copyDirectoryRecordIdentifier(image: Uint8Array, sourceOffset: number, targetOffset: number): void {
  const sourceLength = image[sourceOffset + 32]!;
  const targetLength = image[targetOffset + 32]!;
  if (sourceLength !== targetLength) {
    throw new Error("directory record identifiers must have matching lengths");
  }
  image.set(image.subarray(sourceOffset + 33, sourceOffset + 33 + sourceLength), targetOffset + 33);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function swapBytes(bytes: Uint8Array, leftOffset: number, rightOffset: number, length: number): void {
  const left = bytes.slice(leftOffset, leftOffset + length);
  bytes.copyWithin(leftOffset, rightOffset, rightOffset + length);
  bytes.set(left, rightOffset);
}

function writeUint32Both(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
  bytes[offset + 4] = (value >>> 24) & 0xff;
  bytes[offset + 5] = (value >>> 16) & 0xff;
  bytes[offset + 6] = (value >>> 8) & 0xff;
  bytes[offset + 7] = value & 0xff;
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

function writeUint16Both(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
