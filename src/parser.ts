import { decodeVolumeDate, readAscii, readAsciiTrimmed, readUint16Both, readUint32Both, sectorOffset } from "./binary.js";
import { decodeDirectoryRecord, FILE_FLAG_DIRECTORY, FILE_FLAG_MULTI_EXTENT, type DecodedDirectoryRecord } from "./directory-record.js";
import { decodeExtendedAttributeRecord, extendedAttributeRecordFileFlags } from "./extended-attribute-record.js";
import { decodeFileIdentifier, stripVersion } from "./identifiers.js";
import { decodePathTable, type PathTableRecord } from "./path-table.js";
import {
  type IsoDirectoryEntry,
  type IsoFileEntry,
  type IsoImage,
  type IsoNode,
  type EnhancedVolumeDescriptor,
  type PrimaryVolumeDescriptor,
  type SupplementaryVolumeDescriptor,
  type VolumeDescriptor,
  type VolumePartitionDescriptor,
  SECTOR_SIZE,
  STANDARD_IDENTIFIER,
  SYSTEM_AREA_SECTORS,
  type ValidationIssue,
} from "./types.js";

export function parseIsoImage(imageInput: Uint8Array | ArrayBuffer, options: { includeData?: boolean } = {}): IsoImage {
  const image = imageInput instanceof Uint8Array ? imageInput : new Uint8Array(imageInput);
  const descriptors = parseVolumeDescriptors(image);
  const pvd = descriptors.find((descriptor): descriptor is PrimaryVolumeDescriptor => descriptor.type === 1);
  if (!pvd) {
    throw new Error("missing primary volume descriptor");
  }
  assertSingleVolumeDescriptor(pvd, "primary volume descriptor");
  validatePrimaryDescriptorReferences(image, pvd);
  assertSupportedDirectoryEntry(pvd.rootDirectoryRecord, ".");
  const includeData = options.includeData ?? true;
  const populatedDescriptors = descriptors.map((descriptor) => populateDescriptorDirectoryTree(image, descriptor, includeData));
  const primaryVolumeDescriptor = populatedDescriptors.find((descriptor): descriptor is PrimaryVolumeDescriptor => descriptor.type === 1);
  if (!primaryVolumeDescriptor) {
    throw new Error("missing primary volume descriptor");
  }
  const root = primaryVolumeDescriptor.rootDirectoryRecord;
  return {
    descriptors: populatedDescriptors,
    primaryVolumeDescriptor,
    root,
    files: collectParsedFiles(root),
  };
}

export function validateIsoImage(imageInput: Uint8Array | ArrayBuffer): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const image = imageInput instanceof Uint8Array ? imageInput : new Uint8Array(imageInput);
  if (image.byteLength % SECTOR_SIZE !== 0) {
    issues.push({ code: "image.sector_alignment", message: "image length must be a multiple of 2048 bytes" });
  }
  let descriptors: VolumeDescriptor[] = [];
  let descriptorSequenceFailed = false;
  try {
    descriptors = parseVolumeDescriptors(image);
    const terminator = descriptors.find((descriptor) => descriptor.kind === "terminator");
    if (terminator && !allZero(terminator.raw.subarray(7))) {
      issues.push({ code: "descriptor.terminator_reserved", message: "volume descriptor set terminator reserved bytes must be zero" });
    }
    const pvd = descriptors.find((descriptor): descriptor is PrimaryVolumeDescriptor => descriptor.type === 1);
    if (!pvd) {
      issues.push({ code: "descriptor.primary_missing", message: "primary volume descriptor is required" });
    } else {
      issues.push(...validatePrimaryVolumeDescriptor(image, pvd, descriptors));
      issues.push(...validateDirectoryHierarchy(image, pvd.rootDirectoryRecord, pvd.rootDirectoryRecord, ".", new Set()));
      for (const descriptor of descriptors) {
        if (descriptor.kind === "supplementary" || descriptor.kind === "enhanced") {
          issues.push(...validateSupplementaryLikeVolumeDescriptor(image, descriptor));
        }
      }
      issues.push(...validateVolumePartitionDescriptors(image, descriptors, pvd));
    }
  } catch (error) {
    descriptorSequenceFailed = true;
    issues.push({ code: "descriptor.sequence", message: error instanceof Error ? error.message : String(error) });
  }
  if (!descriptorSequenceFailed) {
    try {
      parseIsoImage(image, { includeData: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!hasTargetedIssueForParseFailure(issues, message)) {
        issues.push({ code: "image.parse", message });
      }
    }
  }
  return dedupeIssues(issues);
}

export function parseVolumeDescriptors(imageInput: Uint8Array | ArrayBuffer): VolumeDescriptor[] {
  const image = imageInput instanceof Uint8Array ? imageInput : new Uint8Array(imageInput);
  const descriptors: VolumeDescriptor[] = [];
  let sector = SYSTEM_AREA_SECTORS;

  while (sectorOffset(sector + 1) <= image.byteLength) {
    const offset = sectorOffset(sector);
    let descriptor: VolumeDescriptor;
    try {
      descriptor = parseVolumeDescriptorAt(image, offset, sector);
    } catch (error) {
      if (allZero(image.subarray(offset, offset + SECTOR_SIZE))) {
        throw new Error(`missing volume descriptor set terminator before sector ${sector}`);
      }
      throw error;
    }
    descriptors.push(descriptor);
    if (descriptor.type === 255) {
      return descriptors;
    }
    sector += 1;
  }

  throw new Error("missing volume descriptor set terminator");
}

function parseVolumeDescriptorAt(image: Uint8Array, offset: number, sector: number): VolumeDescriptor {
  const type = image[offset]!;
  const version = image[offset + 6]!;
  assertDescriptorHeader(image, offset);
  switch (type) {
    case 0:
      assertDescriptorVersion(version, [1], "boot record");
      return {
        ...baseDescriptor(image, offset, sector, "boot"),
        type: 0,
        kind: "boot",
        bootSystemIdentifier: readAsciiTrimmed(image, offset + 7, 32),
        bootIdentifier: readAsciiTrimmed(image, offset + 39, 32),
        bootSystemUse: image.slice(offset + 71, offset + SECTOR_SIZE),
      };
    case 1:
      assertDescriptorVersion(version, [1], "primary volume descriptor");
      return parsePrimaryVolumeDescriptor(image, offset, sector);
    case 2:
      assertDescriptorVersion(version, [1, 2], "supplementary or enhanced volume descriptor");
      return parseSupplementaryLikeDescriptor(image, offset, sector);
    case 3:
      assertDescriptorVersion(version, [1], "volume partition descriptor");
      return parsePartitionDescriptor(image, offset, sector);
    case 255:
      assertDescriptorVersion(version, [1], "volume descriptor set terminator");
      return {
        ...baseDescriptor(image, offset, sector, "terminator"),
        type: 255,
        kind: "terminator",
      };
    default:
      return {
        ...baseDescriptor(image, offset, sector, "unknown"),
        kind: "unknown",
      };
  }
}

