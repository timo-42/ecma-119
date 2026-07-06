import { describe, expect, test } from "vitest";

import { createIsoImage, parseIsoImage, parseVolumeDescriptors, validateIsoImage, type VolumePartitionDescriptor } from "../src/index";
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
    const littlePathTableOffset = readUint32LE(image, PVD_OFFSET + 140) * SECTOR_SIZE;
    const bigPathTableOffset = readUint32BE(image, PVD_OFFSET + 148) * SECTOR_SIZE;
    const rootPathTableRecordLength = 10;
    image[littlePathTableOffset + rootPathTableRecordLength] = 0;
    image[bigPathTableOffset + rootPathTableRecordLength] = 0;

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

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/director|record/i),
          message: expect.stringMatching(/malformed|length|identifier|record/i),
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
  return readBothEndianUint32(image, PVD_OFFSET + 156 + 2);
}

function setRootDirectorySize(image: Uint8Array, size: number): void {
  writeUint32Both(image, PVD_OFFSET + 156 + 10, size);
}

function setPrimaryVolumeSpaceSize(image: Uint8Array, size: number): void {
  writeUint32Both(image, PVD_OFFSET + 80, size);
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
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
