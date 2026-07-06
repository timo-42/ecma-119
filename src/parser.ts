import { decodeVolumeDate, isAString, isDString, readAscii, readAsciiTrimmed, readUint16Both, readUint32Both, readVolumeDescriptorDateTime, sectorOffset } from "./binary.js";
import { decodeDirectoryRecord, FILE_FLAG_ASSOCIATED, FILE_FLAG_DIRECTORY, FILE_FLAG_MULTI_EXTENT, type DecodedDirectoryRecord } from "./directory-record.js";
import { decodeExtendedAttributeRecord, extendedAttributeRecordFileFlags } from "./extended-attribute-record.js";
import { decodeFileIdentifier, isSupportedPrimaryDirectoryIdentifier, isSupportedPrimaryFileIdentifier, stripVersion } from "./identifiers.js";
import { decodePathTable, type PathTableRecord } from "./path-table.js";
import {
  type IsoDirectoryEntry,
  type IsoFileEntry,
  type IsoFileSection,
  type IsoImage,
  type IsoNode,
  type BootVolumeDescriptor,
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
  assertVolumeDescriptorMetadata(pvd, "primary volume descriptor");
  validatePrimaryDescriptorReferences(image, pvd);
  assertSupportedDirectoryEntry(pvd.rootDirectoryRecord, ".", pvd.volumeSequenceNumber);
  const includeData = options.includeData ?? true;
  const populatedDescriptors = descriptors.map((descriptor) => populateDescriptorDirectoryTree(image, descriptor, includeData));
  const primaryVolumeDescriptor = populatedDescriptors.find((descriptor): descriptor is PrimaryVolumeDescriptor => descriptor.type === 1);
  if (!primaryVolumeDescriptor) {
    throw new Error("missing primary volume descriptor");
  }
  const root = primaryVolumeDescriptor.rootDirectoryRecord;
  return {
    systemArea: image.slice(0, sectorOffset(SYSTEM_AREA_SECTORS)),
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
  issues.push(...validateRawDescriptorDateFields(image));
  let descriptors: VolumeDescriptor[] = [];
  let descriptorSequenceFailed = false;
  try {
    descriptors = parseVolumeDescriptors(image);
    for (const terminator of descriptors.filter((descriptor) => descriptor.kind === "terminator")) {
      if (!allZero(terminator.raw.subarray(7))) {
        issues.push({
          code: "descriptor.terminator_reserved",
          message: `volume descriptor set terminator reserved bytes must be zero at sector ${terminator.sector}`,
        });
      }
    }
    issues.push(...validateDescriptorSequenceProfile(descriptors));
    for (const descriptor of descriptors) {
      if (descriptor.kind === "boot") {
        issues.push(...validateBootVolumeDescriptor(descriptor));
      }
    }
    const pvd = descriptors.find((descriptor): descriptor is PrimaryVolumeDescriptor => descriptor.type === 1);
    if (!pvd) {
      issues.push({ code: "descriptor.primary_missing", message: "primary volume descriptor is required" });
    } else {
      issues.push(...validatePrimaryVolumeDescriptor(image, pvd, descriptors));
      issues.push(...validateDirectoryHierarchy(image, pvd.rootDirectoryRecord, pvd.rootDirectoryRecord, ".", pvd.volumeSequenceNumber, new Set(), {
        validatePrimaryLevelOne: true,
      }));
      for (const descriptor of descriptors) {
        if (descriptor.kind === "supplementary" || descriptor.kind === "enhanced") {
          issues.push(...validateSupplementaryLikeVolumeDescriptor(image, descriptor, descriptors));
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

function validateDescriptorSequenceProfile(descriptors: VolumeDescriptor[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const primaryCount = descriptors.filter((descriptor) => descriptor.kind === "primary").length;
  if (primaryCount > 1) {
    issues.push({
      code: "descriptor.primary_duplicate",
      message: `volume descriptor sequence contains ${primaryCount} primary volume descriptors; the supported profile requires exactly one`,
    });
  }
  for (const descriptor of descriptors) {
    if (descriptor.kind === "unknown") {
      issues.push({
        code: "descriptor.unknown",
        message: `volume descriptor type ${descriptor.type} at sector ${descriptor.sector} is outside the supported profile`,
      });
    }
  }
  return issues;
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
      sector += 1;
      while (sectorOffset(sector + 1) <= image.byteLength && isVolumeDescriptorSetTerminatorAt(image, sectorOffset(sector))) {
        descriptors.push(parseVolumeDescriptorAt(image, sectorOffset(sector), sector));
        sector += 1;
      }
      return descriptors;
    }
    sector += 1;
  }

  throw new Error("missing volume descriptor set terminator");
}

function isVolumeDescriptorSetTerminatorAt(image: Uint8Array, offset: number): boolean {
  return image[offset] === 255
    && readAscii(image, offset + 1, 5) === STANDARD_IDENTIFIER
    && image[offset + 6] === 1;
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
  issues.push(...validateDescriptorCharacterFields(pvd, "pvd", [
    { start: 8, length: 32, kind: "a", code: "system_identifier.characters", label: "system identifier" },
    { start: 40, length: 32, kind: "d", code: "volume_identifier.characters", label: "volume identifier" },
    { start: 190, length: 128, kind: "d", code: "volume_set_identifier.characters", label: "volume set identifier" },
    { start: 318, length: 128, kind: "a", code: "publisher_identifier.characters", label: "publisher identifier" },
    { start: 446, length: 128, kind: "a", code: "data_preparer_identifier.characters", label: "data preparer identifier" },
    { start: 574, length: 128, kind: "a", code: "application_identifier.characters", label: "application identifier" },
    { start: 702, length: 37, kind: "file", code: "copyright_file_identifier.characters", label: "copyright file identifier" },
    { start: 739, length: 37, kind: "file", code: "abstract_file_identifier.characters", label: "abstract file identifier" },
    { start: 776, length: 37, kind: "file", code: "bibliographic_file_identifier.characters", label: "bibliographic file identifier" },
  ]));
  if (pvd.rootDirectoryRecord.identifier !== ".") {
    issues.push({
      code: "pvd.root_directory_record.identifier",
      message: "primary volume descriptor root directory record must use identifier 0",
      path: ".",
    });
  }
  if (pvd.logicalBlockSize !== SECTOR_SIZE) {
    issues.push({ code: "pvd.logical_block_size", message: "logical block size must be 2048 for the supported profile" });
  }
  issues.push(...validateVolumeSpaceSize(image, pvd, descriptors, "pvd"));
  if (pvd.fileStructureVersion !== 1) {
    issues.push({ code: "pvd.file_structure_version", message: "primary volume descriptor file structure version must be 1" });
  }
  issues.push(...validateVolumeDescriptorMetadata(pvd, "pvd", "primary volume descriptor"));
  issues.push(...validateDirectoryEntryInterleaving(pvd.rootDirectoryRecord, "."));
  issues.push(...validateDirectoryEntryReservedFileFlags(pvd.rootDirectoryRecord, "."));
  issues.push(...validateDirectoryEntryDirectoryFlags(pvd.rootDirectoryRecord, "."));
  issues.push(...validateDirectoryProtectionExtendedAttributeFlags(pvd.rootDirectoryRecord, "."));
  issues.push(...validateDirectoryEntryVolumeSequence(pvd.rootDirectoryRecord, ".", pvd.volumeSequenceNumber));
  issues.push(...validateDirectoryEntryMultiExtent(pvd.rootDirectoryRecord, "."));
  issues.push(...validateDirectoryEntryExtendedAttributeRecord(image, pvd.rootDirectoryRecord, ".", pvd.volumeSequenceNumber));
  issues.push(...validatePathTableReferences(image, pvd, "path_table"));
  return issues;
}

function validateBootVolumeDescriptor(descriptor: BootVolumeDescriptor): ValidationIssue[] {
  return validateDescriptorCharacterFields(descriptor, "boot", [
    { start: 7, length: 32, kind: "a", code: "system_identifier.characters", label: "boot system identifier" },
    { start: 39, length: 32, kind: "a", code: "identifier.characters", label: "boot identifier" },
  ]);
}

function validateRawDescriptorDateFields(image: Uint8Array): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let sector = SYSTEM_AREA_SECTORS;
  while (sectorOffset(sector + 1) <= image.byteLength) {
    const offset = sectorOffset(sector);
    const type = image[offset]!;
    if (readAscii(image, offset + 1, 5) !== STANDARD_IDENTIFIER) {
      return issues;
    }
    if (type === 1 || type === 2) {
      const version = image[offset + 6]!;
      const codePrefix = type === 1 ? "pvd" : version === 2 ? "enhanced" : "supplementary";
      const descriptorLabel = type === 1 ? "primary" : version === 2 ? "enhanced" : "supplementary";
      issues.push(...validateRawDescriptorDateField(image, offset + 813, `${codePrefix}.creation_date`, `${descriptorLabel} volume creation date and time`));
      issues.push(...validateRawDescriptorDateField(image, offset + 830, `${codePrefix}.modification_date`, `${descriptorLabel} volume modification date and time`));
      issues.push(...validateRawDescriptorDateField(image, offset + 847, `${codePrefix}.expiration_date`, `${descriptorLabel} volume expiration date and time`));
      issues.push(...validateRawDescriptorDateField(image, offset + 864, `${codePrefix}.effective_date`, `${descriptorLabel} volume effective date and time`));
    }
    if (type === 255) {
      return issues;
    }
    sector += 1;
  }
  return issues;
}

function validateRawDescriptorDateField(image: Uint8Array, offset: number, code: string, label: string): ValidationIssue[] {
  const text = readAscii(image, offset, 16);
  if (/^0{16}$/u.test(text)) {
    if (image[offset + 16] !== 0) {
      return [{
        code,
        message: `${label} unspecified value must use zero GMT offset`,
      }];
    }
    return [];
  }
  if (!/^[0-9]{16}$/u.test(text)) {
    return [{
      code,
      message: `${label} must contain 16 decimal digits followed by a signed GMT offset byte`,
    }];
  }
  try {
    readVolumeDescriptorDateTime(image, offset);
    return [];
  } catch (error) {
    return [{
      code,
      message: `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }
}

function validateVolumeSpaceSize(
  image: Uint8Array,
  descriptor: PathTableValidationInput,
  descriptors: VolumeDescriptor[],
  codePrefix: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (descriptor.volumeSpaceSize * SECTOR_SIZE > image.byteLength) {
    const message = codePrefix === "pvd" ? "volume space size exceeds image length" : `${codePrefix} volume space size exceeds image length`;
    issues.push({ code: `${codePrefix}.volume_space_size`, message });
  }
  const minimumVolumeSpaceSize = minimumReferencedVolumeSpaceSize(image, descriptors);
  if (Number.isFinite(minimumVolumeSpaceSize) && descriptor.volumeSpaceSize < minimumVolumeSpaceSize) {
    const message = codePrefix === "pvd"
      ? `volume space size ${descriptor.volumeSpaceSize} is smaller than referenced sector end ${minimumVolumeSpaceSize}`
      : `${codePrefix} volume space size ${descriptor.volumeSpaceSize} is smaller than referenced sector end ${minimumVolumeSpaceSize}`;
    issues.push({
      code: `${codePrefix}.volume_space_size.lower_bound`,
      message,
    });
  }
  return issues;
}

function minimumReferencedVolumeSpaceSize(image: Uint8Array, descriptors: VolumeDescriptor[]): number {
  let minimum = 0;
  for (const descriptor of descriptors) {
    minimum = Math.max(minimum, descriptor.sector + 1);
    if (descriptor.kind === "primary" || descriptor.kind === "supplementary" || descriptor.kind === "enhanced") {
      const localRootEndSector = descriptor.rootDirectoryRecord.volumeSequenceNumber === descriptor.volumeSequenceNumber
        ? directoryTreeEndSector(image, descriptor.rootDirectoryRecord, descriptor.volumeSequenceNumber, new Set())
        : 0;
      minimum = Math.max(
        minimum,
        pathTableEndSector(descriptor.typeLPathTableLocation, descriptor.pathTableSize),
        pathTableEndSector(descriptor.typeMPathTableLocation, descriptor.pathTableSize),
        optionalPathTableEndSector(descriptor.optionalTypeLPathTableLocation, descriptor.pathTableSize),
        optionalPathTableEndSector(descriptor.optionalTypeMPathTableLocation, descriptor.pathTableSize),
        localRootEndSector,
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

function directoryTreeEndSector(image: Uint8Array, directory: IsoDirectoryEntry, localVolumeSequenceNumber: number, visited: Set<number>): number {
  let end = directoryExtentEndSector(directory);
  if (!Number.isFinite(end) || visited.has(directory.extent)) {
    return end;
  }
  if (directory.volumeSequenceNumber !== localVolumeSequenceNumber) {
    return end;
  }
  visited.add(directory.extent);

  const directoryBytes = readDirectoryExtentBytes(image, directory);
  if (!directoryBytes) {
    return Number.POSITIVE_INFINITY;
  }

  let offset = 0;
  let recordIndex = 0;
  while (offset < directoryBytes.byteLength) {
    const length = directoryBytes[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    if (length < 34 || offset + length > directoryBytes.byteLength || (offset % SECTOR_SIZE) + length > SECTOR_SIZE) {
      offset += Math.max(1, length);
      continue;
    }
    let record: DecodedDirectoryRecord;
    try {
      record = decodeDirectoryRecord(directoryBytes, offset, directoryBytes.byteLength);
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
      if (child.volumeSequenceNumber === localVolumeSequenceNumber) {
        end = Math.max(end, directoryExtentEndSector(child));
        end = Math.max(end, directoryTreeEndSector(image, child, localVolumeSequenceNumber, new Set(visited)));
      }
    } else {
      if (record.volumeSequenceNumber === localVolumeSequenceNumber) {
        end = Math.max(end, fileExtentEndSector(record));
      }
    }
  }
  return end;
}

function directoryExtentEndSector(directory: IsoDirectoryEntry): number {
  return directory.extent + sectionExtentSectors({
    dataLength: directory.size,
    extendedAttributeRecordLength: directory.extendedAttributeRecordLength,
    fileUnitSize: directory.fileUnitSize,
    interleaveGapSize: directory.interleaveGapSize,
  });
}

function fileExtentEndSector(record: DecodedDirectoryRecord): number {
  return record.extent + fileSectionExtentSectors(record);
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
  const optionalLittle = validateOptionalPathTableReference(image, descriptor, codePrefix, "little");
  const optionalBig = validateOptionalPathTableReference(image, descriptor, codePrefix, "big");
  const issues = [
    ...little.issues,
    ...big.issues,
    ...optionalLittle.issues,
    ...optionalBig.issues,
  ];
  if (little.records && big.records) {
    issues.push(...validatePathTableMirror(little.records, big.records, codePrefix));
  }
  if (little.records && optionalLittle.records) {
    issues.push(...validatePathTableCopy(little.records, optionalLittle.records, codePrefix, "little"));
  }
  if (big.records && optionalBig.records) {
    issues.push(...validatePathTableCopy(big.records, optionalBig.records, codePrefix, "big"));
  }
  const expected = descriptor.rootDirectoryRecord.volumeSequenceNumber === descriptor.volumeSequenceNumber
    ? expectedPathTableRecords(image, descriptor.rootDirectoryRecord)
    : undefined;
  if (expected) {
    if (little.records) {
      issues.push(...validatePathTableAgainstHierarchy(little.records, expected, codePrefix, "Type L"));
    } else if (big.records) {
      issues.push(...validatePathTableAgainstHierarchy(big.records, expected, codePrefix, "Type M"));
    }
    if (optionalLittle.records) {
      issues.push(...validatePathTableAgainstHierarchy(optionalLittle.records, expected, `${codePrefix}.optional.little`, "optional Type L"));
    }
    if (optionalBig.records) {
      issues.push(...validatePathTableAgainstHierarchy(optionalBig.records, expected, `${codePrefix}.optional.big`, "optional Type M"));
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
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ code: pathTableParseIssueCode(codePrefix, endian, message), message });
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
    if (record.parentDirectoryNumber < 1) {
      issues.push({
        code: `${codePrefix}.${endian}.parent_directory_number.range`,
        message: `${label} path table record ${index + 1} parent directory number must be at least 1`,
      });
    }
    const invalidParent = isRoot
      ? record.parentDirectoryNumber !== 1
      : record.parentDirectoryNumber < 1 || record.parentDirectoryNumber >= index + 1;
    if (invalidParent) {
      issues.push({
        code: `${codePrefix}.${endian}.parent`,
        message: `${label} path table record ${index + 1} parent number ${record.parentDirectoryNumber} does not reference an earlier directory`,
      });
    }
    if (descriptor.kind === "primary" && !isRoot) {
      if (!isSupportedPrimaryDirectoryIdentifier(record.identifier)) {
        issues.push({
          code: `${codePrefix}.${endian}.identifier.characters`,
          message: `${label} path table record ${index + 1} directory identifier contains invalid ECMA-119 primary d-characters`,
        });
      }
    }
  }
  issues.push(...validatePathTableOrder(pathTable, codePrefix, endian));
  return { issues, records: pathTable };
}

function validatePathTableOrder(
  records: PathTableRecord[],
  codePrefix: string,
  endian: "little" | "big",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const label = endian === "little" ? "Type L" : "Type M";
  const levels: Array<number | undefined> = [];
  for (const [index, record] of records.entries()) {
    if (index === 0) {
      levels.push(0);
      continue;
    }
    const parentLevel = levels[record.parentDirectoryNumber - 1];
    levels.push(parentLevel === undefined ? undefined : parentLevel + 1);
  }
  for (let index = 1; index < records.length; index += 1) {
    const previousLevel = levels[index - 1];
    const currentLevel = levels[index];
    if (previousLevel === undefined || currentLevel === undefined) {
      continue;
    }
    const previous = records[index - 1]!;
    const current = records[index]!;
    const orderIssue = pathTableOrderIssue(previous, previousLevel, current, currentLevel);
    if (orderIssue) {
      issues.push({
        code: `${codePrefix}.${endian}.order.${orderIssue}`,
        message: `${label} path table records must be ordered by ${pathTableOrderIssueLabel(orderIssue)}`,
      });
      return issues;
    }
  }
  return issues;
}

function pathTableOrderIssue(
  left: PathTableRecord,
  leftLevel: number,
  right: PathTableRecord,
  rightLevel: number,
): "level" | "parent" | "identifier" | undefined {
  if (leftLevel > rightLevel) {
    return "level";
  }
  if (leftLevel !== rightLevel) {
    return undefined;
  }
  if (left.parentDirectoryNumber > right.parentDirectoryNumber) {
    return "parent";
  }
  if (left.parentDirectoryNumber !== right.parentDirectoryNumber) {
    return undefined;
  }
  return comparePathTableIdentifierBytes(left.identifier, right.identifier) > 0 ? "identifier" : undefined;
}

function pathTableOrderIssueLabel(issue: "level" | "parent" | "identifier"): string {
  switch (issue) {
    case "level":
      return "hierarchy level";
    case "parent":
      return "parent directory number";
    case "identifier":
      return "directory identifier";
  }
}

function pathTableParseIssueCode(codePrefix: string, endian: "little" | "big", message: string): string {
  if (message.includes("padding byte")) {
    return `${codePrefix}.${endian}.record_padding`;
  }
  if (message.includes("invalid length") || message.includes("zero identifier length")) {
    return `${codePrefix}.${endian}.record_length`;
  }
  return `${codePrefix}.${endian}.parse`;
}

function validateOptionalPathTableReference(
  image: Uint8Array,
  descriptor: PathTableValidationInput,
  codePrefix: string,
  endian: "little" | "big",
): { issues: ValidationIssue[]; records?: PathTableRecord[] } {
  const location = endian === "little" ? descriptor.optionalTypeLPathTableLocation : descriptor.optionalTypeMPathTableLocation;
  if (location === 0) {
    return { issues: [] };
  }
  return validatePathTableReference(image, descriptor, `${codePrefix}.optional`, endian, location);
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

function validatePathTableCopy(
  required: PathTableRecord[],
  optional: PathTableRecord[],
  codePrefix: string,
  endian: "little" | "big",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const label = endian === "little" ? "Type L" : "Type M";
  if (required.length !== optional.length) {
    issues.push({
      code: `${codePrefix}.optional.${endian}.mismatch`,
      message: `optional ${label} path table has a different record count than the mandatory ${label} path table: ${optional.length} !== ${required.length}`,
    });
  }
  for (let index = 0; index < Math.min(required.length, optional.length); index += 1) {
    if (!samePathTableRecord(required[index]!, optional[index]!)) {
      issues.push({
        code: `${codePrefix}.optional.${endian}.mismatch`,
        message: `optional ${label} path table record ${index + 1} does not match the mandatory ${label} path table`,
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
  const visited = new Set<number>();
  const queue: Array<{
    directory: IsoDirectoryEntry;
    identifier: Uint8Array;
    parentDirectoryNumber: number;
    parentKey: string;
  }> = [{
    directory: root,
    identifier: Uint8Array.of(0),
    parentDirectoryNumber: 1,
    parentKey: "",
  }];
  const visit = ({ directory, identifier, parentDirectoryNumber, parentKey }: {
    directory: IsoDirectoryEntry;
    identifier: Uint8Array;
    parentDirectoryNumber: number;
    parentKey: string;
  }): void => {
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

    const directoryBytes = readDirectoryExtentBytes(image, directory);
    if (!directoryBytes) {
      return;
    }
    const childDirectories: Array<{ directory: IsoDirectoryEntry; identifier: Uint8Array }> = [];
    let offset = 0;
    let recordIndex = 0;
    while (offset < directoryBytes.byteLength) {
      const length = directoryBytes[offset]!;
      if (length === 0) {
        offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
        continue;
      }
      if (length < 34 || offset + length > directoryBytes.byteLength || (offset % SECTOR_SIZE) + length > SECTOR_SIZE) {
        offset += Math.max(1, length);
        continue;
      }
      let record: DecodedDirectoryRecord;
      try {
        record = decodeDirectoryRecord(directoryBytes, offset, directoryBytes.byteLength);
      } catch {
        offset += length;
        continue;
      }
      offset += record.length;
      if (
        recordIndex++ < 2
        || (record.flags & FILE_FLAG_DIRECTORY) !== FILE_FLAG_DIRECTORY
        || record.volumeSequenceNumber !== directory.volumeSequenceNumber
      ) {
        continue;
      }
      childDirectories.push({ directory: directoryEntryFromRecord(record, "", []), identifier: record.identifier });
    }
    childDirectories.sort((left, right) => comparePathTableIdentifierBytes(left.identifier, right.identifier));
    for (const child of childDirectories) {
      queue.push({
        directory: child.directory,
        identifier: child.identifier,
        parentDirectoryNumber: directoryNumber,
        parentKey: key,
      });
    }
  };

  try {
    for (let index = 0; index < queue.length; index += 1) {
      visit(queue[index]!);
    }
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

function comparePathTableIdentifierBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = left[index] ?? 0x20;
    const rightByte = right[index] ?? 0x20;
    if (leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return 0;
}

function bytesKey(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateDirectoryRecordLayout(image: Uint8Array, directory: IsoDirectoryEntry, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const directoryBytes = readDirectoryExtentBytes(image, directory);
  if (!directoryBytes) {
    return [{ code: "directory.record_bounds", message: `directory extent for ${path} is out of bounds`, path }];
  }
  let offset = 0;
  while (offset < directoryBytes.byteLength) {
    const length = directoryBytes[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    if ((offset % SECTOR_SIZE) + length > SECTOR_SIZE) {
      issues.push({ code: "directory.record_crosses_sector", message: `directory record crosses a logical sector boundary at ${path}`, path });
      offset += 1;
      continue;
    }
    try {
      decodeDirectoryRecord(directoryBytes, offset, directoryBytes.byteLength);
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
    if ((directoryBytes[offset + 25]! & 0x60) !== 0) {
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
  localVolumeSequenceNumber: number,
  visited: Set<number>,
  options: { validatePrimaryLevelOne?: boolean; depth?: number } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const validatePrimaryLevelOne = options.validatePrimaryLevelOne ?? false;
  const depth = options.depth ?? 1;
  if (directory.volumeSequenceNumber !== localVolumeSequenceNumber) {
    return issues;
  }
  if (validatePrimaryLevelOne && depth > 8) {
    issues.push({
      code: "directory.hierarchy_depth",
      message: "primary directory hierarchy depth must not exceed 8 levels",
      path,
    });
  }
  const key = directory.extent;
  if (visited.has(key)) {
    return [{ code: "directory.cycle", message: `directory cycle detected at ${path}`, path }];
  }
  visited.add(key);
  issues.push(...validateDirectoryDataLength(directory, path));
  issues.push(...validateDirectoryRecordLayout(image, directory, path));
  issues.push(...validateExtendedAttributeRecords(image, directory, path, localVolumeSequenceNumber));

  const directoryBytes = readDirectoryExtentBytes(image, directory);
  if (!directoryBytes) {
    return issues;
  }
  let offset = 0;
  let recordIndex = 0;
  let previousOrdinaryRecord: DecodedDirectoryRecord | undefined;
  let previousOrdinaryPath = "";
  let pendingMultiExtentRecord: DecodedDirectoryRecord | undefined;
  let pendingMultiExtentPath = "";
  const ordinaryRecordKeys = new Set<string>();
  while (offset < directoryBytes.byteLength) {
    const length = directoryBytes[offset]!;
    if (length === 0) {
      if (recordIndex === 0) {
        issues.push({ code: "directory.self_record.missing", message: `directory self record is missing at ${path}`, path });
      } else if (recordIndex === 1) {
        issues.push({ code: "directory.parent_record.missing", message: `directory parent record is missing at ${path}`, path });
      }
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    if (length < 34 || offset + length > directoryBytes.byteLength || (offset % SECTOR_SIZE) + length > SECTOR_SIZE) {
      offset += Math.max(1, length);
      continue;
    }
    let record: DecodedDirectoryRecord;
    try {
      record = decodeDirectoryRecord(directoryBytes, offset, directoryBytes.byteLength);
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
    if ((record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY) {
      issues.push(...validateDirectoryRecordDirectoryFlags(record.flags, recordPath || path));
      issues.push(...validateDirectoryProtectionExtendedAttributeFlags(record, recordPath || path));
    }
    if (index >= 2) {
      const isDirectory = (record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY;
      const isMultiExtentContinuationRecord = pendingMultiExtentRecord
        ? isMultiExtentContinuation(pendingMultiExtentRecord, record)
        : false;
      if (pendingMultiExtentRecord && !isMultiExtentContinuationRecord) {
        issues.push({
          code: "directory.multi_extent_sequence",
          message: `multi-extent file record at ${pendingMultiExtentPath} is not followed by a matching file section`,
          path: pendingMultiExtentPath,
        });
        pendingMultiExtentRecord = undefined;
        pendingMultiExtentPath = "";
      }
      issues.push(...validateOrdinaryDirectoryRecordIdentifier(record, recordPath || "."));
      issues.push(...validateOrdinaryFileExtendedAttributeFlags(record, recordPath || "."));
      const recordKey = ordinaryDirectoryRecordKey(record);
      if (ordinaryRecordKeys.has(recordKey) && !isMultiExtentContinuationRecord) {
        issues.push({
          code: "directory.record_duplicate",
          message: `directory records at ${path} contain duplicate file identifier entries`,
          path: recordPath || ".",
        });
      }
      ordinaryRecordKeys.add(recordKey);
      if (previousOrdinaryRecord && !isMultiExtentContinuationRecord && compareDirectoryRecordOrder(previousOrdinaryRecord, record) > 0) {
        issues.push({
          code: "directory.record_order",
          message: `directory records at ${path} are not ordered according to ECMA-119 file identifier ordering`,
          path: recordPath || previousOrdinaryPath || path,
        });
      }
      previousOrdinaryRecord = record;
      previousOrdinaryPath = recordPath || ".";
      if (!isDirectory && (record.flags & FILE_FLAG_MULTI_EXTENT) !== 0) {
        pendingMultiExtentRecord = record;
        pendingMultiExtentPath = recordPath || ".";
      } else if (isMultiExtentContinuationRecord) {
        pendingMultiExtentRecord = undefined;
        pendingMultiExtentPath = "";
      }
    }
    if (index >= 2 && validatePrimaryLevelOne) {
      issues.push(...validatePrimaryDirectoryRecordIdentifier(record, recordPath || "."));
    }
    if (record.fileUnitSize === 0 && record.interleaveGapSize !== 0) {
      issues.push({
        code: "directory.interleaving_invalid",
        message: `directory record at ${recordPath || "."} has invalid interleaved file section fields`,
        path: recordPath || ".",
      });
    } else if (
      record.fileUnitSize !== 0
      && record.extendedAttributeRecordLength !== 0
      && record.extendedAttributeRecordLength !== record.fileUnitSize
    ) {
      const recordKind = (record.flags & FILE_FLAG_DIRECTORY) !== 0 ? "directory" : "file";
      issues.push({
        code: "directory.interleaved_ear_length",
        message: `interleaved ${recordKind} record at ${recordPath || "."} has extended attribute record length ${record.extendedAttributeRecordLength}; expected file unit size ${record.fileUnitSize}`,
        path: recordPath || ".",
      });
    }
    if (record.volumeSequenceNumber !== localVolumeSequenceNumber) {
      issues.push(...validateDirectoryRecordVolumeSequence(record, recordPath || ".", localVolumeSequenceNumber));
    }
    if ((record.flags & FILE_FLAG_MULTI_EXTENT) !== 0 && (record.flags & FILE_FLAG_DIRECTORY) !== 0) {
      issues.push({
        code: "directory.multi_extent_unsupported",
        message: `directory record at ${recordPath || "."} uses unsupported multi-extent file sections`,
        path: recordPath || ".",
      });
    }
    if (
      index < 2
      || (record.flags & FILE_FLAG_DIRECTORY) !== FILE_FLAG_DIRECTORY
      || record.volumeSequenceNumber !== localVolumeSequenceNumber
    ) {
      continue;
    }
    const childPath = recordPath || ".";
    issues.push(...validateDirectoryHierarchy(image, directoryEntryFromRecord(record, childPath, []), directory, childPath, localVolumeSequenceNumber, new Set(visited), {
      depth: depth + 1,
      validatePrimaryLevelOne,
    }));
  }
  if (pendingMultiExtentRecord) {
    issues.push({
      code: "directory.multi_extent_final_missing",
      message: `multi-extent file record at ${pendingMultiExtentPath} is missing its final file section`,
      path: pendingMultiExtentPath,
    });
  }
  return issues;
}

function validateDirectoryDataLength(directory: IsoDirectoryEntry, path: string): ValidationIssue[] {
  if (directory.size > 0 && directory.size % SECTOR_SIZE === 0) {
    return [];
  }
  return [{
    code: "directory.data_length_alignment",
    message: `directory data length at ${path} must be a positive multiple of the logical block size`,
    path,
  }];
}

function validateOrdinaryDirectoryRecordIdentifier(record: DecodedDirectoryRecord, path: string): ValidationIssue[] {
  if (record.identifier.length !== 1 || (record.identifier[0] !== 0 && record.identifier[0] !== 1)) {
    return [];
  }
  return [{
    code: "directory.record_identifier.special",
    message: `directory record at ${path} must not use special identifier ${record.identifier[0]} outside self/parent records`,
    path,
  }];
}

function validateOrdinaryFileExtendedAttributeFlags(record: DecodedDirectoryRecord, path: string): ValidationIssue[] {
  if ((record.flags & FILE_FLAG_DIRECTORY) !== 0 || record.extendedAttributeRecordLength !== 0 || (record.flags & 0x18) === 0) {
    return [];
  }
  return [{
    code: "directory.file_flags_extended_attribute_missing",
    message: `file record at ${path} sets Record or Protection flags without an extended attribute record`,
    path,
  }];
}

function validatePrimaryDirectoryRecordIdentifier(record: DecodedDirectoryRecord, path: string): ValidationIssue[] {
  const isDirectory = (record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY;
  if (isDirectory ? isSupportedPrimaryDirectoryIdentifier(record.identifier) : isSupportedPrimaryFileIdentifier(record.identifier)) {
    return [];
  }
  return [{
    code: isDirectory ? "directory.directory_identifier.characters" : "directory.file_identifier.characters",
    message: `primary directory record ${isDirectory ? "directory identifier contains invalid ECMA-119 primary d-characters" : "file identifier contains invalid ECMA-119 primary file identifier"}`,
    path,
  }];
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

function validateSupplementaryLikeVolumeDescriptor(
  image: Uint8Array,
  descriptor: SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor,
  descriptors: VolumeDescriptor[],
): ValidationIssue[] {
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
  issues.push(...validateDescriptorCharacterFields(descriptor, label, [
    { start: 8, length: 32, kind: "a", code: "system_identifier.characters", label: "system identifier" },
    { start: 40, length: 32, kind: "d", code: "volume_identifier.characters", label: "volume identifier" },
    { start: 190, length: 128, kind: "d", code: "volume_set_identifier.characters", label: "volume set identifier" },
    { start: 318, length: 128, kind: "a", code: "publisher_identifier.characters", label: "publisher identifier" },
    { start: 446, length: 128, kind: "a", code: "data_preparer_identifier.characters", label: "data preparer identifier" },
    { start: 574, length: 128, kind: "a", code: "application_identifier.characters", label: "application identifier" },
    { start: 702, length: 37, kind: "file", code: "copyright_file_identifier.characters", label: "copyright file identifier" },
    { start: 739, length: 37, kind: "file", code: "abstract_file_identifier.characters", label: "abstract file identifier" },
    { start: 776, length: 37, kind: "file", code: "bibliographic_file_identifier.characters", label: "bibliographic file identifier" },
  ]));
  issues.push(...validateSecondaryEscapeSequences(descriptor, label));
  issues.push(...validateVolumeSpaceSize(image, descriptor, descriptors, label));
  const expectedFileStructureVersion = descriptor.kind === "enhanced" ? 2 : 1;
  if (descriptor.fileStructureVersion !== expectedFileStructureVersion) {
    issues.push({
      code: `${label}.file_structure_version`,
      message: `${label} volume descriptor file structure version must be ${expectedFileStructureVersion}`,
    });
  }
  issues.push(...validateVolumeDescriptorMetadata(descriptor, label, `${label} volume descriptor`));
  issues.push(...validateDirectoryEntryInterleaving(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryEntryReservedFileFlags(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryEntryDirectoryFlags(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryProtectionExtendedAttributeFlags(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryEntryVolumeSequence(descriptor.rootDirectoryRecord, `${label}:.`, descriptor.volumeSequenceNumber));
  issues.push(...validateDirectoryEntryMultiExtent(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryEntryExtendedAttributeRecord(image, descriptor.rootDirectoryRecord, `${label}:.`, descriptor.volumeSequenceNumber));
  issues.push(...validatePathTableReferences(image, descriptor, `${label}_path_table`));
  issues.push(...validateDirectoryHierarchy(image, descriptor.rootDirectoryRecord, descriptor.rootDirectoryRecord, `${label}:.`, descriptor.volumeSequenceNumber, new Set()));
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
    issues.push(...validateDescriptorCharacterFields(descriptor, "partition", [
      { start: 8, length: 32, kind: "a", code: "system_identifier.characters", label: "system identifier" },
      { start: 40, length: 32, kind: "d", code: "volume_partition_identifier.characters", label: "volume partition identifier" },
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

function validateDescriptorCharacterFields(
  descriptor: VolumeDescriptor,
  codePrefix: string,
  fields: { start: number; length: number; kind: "a" | "d" | "file"; code: string; label: string }[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const field of fields) {
    const text = readAscii(descriptor.raw, field.start, field.length);
    if (!isDescriptorCharacterField(text, field.kind)) {
      issues.push({
        code: `${codePrefix}.${field.code}`,
        message: `${descriptor.kind} volume descriptor ${field.label} contains invalid ECMA-119 ${field.kind}-characters`,
      });
    }
  }
  return issues;
}

function isDescriptorCharacterField(text: string, kind: "a" | "d" | "file"): boolean {
  if (kind === "a") {
    return isAString(text);
  }
  const value = text.replace(/ +$/u, "");
  if (kind === "d") {
    return isDString(value);
  }
  return value === "" || isSupportedPrimaryFileIdentifier(new TextEncoder().encode(value));
}

function validateSecondaryEscapeSequences(
  descriptor: SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor,
  codePrefix: "supplementary" | "enhanced",
): ValidationIssue[] {
  const bytes = descriptor.raw.subarray(88, 120);
  if (allZero(bytes)) {
    return [];
  }
  if (bytes[0] === 0) {
    return [{
      code: `${codePrefix}.escape_sequences.start`,
      message: `${descriptor.kind} volume descriptor escape sequences must start at BP 89 when present`,
    }];
  }
  const firstZero = bytes.indexOf(0);
  if (firstZero !== -1 && !allZero(bytes.subarray(firstZero))) {
    return [{
      code: `${codePrefix}.escape_sequences.padding`,
      message: `${descriptor.kind} volume descriptor escape sequences field must be zero after the last escape sequence byte`,
    }];
  }
  return [];
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
    volumeSetIdentifier: readAsciiTrimmed(image, offset + 190, 128),
    publisherIdentifier: readAsciiTrimmed(image, offset + 318, 128),
    dataPreparerIdentifier: readAsciiTrimmed(image, offset + 446, 128),
    applicationIdentifier: readAsciiTrimmed(image, offset + 574, 128),
    copyrightFileIdentifier: readAsciiTrimmed(image, offset + 702, 37),
    abstractFileIdentifier: readAsciiTrimmed(image, offset + 739, 37),
    bibliographicFileIdentifier: readAsciiTrimmed(image, offset + 776, 37),
    fileStructureVersion: image[offset + 881]!,
    applicationUse: image.slice(offset + 883, offset + 1395),
    createdAt: decodeSecondaryVolumeDate(image, offset + 813),
    modifiedAt: decodeSecondaryVolumeDate(image, offset + 830),
    expiresAt: decodeSecondaryVolumeDate(image, offset + 847),
    effectiveAt: decodeSecondaryVolumeDate(image, offset + 864),
    escapeSequences: image.slice(offset + 88, offset + 120),
  };
  return image[offset + 6] === 2
    ? { ...common, kind: "enhanced", version: 2 }
    : { ...common, kind: "supplementary", version: 1 };
}

function decodeSecondaryVolumeDate(image: Uint8Array, offset: number): Date | null {
  const bytes = image.subarray(offset, offset + 17);
  if (allZero(bytes)) {
    return null;
  }
  return decodeVolumeDate(image, offset);
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
  if (descriptor.kind === "partition") {
    if (!includeData) {
      return descriptor;
    }
    const start = descriptor.volumePartitionLocation * SECTOR_SIZE;
    const end = start + descriptor.volumePartitionSize * SECTOR_SIZE;
    assertExtentInBounds(image, descriptor.volumePartitionLocation, 0, descriptor.volumePartitionSize * SECTOR_SIZE, `partition:${descriptor.volumePartitionIdentifier}`);
    return {
      ...descriptor,
      data: image.slice(start, end),
    };
  }
  if (descriptor.kind !== "primary" && descriptor.kind !== "supplementary" && descriptor.kind !== "enhanced") {
    return descriptor;
  }
  if (descriptor.rootDirectoryRecord.size === 0) {
    return descriptor;
  }
  assertSupportedDirectoryEntry(
    descriptor.rootDirectoryRecord,
    descriptor.kind === "primary" ? "." : `${descriptor.kind}:.`,
    descriptor.volumeSequenceNumber,
  );
  return {
    ...descriptor,
    rootDirectoryRecord: readDirectoryTree(image, descriptor.rootDirectoryRecord, "", includeData, descriptor.volumeSequenceNumber, new Set()),
  };
}

function readDirectoryTree(image: Uint8Array, directory: IsoDirectoryEntry, path: string, includeData: boolean, localVolumeSequenceNumber: number, visited: Set<number>): IsoDirectoryEntry {
  assertSupportedDirectoryEntry(directory, path || ".", localVolumeSequenceNumber);
  assertDirectoryInBounds(image, directory, path || ".");
  if (visited.has(directory.extent)) {
    throw new Error(`invalid directory cycle detected at ${path || "."}`);
  }
  visited.add(directory.extent);
  const bytes = readDirectoryExtentBytes(image, directory);
  if (!bytes) {
    throw new Error(`invalid extent bounds for ${path || "."}`);
  }
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
      assertSupportedDirectoryRecord(record, path || ".", localVolumeSequenceNumber, { allowInterleaving: true });
      continue;
    }

    if ((record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY) {
      const identifier = decodeFileIdentifier(record.identifier);
      const cleanName = stripVersion(identifier);
      const recordPath = joinPath(path, cleanName);
      assertSupportedDirectoryRecord(record, recordPath || ".", localVolumeSequenceNumber, { allowInterleaving: true });
      const childPath = joinPath(path, identifier);
      const child = directoryEntryFromRecord(record, childPath, []);
      if (record.extendedAttributeRecordLength > 0) {
        child.extendedAttributeRecord = readExtendedAttributeRecord(image, record);
        const fields = decodeOptionalExtendedAttributeRecord(child.extendedAttributeRecord);
        if (fields) {
          child.extendedAttributeRecordFields = fields;
        }
      }
      children.push(readDirectoryTree(image, child, childPath, includeData, localVolumeSequenceNumber, new Set(visited)));
    } else {
      const identifier = decodeFileIdentifier(record.identifier);
      const cleanName = stripVersion(identifier);
      const filePath = joinPath(path, cleanName);
      const chain = readFileSectionChain(bytes, offset, record, filePath);
      offset = chain.nextOffset;
      recordIndex += chain.records.length - 1;
      const firstRecord = chain.records[0]!;
      for (const section of chain.records) {
        assertSupportedDirectoryRecord(section, filePath || ".", localVolumeSequenceNumber, { allowInterleaving: true, allowMultiExtent: true });
        assertFileSectionInBounds(image, section, filePath);
      }
      const file: IsoFileEntry = fileEntryFromSectionChain(chain.records, filePath, identifier);
      if (firstRecord.extendedAttributeRecordLength > 0) {
        file.extendedAttributeRecord = readExtendedAttributeRecord(image, firstRecord);
        const fields = decodeOptionalExtendedAttributeRecord(file.extendedAttributeRecord);
        if (fields) {
          file.extendedAttributeRecordFields = fields;
        }
      }
      if (firstRecord.systemUse.byteLength > 0) {
        file.systemUse = firstRecord.systemUse;
      }
      if (includeData) {
        file.data = readFileSectionData(image, chain.records);
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

function readFileSectionChain(
  directoryBytes: Uint8Array,
  offset: number,
  firstRecord: DecodedDirectoryRecord,
  path: string,
): { records: DecodedDirectoryRecord[]; nextOffset: number } {
  const records = [firstRecord];
  let nextOffset = offset;
  let previous = firstRecord;

  while ((previous.flags & FILE_FLAG_MULTI_EXTENT) !== 0) {
    nextOffset = nextDirectoryRecordOffset(directoryBytes, nextOffset);
    if (nextOffset >= directoryBytes.byteLength) {
      throw new Error(`multi-extent file record at ${path || "."} is missing its final file section`);
    }
    const length = directoryBytes[nextOffset]!;
    if ((nextOffset % SECTOR_SIZE) + length > SECTOR_SIZE) {
      throw new Error(`directory record crosses a logical sector boundary at ${path || "."}`);
    }
    const next = decodeDirectoryRecord(directoryBytes, nextOffset, directoryBytes.byteLength);
    if (!isMultiExtentContinuation(previous, next)) {
      throw new Error(`multi-extent file record at ${path || "."} is not followed by a matching file section`);
    }
    records.push(next);
    nextOffset += next.length;
    previous = next;
  }

  return { records, nextOffset };
}

function nextDirectoryRecordOffset(directoryBytes: Uint8Array, offset: number): number {
  let nextOffset = offset;
  while (nextOffset < directoryBytes.byteLength && directoryBytes[nextOffset] === 0) {
    nextOffset = Math.ceil((nextOffset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
  }
  return nextOffset;
}

function isMultiExtentContinuation(previous: DecodedDirectoryRecord, current: DecodedDirectoryRecord): boolean {
  return (previous.flags & FILE_FLAG_DIRECTORY) === 0
    && (current.flags & FILE_FLAG_DIRECTORY) === 0
    && bytesEqual(previous.identifier, current.identifier)
    && (previous.flags & ~FILE_FLAG_MULTI_EXTENT) === (current.flags & ~FILE_FLAG_MULTI_EXTENT)
    && previous.fileUnitSize === current.fileUnitSize
    && previous.interleaveGapSize === current.interleaveGapSize
    && previous.volumeSequenceNumber === current.volumeSequenceNumber;
}

function fileEntryFromSectionChain(records: DecodedDirectoryRecord[], path: string, identifier: string): IsoFileEntry {
  const first = records[0]!;
  const sections = records.map(fileSectionFromRecord);
  const size = sections.reduce((sum, section) => sum + section.size, 0);
  const file: IsoFileEntry = {
    path,
    identifier,
    extent: first.extent,
    extendedAttributeRecordLength: first.extendedAttributeRecordLength,
    size,
    date: first.date,
    flags: first.flags,
    fileUnitSize: first.fileUnitSize,
    interleaveGapSize: first.interleaveGapSize,
    volumeSequenceNumber: first.volumeSequenceNumber,
  };
  if (records.length > 1) {
    file.sections = sections;
  }
  return file;
}

function fileSectionFromRecord(record: DecodedDirectoryRecord): IsoFileSection {
  return {
    extent: record.extent,
    extendedAttributeRecordLength: record.extendedAttributeRecordLength,
    size: record.dataLength,
    flags: record.flags,
    fileUnitSize: record.fileUnitSize,
    interleaveGapSize: record.interleaveGapSize,
    volumeSequenceNumber: record.volumeSequenceNumber,
  };
}

function readFileSectionData(image: Uint8Array, records: DecodedDirectoryRecord[]): Uint8Array {
  const totalSize = records.reduce((sum, record) => sum + record.dataLength, 0);
  const data = new Uint8Array(totalSize);
  let offset = 0;
  for (const record of records) {
    offset = readFileSectionPayload(image, record, data, offset);
  }
  return data;
}

function readFileSectionPayload(image: Uint8Array, record: DecodedDirectoryRecord, target: Uint8Array, targetOffset: number): number {
  return readSectionPayload(image, {
    extent: record.extent,
    extendedAttributeRecordLength: record.extendedAttributeRecordLength,
    dataLength: record.dataLength,
    fileUnitSize: record.fileUnitSize,
    interleaveGapSize: record.interleaveGapSize,
  }, target, targetOffset);
}

function readSectionPayload(
  image: Uint8Array,
  section: { extent: number; extendedAttributeRecordLength: number; dataLength: number; fileUnitSize: number; interleaveGapSize: number },
  target: Uint8Array,
  targetOffset: number,
): number {
  const dataStart = sectionDataStartSector(section) * SECTOR_SIZE;
  if (section.fileUnitSize === 0) {
    target.set(image.subarray(dataStart, dataStart + section.dataLength), targetOffset);
    return targetOffset + section.dataLength;
  }

  const unitBytes = section.fileUnitSize * SECTOR_SIZE;
  const strideBytes = (section.fileUnitSize + section.interleaveGapSize) * SECTOR_SIZE;
  let remaining = section.dataLength;
  let sourceOffset = dataStart;
  let writeOffset = targetOffset;
  while (remaining > 0) {
    const chunk = Math.min(unitBytes, remaining);
    target.set(image.subarray(sourceOffset, sourceOffset + chunk), writeOffset);
    sourceOffset += strideBytes;
    writeOffset += chunk;
    remaining -= chunk;
  }
  return writeOffset;
}

function validateExtendedAttributeRecords(image: Uint8Array, directory: IsoDirectoryEntry, path: string, localVolumeSequenceNumber: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const directoryBytes = readDirectoryExtentBytes(image, directory);
  if (!directoryBytes) {
    return issues;
  }
  let offset = 0;
  let recordIndex = 0;
  while (offset < directoryBytes.byteLength) {
    const length = directoryBytes[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    if (length < 34 || offset + length > directoryBytes.byteLength || (offset % SECTOR_SIZE) + length > SECTOR_SIZE) {
      offset += Math.max(1, length);
      continue;
    }
    let record: DecodedDirectoryRecord;
    try {
      record = decodeDirectoryRecord(directoryBytes, offset, directoryBytes.byteLength);
    } catch {
      offset += length;
      continue;
    }
    offset += record.length;
    if (
      recordIndex++ < 2
      || record.extendedAttributeRecordLength === 0
      || record.volumeSequenceNumber !== localVolumeSequenceNumber
    ) {
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

function validateDirectoryEntryExtendedAttributeRecord(image: Uint8Array, entry: IsoDirectoryEntry, path: string, localVolumeSequenceNumber: number): ValidationIssue[] {
  if (entry.extendedAttributeRecordLength === 0 || entry.volumeSequenceNumber !== localVolumeSequenceNumber) {
    return [];
  }
  const extendedAttributeRecord = image.slice(entry.extent * SECTOR_SIZE, (entry.extent + entry.extendedAttributeRecordLength) * SECTOR_SIZE);
  try {
    const fields = decodeExtendedAttributeRecord(extendedAttributeRecord);
    const expected = extendedAttributeRecordFileFlags(fields) & 0x10;
    if ((entry.flags & 0x10) !== expected) {
      return [{
        code: "extended_attribute_record.file_flags",
        message: `directory record flags for ${path} do not match associated extended attribute record fields`,
        path,
      }];
    }
  } catch (error) {
    return [{
      code: "extended_attribute_record.parse",
      message: error instanceof Error ? error.message : String(error),
      path,
    }];
  }
  return [];
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

function readDirectoryExtentBytes(image: Uint8Array, directory: IsoDirectoryEntry): Uint8Array | undefined {
  if (!sectionInBounds(image, {
    extent: directory.extent,
    extendedAttributeRecordLength: directory.extendedAttributeRecordLength,
    dataLength: directory.size,
    fileUnitSize: directory.fileUnitSize,
    interleaveGapSize: directory.interleaveGapSize,
  })) {
    return undefined;
  }
  const bytes = new Uint8Array(directory.size);
  readSectionPayload(image, {
    extent: directory.extent,
    extendedAttributeRecordLength: directory.extendedAttributeRecordLength,
    dataLength: directory.size,
    fileUnitSize: directory.fileUnitSize,
    interleaveGapSize: directory.interleaveGapSize,
  }, bytes, 0);
  return bytes;
}

function assertDirectoryInBounds(image: Uint8Array, directory: IsoDirectoryEntry, path: string): void {
  if (!sectionInBounds(image, {
    extent: directory.extent,
    extendedAttributeRecordLength: directory.extendedAttributeRecordLength,
    dataLength: directory.size,
    fileUnitSize: directory.fileUnitSize,
    interleaveGapSize: directory.interleaveGapSize,
  })) {
    throw new Error(`invalid extent bounds for ${path}`);
  }
}

function assertFileSectionInBounds(image: Uint8Array, record: DecodedDirectoryRecord, path: string): void {
  if (!sectionInBounds(image, {
    extent: record.extent,
    extendedAttributeRecordLength: record.extendedAttributeRecordLength,
    dataLength: record.dataLength,
    fileUnitSize: record.fileUnitSize,
    interleaveGapSize: record.interleaveGapSize,
  })) {
    throw new Error(`invalid extent bounds for ${path}`);
  }
}

function fileSectionStorageByteLength(record: Pick<DecodedDirectoryRecord, "dataLength" | "fileUnitSize" | "interleaveGapSize">): number {
  if (record.fileUnitSize === 0) {
    return record.dataLength;
  }
  const unitBytes = record.fileUnitSize * SECTOR_SIZE;
  const units = Math.ceil(record.dataLength / unitBytes);
  if (units === 0) {
    return 0;
  }
  const fullStrides = (units - 1) * (record.fileUnitSize + record.interleaveGapSize) * SECTOR_SIZE;
  const finalUnitBytes = record.dataLength - (units - 1) * unitBytes;
  return fullStrides + finalUnitBytes;
}

function fileSectionStorageSectors(record: Pick<DecodedDirectoryRecord, "dataLength" | "fileUnitSize" | "interleaveGapSize">): number {
  if (record.fileUnitSize === 0) {
    return Math.max(1, sectorsForBytes(record.dataLength));
  }
  return sectorsForBytes(fileSectionStorageByteLength(record));
}

function fileSectionExtentSectors(record: Pick<DecodedDirectoryRecord, "dataLength" | "extendedAttributeRecordLength" | "fileUnitSize" | "interleaveGapSize">): number {
  return sectionExtentSectors(record);
}

function sectionExtentSectors(record: Pick<DecodedDirectoryRecord, "dataLength" | "extendedAttributeRecordLength" | "fileUnitSize" | "interleaveGapSize">): number {
  if (record.fileUnitSize === 0 || record.extendedAttributeRecordLength === 0) {
    return record.extendedAttributeRecordLength + fileSectionStorageSectors(record);
  }
  return record.extendedAttributeRecordLength + record.interleaveGapSize + fileSectionStorageSectors(record);
}

function sectionInBounds(
  image: Uint8Array,
  record: Pick<DecodedDirectoryRecord, "extent" | "dataLength" | "extendedAttributeRecordLength" | "fileUnitSize" | "interleaveGapSize">,
): boolean {
  const start = record.extent * SECTOR_SIZE;
  const end = start + sectionExtentSectors(record) * SECTOR_SIZE;
  return Number.isInteger(record.extent)
    && Number.isInteger(record.dataLength)
    && Number.isInteger(record.extendedAttributeRecordLength)
    && Number.isInteger(record.fileUnitSize)
    && Number.isInteger(record.interleaveGapSize)
    && record.extent >= 0
    && record.dataLength >= 0
    && record.extendedAttributeRecordLength >= 0
    && record.fileUnitSize >= 0
    && record.interleaveGapSize >= 0
    && start >= 0
    && end <= image.byteLength;
}

function sectionDataStartSector(record: Pick<DecodedDirectoryRecord, "extent" | "extendedAttributeRecordLength" | "fileUnitSize" | "interleaveGapSize">): number {
  if (record.fileUnitSize !== 0 && record.extendedAttributeRecordLength !== 0) {
    return record.extent + record.extendedAttributeRecordLength + record.interleaveGapSize;
  }
  return record.extent + record.extendedAttributeRecordLength;
}

function assertSupportedDirectoryRecord(
  record: DecodedDirectoryRecord,
  path: string,
  localVolumeSequenceNumber: number,
  options: { allowInterleaving?: boolean; allowMultiExtent?: boolean } = {},
): void {
  assertSupportedDirectoryFileFlags(record.flags, path);
  if (!options.allowInterleaving && (record.fileUnitSize !== 0 || record.interleaveGapSize !== 0)) {
    throw new Error(`directory record at ${path} uses unsupported interleaved file section fields`);
  }
  if (record.fileUnitSize === 0 && record.interleaveGapSize !== 0) {
    throw new Error(`directory record at ${path} has invalid interleaved file section fields`);
  }
  if (
    options.allowInterleaving
    && record.fileUnitSize !== 0
    && record.extendedAttributeRecordLength !== 0
    && record.extendedAttributeRecordLength !== record.fileUnitSize
  ) {
    const recordKind = (record.flags & FILE_FLAG_DIRECTORY) !== 0 ? "directory" : "file";
    throw new Error(`interleaved ${recordKind} record at ${path} has extended attribute record length ${record.extendedAttributeRecordLength}; expected file unit size ${record.fileUnitSize}`);
  }
  if (!options.allowMultiExtent && (record.flags & FILE_FLAG_MULTI_EXTENT) !== 0) {
    throw new Error(`directory record at ${path} uses unsupported multi-extent file sections`);
  }
  assertSupportedVolumeSequence(record.volumeSequenceNumber, path, localVolumeSequenceNumber);
}

function assertSupportedDirectoryEntry(entry: IsoDirectoryEntry, path: string, localVolumeSequenceNumber: number): void {
  assertSupportedDirectoryFileFlags(entry.flags, path);
  if (entry.fileUnitSize === 0 && entry.interleaveGapSize !== 0) {
    throw new Error(`directory record at ${path} has invalid interleaved file section fields`);
  }
  if (
    entry.fileUnitSize !== 0
    && entry.extendedAttributeRecordLength !== 0
    && entry.extendedAttributeRecordLength !== entry.fileUnitSize
  ) {
    throw new Error(`interleaved directory record at ${path} has extended attribute record length ${entry.extendedAttributeRecordLength}; expected file unit size ${entry.fileUnitSize}`);
  }
  if ((entry.flags & FILE_FLAG_MULTI_EXTENT) !== 0) {
    throw new Error(`directory record at ${path} uses unsupported multi-extent file sections`);
  }
  assertSupportedVolumeSequence(entry.volumeSequenceNumber, path, localVolumeSequenceNumber);
}

function assertSupportedDirectoryFileFlags(flags: number, path: string): void {
  if ((flags & 0x60) !== 0) {
    throw new Error(`directory record has reserved file flag bits set at ${path}`);
  }
}

function assertSupportedVolumeSequence(volumeSequenceNumber: number, path: string, localVolumeSequenceNumber: number): void {
  if (volumeSequenceNumber < 1) {
    throw new Error(`directory record at ${path} has invalid volume sequence number ${volumeSequenceNumber}`);
  }
  if (volumeSequenceNumber !== localVolumeSequenceNumber) {
    throw new Error(`directory record at ${path} references unsupported external volume sequence number ${volumeSequenceNumber}; expected local volume sequence number ${localVolumeSequenceNumber}`);
  }
}

function assertVolumeDescriptorMetadata(descriptor: PathTableValidationInput, label: string): void {
  if (descriptor.volumeSetSize < 1) {
    throw new Error(`${label} volume set size must be at least 1`);
  }
  if (descriptor.volumeSequenceNumber < 1) {
    throw new Error(`${label} volume sequence number must be at least 1`);
  }
  if (descriptor.volumeSequenceNumber > descriptor.volumeSetSize) {
    throw new Error(`${label} volume sequence number must be less than or equal to volume set size`);
  }
}

function validateVolumeDescriptorMetadata(descriptor: PathTableValidationInput, codePrefix: string, label: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (descriptor.volumeSetSize < 1) {
    issues.push({
      code: `${codePrefix}.volume_set_size.range`,
      message: `${label} volume set size must be at least 1`,
    });
  }
  if (descriptor.volumeSequenceNumber < 1) {
    issues.push({
      code: `${codePrefix}.volume_sequence_number.range`,
      message: `${label} volume sequence number must be at least 1`,
    });
  }
  if (issues.length === 0 && descriptor.volumeSequenceNumber > descriptor.volumeSetSize) {
    issues.push({
      code: `${codePrefix}.volume_sequence_number.bounds`,
      message: `${label} volume sequence number must be less than or equal to volume set size`,
    });
  }
  return issues;
}

function validateDirectoryEntryInterleaving(entry: IsoDirectoryEntry, path: string): ValidationIssue[] {
  if (entry.fileUnitSize === 0 && entry.interleaveGapSize === 0) {
    return [];
  }
  if (entry.fileUnitSize === 0) {
    return [{
      code: "directory.interleaving_invalid",
      message: `directory record at ${path} has invalid interleaved file section fields`,
      path,
    }];
  }
  if (entry.extendedAttributeRecordLength !== 0 && entry.extendedAttributeRecordLength !== entry.fileUnitSize) {
    return [{
      code: "directory.interleaved_ear_length",
      message: `interleaved directory record at ${path} has extended attribute record length ${entry.extendedAttributeRecordLength}; expected file unit size ${entry.fileUnitSize}`,
      path,
    }];
  }
  return [];
}

function validateDirectoryEntryReservedFileFlags(entry: Pick<IsoDirectoryEntry, "flags">, path: string): ValidationIssue[] {
  if ((entry.flags & 0x60) === 0) {
    return [];
  }
  return [{
    code: "directory.file_flags_reserved",
    message: `directory record has reserved file flag bits set at ${path}`,
    path,
  }];
}

function validateDirectoryEntryDirectoryFlags(entry: Pick<IsoDirectoryEntry, "flags">, path: string): ValidationIssue[] {
  return validateDirectoryRecordDirectoryFlags(entry.flags, path);
}

function validateDirectoryRecordDirectoryFlags(flags: number, path: string): ValidationIssue[] {
  if ((flags & 0x0c) === 0) {
    return [];
  }
  return [{
    code: "directory.file_flags_directory",
    message: `directory record at ${path} identifies a directory and must not set Associated File or Record bits`,
    path,
  }];
}

function validateDirectoryProtectionExtendedAttributeFlags(
  entry: Pick<IsoDirectoryEntry, "flags" | "extendedAttributeRecordLength"> | Pick<DecodedDirectoryRecord, "flags" | "extendedAttributeRecordLength">,
  path: string,
): ValidationIssue[] {
  if ((entry.flags & FILE_FLAG_DIRECTORY) === 0 || entry.extendedAttributeRecordLength !== 0 || (entry.flags & 0x10) === 0) {
    return [];
  }
  return [{
    code: "directory.file_flags_extended_attribute_missing",
    message: `directory record at ${path} sets Protection flag without an extended attribute record`,
    path,
  }];
}

function validateDirectoryEntryVolumeSequence(entry: IsoDirectoryEntry, path: string, localVolumeSequenceNumber: number): ValidationIssue[] {
  if (entry.volumeSequenceNumber === localVolumeSequenceNumber) {
    return [];
  }
  if (entry.volumeSequenceNumber < 1) {
    return [{
      code: "directory.volume_sequence_number.range",
      message: `directory record at ${path} has invalid volume sequence number ${entry.volumeSequenceNumber}`,
      path,
    }];
  }
  return [{
    code: "directory.volume_sequence_unsupported",
    message: `directory record at ${path} references unsupported external volume sequence number ${entry.volumeSequenceNumber}; expected local volume sequence number ${localVolumeSequenceNumber}`,
    path,
  }];
}

function validateDirectoryRecordVolumeSequence(record: DecodedDirectoryRecord, path: string, localVolumeSequenceNumber: number): ValidationIssue[] {
  if (record.volumeSequenceNumber === localVolumeSequenceNumber) {
    return [];
  }
  if (record.volumeSequenceNumber < 1) {
    return [{
      code: "directory.volume_sequence_number.range",
      message: `directory record at ${path} has invalid volume sequence number ${record.volumeSequenceNumber}`,
      path,
    }];
  }
  return [{
    code: "directory.volume_sequence_unsupported",
    message: `directory record at ${path} references unsupported external volume sequence number ${record.volumeSequenceNumber}; expected local volume sequence number ${localVolumeSequenceNumber}`,
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

function compareDirectoryRecordOrder(left: DecodedDirectoryRecord, right: DecodedDirectoryRecord): number {
  const leftIdentifier = splitFileIdentifier(left.identifier);
  const rightIdentifier = splitFileIdentifier(right.identifier);
  return compareRightPaddedBytes(leftIdentifier.name, rightIdentifier.name, 0x20)
    || compareRightPaddedBytes(leftIdentifier.extension, rightIdentifier.extension, 0x20)
    || -compareLeftPaddedBytes(leftIdentifier.version, rightIdentifier.version, 0x30)
    || compareAssociatedFileBit(right.flags, left.flags);
}

function splitFileIdentifier(identifier: Uint8Array): { name: Uint8Array; extension: Uint8Array; version: Uint8Array } {
  const separator2 = identifier.indexOf(0x3b);
  const withoutVersion = separator2 === -1 ? identifier : identifier.subarray(0, separator2);
  const version = separator2 === -1 ? new Uint8Array() : identifier.subarray(separator2 + 1);
  const separator1 = withoutVersion.indexOf(0x2e);
  if (separator1 === -1) {
    return { name: withoutVersion, extension: new Uint8Array(), version };
  }
  return {
    name: withoutVersion.subarray(0, separator1),
    extension: withoutVersion.subarray(separator1 + 1),
    version,
  };
}

function compareRightPaddedBytes(left: Uint8Array, right: Uint8Array, padding: number): number {
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = left[index] ?? padding;
    const rightByte = right[index] ?? padding;
    if (leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return 0;
}

function compareLeftPaddedBytes(left: Uint8Array, right: Uint8Array, padding: number): number {
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = left[index - (length - left.byteLength)] ?? padding;
    const rightByte = right[index - (length - right.byteLength)] ?? padding;
    if (leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return 0;
}

function compareAssociatedFileBit(leftFlags: number, rightFlags: number): number {
  const leftAssociated = (leftFlags & FILE_FLAG_ASSOCIATED) === FILE_FLAG_ASSOCIATED ? 1 : 0;
  const rightAssociated = (rightFlags & FILE_FLAG_ASSOCIATED) === FILE_FLAG_ASSOCIATED ? 1 : 0;
  return leftAssociated - rightAssociated;
}

function ordinaryDirectoryRecordKey(record: DecodedDirectoryRecord): string {
  const associated = (record.flags & FILE_FLAG_ASSOCIATED) === FILE_FLAG_ASSOCIATED ? "1" : "0";
  return `${bytesKey(record.identifier)}:${associated}`;
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