function parsePrimaryVolumeDescriptor(image: Uint8Array, offset: number, sector: number): PrimaryVolumeDescriptor {
  const rootRecord = decodeDirectoryRecord(image, offset + 156, offset + 190);
  const pvd: PrimaryVolumeDescriptor = {
    type: 1,
    kind: "primary",
    identifier: STANDARD_IDENTIFIER,
    version: image[offset + 6]!,
    offset,
    sector,
    raw: image.slice(offset, offset + SECTOR_SIZE),
    systemIdentifier: readAsciiTrimmed(image, offset + 8, 32),
    volumeIdentifier: readAsciiTrimmed(image, offset + 40, 32),
    volumeSpaceSize: readUint32Both(image, offset + 80),
    volumeSetSize: readUint16Both(image, offset + 120),
    volumeSequenceNumber: readUint16Both(image, offset + 124),
    logicalBlockSize: readUint16Both(image, offset + 128),
    pathTableSize: readUint32Both(image, offset + 132),
    typeLPathTableLocation: readUint32LEAt(image, offset + 140),
    optionalTypeLPathTableLocation: readUint32LEAt(image, offset + 144),
    typeMPathTableLocation: readUint32BEAt(image, offset + 148),
    optionalTypeMPathTableLocation: readUint32BEAt(image, offset + 152),
    rootDirectoryRecord: directoryEntryFromRecord(rootRecord, "", []),
    volumeSetIdentifier: readAsciiTrimmed(image, offset + 190, 128),
    publisherIdentifier: readAsciiTrimmed(image, offset + 318, 128),
    dataPreparerIdentifier: readAsciiTrimmed(image, offset + 446, 128),
    applicationIdentifier: readAsciiTrimmed(image, offset + 574, 128),
    copyrightFileIdentifier: readAsciiTrimmed(image, offset + 702, 37),
    abstractFileIdentifier: readAsciiTrimmed(image, offset + 739, 37),
    bibliographicFileIdentifier: readAsciiTrimmed(image, offset + 776, 37),
    fileStructureVersion: image[offset + 881]!,
    applicationUse: image.slice(offset + 883, offset + 1395),
    createdAt: decodeVolumeDate(image, offset + 813),
    modifiedAt: decodeVolumeDate(image, offset + 830),
    expiresAt: decodeVolumeDate(image, offset + 847),
    effectiveAt: decodeVolumeDate(image, offset + 864),
  };
  return pvd;
}

function validatePrimaryDescriptorReferences(image: Uint8Array, pvd: PrimaryVolumeDescriptor): void {
  const pathTableStart = pvd.typeLPathTableLocation * SECTOR_SIZE;
  const pathTableEnd = pathTableStart + pvd.pathTableSize;
  if (pathTableStart < 0 || pathTableEnd > image.byteLength) {
    throw new Error("primary volume descriptor path table extent is out of bounds");
  }
  decodePathTable(image.subarray(pathTableStart, pathTableEnd), "little");
}

