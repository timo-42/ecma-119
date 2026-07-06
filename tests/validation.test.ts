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

  test("reports a bad descriptor version as a validation issue", () => {
    const image = baselineImage();
    image[PVD_OFFSET + 6] = 2;

    expect(validateIsoImage(image)).toEqual([
      expect.objectContaining({
        code: "descriptor.sequence",
        message: expect.stringMatching(/^expected primary volume descriptor version 1$/i),
      }),
    ]);
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
      "A;1",
      "A0.TXT;1",
      "A_.TXT;1",
    ]);
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

  test("reports primary path table directory identifiers outside Level 1 d-character rules", () => {
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
          message: expect.stringMatching(/Level 1 d-characters/i),
        }),
        expect.objectContaining({
          code: "path_table.big.identifier.characters",
          message: expect.stringMatching(/Level 1 d-characters/i),
        }),
      ]),
    );

    const tooLong = baselineImage([{ path: "DIR/FILE.TXT", data: "path table length\n" }]);
    appendPrimaryPathTableRecord(tooLong, "TOO_LONG1", 1, rootDirectoryExtent(tooLong), 0);
    expect(validateIsoImage(tooLong)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "path_table.little.identifier.characters",
          message: expect.stringMatching(/Level 1 d-characters/i),
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

  test("reports primary directory record identifiers outside Level 1 rules", () => {
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
          message: expect.stringMatching(/Level 1 d-characters/i),
        }),
        expect.objectContaining({
          code: "directory.file_identifier.characters",
          message: expect.stringMatching(/Level 1 file identifier/i),
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
          message: expect.stringMatching(/Level 1 file identifier/i),
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

  test("reports unsupported interleaved directory record fields without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "interleaved metadata\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    image[fileRecordOffset + 26] = 1;
    image[fileRecordOffset + 27] = 2;

    expect(() => parseIsoImage(image)).toThrow(/unsupported interleaved file section fields/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.interleaving_unsupported",
          path: "README.TXT",
          message: expect.stringMatching(/unsupported interleaved/i),
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

  test("reports unsupported interleaved descriptor root directory fields without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root interleaved metadata\n" }]);
    image[PVD_OFFSET + 156 + 26] = 1;
    image[PVD_OFFSET + 156 + 27] = 2;

    expect(() => parseIsoImage(image)).toThrow(/unsupported interleaved file section fields/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.interleaving_unsupported",
          path: ".",
          message: expect.stringMatching(/unsupported interleaved/i),
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

  test("reports unsupported multi-extent file records without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "multi extent flag\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    image[fileRecordOffset + 25] |= 0x80;

    expect(() => parseIsoImage(image)).toThrow(/unsupported multi-extent/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.multi_extent_unsupported",
          path: "README.TXT",
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

  test("reports unsupported primary volume set size without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "multi-volume descriptor\n" }]);
    writeUint16Both(image, PVD_OFFSET + 120, 2);

    expect(() => parseIsoImage(image)).toThrow(/unsupported multi-volume fields/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.single_volume_profile",
          message: "primary volume descriptor uses unsupported multi-volume fields",
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

  test("reports unsupported primary volume sequence number before path table parsing", () => {
    const image = baselineImage([{ path: "README.TXT", data: "multi-volume descriptor\n" }]);
    writeUint16Both(image, PVD_OFFSET + 124, 2);
    writeUint32Both(image, PVD_OFFSET + 140, 0xffff);

    expect(() => parseIsoImage(image)).toThrow(/^primary volume descriptor uses unsupported multi-volume fields$/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pvd.single_volume_profile",
          message: "primary volume descriptor uses unsupported multi-volume fields",
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

  test("reports unsupported descriptor root volume sequence numbers without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "root sequence\n" }]);
    writeUint16Both(image, PVD_OFFSET + 156 + 28, 2);

    expect(() => parseIsoImage(image)).toThrow(/unsupported volume sequence number 2/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.volume_sequence_unsupported",
          path: ".",
          message: expect.stringMatching(/volume sequence number 2/i),
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

  test("reports unsupported child directory record volume sequence numbers without duplicate parse issues", () => {
    const image = baselineImage([{ path: "README.TXT", data: "child sequence\n" }]);
    const rootDirectoryOffset = rootDirectoryExtent(image) * SECTOR_SIZE;
    const fileRecordOffset = findDirectoryRecordOffset(image, rootDirectoryOffset, SECTOR_SIZE, "README.TXT;1");
    writeUint16Both(image, fileRecordOffset + 28, 2);

    expect(() => parseIsoImage(image)).toThrow(/unsupported volume sequence number 2/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "directory.volume_sequence_unsupported",
          path: "README.TXT",
          message: expect.stringMatching(/volume sequence number 2/i),
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

  test("reports unsupported supplementary volume set size", () => {
    const image = createIsoImage([{ path: "DIR/FILE.TXT", data: "nested\n" }], {
      volumeIdentifier: "VALIDATION",
      supplementaryVolumeDescriptors: [{
        volumeIdentifier: "SUPP",
      }],
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const supplementaryDescriptorOffset = 17 * SECTOR_SIZE;
    writeUint16Both(image, supplementaryDescriptorOffset + 120, 2);

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "supplementary.single_volume_profile",
          message: "supplementary volume descriptor uses unsupported multi-volume fields",
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

  test("reports unsupported supplementary volume sequence number", () => {
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
          code: "supplementary.single_volume_profile",
          message: "supplementary volume descriptor uses unsupported multi-volume fields",
        }),
      ]),
    );
  });

  test("reports unsupported enhanced volume sequence number", () => {
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
          code: "enhanced.single_volume_profile",
          message: "enhanced volume descriptor uses unsupported multi-volume fields",
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

function writeDirectoryRecordExtentFields(image: Uint8Array, offset: number, extent: number, extendedAttributeRecordLength: number): void {
  image[offset + 1] = extendedAttributeRecordLength;
  writeUint32Both(image, offset + 2, extent);
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