function validatePrimaryVolumeDescriptor(image: Uint8Array, pvd: PrimaryVolumeDescriptor, descriptors: VolumeDescriptor[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(...validateZeroDescriptorRanges(pvd, "pvd", [
    { start: 7, end: 8, code: "unused", label: "unused field at BP 8" },
    { start: 72, end: 80, code: "unused", label: "unused field at BP 73 to 80" },
    { start: 88, end: 120, code: "unused", label: "unused field at BP 89 to 120" },
    { start: 882, end: 883, code: "unused", label: "unused field at BP 883" },
    { start: 1395, end: SECTOR_SIZE, code: "reserved", label: "reserved field at BP 1396 to 2048" },
  ]));
  if (pvd.logicalBlockSize !== SECTOR_SIZE) {
    issues.push({ code: "pvd.logical_block_size", message: "logical block size must be 2048 for the supported profile" });
  }
  if (pvd.volumeSpaceSize * SECTOR_SIZE > image.byteLength) {
    issues.push({ code: "pvd.volume_space_size", message: "volume space size exceeds image length" });
  }
  const minimumVolumeSpaceSize = minimumReferencedVolumeSpaceSize(image, descriptors);
  if (Number.isFinite(minimumVolumeSpaceSize) && pvd.volumeSpaceSize < minimumVolumeSpaceSize) {
    issues.push({
      code: "pvd.volume_space_size.lower_bound",
      message: `volume space size ${pvd.volumeSpaceSize} is smaller than referenced sector end ${minimumVolumeSpaceSize}`,
    });
  }
  if (pvd.fileStructureVersion !== 1) {
    issues.push({ code: "pvd.file_structure_version", message: "primary volume descriptor file structure version must be 1" });
  }
  issues.push(...validateSingleVolumeDescriptor(pvd, "pvd", "primary volume descriptor"));
  issues.push(...validateDirectoryEntryInterleaving(pvd.rootDirectoryRecord, "."));
  issues.push(...validateDirectoryEntryVolumeSequence(pvd.rootDirectoryRecord, "."));
  issues.push(...validateDirectoryEntryMultiExtent(pvd.rootDirectoryRecord, "."));
  issues.push(...validatePathTableReferences(image, pvd, "path_table"));
  return issues;
}

function minimumReferencedVolumeSpaceSize(image: Uint8Array, descriptors: VolumeDescriptor[]): number {
  let minimum = 0;
  for (const descriptor of descriptors) {
    minimum = Math.max(minimum, descriptor.sector + 1);
    if (descriptor.kind === "primary" || descriptor.kind === "supplementary" || descriptor.kind === "enhanced") {
      minimum = Math.max(
        minimum,
        pathTableEndSector(descriptor.typeLPathTableLocation, descriptor.pathTableSize),
        pathTableEndSector(descriptor.typeMPathTableLocation, descriptor.pathTableSize),
        optionalPathTableEndSector(descriptor.optionalTypeLPathTableLocation, descriptor.pathTableSize),
        optionalPathTableEndSector(descriptor.optionalTypeMPathTableLocation, descriptor.pathTableSize),
        directoryTreeEndSector(image, descriptor.rootDirectoryRecord, new Set()),
      );
    } else if (descriptor.kind === "partition") {
      minimum = Math.max(minimum, descriptor.volumePartitionLocation + descriptor.volumePartitionSize);
    }
  }
  return minimum;
}

function pathTableEndSector(location: number, size: number): number {
  if (!Number.isInteger(location) || !Number.isInteger(size) || location < 0 || size < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return location + sectorsForBytes(size);
}

function optionalPathTableEndSector(location: number, size: number): number {
  return location === 0 ? 0 : pathTableEndSector(location, size);
}

function directoryTreeEndSector(image: Uint8Array, directory: IsoDirectoryEntry, visited: Set<number>): number {
  let end = directoryExtentEndSector(directory);
  if (!Number.isFinite(end) || visited.has(directory.extent)) {
    return end;
  }
  visited.add(directory.extent);

  const start = (directory.extent + directory.extendedAttributeRecordLength) * SECTOR_SIZE;
  const directoryEnd = start + directory.size;
  if (!Number.isInteger(start) || !Number.isInteger(directoryEnd) || start < 0 || directoryEnd < start) {
    return Number.POSITIVE_INFINITY;
  }
  if (directoryEnd > image.byteLength) {
    return end;
  }

  let offset = start;
  let recordIndex = 0;
  while (offset < directoryEnd) {
    const length = image[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset - start + 1) / SECTOR_SIZE) * SECTOR_SIZE + start;
      continue;
    }
    if (length < 34 || offset + length > directoryEnd || (offset - start) % SECTOR_SIZE + length > SECTOR_SIZE) {
      offset += Math.max(1, length);
      continue;
    }
    let record: DecodedDirectoryRecord;
    try {
      record = decodeDirectoryRecord(image, offset, directoryEnd);
    } catch {
      offset += length;
      continue;
    }
    offset += record.length;
    if (recordIndex++ < 2) {
      continue;
    }
    if ((record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY) {
      const identifier = decodeFileIdentifier(record.identifier);
      const child = directoryEntryFromRecord(record, identifier, []);
      end = Math.max(end, directoryExtentEndSector(child));
      end = Math.max(end, directoryTreeEndSector(image, child, new Set(visited)));
    } else {
      end = Math.max(end, fileExtentEndSector(record));
    }
  }
  return end;
}

function directoryExtentEndSector(directory: IsoDirectoryEntry): number {
  return extentEndSector(directory.extent, directory.extendedAttributeRecordLength, sectorsForBytes(directory.size));
}

function fileExtentEndSector(record: DecodedDirectoryRecord): number {
  return extentEndSector(record.extent, record.extendedAttributeRecordLength, Math.max(1, sectorsForBytes(record.dataLength)));
}

function extentEndSector(extent: number, extendedAttributeRecordLength: number, dataSectors: number): number {
  if (
    !Number.isInteger(extent)
    || !Number.isInteger(extendedAttributeRecordLength)
    || !Number.isInteger(dataSectors)
    || extent < 0
    || extendedAttributeRecordLength < 0
    || dataSectors < 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return extent + extendedAttributeRecordLength + dataSectors;
}

function sectorsForBytes(size: number): number {
  if (!Number.isInteger(size) || size < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil(size / SECTOR_SIZE);
}

type PathTableValidationInput = PrimaryVolumeDescriptor | SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor;
type CanonicalPathTableRecord = PathTableRecord & { key: string };

function validatePathTableReferences(
  image: Uint8Array,
  descriptor: PathTableValidationInput,
  codePrefix: string,
): ValidationIssue[] {
  const little = validatePathTableReference(image, descriptor, codePrefix, "little", descriptor.typeLPathTableLocation);
  const big = validatePathTableReference(image, descriptor, codePrefix, "big", descriptor.typeMPathTableLocation);
  const issues = [
    ...little.issues,
    ...big.issues,
    ...validateOptionalPathTableReference(image, descriptor, codePrefix, "little"),
    ...validateOptionalPathTableReference(image, descriptor, codePrefix, "big"),
  ];
  if (little.records && big.records) {
    issues.push(...validatePathTableMirror(little.records, big.records, codePrefix));
  }
  const expected = expectedPathTableRecords(image, descriptor.rootDirectoryRecord);
  if (expected) {
    if (little.records) {
      issues.push(...validatePathTableAgainstHierarchy(little.records, expected, codePrefix, "Type L"));
    } else if (big.records) {
      issues.push(...validatePathTableAgainstHierarchy(big.records, expected, codePrefix, "Type M"));
    }
  }
  return issues;
}

function validatePathTableReference(
  image: Uint8Array,
  descriptor: PathTableValidationInput,
  codePrefix: string,
  endian: "little" | "big",
  location: number,
): { issues: ValidationIssue[]; records?: PathTableRecord[] } {
  const issues: ValidationIssue[] = [];
  const label = endian === "little" ? "Type L" : "Type M";
  const pathTableStart = location * SECTOR_SIZE;
  const pathTableEnd = pathTableStart + descriptor.pathTableSize;
  if (pathTableStart < 0 || pathTableEnd > image.byteLength) {
    issues.push({ code: `${codePrefix}.${endian}.bounds`, message: `${label} path table extent is out of bounds` });
    return { issues };
  }
  let pathTable: PathTableRecord[];
  try {
    pathTable = decodePathTable(image.subarray(pathTableStart, pathTableEnd), endian);
  } catch (error) {
    issues.push({ code: `${codePrefix}.${endian}.parse`, message: error instanceof Error ? error.message : String(error) });
    return { issues };
  }
  if (pathTable.length === 0) {
    issues.push({ code: `${codePrefix}.${endian}.empty`, message: `${label} path table must contain the root directory record` });
    return { issues, records: pathTable };
  }
  const root = pathTable[0]!;
  if (root.parentDirectoryNumber !== 1 || root.identifier.length !== 1 || root.identifier[0] !== 0) {
    issues.push({ code: `${codePrefix}.${endian}.root`, message: `first ${label} path table record must be the root directory with parent number 1` });
  }
  for (const [index, record] of pathTable.entries()) {
    const isRoot = index === 0;
    const invalidParent = isRoot
      ? record.parentDirectoryNumber !== 1
      : record.parentDirectoryNumber < 1 || record.parentDirectoryNumber >= index + 1;
    if (invalidParent) {
      issues.push({
        code: `${codePrefix}.${endian}.parent`,
        message: `${label} path table record ${index + 1} parent number ${record.parentDirectoryNumber} does not reference an earlier directory`,
      });
    }
  }
  return { issues, records: pathTable };
}

function validateOptionalPathTableReference(
  image: Uint8Array,
  descriptor: PathTableValidationInput,
  codePrefix: string,
  endian: "little" | "big",
): ValidationIssue[] {
  const location = endian === "little" ? descriptor.optionalTypeLPathTableLocation : descriptor.optionalTypeMPathTableLocation;
  if (location === 0) {
    return [];
  }
  const result = validatePathTableReference(image, descriptor, `${codePrefix}.optional`, endian, location);
  return result.issues;
}

function validatePathTableMirror(little: PathTableRecord[], big: PathTableRecord[], codePrefix: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (little.length !== big.length) {
    issues.push({
      code: `${codePrefix}.mirror.mismatch`,
      message: `Type L and Type M path tables have different record counts: ${little.length} !== ${big.length}`,
    });
  }
  for (let index = 0; index < Math.min(little.length, big.length); index += 1) {
    const left = little[index]!;
    const right = big[index]!;
    if (!samePathTableRecord(left, right)) {
      issues.push({
        code: `${codePrefix}.mirror.mismatch`,
        message: `Type L and Type M path table record ${index + 1} do not match`,
      });
    }
  }
  return issues;
}

function validatePathTableAgainstHierarchy(
  actual: PathTableRecord[],
  expected: CanonicalPathTableRecord[],
  codePrefix: string,
  label: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const actualRecords = canonicalPathTableRecords(actual, issues, codePrefix);
  const actualByKey = new Map(actualRecords.map((record) => [record.key, record]));
  const expectedByKey = new Map(expected.map((record) => [record.key, record]));

  for (const actualRecord of actualRecords) {
    if (!expectedByKey.has(actualRecord.key)) {
      issues.push({
        code: `${codePrefix}.hierarchy.extra`,
        message: `${label} path table contains an extra directory record not present in the directory hierarchy`,
      });
    }
  }
  for (const expectedRecord of expected) {
    const actualRecord = actualByKey.get(expectedRecord.key);
    if (!actualRecord) {
      issues.push({
        code: `${codePrefix}.hierarchy.missing`,
        message: `${label} path table is missing a directory from the directory hierarchy`,
      });
      continue;
    }
    if (
      actualRecord.extent !== expectedRecord.extent
      || (actualRecord.extendedAttributeRecordLength ?? 0) !== (expectedRecord.extendedAttributeRecordLength ?? 0)
    ) {
      issues.push({
        code: `${codePrefix}.hierarchy.record`,
        message: `${label} path table directory record does not match the directory hierarchy extent fields`,
      });
    }
  }
  return issues;
}

function expectedPathTableRecords(image: Uint8Array, root: IsoDirectoryEntry): CanonicalPathTableRecord[] | undefined {
  const records: CanonicalPathTableRecord[] = [];
  const visit = (directory: IsoDirectoryEntry, identifier: Uint8Array, parentDirectoryNumber: number, parentKey: string, visited: Set<number>): void => {
    if (visited.has(directory.extent)) {
      return;
    }
    visited.add(directory.extent);
    const directoryNumber = records.length + 1;
    const key = directoryNumber === 1 ? "/" : `${parentKey}/${bytesKey(identifier)}`;
    records.push({
      identifier,
      extent: directory.extent,
      parentDirectoryNumber,
      extendedAttributeRecordLength: directory.extendedAttributeRecordLength,
      key,
    });

    const start = (directory.extent + directory.extendedAttributeRecordLength) * SECTOR_SIZE;
    const end = start + directory.size;
    if (start < 0 || end > image.byteLength) {
      return;
    }
    let offset = start;
    let recordIndex = 0;
    while (offset < end) {
      const length = image[offset]!;
      if (length === 0) {
        offset = Math.ceil((offset - start + 1) / SECTOR_SIZE) * SECTOR_SIZE + start;
        continue;
      }
      if (length < 34 || offset + length > end || (offset - start) % SECTOR_SIZE + length > SECTOR_SIZE) {
        offset += Math.max(1, length);
        continue;
      }
      let record: DecodedDirectoryRecord;
      try {
        record = decodeDirectoryRecord(image, offset, end);
      } catch {
        offset += length;
        continue;
      }
      offset += record.length;
      if (recordIndex++ < 2 || (record.flags & FILE_FLAG_DIRECTORY) !== FILE_FLAG_DIRECTORY) {
        continue;
      }
      visit(directoryEntryFromRecord(record, "", []), record.identifier, directoryNumber, key, new Set(visited));
    }
  };

  try {
    visit(root, Uint8Array.of(0), 1, "", new Set());
    return records;
  } catch {
    return undefined;
  }
}

function canonicalPathTableRecords(records: PathTableRecord[], issues: ValidationIssue[], codePrefix: string): CanonicalPathTableRecord[] {
  const canonical: CanonicalPathTableRecord[] = [];
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    let key: string;
    if (index === 0) {
      key = "/";
    } else {
      const parent = canonical[record.parentDirectoryNumber - 1];
      if (!parent) {
        continue;
      }
      key = `${parent.key}/${bytesKey(record.identifier)}`;
    }
    if (seen.has(key)) {
      issues.push({
        code: `${codePrefix}.hierarchy.duplicate`,
        message: "path table contains duplicate directory paths",
      });
    }
    seen.add(key);
    canonical.push({ ...record, key });
  }
  return canonical;
}

function samePathTableRecord(left: PathTableRecord, right: PathTableRecord): boolean {
  return left.extent === right.extent
    && left.parentDirectoryNumber === right.parentDirectoryNumber
    && (left.extendedAttributeRecordLength ?? 0) === (right.extendedAttributeRecordLength ?? 0)
    && bytesEqual(left.identifier, right.identifier);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function bytesKey(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateDirectoryRecordLayout(image: Uint8Array, directory: IsoDirectoryEntry, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const start = directory.extent * SECTOR_SIZE;
  const directoryStart = start + directory.extendedAttributeRecordLength * SECTOR_SIZE;
  const end = directoryStart + directory.size;
  if (start < 0 || end > image.byteLength) {
    return [{ code: "directory.record_bounds", message: `directory extent for ${path} is out of bounds`, path }];
  }
  let offset = directoryStart;
  while (offset < end) {
    const length = image[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset - directoryStart + 1) / SECTOR_SIZE) * SECTOR_SIZE + directoryStart;
      continue;
    }
    const relative = offset - directoryStart;
    if ((relative % SECTOR_SIZE) + length > SECTOR_SIZE) {
      issues.push({ code: "directory.record_crosses_sector", message: `directory record crosses a logical sector boundary at ${path}`, path });
      offset += 1;
      continue;
    }
    try {
      decodeDirectoryRecord(image, offset, end);
    } catch (error) {
      const message = error instanceof Error ? error.message : `directory record is malformed at ${path}`;
      const isPaddingError = message.includes("padding byte");
      issues.push({
        code: isPaddingError ? "directory.record_padding" : "directory.record_malformed",
        message,
        path,
      });
      offset += Math.max(1, length);
      continue;
    }
    if ((image[offset + 25]! & 0x60) !== 0) {
      issues.push({ code: "directory.file_flags_reserved", message: `directory record has reserved file flag bits set at ${path}`, path });
    }
    offset += length;
  }
  return issues;
}

function validateDirectoryHierarchy(
  image: Uint8Array,
  directory: IsoDirectoryEntry,
  parent: IsoDirectoryEntry,
  path: string,
  visited: Set<number>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const key = directory.extent;
  if (visited.has(key)) {
    return [{ code: "directory.cycle", message: `directory cycle detected at ${path}`, path }];
  }
  visited.add(key);
  issues.push(...validateDirectoryRecordLayout(image, directory, path));
  issues.push(...validateExtendedAttributeRecords(image, directory, path));

  const start = (directory.extent + directory.extendedAttributeRecordLength) * SECTOR_SIZE;
  const end = start + directory.size;
  if (start < 0 || end > image.byteLength) {
    return issues;
  }
  let offset = start;
  let recordIndex = 0;
  while (offset < end) {
    const length = image[offset]!;
    if (length === 0) {
      if (recordIndex === 0) {
        issues.push({ code: "directory.self_record.missing", message: `directory self record is missing at ${path}`, path });
      } else if (recordIndex === 1) {
        issues.push({ code: "directory.parent_record.missing", message: `directory parent record is missing at ${path}`, path });
      }
      offset = Math.ceil((offset - start + 1) / SECTOR_SIZE) * SECTOR_SIZE + start;
      continue;
    }
    if (length < 34 || offset + length > end || (offset - start) % SECTOR_SIZE + length > SECTOR_SIZE) {
      offset += Math.max(1, length);
      continue;
    }
    let record: DecodedDirectoryRecord;
    try {
      record = decodeDirectoryRecord(image, offset, end);
    } catch {
      offset += length;
      continue;
    }
    offset += record.length;
    const index = recordIndex++;
    const identifier = index < 2 ? "" : decodeFileIdentifier(record.identifier);
    const recordPath = index < 2 ? path : joinPath(path === "." ? "" : path, stripVersion(identifier));
    if (index < 2) {
      issues.push(...validateDotDirectoryRecord(record, index, directory, parent, path));
    }
    if (record.fileUnitSize !== 0 || record.interleaveGapSize !== 0) {
      issues.push({
        code: "directory.interleaving_unsupported",
        message: `directory record at ${recordPath || "."} uses unsupported interleaved file section fields`,
        path: recordPath || ".",
      });
    }
    if (record.volumeSequenceNumber !== 1) {
      issues.push({
        code: "directory.volume_sequence_unsupported",
        message: `directory record at ${recordPath || "."} uses unsupported volume sequence number ${record.volumeSequenceNumber}`,
        path: recordPath || ".",
      });
    }
    if ((record.flags & FILE_FLAG_MULTI_EXTENT) !== 0) {
      issues.push({
        code: "directory.multi_extent_unsupported",
        message: `directory record at ${recordPath || "."} uses unsupported multi-extent file sections`,
        path: recordPath || ".",
      });
    }
    if (index < 2 || (record.flags & FILE_FLAG_DIRECTORY) !== FILE_FLAG_DIRECTORY) {
      continue;
    }
    const childPath = joinPath(path === "." ? "" : path, identifier);
    issues.push(...validateDirectoryHierarchy(image, directoryEntryFromRecord(record, childPath, []), directory, childPath, new Set(visited)));
  }
  return issues;
}

function validateDotDirectoryRecord(
  record: DecodedDirectoryRecord,
  index: number,
  directory: IsoDirectoryEntry,
  parent: IsoDirectoryEntry,
  path: string,
): ValidationIssue[] {
  const expectedIdentifier = index === 0 ? 0 : 1;
  const expectedEntry = index === 0 ? directory : parent;
  const recordName = index === 0 ? "self" : "parent";
  const expectedName = index === 0 ? "current directory" : "parent directory";
  const code = index === 0 ? "directory.self_record" : "directory.parent_record";
  const issues: ValidationIssue[] = [];

  if (record.identifier.length !== 1 || record.identifier[0] !== expectedIdentifier) {
    issues.push({
      code: `${code}.identifier`,
      message: `directory ${recordName} record at ${path} must use identifier ${expectedIdentifier}`,
      path,
    });
  }
  if ((record.flags & FILE_FLAG_DIRECTORY) !== FILE_FLAG_DIRECTORY) {
    issues.push({
      code: `${code}.identifier`,
      message: `directory ${recordName} record at ${path} must have the Directory flag set`,
      path,
    });
  }
  if (
    record.extent !== expectedEntry.extent
    || record.extendedAttributeRecordLength !== expectedEntry.extendedAttributeRecordLength
    || record.dataLength !== expectedEntry.size
  ) {
    issues.push({
      code: `${code}.extent`,
      message: `directory ${recordName} record at ${path} does not match the ${expectedName} extent fields`,
      path,
    });
  }

  return issues;
}

function validateSupplementaryLikeVolumeDescriptor(image: Uint8Array, descriptor: SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const label = descriptor.kind === "supplementary" ? "supplementary" : "enhanced";
  issues.push(...validateZeroDescriptorRanges(descriptor, label, [
    { start: 72, end: 80, code: "unused", label: "unused field at BP 73 to 80" },
    { start: 882, end: 883, code: "unused", label: "unused field at BP 883" },
    { start: 1395, end: SECTOR_SIZE, code: "reserved", label: "reserved field at BP 1396 to 2048" },
  ]));
  if ((descriptor.volumeFlags & 0xfe) !== 0) {
    issues.push({ code: `${label}.volume_flags`, message: `${label} volume descriptor flags bits 1 through 7 must be zero` });
  }
  if (descriptor.logicalBlockSize !== SECTOR_SIZE) {
    issues.push({ code: `${label}.logical_block_size`, message: `${label} logical block size must be 2048 for the supported profile` });
  }
  if (descriptor.fileStructureVersion !== 1) {
    issues.push({ code: `${label}.file_structure_version`, message: `${label} volume descriptor file structure version must be 1` });
  }
  issues.push(...validateSingleVolumeDescriptor(descriptor, label, `${label} volume descriptor`));
  issues.push(...validateDirectoryEntryInterleaving(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryEntryVolumeSequence(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryEntryMultiExtent(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validatePathTableReferences(image, descriptor, `${label}_path_table`));
  if (descriptor.rootDirectoryRecord.size > 0) {
    issues.push(...validateDirectoryHierarchy(image, descriptor.rootDirectoryRecord, descriptor.rootDirectoryRecord, `${label}:.`, new Set()));
  }
  return issues;
}

function validateVolumePartitionDescriptors(image: Uint8Array, descriptors: VolumeDescriptor[], pvd: PrimaryVolumeDescriptor): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const volumeSpaceSectors = Math.min(Math.floor(image.byteLength / SECTOR_SIZE), pvd.volumeSpaceSize);
  for (const descriptor of descriptors) {
    if (descriptor.kind !== "partition") {
      continue;
    }
    issues.push(...validateZeroDescriptorRanges(descriptor, "partition", [
      { start: 7, end: 8, code: "unused", label: "unused field at BP 8" },
    ]));
    const location = descriptor.volumePartitionLocation;
    const size = descriptor.volumePartitionSize;
    const end = location + size;
    if (
      !Number.isInteger(location)
      || !Number.isInteger(size)
      || size < 1
      || end > 0xffffffff
      || end > volumeSpaceSectors
      || location > volumeSpaceSectors
    ) {
      issues.push({
        code: "partition.bounds",
        message: `volume partition extent ${location}+${size} is out of bounds`,
      });
    }
  }
  return issues;
}

function validateZeroDescriptorRanges(
  descriptor: VolumeDescriptor,
  codePrefix: string,
  ranges: { start: number; end: number; code: "reserved" | "unused"; label: string }[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const range of ranges) {
    if (!allZero(descriptor.raw.subarray(range.start, range.end))) {
      issues.push({
        code: `${codePrefix}.${range.code}`,
        message: `${descriptor.kind} volume descriptor ${range.label} must be zero`,
      });
    }
  }
  return issues;
}

function parseSupplementaryLikeDescriptor(image: Uint8Array, offset: number, sector: number): SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor {
  const rootRecord = image[offset + 156] === 0 ? undefined : decodeDirectoryRecord(image, offset + 156, offset + 190);
  const common = {
    ...baseDescriptor(image, offset, sector, image[offset + 6] === 2 ? "enhanced" : "supplementary"),
    type: 2 as const,
    volumeFlags: image[offset + 7]!,
    systemIdentifier: readAsciiTrimmed(image, offset + 8, 32),
    volumeIdentifier: readAsciiTrimmed(image, offset + 40, 32),
    volumeSpaceSize: readUint32Both(image, offset + 80),
    volumeSetSize: readUint16Both(image, offset + 120),
    volumeSequenceNumber: readUint16Both(image, offset + 124),
    logicalBlockSize: readUint16Both(image, offset + 128),
    pathTableSize: readUint32Both(image, offset + 132),
    typeLPathTableLocation: readUint32LEAt(image, offset + 140),
    optionalTypeLPathTableLocation: readUint32LEAt(image, offset + 144),
    typeMPathTableLocation: readUint32BEAt(image, offset + 148),
    optionalTypeMPathTableLocation: readUint32BEAt(image, offset + 152),
    rootDirectoryRecord: rootRecord ? directoryEntryFromRecord(rootRecord, "", []) : emptyDirectoryEntry(),
    copyrightFileIdentifier: readAsciiTrimmed(image, offset + 702, 37),
    abstractFileIdentifier: readAsciiTrimmed(image, offset + 739, 37),
    bibliographicFileIdentifier: readAsciiTrimmed(image, offset + 776, 37),
    fileStructureVersion: image[offset + 881]!,
    applicationUse: image.slice(offset + 883, offset + 1395),
    escapeSequences: image.slice(offset + 88, offset + 120),
  };
  return image[offset + 6] === 2
    ? { ...common, kind: "enhanced", version: 2 }
    : { ...common, kind: "supplementary", version: 1 };
}

function emptyDirectoryEntry(): IsoDirectoryEntry {
  return {
    path: "",
    identifier: "",
    extent: 0,
    extendedAttributeRecordLength: 0,
    size: 0,
    date: new Date(0),
    flags: FILE_FLAG_DIRECTORY,
    fileUnitSize: 0,
    interleaveGapSize: 0,
    volumeSequenceNumber: 1,
    children: [],
  };
}

function parsePartitionDescriptor(image: Uint8Array, offset: number, sector: number): VolumePartitionDescriptor {
  return {
    ...baseDescriptor(image, offset, sector, "partition"),
    type: 3,
    kind: "partition",
    systemIdentifier: readAsciiTrimmed(image, offset + 8, 32),
    volumePartitionIdentifier: readAsciiTrimmed(image, offset + 40, 32),
    volumePartitionLocation: readUint32Both(image, offset + 72),
    volumePartitionSize: readUint32Both(image, offset + 80),
    systemUse: image.slice(offset + 88, offset + SECTOR_SIZE),
  };
}

function populateDescriptorDirectoryTree(image: Uint8Array, descriptor: VolumeDescriptor, includeData: boolean): VolumeDescriptor {
  if (descriptor.kind !== "primary" && descriptor.kind !== "supplementary" && descriptor.kind !== "enhanced") {
    return descriptor;
  }
  if (descriptor.rootDirectoryRecord.size === 0) {
    return descriptor;
  }
  return {
    ...descriptor,
    rootDirectoryRecord: readDirectoryTree(image, descriptor.rootDirectoryRecord, "", includeData, new Set()),
  };
}

function readDirectoryTree(image: Uint8Array, directory: IsoDirectoryEntry, path: string, includeData: boolean, visited: Set<number>): IsoDirectoryEntry {
  assertExtentInBounds(image, directory.extent, directory.extendedAttributeRecordLength, directory.size, path || ".");
  if (visited.has(directory.extent)) {
    throw new Error(`invalid directory cycle detected at ${path || "."}`);
  }
  visited.add(directory.extent);
  const start = (directory.extent + directory.extendedAttributeRecordLength) * SECTOR_SIZE;
  const bytes = image.subarray(start, start + directory.size);
  const children: IsoNode[] = [];
  let offset = 0;
  let recordIndex = 0;

  while (offset < bytes.byteLength) {
    const length = bytes[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    if ((offset % SECTOR_SIZE) + length > SECTOR_SIZE) {
      throw new Error(`directory record crosses a logical sector boundary at ${path || "."}`);
    }
    const record = decodeDirectoryRecord(bytes, offset, bytes.byteLength);
    if ((record.flags & 0x60) !== 0) {
      throw new Error(`directory record has reserved file flag bits set at ${path || "."}`);
    }
    offset += record.length;

    const index = recordIndex++;
    if (index < 2) {
      assertSupportedDirectoryRecord(record, path || ".");
      continue;
    }

    const identifier = decodeFileIdentifier(record.identifier);
    const cleanName = stripVersion(identifier);
    const recordPath = joinPath(path, cleanName);
    assertSupportedDirectoryRecord(record, recordPath || ".");
    if ((record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY) {
      const childPath = joinPath(path, identifier);
      const child = directoryEntryFromRecord(record, childPath, []);
      if (record.extendedAttributeRecordLength > 0) {
        child.extendedAttributeRecord = readExtendedAttributeRecord(image, record);
        const fields = decodeOptionalExtendedAttributeRecord(child.extendedAttributeRecord);
        if (fields) {
          child.extendedAttributeRecordFields = fields;
        }
      }
      children.push(readDirectoryTree(image, child, childPath, includeData, new Set(visited)));
    } else {
      assertExtentInBounds(image, record.extent, record.extendedAttributeRecordLength, record.dataLength, recordPath);
      const filePath = joinPath(path, cleanName);
      const file: IsoFileEntry = {
        path: filePath,
        identifier,
        extent: record.extent,
        extendedAttributeRecordLength: record.extendedAttributeRecordLength,
        size: record.dataLength,
        date: record.date,
        flags: record.flags,
        fileUnitSize: record.fileUnitSize,
        interleaveGapSize: record.interleaveGapSize,
        volumeSequenceNumber: record.volumeSequenceNumber,
      };
      if (record.extendedAttributeRecordLength > 0) {
        file.extendedAttributeRecord = readExtendedAttributeRecord(image, record);
        const fields = decodeOptionalExtendedAttributeRecord(file.extendedAttributeRecord);
        if (fields) {
          file.extendedAttributeRecordFields = fields;
        }
      }
      if (record.systemUse.byteLength > 0) {
        file.systemUse = record.systemUse;
      }
      if (includeData) {
        const dataStart = (record.extent + record.extendedAttributeRecordLength) * SECTOR_SIZE;
        file.data = image.slice(dataStart, dataStart + record.dataLength);
      }
      children.push(file);
    }
  }

  const entry = { ...directory, children };
  if (entry.extendedAttributeRecordLength > 0 && !entry.extendedAttributeRecord) {
    entry.extendedAttributeRecord = image.slice(directory.extent * SECTOR_SIZE, (directory.extent + directory.extendedAttributeRecordLength) * SECTOR_SIZE);
    const fields = decodeOptionalExtendedAttributeRecord(entry.extendedAttributeRecord);
    if (fields) {
      entry.extendedAttributeRecordFields = fields;
    }
  }
  return entry;
}

function validateExtendedAttributeRecords(image: Uint8Array, directory: IsoDirectoryEntry, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const start = (directory.extent + directory.extendedAttributeRecordLength) * SECTOR_SIZE;
  const end = start + directory.size;
  if (start < 0 || end > image.byteLength) {
    return issues;
  }
  let offset = start;
  let recordIndex = 0;
  while (offset < end) {
    const length = image[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset - start + 1) / SECTOR_SIZE) * SECTOR_SIZE + start;
      continue;
    }
    if (length < 34 || offset + length > end || (offset - start) % SECTOR_SIZE + length > SECTOR_SIZE) {
      offset += Math.max(1, length);
      continue;
    }
    let record: DecodedDirectoryRecord;
    try {
      record = decodeDirectoryRecord(image, offset, end);
    } catch {
      offset += length;
      continue;
    }
    offset += record.length;
    if (recordIndex++ < 2 || record.extendedAttributeRecordLength === 0) {
      continue;
    }

    const identifier = decodeFileIdentifier(record.identifier);
    const recordPath = joinPath(path === "." ? "" : path, stripVersion(identifier)) || ".";
    const extendedAttributeRecord = readExtendedAttributeRecord(image, record);
    try {
      const fields = decodeExtendedAttributeRecord(extendedAttributeRecord);
      if ((record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY) {
        const expected = extendedAttributeRecordFileFlags(fields) & 0x10;
        if ((record.flags & 0x10) !== expected) {
          issues.push({
            code: "extended_attribute_record.file_flags",
            message: `directory record flags for ${recordPath} do not match associated extended attribute record fields`,
            path: recordPath,
          });
        }
        if ((record.flags & 0x08) !== 0) {
          issues.push({
            code: "directory.file_flags_record",
            message: `directory record flags for ${recordPath} must not set the Record bit`,
            path: recordPath,
          });
        }
      } else {
        const expected = extendedAttributeRecordFileFlags(fields);
        if ((record.flags & 0x18) !== expected) {
          issues.push({
            code: "extended_attribute_record.file_flags",
            message: `directory record flags for ${recordPath} do not match associated extended attribute record fields`,
            path: recordPath,
          });
        }
      }
    } catch (error) {
      issues.push({
        code: "extended_attribute_record.parse",
        message: error instanceof Error ? error.message : String(error),
        path: recordPath,
      });
    }
  }
  return issues;
}

function assertExtentInBounds(image: Uint8Array, extent: number, extendedAttributeRecordLength: number, length: number, path: string): void {
  const start = extent * SECTOR_SIZE;
  const end = start + extendedAttributeRecordLength * SECTOR_SIZE + length;
  if (
    !Number.isInteger(extent)
    || !Number.isInteger(extendedAttributeRecordLength)
    || !Number.isInteger(length)
    || extent < 0
    || extendedAttributeRecordLength < 0
    || length < 0
    || start < 0
    || end > image.byteLength
  ) {
    throw new Error(`invalid extent bounds for ${path}`);
  }
}

function assertSupportedDirectoryRecord(record: DecodedDirectoryRecord, path: string): void {
  if (record.fileUnitSize !== 0 || record.interleaveGapSize !== 0) {
    throw new Error(`directory record at ${path} uses unsupported interleaved file section fields`);
  }
  if ((record.flags & FILE_FLAG_MULTI_EXTENT) !== 0) {
    throw new Error(`directory record at ${path} uses unsupported multi-extent file sections`);
  }
  assertSupportedVolumeSequence(record.volumeSequenceNumber, path);
}

function assertSupportedDirectoryEntry(entry: IsoDirectoryEntry, path: string): void {
  if (entry.fileUnitSize !== 0 || entry.interleaveGapSize !== 0) {
    throw new Error(`directory record at ${path} uses unsupported interleaved file section fields`);
  }
  if ((entry.flags & FILE_FLAG_MULTI_EXTENT) !== 0) {
    throw new Error(`directory record at ${path} uses unsupported multi-extent file sections`);
  }
  assertSupportedVolumeSequence(entry.volumeSequenceNumber, path);
}

function assertSupportedVolumeSequence(volumeSequenceNumber: number, path: string): void {
  if (volumeSequenceNumber !== 1) {
    throw new Error(`directory record at ${path} uses unsupported volume sequence number ${volumeSequenceNumber}`);
  }
}

function assertSingleVolumeDescriptor(descriptor: PathTableValidationInput, label: string): void {
  if (descriptor.volumeSetSize !== 1 || descriptor.volumeSequenceNumber !== 1) {
    throw new Error(`${label} uses unsupported multi-volume fields`);
  }
}

function validateSingleVolumeDescriptor(descriptor: PathTableValidationInput, codePrefix: string, label: string): ValidationIssue[] {
  if (descriptor.volumeSetSize === 1 && descriptor.volumeSequenceNumber === 1) {
    return [];
  }
  return [{
    code: `${codePrefix}.single_volume_profile`,
    message: `${label} uses unsupported multi-volume fields`,
  }];
}

function validateDirectoryEntryInterleaving(entry: IsoDirectoryEntry, path: string): ValidationIssue[] {
  if (entry.fileUnitSize === 0 && entry.interleaveGapSize === 0) {
    return [];
  }
  return [{
    code: "directory.interleaving_unsupported",
    message: `directory record at ${path} uses unsupported interleaved file section fields`,
    path,
  }];
}

function validateDirectoryEntryVolumeSequence(entry: IsoDirectoryEntry, path: string): ValidationIssue[] {
  if (entry.volumeSequenceNumber === 1) {
    return [];
  }
  return [{
    code: "directory.volume_sequence_unsupported",
    message: `directory record at ${path} uses unsupported volume sequence number ${entry.volumeSequenceNumber}`,
    path,
  }];
}

function validateDirectoryEntryMultiExtent(entry: IsoDirectoryEntry, path: string): ValidationIssue[] {
  if ((entry.flags & FILE_FLAG_MULTI_EXTENT) === 0) {
    return [];
  }
  return [{
    code: "directory.multi_extent_unsupported",
    message: `directory record at ${path} uses unsupported multi-extent file sections`,
    path,
  }];
}

function directoryEntryFromRecord(record: DecodedDirectoryRecord, path: string, children: IsoNode[]): IsoDirectoryEntry {
  const entry: IsoDirectoryEntry = {
    path,
    identifier: decodeFileIdentifier(record.identifier),
    extent: record.extent,
    extendedAttributeRecordLength: record.extendedAttributeRecordLength,
    size: record.dataLength,
    date: record.date,
    flags: record.flags,
    fileUnitSize: record.fileUnitSize,
    interleaveGapSize: record.interleaveGapSize,
    volumeSequenceNumber: record.volumeSequenceNumber,
    children,
  };
  if (record.systemUse.byteLength > 0) {
    entry.systemUse = record.systemUse;
  }
  return entry;
}

function readExtendedAttributeRecord(image: Uint8Array, record: DecodedDirectoryRecord): Uint8Array {
  const start = record.extent * SECTOR_SIZE;
  return image.slice(start, start + record.extendedAttributeRecordLength * SECTOR_SIZE);
}

function decodeOptionalExtendedAttributeRecord(bytes: Uint8Array): ReturnType<typeof decodeExtendedAttributeRecord> | undefined {
  try {
    return decodeExtendedAttributeRecord(bytes);
  } catch {
    return undefined;
  }
}

function collectParsedFiles(directory: IsoDirectoryEntry): IsoFileEntry[] {
  const files: IsoFileEntry[] = [];
  for (const child of directory.children) {
    if ("children" in child) {
      files.push(...collectParsedFiles(child));
    } else {
      files.push(child);
    }
  }
  return files;
}

function assertDescriptorHeader(image: Uint8Array, offset: number): void {
  if (readAscii(image, offset + 1, 5) !== STANDARD_IDENTIFIER) {
    throw new Error(`expected ${STANDARD_IDENTIFIER} descriptor identifier at byte offset ${offset + 1}`);
  }
}

function assertDescriptorVersion(version: number, allowed: number[], name: string): void {
  if (!allowed.includes(version)) {
    throw new Error(`expected ${name} version ${allowed.join(" or ")}`);
  }
}

function baseDescriptor(image: Uint8Array, offset: number, sector: number, kind: string): { type: number; kind: string; identifier: string; version: number; offset: number; sector: number; raw: Uint8Array } {
  return {
    type: image[offset]!,
    kind,
    identifier: STANDARD_IDENTIFIER,
    version: image[offset + 6]!,
    offset,
    sector,
    raw: image.slice(offset, offset + SECTOR_SIZE),
  };
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function dedupeIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\0${issue.path ?? ""}\0${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasTargetedIssueForParseFailure(issues: ValidationIssue[], message: string): boolean {
  return issues.some((issue) => {
    if (issue.code === "image.parse" || issue.code === "descriptor.sequence") {
      return false;
    }
    if (
      (issue.code === "directory.record_malformed" || issue.code === "directory.record_padding")
      && (message.includes("directory record has invalid length")
        || message.includes("directory record identifier length is inconsistent")
        || message.includes("directory record file identifier padding byte must be zero"))
    ) {
      return true;
    }
    return message.includes(issue.message) || issue.message.includes(message);
  });
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function readUint32LEAt(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function readUint32BEAt(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 24)
    | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8)
    | bytes[offset + 3]!
  ) >>> 0;
}
