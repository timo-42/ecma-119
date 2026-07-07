import { decodeVolumeDate, isAString, isDString, readAscii, readAsciiTrimmed, readDirectoryDateTime, readUint16Both, readUint32Both, readVolumeDescriptorDateTime, sectorOffset } from "./binary.js";
import { decodeDirectoryRecord, FILE_FLAG_ASSOCIATED, FILE_FLAG_DIRECTORY, FILE_FLAG_MULTI_EXTENT, type DecodedDirectoryRecord } from "./directory-record.js";
import { decodeExtendedAttributeRecord, extendedAttributeRecordFileFlags } from "./extended-attribute-record.js";
import { decodeFileIdentifier, isLevelOneFileIdentifier, isSupportedPrimaryDirectoryIdentifier, isSupportedPrimaryFileIdentifier, stripVersion } from "./identifiers.js";
import { decodePathTable, type PathTableRecord } from "./path-table.js";
import {
  type IsoDirectoryEntry,
  type IsoFileEntry,
  type IsoFileSection,
  type IsoImage,
  type IsoNode,
  type IsoPathTables,
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

type DirectoryIdentifierProfile = "supplementary" | "enhanced";
type DescriptorCharacterField = {
  start: number;
  length: number;
  kind: "a" | "d" | "file";
  code: string;
  label: string;
};
type DescriptorZeroRange = {
  start: number;
  end: number;
  code: "reserved" | "unused";
  label: string;
};

export function parseIsoImage(imageInput: Uint8Array | ArrayBuffer, options: { includeData?: boolean } = {}): IsoImage {
  const image = imageInput instanceof Uint8Array ? imageInput : new Uint8Array(imageInput);
  const descriptors = parseVolumeDescriptors(image);
  assertSupportedDescriptorSequenceProfile(descriptors);
  const pvd = descriptors.find((descriptor): descriptor is PrimaryVolumeDescriptor => descriptor.type === 1);
  if (!pvd) {
    throw new Error("missing primary volume descriptor");
  }
  assertSupportedDescriptorProfile(pvd, "primary volume descriptor");
  assertVolumeDescriptorMetadata(pvd, "primary volume descriptor");
  assertZeroDescriptorRanges(pvd, primaryVolumeDescriptorZeroRanges());
  assertDescriptorCharacterFields(pvd, primaryVolumeDescriptorCharacterFields());
  assertDescriptorRootDirectoryRecordIdentifier(pvd, "primary");
  validateDescriptorPathTableReferences(image, pvd, "primary volume descriptor");
  for (const descriptor of descriptors) {
    if (descriptor.kind === "boot") {
      assertSupportedBootVolumeDescriptor(descriptor);
    } else if (descriptor.kind === "partition") {
      assertZeroDescriptorRanges(descriptor, partitionDescriptorZeroRanges());
      assertSupportedPartitionVolumeDescriptor(image, descriptor, pvd);
    } else if (descriptor.kind === "supplementary" || descriptor.kind === "enhanced") {
      assertSupportedDescriptorProfile(descriptor, `${descriptor.kind} volume descriptor`);
      assertVolumeDescriptorMetadata(descriptor, `${descriptor.kind} volume descriptor`);
      assertZeroDescriptorRanges(descriptor, secondaryVolumeDescriptorZeroRanges());
      assertVolumeSetConsistentWithPrimary(descriptor, pvd);
      assertSupportedSecondaryVolumeFlags(descriptor);
      assertSupportedSecondaryEscapeSequences(descriptor);
      assertDescriptorCharacterFields(descriptor, commonVolumeDescriptorCharacterFields());
      assertDescriptorRootDirectoryRecordIdentifier(descriptor, descriptor.kind);
      validateDescriptorPathTableReferences(image, descriptor, `${descriptor.kind} volume descriptor`);
    } else if (descriptor.kind === "terminator") {
      assertVolumeDescriptorSetTerminatorReservedBytes(descriptor);
    }
  }
  assertSupportedDirectoryEntry(pvd.rootDirectoryRecord, ".", pvd.volumeSetSize);
  const includeData = options.includeData ?? true;
  const populatedDescriptors = descriptors.map((descriptor) => populateDescriptorDirectoryTree(image, descriptor, includeData));
  for (const descriptor of populatedDescriptors) {
    if (descriptor.kind === "primary") {
      assertDescriptorPathTableHierarchy(image, descriptor, "path_table");
    } else if (descriptor.kind === "supplementary" || descriptor.kind === "enhanced") {
      assertDescriptorPathTableHierarchy(image, descriptor, `${descriptor.kind}_path_table`);
    }
  }
  assertPrimaryVolumeSpaceSize(image, pvd, populatedDescriptors);
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
  issues.push(...validateRawDescriptorHeaders(image));
  issues.push(...validateRawDescriptorBothEndianFields(image));
  issues.push(...validateRawDescriptorRootDirectoryRecordBothEndianFields(image));
  issues.push(...validateRawDescriptorRootDirectoryRecordLayout(image));
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
      issues.push(...validateDirectoryHierarchy(image, pvd.rootDirectoryRecord, pvd.rootDirectoryRecord, ".", pvd.volumeSequenceNumber, pvd.volumeSetSize, new Set(), {
        validatePrimaryLevelOne: true,
      }));
      for (const descriptor of descriptors) {
        if (descriptor.kind === "supplementary" || descriptor.kind === "enhanced") {
          issues.push(...validateSupplementaryLikeVolumeDescriptor(image, descriptor, descriptors, pvd));
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
  issues.push(...validateDescriptorSequenceOrder(descriptors));
  return issues;
}

function assertSupportedDescriptorSequenceProfile(descriptors: VolumeDescriptor[]): void {
  const primaryCount = descriptors.filter((descriptor) => descriptor.kind === "primary").length;
  if (primaryCount > 1) {
    throw new Error(`volume descriptor sequence contains ${primaryCount} primary volume descriptors; the supported profile requires exactly one`);
  }
  const unknown = descriptors.find((descriptor) => descriptor.kind === "unknown");
  if (unknown) {
    throw new Error(`volume descriptor type ${unknown.type} at sector ${unknown.sector} is outside the supported profile`);
  }
  const orderIssue = validateDescriptorSequenceOrder(descriptors)[0];
  if (orderIssue) {
    throw new Error(orderIssue.message);
  }
}

function validateDescriptorSequenceOrder(descriptors: VolumeDescriptor[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let latestOrder = -1;
  for (const descriptor of descriptors) {
    const order = descriptorSequenceOrder(descriptor);
    if (order === undefined) {
      continue;
    }
    if (order < latestOrder) {
      issues.push({
        code: "descriptor.sequence.order",
        message: `volume descriptor ${descriptor.kind} at sector ${descriptor.sector} appears outside ECMA-119 descriptor sequence order`,
      });
      continue;
    }
    latestOrder = order;
  }
  return issues;
}

function descriptorSequenceOrder(descriptor: VolumeDescriptor): number | undefined {
  switch (descriptor.kind) {
    case "primary":
      return 0;
    case "supplementary":
      return 1;
    case "enhanced":
      return 2;
    case "partition":
      return 3;
    case "boot":
      return 4;
    case "terminator":
      return 5;
    case "unknown":
      return undefined;
  }
}

function validateRawDescriptorHeaders(image: Uint8Array): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let sector = SYSTEM_AREA_SECTORS;
  while (sectorOffset(sector + 1) <= image.byteLength) {
    const offset = sectorOffset(sector);
    if (allZero(image.subarray(offset, offset + SECTOR_SIZE))) {
      return issues;
    }
    const type = image[offset]!;
    const version = image[offset + 6]!;
    const identifier = readAscii(image, offset + 1, 5);
    const codePrefix = rawDescriptorCodePrefix(type, version);
    const label = rawDescriptorLabel(type, version);
    if (identifier !== STANDARD_IDENTIFIER) {
      issues.push({
        code: `${codePrefix}.identifier`,
        message: `${label} descriptor at sector ${sector} must use ${STANDARD_IDENTIFIER} standard identifier`,
      });
      return issues;
    }
    const allowedVersions = rawDescriptorAllowedVersions(type);
    if (allowedVersions && !allowedVersions.includes(version)) {
      issues.push({
        code: `${codePrefix}.version`,
        message: `${label} descriptor at sector ${sector} must use version ${allowedVersions.join(" or ")}`,
      });
    }
    if (type === 255) {
      return issues;
    }
    sector += 1;
  }
  return issues;
}

function rawDescriptorAllowedVersions(type: number): number[] | undefined {
  switch (type) {
    case 0:
    case 1:
    case 3:
    case 255:
      return [1];
    case 2:
      return [1, 2];
    default:
      return undefined;
  }
}

function rawDescriptorCodePrefix(type: number, version: number): string {
  switch (type) {
    case 0:
      return "boot";
    case 1:
      return "pvd";
    case 2:
      return version === 1 ? "supplementary" : version === 2 ? "enhanced" : "secondary";
    case 3:
      return "partition";
    case 255:
      return "terminator";
    default:
      return "descriptor";
  }
}

function rawDescriptorLabel(type: number, version: number): string {
  switch (type) {
    case 0:
      return "boot record";
    case 1:
      return "primary volume";
    case 2:
      return version === 1 ? "supplementary volume" : version === 2 ? "enhanced volume" : "supplementary or enhanced volume";
    case 3:
      return "volume partition";
    case 255:
      return "volume descriptor set terminator";
    default:
      return `volume descriptor type ${type}`;
  }
}

function validateRawDescriptorBothEndianFields(image: Uint8Array): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let sector = SYSTEM_AREA_SECTORS;
  while (sectorOffset(sector + 1) <= image.byteLength) {
    const offset = sectorOffset(sector);
    if (allZero(image.subarray(offset, offset + SECTOR_SIZE))) {
      return issues;
    }
    const profile = rawDescriptorBothEndianProfileAt(image, offset);
    if (profile) {
      issues.push(...validateRawDescriptorBothEndianFieldsAt(image, offset, sector, profile));
    }
    if (isVolumeDescriptorSetTerminatorAt(image, offset)) {
      return issues;
    }
    sector += 1;
  }
  return issues;
}

function validateRawDescriptorBothEndianFieldsAt(
  image: Uint8Array,
  offset: number,
  sector: number,
  profile: RawDescriptorBothEndianProfile,
): ValidationIssue[] {
  return profile.fields.flatMap((field) => {
    const little = field.bytes === 2
      ? readUint16LEAt(image, offset + field.start)
      : readUint32LEAt(image, offset + field.start);
    const big = field.bytes === 2
      ? readUint16BEAt(image, offset + field.start + field.bytes)
      : readUint32BEAt(image, offset + field.start + field.bytes);

    return little === big
      ? []
      : [{
          code: `${profile.codePrefix}.${field.code}.endian_mismatch`,
          message: `${profile.label} descriptor ${field.label} must store matching little- and big-endian values at sector ${sector}: ${little} !== ${big}`,
        }];
  });
}

type RawDescriptorBothEndianField = {
  start: number;
  bytes: 2 | 4;
  code: string;
  label: string;
};

type RawDescriptorBothEndianProfile = {
  codePrefix: "pvd" | "supplementary" | "enhanced" | "partition";
  label: string;
  fields: readonly RawDescriptorBothEndianField[];
};

const rawVolumeDescriptorBothEndianFields = [
  { start: 80, bytes: 4, code: "volume_space_size", label: "volume space size" },
  { start: 120, bytes: 2, code: "volume_set_size", label: "volume set size" },
  { start: 124, bytes: 2, code: "volume_sequence_number", label: "volume sequence number" },
  { start: 128, bytes: 2, code: "logical_block_size", label: "logical block size" },
  { start: 132, bytes: 4, code: "path_table_size", label: "path table size" },
] as const;

const rawPartitionDescriptorBothEndianFields = [
  { start: 72, bytes: 4, code: "volume_partition_location", label: "volume partition location" },
  { start: 80, bytes: 4, code: "volume_partition_size", label: "volume partition size" },
] as const;

function rawDescriptorBothEndianProfileAt(image: Uint8Array, offset: number): RawDescriptorBothEndianProfile | undefined {
  if (readAscii(image, offset + 1, 5) !== STANDARD_IDENTIFIER) {
    return undefined;
  }
  const type = image[offset];
  const version = image[offset + 6];
  if (type === 1 && version === 1) {
    return { codePrefix: "pvd", label: "primary volume", fields: rawVolumeDescriptorBothEndianFields };
  }
  if (type === 2 && version === 1) {
    return { codePrefix: "supplementary", label: "supplementary volume", fields: rawVolumeDescriptorBothEndianFields };
  }
  if (type === 2 && version === 2) {
    return { codePrefix: "enhanced", label: "enhanced volume", fields: rawVolumeDescriptorBothEndianFields };
  }
  if (type === 3 && version === 1) {
    return { codePrefix: "partition", label: "volume partition", fields: rawPartitionDescriptorBothEndianFields };
  }
  return undefined;
}

function validateRawDescriptorRootDirectoryRecordBothEndianFields(image: Uint8Array): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let sector = SYSTEM_AREA_SECTORS;
  while (sectorOffset(sector + 1) <= image.byteLength) {
    const offset = sectorOffset(sector);
    if (allZero(image.subarray(offset, offset + SECTOR_SIZE))) {
      return issues;
    }
    const descriptorRootPath = rawDescriptorRootPathAt(image, offset);
    if (descriptorRootPath) {
      issues.push(...validateRawDirectoryRecordBothEndianFields(image, offset + 156, descriptorRootPath));
    }
    if (isVolumeDescriptorSetTerminatorAt(image, offset)) {
      return issues;
    }
    sector += 1;
  }
  return issues;
}

function validateRawDescriptorRootDirectoryRecordLayout(image: Uint8Array): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let sector = SYSTEM_AREA_SECTORS;
  while (sectorOffset(sector + 1) <= image.byteLength) {
    const offset = sectorOffset(sector);
    if (allZero(image.subarray(offset, offset + SECTOR_SIZE))) {
      return issues;
    }
    const descriptorRootPath = rawDescriptorRootPathAt(image, offset);
    if (descriptorRootPath) {
      issues.push(...validateRawDescriptorRootDirectoryRecordAt(image, offset + 156, descriptorRootPath));
    }
    if (isVolumeDescriptorSetTerminatorAt(image, offset)) {
      return issues;
    }
    sector += 1;
  }
  return issues;
}

function validateRawDescriptorRootDirectoryRecordAt(image: Uint8Array, recordOffset: number, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bothEndianIssues = validateRawDirectoryRecordBothEndianFields(image, recordOffset, path);
  const dateIssues = validateRawDirectoryRecordDateField(image, recordOffset, "directory.record_date", `directory record date/time at ${path}`, path);
  try {
    decodeDirectoryRecord(image, recordOffset, recordOffset + 34);
  } catch (error) {
    const message = error instanceof Error ? error.message : `directory record is malformed at ${path}`;
    const isTargetedBothEndianError = bothEndianIssues.length > 0 && message.includes("both-endian");
    if (!isTargetedBothEndianError && (dateIssues.length === 0 || !isDirectoryRecordDateTimeError(message))) {
      const isPaddingError = message.includes("padding byte");
      issues.push({
        code: isPaddingError ? "directory.record_padding" : "directory.record_malformed",
        message,
        path,
      });
    }
  }
  return issues;
}

function rawDescriptorRootPathAt(image: Uint8Array, offset: number): string | undefined {
  if (readAscii(image, offset + 1, 5) !== STANDARD_IDENTIFIER) {
    return undefined;
  }
  const type = image[offset];
  const version = image[offset + 6];
  if (type === 1 && version === 1) {
    return ".";
  }
  if (type === 2 && version === 1) {
    return "supplementary:.";
  }
  if (type === 2 && version === 2) {
    return "enhanced:.";
  }
  return undefined;
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

function validateDescriptorPathTableReferences(image: Uint8Array, descriptor: PathTableValidationInput, label: string): void {
  validatePathTableReferenceForParsing(image, descriptor, "little", descriptor.typeLPathTableLocation, `${label} Type L path table`);
  validatePathTableReferenceForParsing(image, descriptor, "big", descriptor.typeMPathTableLocation, `${label} Type M path table`);
  if (descriptor.optionalTypeLPathTableLocation !== 0) {
    validatePathTableReferenceForParsing(image, descriptor, "little", descriptor.optionalTypeLPathTableLocation, `${label} optional Type L path table`);
  }
  if (descriptor.optionalTypeMPathTableLocation !== 0) {
    validatePathTableReferenceForParsing(image, descriptor, "big", descriptor.optionalTypeMPathTableLocation, `${label} optional Type M path table`);
  }
}

function validatePathTableReferenceForParsing(
  image: Uint8Array,
  descriptor: PathTableValidationInput,
  endian: "little" | "big",
  location: number,
  label: string,
): void {
  const pathTableStart = location * SECTOR_SIZE;
  const pathTableEnd = pathTableStart + descriptor.pathTableSize;
  if (pathTableStart < 0 || pathTableEnd > image.byteLength) {
    throw new Error(`${label} extent is out of bounds`);
  }
  let pathTable: PathTableRecord[];
  try {
    pathTable = decodePathTable(image.subarray(pathTableStart, pathTableEnd), endian);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is invalid: ${message}`);
  }
  validateDecodedPathTableForParsing(pathTable, descriptor, label);
}

function assertDescriptorPathTableHierarchy(
  image: Uint8Array,
  descriptor: PathTableValidationInput,
  codePrefix: string,
): void {
  if (descriptor.rootDirectoryRecord.volumeSequenceNumber !== descriptor.volumeSequenceNumber) {
    return;
  }
  const expected = expectedPathTableRecords(image, descriptor.rootDirectoryRecord);
  if (!expected) {
    return;
  }

  const mandatory = decodeDescriptorPathTableForHierarchy(image, descriptor, descriptor.typeLPathTableLocation, "little");
  const issues = validatePathTableAgainstHierarchy(mandatory, expected, codePrefix, "Type L");
  if (issues.length > 0) {
    throw new Error(issues[0]!.message);
  }
  const mandatoryBig = decodeDescriptorPathTableForHierarchy(image, descriptor, descriptor.typeMPathTableLocation, "big");
  const bigIssues = validatePathTableAgainstHierarchy(mandatoryBig, expected, codePrefix, "Type M");
  if (bigIssues.length > 0) {
    throw new Error(bigIssues[0]!.message);
  }

  if (descriptor.optionalTypeLPathTableLocation !== 0) {
    const optionalLittle = decodeDescriptorPathTableForHierarchy(image, descriptor, descriptor.optionalTypeLPathTableLocation, "little");
    const optionalIssues = validatePathTableAgainstHierarchy(optionalLittle, expected, `${codePrefix}.optional.little`, "optional Type L");
    if (optionalIssues.length > 0) {
      throw new Error(optionalIssues[0]!.message);
    }
  }
  if (descriptor.optionalTypeMPathTableLocation !== 0) {
    const optionalBig = decodeDescriptorPathTableForHierarchy(image, descriptor, descriptor.optionalTypeMPathTableLocation, "big");
    const optionalIssues = validatePathTableAgainstHierarchy(optionalBig, expected, `${codePrefix}.optional.big`, "optional Type M");
    if (optionalIssues.length > 0) {
      throw new Error(optionalIssues[0]!.message);
    }
  }
}

function decodeDescriptorPathTableForHierarchy(
  image: Uint8Array,
  descriptor: PathTableValidationInput,
  location: number,
  endian: "little" | "big",
): PathTableRecord[] {
  const start = location * SECTOR_SIZE;
  return decodePathTable(image.subarray(start, start + descriptor.pathTableSize), endian);
}

function validateDecodedPathTableForParsing(pathTable: PathTableRecord[], descriptor: PathTableValidationInput, label: string): void {
  if (pathTable.length === 0) {
    throw new Error(`${label} must contain the root directory record`);
  }
  const root = pathTable[0]!;
  if (root.parentDirectoryNumber !== 1 || root.identifier.length !== 1 || root.identifier[0] !== 0) {
    throw new Error(`${label} first record must be the root directory with parent number 1`);
  }
  const directoryIdentifierLengthLimit = pathTableDirectoryIdentifierLengthLimit(descriptor);
  for (const [index, record] of pathTable.entries()) {
    const invalidParent = index === 0
      ? record.parentDirectoryNumber !== 1
      : record.parentDirectoryNumber < 1 || record.parentDirectoryNumber >= index + 1;
    if (invalidParent) {
      throw new Error(`${label} record ${index + 1} parent number ${record.parentDirectoryNumber} does not reference an earlier directory`);
    }
    if (index !== 0 && record.identifier.length > directoryIdentifierLengthLimit) {
      throw new Error(`${label} record ${index + 1} directory identifier length must not exceed ${directoryIdentifierLengthLimit} bytes`);
    }
  }
}

function validatePrimaryVolumeDescriptor(image: Uint8Array, pvd: PrimaryVolumeDescriptor, descriptors: VolumeDescriptor[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(...validateZeroDescriptorRanges(pvd, "pvd", primaryVolumeDescriptorZeroRanges()));
  issues.push(...validateDescriptorCharacterFields(pvd, "pvd", primaryVolumeDescriptorCharacterFields()));
  issues.push(...validateDescriptorRootFileReferences(image, pvd, "pvd"));
  issues.push(...validateDescriptorRootDirectoryRecordIdentifier(pvd, "pvd", "primary"));
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
  issues.push(...validateDirectoryEntryVolumeSequence(pvd.rootDirectoryRecord, ".", pvd.volumeSetSize));
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
      const rootPath = type === 1 ? "." : `${codePrefix}:.`;
      issues.push(...validateRawDescriptorDateField(image, offset + 813, `${codePrefix}.creation_date`, `${descriptorLabel} volume creation date and time`));
      issues.push(...validateRawDescriptorDateField(image, offset + 830, `${codePrefix}.modification_date`, `${descriptorLabel} volume modification date and time`));
      issues.push(...validateRawDescriptorDateField(image, offset + 847, `${codePrefix}.expiration_date`, `${descriptorLabel} volume expiration date and time`));
      issues.push(...validateRawDescriptorDateField(image, offset + 864, `${codePrefix}.effective_date`, `${descriptorLabel} volume effective date and time`));
      issues.push(...validateRawDirectoryRecordDateField(image, offset + 156, `${codePrefix}.root_directory_record.date`, `${descriptorLabel} volume descriptor root directory record date/time`, rootPath));
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

function validateRawDirectoryRecordDateField(image: Uint8Array, recordOffset: number, code: string, label: string, path: string): ValidationIssue[] {
  const length = image[recordOffset];
  if (length === undefined || length < 25 || recordOffset + length > image.byteLength) {
    return [];
  }
  if (allZero(image.subarray(recordOffset + 18, recordOffset + 25))) {
    return [];
  }
  try {
    readDirectoryDateTime(image, recordOffset + 18);
    return [];
  } catch (error) {
    return [{
      code,
      message: `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      path,
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
    const message = volumeSpaceLowerBoundMessage(descriptor.volumeSpaceSize, minimumVolumeSpaceSize, codePrefix);
    issues.push({
      code: `${codePrefix}.volume_space_size.lower_bound`,
      message,
    });
  }
  return issues;
}

function volumeSpaceLowerBoundMessage(volumeSpaceSize: number, minimumVolumeSpaceSize: number, codePrefix: string): string {
  return codePrefix === "pvd"
    ? `volume space size ${volumeSpaceSize} is smaller than referenced sector end ${minimumVolumeSpaceSize}`
    : `${codePrefix} volume space size ${volumeSpaceSize} is smaller than referenced sector end ${minimumVolumeSpaceSize}`;
}

function assertPrimaryVolumeSpaceSize(image: Uint8Array, pvd: PrimaryVolumeDescriptor, descriptors: VolumeDescriptor[]): void {
  const issues = validateVolumeSpaceSize(image, pvd, descriptors, "pvd");
  if (issues.length > 0) {
    throw new Error(issues[0]!.message);
  }
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
      const childPath = identifier;
      const child = directoryEntryFromRecord(record, childPath, []);
      if (child.volumeSequenceNumber === localVolumeSequenceNumber) {
        end = Math.max(end, fileExtentEndSector(record));
        if ((record.flags & FILE_FLAG_MULTI_EXTENT) === 0) {
          end = Math.max(end, directoryTreeEndSector(image, child, localVolumeSequenceNumber, new Set(visited)));
        }
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
const MAX_FILE_PATH_LENGTH = 255;

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
    }
    if (big.records) {
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
  const directoryIdentifierLengthLimit = pathTableDirectoryIdentifierLengthLimit(descriptor);
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
    if (!isRoot && record.identifier.length > directoryIdentifierLengthLimit) {
      issues.push({
        code: `${codePrefix}.${endian}.identifier.length`,
        message: `${label} path table record ${index + 1} directory identifier length must not exceed ${directoryIdentifierLengthLimit} bytes`,
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

function pathTableDirectoryIdentifierLengthLimit(descriptor: PathTableValidationInput): number {
  return descriptor.kind === "enhanced" ? 207 : 31;
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
  const visited = new Set<string>();
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
    const visitedKey = `${directory.volumeSequenceNumber}:${directory.extent}`;
    if (visited.has(visitedKey)) {
      return;
    }
    visited.add(visitedKey);
    const directoryNumber = records.length + 1;
    const key = directoryNumber === 1 ? "/" : `${parentKey}/${bytesKey(identifier)}`;
    records.push({
      identifier,
      extent: directory.extent,
      parentDirectoryNumber,
      extendedAttributeRecordLength: directory.extendedAttributeRecordLength,
      key,
    });
    if (directory.volumeSequenceNumber !== root.volumeSequenceNumber) {
      return;
    }

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
      ) {
        continue;
      }
      const child = directoryEntryFromRecord(record, "", []);
      childDirectories.push({ directory: child, identifier: record.identifier });
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
  let recordIndex = 0;
  while (offset < directoryBytes.byteLength) {
    const length = directoryBytes[offset]!;
    if (length === 0) {
      const nextSectorOffset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      if (hasNonzeroUnusedDirectoryBytes(directoryBytes, offset, nextSectorOffset)) {
        issues.push({
          code: "directory.unused_bytes",
          message: `unused directory bytes after the last record at ${path} must be zero`,
          path,
        });
      }
      offset = nextSectorOffset;
      continue;
    }
    if ((offset % SECTOR_SIZE) + length > SECTOR_SIZE) {
      issues.push({ code: "directory.record_crosses_sector", message: `directory record crosses a logical sector boundary at ${path}`, path });
      offset += 1;
      continue;
    }
    const currentRecordIndex = recordIndex++;
    const recordPath = rawDirectoryRecordPath(directoryBytes, offset, currentRecordIndex, path);
    const bothEndianIssues = validateRawDirectoryRecordBothEndianFields(directoryBytes, offset, recordPath);
    issues.push(...bothEndianIssues);
    const dateIssues = validateRawDirectoryRecordDateField(
      directoryBytes,
      offset,
      "directory.record_date",
      `directory record date/time at ${recordPath}`,
      recordPath,
    );
    issues.push(...dateIssues);
    try {
      decodeDirectoryRecord(directoryBytes, offset, directoryBytes.byteLength);
    } catch (error) {
      const message = error instanceof Error ? error.message : `directory record is malformed at ${path}`;
      const isTargetedBothEndianError = bothEndianIssues.length > 0 && message.includes("both-endian");
      if (!isTargetedBothEndianError && (dateIssues.length === 0 || !isDirectoryRecordDateTimeError(message))) {
        const isPaddingError = message.includes("padding byte");
        issues.push({
          code: isPaddingError ? "directory.record_padding" : "directory.record_malformed",
          message,
          path,
        });
      }
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

function validateRawDirectoryRecordBothEndianFields(bytes: Uint8Array, offset: number, path: string): ValidationIssue[] {
  const length = bytes[offset];
  if (length === undefined || length < 34 || offset + 34 > bytes.byteLength) {
    return [];
  }
  return rawDirectoryRecordBothEndianFields.flatMap((field) => {
    const little = field.bytes === 2
      ? readUint16LEAt(bytes, offset + field.start)
      : readUint32LEAt(bytes, offset + field.start);
    const big = field.bytes === 2
      ? readUint16BEAt(bytes, offset + field.start + field.bytes)
      : readUint32BEAt(bytes, offset + field.start + field.bytes);

    return little === big
      ? []
      : [{
          code: `directory.${field.code}.endian_mismatch`,
          message: `directory record ${field.label} at ${path} must store matching little- and big-endian values: ${little} !== ${big}`,
          path,
        }];
  });
}

const rawDirectoryRecordBothEndianFields = [
  { start: 2, bytes: 4, code: "extent", label: "location of extent" },
  { start: 10, bytes: 4, code: "data_length", label: "data length" },
  { start: 28, bytes: 2, code: "volume_sequence_number", label: "volume sequence number" },
] as const;

function isDirectoryRecordDateTimeError(message: string): boolean {
  return /^(month|day|hour|minute|second|time zone offset) /u.test(message)
    || message === "day is not valid for the supplied month and year";
}

function rawDirectoryRecordPath(directoryBytes: Uint8Array, offset: number, recordIndex: number, directoryPath: string): string {
  if (recordIndex < 2) {
    return directoryPath;
  }
  const length = directoryBytes[offset]!;
  const identifierLength = directoryBytes[offset + 32];
  if (identifierLength === undefined || identifierLength < 1 || offset + 33 + identifierLength > directoryBytes.byteLength || 33 + identifierLength > length) {
    return directoryPath;
  }
  const identifier = decodeFileIdentifier(directoryBytes.subarray(offset + 33, offset + 33 + identifierLength));
  return joinPath(directoryPath === "." ? "" : directoryPath, stripVersion(identifier)) || ".";
}

function validateDirectoryHierarchy(
  image: Uint8Array,
  directory: IsoDirectoryEntry,
  parent: IsoDirectoryEntry,
  path: string,
  localVolumeSequenceNumber: number,
  volumeSetSize: number,
  visited: Set<number>,
  options: { identifierProfile?: DirectoryIdentifierProfile; validatePrimaryLevelOne?: boolean; depth?: number; filePathLengthPrefix?: number } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const identifierProfile = options.identifierProfile;
  const validatePrimaryLevelOne = options.validatePrimaryLevelOne ?? false;
  const depth = options.depth ?? 1;
  const filePathLengthPrefix = options.filePathLengthPrefix ?? 0;
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
  let pendingMultiExtentKind: "file" | "directory" = "file";
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
    let isMultiExtentContinuationRecord = false;
    const identifier = index < 2 ? "" : decodeFileIdentifier(record.identifier);
    const recordPath = index < 2 ? path : joinPath(path === "." ? "" : path, stripVersion(identifier));
    if (index < 2) {
      issues.push(...validateDotDirectoryRecord(record, index, directory, parent, path));
    }
    const recordIsDirectory = (record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY;
    if (recordIsDirectory) {
      issues.push(...validateDirectoryRecordDirectoryFlags(record.flags, recordPath || path));
      issues.push(...validateDirectoryProtectionExtendedAttributeFlags(record, recordPath || path));
    }
    if (index >= 2) {
      isMultiExtentContinuationRecord = pendingMultiExtentRecord
        ? isMultiExtentContinuation(pendingMultiExtentRecord, record)
        : false;
      if (pendingMultiExtentRecord && !isMultiExtentContinuationRecord) {
        issues.push({
          code: "directory.multi_extent_sequence",
          message: `multi-extent ${pendingMultiExtentKind} record at ${pendingMultiExtentPath} is not followed by a matching ${pendingMultiExtentKind} section`,
          path: pendingMultiExtentPath,
        });
        pendingMultiExtentRecord = undefined;
        pendingMultiExtentPath = "";
        pendingMultiExtentKind = "file";
      }
      issues.push(...validateOrdinaryDirectoryRecordIdentifier(record, recordPath || "."));
      if (identifierProfile) {
        issues.push(...validateDirectoryRecordIdentifierProfile(record, recordPath || ".", identifierProfile));
      }
      issues.push(...validateOrdinaryFileExtendedAttributeFlags(record, recordPath || "."));
      if (!recordIsDirectory && !isMultiExtentContinuationRecord) {
        issues.push(...validateFilePathLength(record, recordPath || ".", filePathLengthPrefix));
      }
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
      if ((record.flags & FILE_FLAG_MULTI_EXTENT) !== 0 && !recordIsDirectory) {
        pendingMultiExtentRecord = record;
        pendingMultiExtentPath = recordPath || ".";
        pendingMultiExtentKind = "file";
      } else if (isMultiExtentContinuationRecord) {
        pendingMultiExtentRecord = undefined;
        pendingMultiExtentPath = "";
        pendingMultiExtentKind = "file";
      }
    }
    if (index >= 2 && validatePrimaryLevelOne) {
      issues.push(...validatePrimaryDirectoryRecordIdentifier(record, recordPath || "."));
    }
    if (recordIsDirectory) {
      issues.push(...validateDirectoryRecordSectionLayout(record, recordPath || path));
    } else if (record.fileUnitSize === 0 && record.interleaveGapSize !== 0) {
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
      issues.push(...validateDirectoryRecordVolumeSequence(record, recordPath || ".", volumeSetSize));
    }
    if (
      index >= 2
      && !recordIsDirectory
      && record.volumeSequenceNumber === localVolumeSequenceNumber
    ) {
      issues.push(...validateFileSectionBounds(image, record, recordPath || "."));
    }
    if (
      index < 2
      || !recordIsDirectory
      || isMultiExtentContinuationRecord
      || record.volumeSequenceNumber !== localVolumeSequenceNumber
      || (record.flags & FILE_FLAG_MULTI_EXTENT) !== 0
    ) {
      continue;
    }
    const childPath = recordPath || ".";
    const childDirectory = directoryEntryFromRecord(record, childPath, []);
    issues.push(...validateDirectoryHierarchy(image, childDirectory, directory, childPath, localVolumeSequenceNumber, volumeSetSize, new Set(visited), {
      depth: depth + 1,
      filePathLengthPrefix: filePathLengthPrefix + record.identifier.length + 1,
      ...(identifierProfile ? { identifierProfile } : {}),
      validatePrimaryLevelOne,
    }));
  }
  if (pendingMultiExtentRecord) {
    issues.push({
      code: "directory.multi_extent_final_missing",
      message: `multi-extent ${pendingMultiExtentKind} record at ${pendingMultiExtentPath} is missing its final ${pendingMultiExtentKind} section`,
      path: pendingMultiExtentPath,
    });
  }
  return issues;
}

function validateFilePathLength(record: DecodedDirectoryRecord, path: string, filePathLengthPrefix: number): ValidationIssue[] {
  const filePathLength = filePathLengthPrefix + record.identifier.length;
  if (filePathLength <= MAX_FILE_PATH_LENGTH) {
    return [];
  }
  return [{
    code: "directory.file_path_length",
    message: `file path length at ${path} must not exceed ${MAX_FILE_PATH_LENGTH} bytes`,
    path,
  }];
}

function validateFileSectionBounds(image: Uint8Array, record: DecodedDirectoryRecord, path: string): ValidationIssue[] {
  if (sectionInBounds(image, {
    extent: record.extent,
    extendedAttributeRecordLength: record.extendedAttributeRecordLength,
    dataLength: record.dataLength,
    fileUnitSize: record.fileUnitSize,
    interleaveGapSize: record.interleaveGapSize,
  })) {
    return [];
  }
  return [{
    code: "directory.file_extent_bounds",
    message: `file record at ${path} has invalid extent bounds`,
    path,
  }];
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

function validateDirectoryRecordIdentifierProfile(record: DecodedDirectoryRecord, path: string, profile: DirectoryIdentifierProfile): ValidationIssue[] {
  if ((record.flags & FILE_FLAG_DIRECTORY) !== FILE_FLAG_DIRECTORY) {
    return [];
  }
  const limit = secondaryDirectoryIdentifierLengthLimit(profile);
  if (record.identifier.length <= limit) {
    return [];
  }
  return [{
    code: "directory.directory_identifier.length",
    message: `${profile} directory record directory identifier length at ${path} must not exceed ${limit} bytes`,
    path,
  }];
}

function secondaryDirectoryIdentifierLengthLimit(profile: DirectoryIdentifierProfile): number {
  return profile === "enhanced" ? 207 : 31;
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
  if (record.volumeSequenceNumber !== expectedEntry.volumeSequenceNumber) {
    issues.push({
      code: `${code}.volume_sequence_number`,
      message: `directory ${recordName} record at ${path} does not match the ${expectedName} volume sequence number`,
      path,
    });
  }

  return issues;
}

function validateSupplementaryLikeVolumeDescriptor(
  image: Uint8Array,
  descriptor: SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor,
  descriptors: VolumeDescriptor[],
  pvd: PrimaryVolumeDescriptor,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const label = descriptor.kind === "supplementary" ? "supplementary" : "enhanced";
  issues.push(...validateZeroDescriptorRanges(descriptor, label, secondaryVolumeDescriptorZeroRanges()));
  if ((descriptor.volumeFlags & 0xfe) !== 0) {
    issues.push({ code: `${label}.volume_flags`, message: `${label} volume descriptor flags bits 1 through 7 must be zero` });
  }
  if (descriptor.logicalBlockSize !== SECTOR_SIZE) {
    issues.push({ code: `${label}.logical_block_size`, message: `${label} logical block size must be 2048 for the supported profile` });
  }
  issues.push(...validateDescriptorCharacterFields(descriptor, label, commonVolumeDescriptorCharacterFields()));
  issues.push(...validateDescriptorRootFileReferences(image, descriptor, label));
  issues.push(...validateDescriptorRootDirectoryRecordIdentifier(descriptor, label, label));
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
  issues.push(...validateVolumeSetConsistency(descriptor, pvd, label));
  issues.push(...validateDirectoryEntryInterleaving(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryEntryReservedFileFlags(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryEntryDirectoryFlags(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryProtectionExtendedAttributeFlags(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryEntryVolumeSequence(descriptor.rootDirectoryRecord, `${label}:.`, descriptor.volumeSetSize));
  issues.push(...validateDirectoryEntryMultiExtent(descriptor.rootDirectoryRecord, `${label}:.`));
  issues.push(...validateDirectoryEntryExtendedAttributeRecord(image, descriptor.rootDirectoryRecord, `${label}:.`, descriptor.volumeSequenceNumber));
  issues.push(...validatePathTableReferences(image, descriptor, `${label}_path_table`));
  issues.push(...validateDirectoryHierarchy(image, descriptor.rootDirectoryRecord, descriptor.rootDirectoryRecord, `${label}:.`, descriptor.volumeSequenceNumber, descriptor.volumeSetSize, new Set(), {
    identifierProfile: descriptor.kind,
  }));
  return issues;
}

function validateVolumePartitionDescriptors(image: Uint8Array, descriptors: VolumeDescriptor[], pvd: PrimaryVolumeDescriptor): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const volumeSpaceSectors = Math.min(Math.floor(image.byteLength / SECTOR_SIZE), pvd.volumeSpaceSize);
  for (const descriptor of descriptors) {
    if (descriptor.kind !== "partition") {
      continue;
    }
    issues.push(...validateZeroDescriptorRanges(descriptor, "partition", partitionDescriptorZeroRanges()));
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
  ranges: DescriptorZeroRange[],
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

function assertZeroDescriptorRanges(descriptor: VolumeDescriptor, ranges: DescriptorZeroRange[]): void {
  const issues = validateZeroDescriptorRanges(descriptor, descriptorZeroRangeCodePrefix(descriptor), ranges);
  if (issues.length > 0) {
    throw new Error(issues[0]!.message);
  }
}

function descriptorZeroRangeCodePrefix(descriptor: VolumeDescriptor): string {
  switch (descriptor.kind) {
    case "primary":
      return "pvd";
    case "supplementary":
    case "enhanced":
    case "partition":
      return descriptor.kind;
    default:
      return "descriptor";
  }
}

function primaryVolumeDescriptorZeroRanges(): DescriptorZeroRange[] {
  return [
    { start: 7, end: 8, code: "unused", label: "unused field at BP 8" },
    { start: 72, end: 80, code: "unused", label: "unused field at BP 73 to 80" },
    { start: 88, end: 120, code: "unused", label: "unused field at BP 89 to 120" },
    { start: 882, end: 883, code: "unused", label: "unused field at BP 883" },
    { start: 1395, end: SECTOR_SIZE, code: "reserved", label: "reserved field at BP 1396 to 2048" },
  ];
}

function secondaryVolumeDescriptorZeroRanges(): DescriptorZeroRange[] {
  return [
    { start: 72, end: 80, code: "unused", label: "unused field at BP 73 to 80" },
    { start: 882, end: 883, code: "unused", label: "unused field at BP 883" },
    { start: 1395, end: SECTOR_SIZE, code: "reserved", label: "reserved field at BP 1396 to 2048" },
  ];
}

function partitionDescriptorZeroRanges(): DescriptorZeroRange[] {
  return [
    { start: 7, end: 8, code: "unused", label: "unused field at BP 8" },
  ];
}

function assertVolumeDescriptorSetTerminatorReservedBytes(descriptor: VolumeDescriptor): void {
  if (descriptor.kind === "terminator" && !allZero(descriptor.raw.subarray(7))) {
    throw new Error(`volume descriptor set terminator reserved bytes must be zero at sector ${descriptor.sector}`);
  }
}

function validateDescriptorCharacterFields(
  descriptor: VolumeDescriptor,
  codePrefix: string,
  fields: DescriptorCharacterField[],
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

function assertDescriptorCharacterFields(
  descriptor: VolumeDescriptor,
  fields: DescriptorCharacterField[],
): void {
  for (const field of fields) {
    const text = readAscii(descriptor.raw, field.start, field.length);
    if (!isDescriptorCharacterField(text, field.kind)) {
      throw new Error(`${descriptor.kind} volume descriptor ${field.label} contains invalid ECMA-119 ${field.kind}-characters`);
    }
  }
}

function primaryVolumeDescriptorCharacterFields(): DescriptorCharacterField[] {
  return commonVolumeDescriptorCharacterFields();
}

function commonVolumeDescriptorCharacterFields(): DescriptorCharacterField[] {
  return [
    { start: 8, length: 32, kind: "a", code: "system_identifier.characters", label: "system identifier" },
    { start: 40, length: 32, kind: "d", code: "volume_identifier.characters", label: "volume identifier" },
    { start: 190, length: 128, kind: "d", code: "volume_set_identifier.characters", label: "volume set identifier" },
    { start: 318, length: 128, kind: "a", code: "publisher_identifier.characters", label: "publisher identifier" },
    { start: 446, length: 128, kind: "a", code: "data_preparer_identifier.characters", label: "data preparer identifier" },
    { start: 574, length: 128, kind: "a", code: "application_identifier.characters", label: "application identifier" },
    { start: 702, length: 37, kind: "file", code: "copyright_file_identifier.characters", label: "copyright file identifier" },
    { start: 739, length: 37, kind: "file", code: "abstract_file_identifier.characters", label: "abstract file identifier" },
    { start: 776, length: 37, kind: "file", code: "bibliographic_file_identifier.characters", label: "bibliographic file identifier" },
  ];
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

function validateDescriptorRootDirectoryRecordIdentifier(
  descriptor: PathTableValidationInput,
  codePrefix: string,
  label: string,
): ValidationIssue[] {
  if (descriptor.raw[156 + 32] === 1 && descriptor.raw[156 + 33] === 0) {
    return [];
  }
  return [{
    code: `${codePrefix}.root_directory_record.identifier`,
    message: `${label} volume descriptor root directory record must use identifier 0`,
    path: descriptorRootValidationPath(descriptor),
  }];
}

function assertDescriptorRootDirectoryRecordIdentifier(
  descriptor: PathTableValidationInput,
  label: string,
): void {
  if (descriptor.raw[156 + 32] === 1 && descriptor.raw[156 + 33] === 0) {
    return;
  }
  throw new Error(`${label} volume descriptor root directory record must use identifier 0`);
}

function validateDescriptorRootFileReferences(
  image: Uint8Array,
  descriptor: PathTableValidationInput,
  codePrefix: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const path = descriptorRootValidationPath(descriptor);
  const fields: DescriptorFileReferenceField[] = [
    { identifier: prefixedDescriptorFileIdentifier(descriptor.raw, 318, 128), code: "publisher_identifier.file_reference", label: "publisher identifier", prefixed: true },
    { identifier: prefixedDescriptorFileIdentifier(descriptor.raw, 446, 128), code: "data_preparer_identifier.file_reference", label: "data preparer identifier", prefixed: true },
    { identifier: prefixedDescriptorFileIdentifier(descriptor.raw, 574, 128), code: "application_identifier.file_reference", label: "application identifier", prefixed: true },
    { identifier: descriptor.copyrightFileIdentifier, code: "copyright_file_identifier.file_reference", label: "copyright file identifier", prefixed: false },
    { identifier: descriptor.abstractFileIdentifier, code: "abstract_file_identifier.file_reference", label: "abstract file identifier", prefixed: false },
    { identifier: descriptor.bibliographicFileIdentifier, code: "bibliographic_file_identifier.file_reference", label: "bibliographic file identifier", prefixed: false },
  ];
  for (const field of fields) {
    if (!field.identifier) {
      continue;
    }
    if (field.prefixed && !isLevelOneFileIdentifier(new TextEncoder().encode(field.identifier))) {
      issues.push({
        code: `${codePrefix}.${field.code}.identifier`,
        message: `${descriptor.kind} volume descriptor ${field.label} references ${field.identifier}, which must be an ECMA-119 Level 1 file identifier`,
        path,
      });
      continue;
    }
  }
  const rootFileIdentifiers = rootDirectoryFileIdentifiers(image, descriptor.rootDirectoryRecord);
  if (!rootFileIdentifiers) {
    return issues;
  }
  for (const field of fields) {
    if (!field.identifier || (field.prefixed && !isLevelOneFileIdentifier(new TextEncoder().encode(field.identifier)))) {
      continue;
    }
    if (!rootFileIdentifiers.has(field.identifier)) {
      issues.push({
        code: `${codePrefix}.${field.code}`,
        message: `${descriptor.kind} volume descriptor ${field.label} references ${field.identifier}, which is not a file described in the root directory`,
        path,
      });
    }
  }
  return issues;
}

type DescriptorFileReferenceField = {
  identifier: string | undefined;
  code: string;
  label: string;
  prefixed: boolean;
};

function descriptorRootValidationPath(descriptor: PathTableValidationInput): string {
  return descriptor.kind === "primary" ? "." : `${descriptor.kind}:.`;
}

function prefixedDescriptorFileIdentifier(bytes: Uint8Array, offset: number, length: number): string | undefined {
  if (bytes[offset] !== 0x5f) {
    return undefined;
  }
  return readAscii(bytes, offset + 1, length - 1).replace(/[ \0]+$/u, "");
}

function rootDirectoryFileIdentifiers(image: Uint8Array, root: IsoDirectoryEntry): Set<string> | undefined {
  const bytes = readDirectoryExtentBytes(image, root);
  if (!bytes) {
    return undefined;
  }
  const identifiers = new Set<string>();
  let offset = 0;
  let recordIndex = 0;
  while (offset < bytes.byteLength) {
    const length = bytes[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }
    if (length < 34 || offset + length > bytes.byteLength || (offset % SECTOR_SIZE) + length > SECTOR_SIZE) {
      offset += Math.max(1, length);
      continue;
    }
    let record: DecodedDirectoryRecord;
    try {
      record = decodeDirectoryRecord(bytes, offset, bytes.byteLength);
    } catch {
      offset += length;
      continue;
    }
    offset += record.length;
    if (recordIndex++ < 2 || (record.flags & FILE_FLAG_DIRECTORY) !== 0) {
      continue;
    }
    identifiers.add(decodeFileIdentifier(record.identifier));
  }
  return identifiers;
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
  if (!isSupportedSecondaryEscapeSequence(descriptor.kind, bytes)) {
    return [{
      code: `${codePrefix}.escape_sequences.value`,
      message: `${descriptor.kind} volume descriptor escape sequences contain an unsupported value`,
    }];
  }
  return [];
}

function parseSupplementaryLikeDescriptor(image: Uint8Array, offset: number, sector: number): SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor {
  const descriptorKind = image[offset + 6] === 2 ? "enhanced" : "supplementary";
  if (image[offset + 156] === 0) {
    throw new Error(`missing directory record at ${descriptorKind}:.`);
  }
  const rootRecord = decodeDirectoryRecord(image, offset + 156, offset + 190);
  const common = {
    ...baseDescriptor(image, offset, sector, descriptorKind),
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
  assertDirectoryDataLengthForParsing(
    descriptor.rootDirectoryRecord,
    descriptor.kind === "primary" ? "." : `${descriptor.kind}:.`,
  );
  assertSupportedDirectoryEntry(
    descriptor.rootDirectoryRecord,
    descriptor.kind === "primary" ? "." : `${descriptor.kind}:.`,
    descriptor.volumeSetSize,
  );
  if (descriptor.rootDirectoryRecord.volumeSequenceNumber !== descriptor.volumeSequenceNumber) {
    return {
      ...descriptor,
      pathTables: readDescriptorPathTables(image, descriptor),
      rootDirectoryRecord: markExternalDirectory(descriptor.rootDirectoryRecord),
    };
  }
  return {
    ...descriptor,
    pathTables: readDescriptorPathTables(image, descriptor),
    rootDirectoryRecord: readDirectoryTree(image, descriptor.rootDirectoryRecord, descriptor.rootDirectoryRecord, "", includeData, descriptor.volumeSequenceNumber, descriptor.volumeSetSize, new Set(), {
      ...(descriptor.kind === "primary" ? {} : { identifierProfile: descriptor.kind }),
      enforceFilePathLength: true,
      validatePrimaryIdentifiers: descriptor.kind === "primary",
      validatePrimaryHierarchyDepth: descriptor.kind === "primary",
    }),
  };
}

function readDescriptorPathTables(image: Uint8Array, descriptor: PrimaryVolumeDescriptor | SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor): IsoPathTables {
  const pathTables: IsoPathTables = {
    typeL: readPathTable(image, descriptor.typeLPathTableLocation, descriptor.pathTableSize, "little"),
    typeM: readPathTable(image, descriptor.typeMPathTableLocation, descriptor.pathTableSize, "big"),
  };
  if (descriptor.optionalTypeLPathTableLocation !== 0) {
    pathTables.optionalTypeL = readPathTable(image, descriptor.optionalTypeLPathTableLocation, descriptor.pathTableSize, "little");
  }
  if (descriptor.optionalTypeMPathTableLocation !== 0) {
    pathTables.optionalTypeM = readPathTable(image, descriptor.optionalTypeMPathTableLocation, descriptor.pathTableSize, "big");
  }
  return pathTables;
}

function readPathTable(image: Uint8Array, location: number, size: number, endian: "little" | "big"): PathTableRecord[] {
  const start = location * SECTOR_SIZE;
  return decodePathTable(image.subarray(start, start + size), endian);
}

function readDirectoryTree(
  image: Uint8Array,
  directory: IsoDirectoryEntry,
  parent: IsoDirectoryEntry,
  path: string,
  includeData: boolean,
  localVolumeSequenceNumber: number,
  volumeSetSize: number,
  visited: Set<number>,
  options: { identifierProfile?: DirectoryIdentifierProfile; validatePrimaryIdentifiers?: boolean; validatePrimaryHierarchyDepth?: boolean; enforceFilePathLength?: boolean; depth?: number; filePathLengthPrefix?: number } = {},
): IsoDirectoryEntry {
  const depth = options.depth ?? 1;
  const filePathLengthPrefix = options.filePathLengthPrefix ?? 0;
  assertSupportedDirectoryEntry(directory, path || ".", volumeSetSize);
  if (directory.volumeSequenceNumber !== localVolumeSequenceNumber) {
    return markExternalDirectory(directory);
  }
  if (options.validatePrimaryHierarchyDepth) {
    assertPrimaryHierarchyDepthForParsing(depth, path || ".");
  }
  assertDirectoryDataLengthForParsing(directory, path || ".");
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
      if (recordIndex === 0) {
        throw new Error(`directory self record is missing at ${path || "."}`);
      }
      if (recordIndex === 1) {
        throw new Error(`directory parent record is missing at ${path || "."}`);
      }
      const nextSectorOffset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      if (hasNonzeroUnusedDirectoryBytes(bytes, offset, nextSectorOffset)) {
        throw new Error(`unused directory bytes after the last record at ${path || "."} must be zero`);
      }
      offset = nextSectorOffset;
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
      assertSupportedDirectoryRecord(record, path || ".", volumeSetSize);
      assertDotDirectoryRecordForParsing(record, index, directory, parent, path || ".");
      continue;
    }
    const isDirectory = (record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY;
    const identifier = decodeFileIdentifier(record.identifier);
    const cleanName = stripVersion(identifier);
    const recordPath = joinPath(path, cleanName) || ".";
    assertOrdinaryDirectoryRecordIdentifierForParsing(record, recordPath);
    if (options.validatePrimaryHierarchyDepth && isDirectory && record.volumeSequenceNumber === localVolumeSequenceNumber) {
      assertPrimaryHierarchyDepthForParsing(depth + 1, recordPath);
    }
    if (options.identifierProfile) {
      assertDirectoryRecordIdentifierProfileForParsing(record, recordPath, options.identifierProfile);
    }
    if (options.validatePrimaryIdentifiers) {
      assertPrimaryDirectoryRecordIdentifierForParsing(record, recordPath);
    }
    if (options.enforceFilePathLength && !isDirectory) {
      assertPrimaryFilePathLengthForParsing(record, recordPath, filePathLengthPrefix);
    }

    if (isDirectory) {
      assertSupportedDirectoryRecord(record, recordPath || ".", volumeSetSize);
      const childPath = joinPath(path, identifier);
      const child = directoryEntryFromRecord(record, childPath, []);
      if (record.volumeSequenceNumber !== localVolumeSequenceNumber) {
        children.push(markExternalDirectory(child));
        continue;
      }
      assertFileSectionInBounds(image, record, recordPath);
      if (record.extendedAttributeRecordLength > 0) {
        child.extendedAttributeRecord = readExtendedAttributeRecord(image, record);
        const fields = decodeOptionalExtendedAttributeRecord(child.extendedAttributeRecord);
        if (fields) {
          child.extendedAttributeRecordFields = fields;
        }
      }
      children.push(readDirectoryTree(image, child, directory, childPath, includeData, localVolumeSequenceNumber, volumeSetSize, new Set(visited), {
        ...options,
        depth: depth + 1,
        filePathLengthPrefix: filePathLengthPrefix + record.identifier.length + 1,
      }));
    } else {
      const filePath = recordPath;
      const chain = readFileSectionChain(bytes, offset, record, filePath);
      offset = chain.nextOffset;
      recordIndex += chain.records.length - 1;
      const firstRecord = chain.records[0]!;
      for (const section of chain.records) {
        assertSupportedDirectoryRecord(section, filePath || ".", volumeSetSize, { allowInterleaving: true, allowMultiExtent: true });
        if (section.volumeSequenceNumber === localVolumeSequenceNumber) {
          assertFileSectionInBounds(image, section, filePath);
        }
      }
      const file: IsoFileEntry = fileEntryFromSectionChain(chain.records, filePath, identifier);
      if (firstRecord.systemUse.byteLength > 0) {
        file.systemUse = firstRecord.systemUse;
      }
      if (firstRecord.volumeSequenceNumber !== localVolumeSequenceNumber) {
        children.push(markExternalFile(file));
        continue;
      }
      if (firstRecord.extendedAttributeRecordLength > 0) {
        file.extendedAttributeRecord = readExtendedAttributeRecord(image, firstRecord);
        const fields = decodeOptionalExtendedAttributeRecord(file.extendedAttributeRecord);
        if (fields) {
          file.extendedAttributeRecordFields = fields;
        }
      }
      if (includeData) {
        file.data = readFileSectionData(image, chain.records);
      }
      children.push(file);
    }
  }

  if (recordIndex === 0) {
    throw new Error(`directory self record is missing at ${path || "."}`);
  }
  if (recordIndex === 1) {
    throw new Error(`directory parent record is missing at ${path || "."}`);
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

function assertDirectoryDataLengthForParsing(directory: Pick<IsoDirectoryEntry, "size">, path: string): void {
  if (directory.size <= 0 || directory.size % SECTOR_SIZE !== 0) {
    throw new Error(`directory data length at ${path} must be a positive multiple of the logical block size`);
  }
}

function hasNonzeroUnusedDirectoryBytes(bytes: Uint8Array, offset: number, nextSectorOffset: number): boolean {
  for (let paddingOffset = offset; paddingOffset < nextSectorOffset && paddingOffset < bytes.byteLength; paddingOffset += 1) {
    if (bytes[paddingOffset] !== 0) {
      return true;
    }
  }
  return false;
}

function assertOrdinaryDirectoryRecordIdentifierForParsing(record: DecodedDirectoryRecord, path: string): void {
  if (record.identifier.length === 1 && (record.identifier[0] === 0 || record.identifier[0] === 1)) {
    throw new Error(`directory record at ${path} must not use special identifier ${record.identifier[0]} outside self/parent records`);
  }
}

function assertPrimaryDirectoryRecordIdentifierForParsing(record: DecodedDirectoryRecord, path: string): void {
  const isDirectory = (record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY;
  const valid = isDirectory ? isSupportedPrimaryDirectoryIdentifier(record.identifier) : isSupportedPrimaryFileIdentifier(record.identifier);
  if (!valid) {
    throw new Error(`primary directory record ${isDirectory ? "directory identifier contains invalid ECMA-119 primary d-characters" : "file identifier contains invalid ECMA-119 primary file identifier"} at ${path}`);
  }
}

function assertPrimaryHierarchyDepthForParsing(depth: number, path: string): void {
  if (depth > 8) {
    throw new Error(`primary directory hierarchy depth at ${path} must not exceed 8 levels`);
  }
}

function assertPrimaryFilePathLengthForParsing(record: DecodedDirectoryRecord, path: string, filePathLengthPrefix: number): void {
  const filePathLength = filePathLengthPrefix + record.identifier.length;
  if (filePathLength > MAX_FILE_PATH_LENGTH) {
    throw new Error(`file path length at ${path} must not exceed ${MAX_FILE_PATH_LENGTH} bytes`);
  }
}

function assertDirectoryRecordIdentifierProfileForParsing(record: DecodedDirectoryRecord, path: string, profile: DirectoryIdentifierProfile): void {
  if ((record.flags & FILE_FLAG_DIRECTORY) !== FILE_FLAG_DIRECTORY) {
    return;
  }
  const limit = secondaryDirectoryIdentifierLengthLimit(profile);
  if (record.identifier.length > limit) {
    throw new Error(`${profile} directory record directory identifier length at ${path} must not exceed ${limit} bytes`);
  }
}

function assertDotDirectoryRecordForParsing(
  record: DecodedDirectoryRecord,
  index: number,
  directory: IsoDirectoryEntry,
  parent: IsoDirectoryEntry,
  path: string,
): void {
  const expectedIdentifier = index === 0 ? 0 : 1;
  const expectedEntry = index === 0 ? directory : parent;
  const recordName = index === 0 ? "self" : "parent";
  const expectedName = index === 0 ? "current directory" : "parent directory";

  if (record.identifier.length !== 1 || record.identifier[0] !== expectedIdentifier) {
    throw new Error(`directory ${recordName} record at ${path} must use identifier ${expectedIdentifier}`);
  }
  if ((record.flags & FILE_FLAG_DIRECTORY) !== FILE_FLAG_DIRECTORY) {
    throw new Error(`directory ${recordName} record at ${path} must have the Directory flag set`);
  }
  if (
    record.extent !== expectedEntry.extent
    || record.extendedAttributeRecordLength !== expectedEntry.extendedAttributeRecordLength
    || record.dataLength !== expectedEntry.size
  ) {
    throw new Error(`directory ${recordName} record at ${path} does not match the ${expectedName} extent fields`);
  }
  if (record.volumeSequenceNumber !== expectedEntry.volumeSequenceNumber) {
    throw new Error(`directory ${recordName} record at ${path} does not match the ${expectedName} volume sequence number`);
  }
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

function markExternalDirectory(directory: IsoDirectoryEntry): IsoDirectoryEntry {
  const externalDirectory: IsoDirectoryEntry = {
    ...directory,
    external: true,
    children: [],
  };
  if (directory.sections) {
    externalDirectory.sections = directory.sections.map(markExternalSection);
  }
  return externalDirectory;
}

function markExternalFile(file: IsoFileEntry): IsoFileEntry {
  const { data, extendedAttributeRecord, extendedAttributeRecordFields, ...metadata } = file;
  void data;
  void extendedAttributeRecord;
  void extendedAttributeRecordFields;
  const externalFile: IsoFileEntry = {
    ...metadata,
    external: true,
  };
  if (file.sections) {
    externalFile.sections = file.sections.map(markExternalSection);
  }
  return externalFile;
}

function markExternalSection(section: IsoFileSection): IsoFileSection {
  return { ...section, external: true };
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
    const boundsIssue = validateExtendedAttributeRecordBounds(image, record.extent, record.extendedAttributeRecordLength, recordPath);
    if (boundsIssue) {
      issues.push(boundsIssue);
      continue;
    }
    const extendedAttributeRecord = readExtendedAttributeRecord(image, record);
    const bothEndianIssues = validateExtendedAttributeRecordBothEndianFields(extendedAttributeRecord, recordPath);
    const dateIssues = validateExtendedAttributeRecordDateFields(extendedAttributeRecord, recordPath);
    const characterIssues = validateExtendedAttributeRecordCharacterFields(extendedAttributeRecord, recordPath);
    const reservedIssues = validateExtendedAttributeRecordReservedBytes(extendedAttributeRecord, recordPath);
    const scalarIssues = validateExtendedAttributeRecordScalarLayoutFields(extendedAttributeRecord, recordPath);
    issues.push(...bothEndianIssues);
    issues.push(...dateIssues);
    issues.push(...characterIssues);
    issues.push(...reservedIssues);
    issues.push(...scalarIssues);
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
      const message = error instanceof Error ? error.message : String(error);
      if (!shouldSuppressExtendedAttributeRecordParse(message, [...bothEndianIssues, ...dateIssues, ...characterIssues, ...reservedIssues, ...scalarIssues], extendedAttributeRecord)) {
        issues.push({
          code: "extended_attribute_record.parse",
          message,
          path: recordPath,
        });
      }
    }
  }
  return issues;
}

function validateDirectoryEntryExtendedAttributeRecord(image: Uint8Array, entry: IsoDirectoryEntry, path: string, localVolumeSequenceNumber: number): ValidationIssue[] {
  if (entry.extendedAttributeRecordLength === 0 || entry.volumeSequenceNumber !== localVolumeSequenceNumber) {
    return [];
  }
  const boundsIssue = validateExtendedAttributeRecordBounds(image, entry.extent, entry.extendedAttributeRecordLength, path);
  if (boundsIssue) {
    return [boundsIssue];
  }
  const extendedAttributeRecord = image.slice(entry.extent * SECTOR_SIZE, (entry.extent + entry.extendedAttributeRecordLength) * SECTOR_SIZE);
  const issues = validateExtendedAttributeRecordBothEndianFields(extendedAttributeRecord, path);
  issues.push(...validateExtendedAttributeRecordDateFields(extendedAttributeRecord, path));
  issues.push(...validateExtendedAttributeRecordCharacterFields(extendedAttributeRecord, path));
  issues.push(...validateExtendedAttributeRecordReservedBytes(extendedAttributeRecord, path));
  issues.push(...validateExtendedAttributeRecordScalarLayoutFields(extendedAttributeRecord, path));
  try {
    const fields = decodeExtendedAttributeRecord(extendedAttributeRecord);
    const expected = extendedAttributeRecordFileFlags(fields) & 0x10;
    if ((entry.flags & 0x10) !== expected) {
      issues.push({
        code: "extended_attribute_record.file_flags",
        message: `directory record flags for ${path} do not match associated extended attribute record fields`,
        path,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!shouldSuppressExtendedAttributeRecordParse(message, issues, extendedAttributeRecord)) {
      issues.push({
        code: "extended_attribute_record.parse",
        message,
        path,
      });
    }
  }
  return issues;
}

const extendedAttributeRecordBothEndianFields = [
  { start: 0, code: "owner_identification", label: "owner identification" },
  { start: 4, code: "group_identification", label: "group identification" },
  { start: 80, code: "record_length", label: "record length" },
  { start: 246, code: "application_use_length", label: "application use length" },
] as const;

function validateExtendedAttributeRecordBounds(image: Uint8Array, extent: number, length: number, path: string): ValidationIssue | undefined {
  const start = extent * SECTOR_SIZE;
  const end = start + length * SECTOR_SIZE;
  if (
    !Number.isInteger(extent)
    || !Number.isInteger(length)
    || extent < 0
    || length < 0
    || start < 0
    || end > image.byteLength
  ) {
    return {
      code: "extended_attribute_record.bounds",
      message: `extended attribute record for ${path} has invalid extent bounds`,
      path,
    };
  }
  return undefined;
}

function validateExtendedAttributeRecordBothEndianFields(bytes: Uint8Array, path: string): ValidationIssue[] {
  if (bytes.byteLength < 250) {
    return [];
  }
  const issues: ValidationIssue[] = [];
  for (const field of extendedAttributeRecordBothEndianFields) {
    const little = readUint16LEAt(bytes, field.start);
    const big = readUint16BEAt(bytes, field.start + 2);
    if (little !== big) {
      issues.push({
        code: `extended_attribute_record.${field.code}.endian_mismatch`,
        message: `extended attribute record ${field.label} at ${path} must store matching little- and big-endian values: ${little} !== ${big}`,
        path,
      });
    }
  }
  return issues;
}

const extendedAttributeRecordDateFields = [
  { start: 10, code: "creation_date", label: "creation date and time", required: true },
  { start: 27, code: "modification_date", label: "modification date and time", required: true },
  { start: 44, code: "expiration_date", label: "expiration date and time", required: false },
  { start: 61, code: "effective_date", label: "effective date and time", required: false },
] as const;

function validateExtendedAttributeRecordDateFields(bytes: Uint8Array, path: string): ValidationIssue[] {
  if (bytes.byteLength < 78) {
    return [];
  }
  return extendedAttributeRecordDateFields.flatMap((field) =>
    validateExtendedAttributeRecordDateField(bytes, field.start, `extended_attribute_record.${field.code}`, `extended attribute record ${field.label} at ${path}`, path, field.required)
  );
}

function validateExtendedAttributeRecordCharacterFields(bytes: Uint8Array, path: string): ValidationIssue[] {
  if (bytes.byteLength < 116) {
    return [];
  }
  const systemIdentifier = readAscii(bytes, 84, 32);
  if (isAString(systemIdentifier)) {
    return [];
  }
  return [{
    code: "extended_attribute_record.system_identifier.characters",
    message: `extended attribute record system identifier at ${path} contains invalid ECMA-119 a-characters`,
    path,
  }];
}

function validateExtendedAttributeRecordReservedBytes(bytes: Uint8Array, path: string): ValidationIssue[] {
  if (bytes.byteLength < 246) {
    return [];
  }
  for (let offset = 182; offset < 246; offset += 1) {
    if (bytes[offset] !== 0) {
      return [{
        code: "extended_attribute_record.reserved_bytes",
        message: `extended attribute record reserved bytes at ${path} must be zero`,
        path,
      }];
    }
  }
  return [];
}

function validateExtendedAttributeRecordScalarLayoutFields(bytes: Uint8Array, path: string): ValidationIssue[] {
  if (bytes.byteLength < 181) {
    return [];
  }
  const issues: ValidationIssue[] = [];
  const ownerIdentification = readMatchingBothEndianUint16(bytes, 0);
  const groupIdentification = readMatchingBothEndianUint16(bytes, 4);
  if (
    ownerIdentification !== undefined
    && groupIdentification !== undefined
    && (ownerIdentification === 0) !== (groupIdentification === 0)
  ) {
    issues.push({
      code: "extended_attribute_record.owner_group",
      message: `extended attribute record owner identification and group identification at ${path} must both be zero or both be nonzero`,
      path,
    });
  }

  const permissions = (bytes[8]! << 8) | bytes[9]!;
  if ((permissions & 0xaaaa) !== 0xaaaa) {
    issues.push({
      code: "extended_attribute_record.permissions",
      message: `extended attribute record permissions at ${path} must set bits 1,3,5,7,9,11,13,15`,
      path,
    });
  }

  const recordFormat = bytes[78]!;
  const recordAttributes = bytes[79]!;
  const recordLength = readMatchingBothEndianUint16(bytes, 80);
  const applicationUseLength = readMatchingBothEndianUint16(bytes, 246);
  if (applicationUseLength !== undefined && 250 + applicationUseLength + bytes[181]! > bytes.byteLength) {
    issues.push({
      code: "extended_attribute_record.application_use_escape_sequences.bounds",
      message: `extended attribute record application use and escape sequences at ${path} exceed record length`,
      path,
    });
  }
  if (recordFormat > 3 && recordFormat < 128) {
    issues.push({
      code: "extended_attribute_record.record_format.reserved",
      message: `extended attribute record record format at ${path} uses reserved value ${recordFormat}`,
      path,
    });
  }
  if (recordAttributes > 2) {
    issues.push({
      code: "extended_attribute_record.record_attributes.reserved",
      message: `extended attribute record record attributes at ${path} uses reserved value ${recordAttributes}`,
      path,
    });
  }
  if (recordLength !== undefined) {
    if (recordFormat === 0 && recordLength !== 0) {
      issues.push({
        code: "extended_attribute_record.record_length",
        message: `extended attribute record record length at ${path} must be zero when record format is zero`,
        path,
      });
    } else if (recordFormat === 1 && recordLength < 1) {
      issues.push({
        code: "extended_attribute_record.record_length",
        message: `extended attribute record record length at ${path} must be at least one for fixed-length records`,
        path,
      });
    } else if ((recordFormat === 2 || recordFormat === 3) && (recordLength < 1 || recordLength > 32767)) {
      issues.push({
        code: "extended_attribute_record.record_length",
        message: `extended attribute record record length at ${path} must be 1 through 32767 for variable-length records`,
        path,
      });
    }
  }

  const version = bytes[180]!;
  if (version !== 1) {
    issues.push({
      code: "extended_attribute_record.version",
      message: `extended attribute record version at ${path} must be 1`,
      path,
    });
  }
  return issues;
}

function readMatchingBothEndianUint16(bytes: Uint8Array, offset: number): number | undefined {
  if (bytes.byteLength < offset + 4) {
    return undefined;
  }
  const little = bytes[offset]! | (bytes[offset + 1]! << 8);
  const big = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
  return little === big ? little : undefined;
}

function validateExtendedAttributeRecordDateField(bytes: Uint8Array, offset: number, code: string, label: string, path: string, required: boolean): ValidationIssue[] {
  const text = readAscii(bytes, offset, 16);
  if (/^0{16}$/u.test(text)) {
    if (required) {
      return [{ code, message: `${label} must be specified`, path }];
    }
    if (bytes[offset + 16] !== 0) {
      return [{ code, message: `${label} unspecified value must use zero GMT offset`, path }];
    }
    return [];
  }
  if (!/^[0-9]{16}$/u.test(text)) {
    return [{ code, message: `${label} must contain 16 decimal digits followed by a signed GMT offset byte`, path }];
  }
  try {
    readVolumeDescriptorDateTime(bytes, offset);
    return [];
  } catch (error) {
    return [{
      code,
      message: `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      path,
    }];
  }
}

function shouldSuppressExtendedAttributeRecordParse(message: string, issues: ValidationIssue[], bytes: Uint8Array): boolean {
  const hasBothEndianIssue = issues.some((issue) => issue.code.startsWith("extended_attribute_record.") && issue.code.endsWith(".endian_mismatch"));
  const hasDateIssue = issues.some((issue) => issue.code.startsWith("extended_attribute_record.") && issue.code.endsWith("_date"));
  const hasCharacterIssue = issues.some((issue) => issue.code === "extended_attribute_record.system_identifier.characters");
  const hasReservedIssue = issues.some((issue) => issue.code === "extended_attribute_record.reserved_bytes");
  const hasOwnerGroupIssue = issues.some((issue) => issue.code === "extended_attribute_record.owner_group");
  const hasPermissionsIssue = issues.some((issue) => issue.code === "extended_attribute_record.permissions");
  const hasApplicationUseEscapeBoundsIssue = issues.some((issue) => issue.code === "extended_attribute_record.application_use_escape_sequences.bounds");
  const hasRecordFormatIssue = issues.some((issue) => issue.code === "extended_attribute_record.record_format.reserved");
  const hasRecordAttributesIssue = issues.some((issue) => issue.code === "extended_attribute_record.record_attributes.reserved");
  const hasRecordLengthIssue = issues.some((issue) => issue.code === "extended_attribute_record.record_length");
  const hasVersionIssue = issues.some((issue) => issue.code === "extended_attribute_record.version");
  const hasStructuredVersion = bytes[180] === 1;
  return (hasBothEndianIssue
    && message.includes("both-endian")
    && bytes[180] === 1)
    || (hasDateIssue && isExtendedAttributeRecordDateParseMessage(message))
    || (hasCharacterIssue && message.includes("system identifier contains invalid ECMA-119 a-characters"))
    || (hasReservedIssue && message.includes("reserved bytes must be zero"))
    || (hasStructuredVersion && hasApplicationUseEscapeBoundsIssue && message.includes("application use and escape sequences exceed record length"))
    || (hasStructuredVersion && hasOwnerGroupIssue && message.includes("owner identification and group identification must both be zero or both be nonzero"))
    || (hasStructuredVersion && hasPermissionsIssue && message.includes("permissions bits 1,3,5,7,9,11,13,15 must be set"))
    || (hasStructuredVersion && hasRecordFormatIssue && message.includes("record format values 4 through 127 are reserved"))
    || (hasStructuredVersion && hasRecordAttributesIssue && message.includes("record attributes values 3 through 255 are reserved"))
    || (hasStructuredVersion && hasRecordLengthIssue && isExtendedAttributeRecordLengthParseMessage(message))
    || (hasVersionIssue && message.includes("extended attribute record version must be 1"));
}

function isExtendedAttributeRecordDateParseMessage(message: string): boolean {
  return /\b(date|month|day|hour|minute|second|hundredths|offset)\b/i.test(message);
}

function isExtendedAttributeRecordLengthParseMessage(message: string): boolean {
  return message.includes("record length must be zero when record format is zero")
    || message.includes("record length must be at least one for fixed-length records")
    || message.includes("record length must be 1 through 32767 for variable-length records");
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
  if (directory.sections) {
    if (directory.sections.some((section) => !sectionInBounds(image, {
      extent: section.extent,
      extendedAttributeRecordLength: section.extendedAttributeRecordLength,
      dataLength: section.size,
      fileUnitSize: section.fileUnitSize,
      interleaveGapSize: section.interleaveGapSize,
    }))) {
      return undefined;
    }
    const bytes = new Uint8Array(directory.size);
    let writeOffset = 0;
    for (const section of directory.sections) {
      writeOffset = readSectionPayload(image, {
        extent: section.extent,
        extendedAttributeRecordLength: section.extendedAttributeRecordLength,
        dataLength: section.size,
        fileUnitSize: section.fileUnitSize,
        interleaveGapSize: section.interleaveGapSize,
      }, bytes, writeOffset);
    }
    return bytes;
  }
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
  if (directory.sections) {
    for (const section of directory.sections) {
      if (!sectionInBounds(image, {
        extent: section.extent,
        extendedAttributeRecordLength: section.extendedAttributeRecordLength,
        dataLength: section.size,
        fileUnitSize: section.fileUnitSize,
        interleaveGapSize: section.interleaveGapSize,
      })) {
        throw new Error(`invalid extent bounds for ${path}`);
      }
    }
    return;
  }
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
  volumeSetSize: number,
  options: { allowInterleaving?: boolean; allowMultiExtent?: boolean } = {},
): void {
  assertSupportedDirectoryFileFlags(record.flags, path);
  assertSupportedDirectoryRecordDirectoryFlags(record.flags, path);
  if (record.fileUnitSize === 0 && record.interleaveGapSize !== 0) {
    throw new Error(`directory record at ${path} has invalid interleaved file section fields`);
  }
  if (!options.allowInterleaving && record.fileUnitSize !== 0) {
    throw new Error(`directory record at ${path} uses unsupported interleaved file section fields`);
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
  assertSupportedVolumeSequence(record.volumeSequenceNumber, path, volumeSetSize);
}

function assertSupportedDirectoryEntry(entry: IsoDirectoryEntry, path: string, volumeSetSize: number): void {
  assertSupportedDirectoryFileFlags(entry.flags, path);
  assertSupportedDirectoryRecordDirectoryFlags(entry.flags, path);
  if (entry.fileUnitSize === 0 && entry.interleaveGapSize !== 0) {
    throw new Error(`directory record at ${path} has invalid interleaved file section fields`);
  }
  if (entry.fileUnitSize !== 0) {
    throw new Error(`directory record at ${path} uses unsupported interleaved file section fields`);
  }
  if ((entry.flags & FILE_FLAG_MULTI_EXTENT) !== 0) {
    throw new Error(`directory record at ${path} uses unsupported multi-extent file sections`);
  }
  assertSupportedVolumeSequence(entry.volumeSequenceNumber, path, volumeSetSize);
}

function assertSupportedDirectoryFileFlags(flags: number, path: string): void {
  if ((flags & 0x60) !== 0) {
    throw new Error(`directory record has reserved file flag bits set at ${path}`);
  }
}

function assertSupportedDirectoryRecordDirectoryFlags(flags: number, path: string): void {
  if ((flags & FILE_FLAG_DIRECTORY) !== 0 && (flags & 0x0c) !== 0) {
    throw new Error(`directory record at ${path} identifies a directory and must not set Associated File or Record bits`);
  }
}

function assertSupportedBootVolumeDescriptor(descriptor: BootVolumeDescriptor): void {
  if (!isAString(readAscii(descriptor.raw, 7, 32))) {
    throw new Error("boot system identifier contains invalid ECMA-119 a-characters");
  }
  if (!isAString(readAscii(descriptor.raw, 39, 32))) {
    throw new Error("boot identifier contains invalid ECMA-119 a-characters");
  }
}

function assertSupportedPartitionVolumeDescriptor(image: Uint8Array, descriptor: VolumePartitionDescriptor, pvd: PrimaryVolumeDescriptor): void {
  if (!isAString(readAscii(descriptor.raw, 8, 32))) {
    throw new Error("volume partition descriptor system identifier contains invalid ECMA-119 a-characters");
  }
  if (!isDString(readAscii(descriptor.raw, 40, 32).replace(/ +$/u, ""))) {
    throw new Error("volume partition descriptor volume partition identifier contains invalid ECMA-119 d-characters");
  }
  const location = descriptor.volumePartitionLocation;
  const size = descriptor.volumePartitionSize;
  const end = location + size;
  const imageSectors = Math.floor(image.byteLength / SECTOR_SIZE);
  if (
    !Number.isInteger(location)
    || !Number.isInteger(size)
    || size < 1
    || end > 0xffffffff
    || end > imageSectors
    || location > imageSectors
  ) {
    throw new Error(`volume partition extent ${location}+${size} is out of bounds`);
  }
  if (end > pvd.volumeSpaceSize) {
    throw new Error(volumeSpaceLowerBoundMessage(pvd.volumeSpaceSize, end, "pvd"));
  }
}

function assertSupportedVolumeSequence(volumeSequenceNumber: number, path: string, volumeSetSize: number): void {
  if (volumeSequenceNumber < 1) {
    throw new Error(`directory record at ${path} has invalid volume sequence number ${volumeSequenceNumber}`);
  }
  if (volumeSequenceNumber > volumeSetSize) {
    throw new Error(`directory record at ${path} references volume sequence number ${volumeSequenceNumber} outside volume set size ${volumeSetSize}`);
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

function assertVolumeSetConsistentWithPrimary(
  descriptor: SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor,
  pvd: PrimaryVolumeDescriptor,
): void {
  if (descriptor.volumeSetSize !== pvd.volumeSetSize) {
    throw new Error(`${descriptor.kind} volume descriptor volume set size must match primary volume descriptor`);
  }
  if (descriptor.volumeSequenceNumber !== pvd.volumeSequenceNumber) {
    throw new Error(`${descriptor.kind} volume descriptor volume sequence number must match primary volume descriptor`);
  }
}

function assertSupportedDescriptorProfile(descriptor: PathTableValidationInput, label: string): void {
  if (descriptor.logicalBlockSize !== SECTOR_SIZE) {
    throw new Error(`${label} logical block size must be 2048 for the supported profile`);
  }
  const expectedFileStructureVersion = descriptor.kind === "enhanced" ? 2 : 1;
  if (descriptor.fileStructureVersion !== expectedFileStructureVersion) {
    throw new Error(`${label} file structure version must be ${expectedFileStructureVersion}`);
  }
}

function assertSupportedSecondaryVolumeFlags(descriptor: SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor): void {
  if ((descriptor.volumeFlags & 0xfe) !== 0) {
    throw new Error(`${descriptor.kind} volume descriptor flags bits 1 through 7 must be zero`);
  }
}

function assertSupportedSecondaryEscapeSequences(descriptor: SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor): void {
  const bytes = descriptor.escapeSequences;
  if (allZero(bytes)) {
    return;
  }
  if (bytes[0] === 0) {
    throw new Error(`${descriptor.kind} volume descriptor escape sequences must start at BP 89 when present`);
  }
  const firstZero = bytes.indexOf(0);
  if (firstZero !== -1 && !allZero(bytes.subarray(firstZero))) {
    throw new Error(`${descriptor.kind} volume descriptor escape sequences field must be zero after the last escape sequence byte`);
  }
  if (!isSupportedSecondaryEscapeSequence(descriptor.kind, bytes)) {
    throw new Error(`${descriptor.kind} volume descriptor escape sequences contain an unsupported value`);
  }
}

function isSupportedSecondaryEscapeSequence(kind: "supplementary" | "enhanced", bytes: Uint8Array): boolean {
  const sequenceEnd = bytes.indexOf(0);
  const sequence = sequenceEnd === -1 ? bytes : bytes.subarray(0, sequenceEnd);
  if (kind === "enhanced") {
    return bytesEqual(sequence, Uint8Array.of(0x25, 0x2f, 0x45));
  }
  return [
    Uint8Array.of(0x25, 0x2f, 0x40),
    Uint8Array.of(0x25, 0x2f, 0x43),
    Uint8Array.of(0x25, 0x2f, 0x45),
  ].some((supported) => bytesEqual(sequence, supported));
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

function validateVolumeSetConsistency(
  descriptor: SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor,
  pvd: PrimaryVolumeDescriptor,
  codePrefix: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (descriptor.volumeSetSize !== pvd.volumeSetSize) {
    issues.push({
      code: `${codePrefix}.volume_set_size.mismatch`,
      message: `${codePrefix} volume descriptor volume set size must match primary volume descriptor`,
    });
  }
  if (descriptor.volumeSequenceNumber !== pvd.volumeSequenceNumber) {
    issues.push({
      code: `${codePrefix}.volume_sequence_number.mismatch`,
      message: `${codePrefix} volume descriptor volume sequence number must match primary volume descriptor`,
    });
  }
  return issues;
}

function validateDirectoryEntryInterleaving(entry: IsoDirectoryEntry, path: string): ValidationIssue[] {
  return validateDirectoryRecordSectionLayout(entry, path);
}

function validateDirectoryRecordSectionLayout(
  entry: Pick<IsoDirectoryEntry | DecodedDirectoryRecord, "fileUnitSize" | "interleaveGapSize" | "flags">,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (entry.fileUnitSize === 0 && entry.interleaveGapSize === 0 && (entry.flags & FILE_FLAG_MULTI_EXTENT) === 0) {
    return [];
  }
  if (entry.fileUnitSize === 0 && entry.interleaveGapSize !== 0) {
    issues.push({
      code: "directory.interleaving_invalid",
      message: `directory record at ${path} has invalid interleaved file section fields`,
      path,
    });
  } else if (entry.fileUnitSize !== 0) {
    issues.push({
      code: "directory.interleaving_unsupported",
      message: `directory record at ${path} uses unsupported interleaved file section fields`,
      path,
    });
  }
  if ((entry.flags & FILE_FLAG_MULTI_EXTENT) !== 0) {
    issues.push({
      code: "directory.multi_extent_unsupported",
      message: `directory record at ${path} uses unsupported multi-extent file sections`,
      path,
    });
  }
  return issues;
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

function validateDirectoryEntryVolumeSequence(entry: IsoDirectoryEntry, path: string, volumeSetSize: number): ValidationIssue[] {
  if (entry.volumeSequenceNumber >= 1 && entry.volumeSequenceNumber <= volumeSetSize) {
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
    code: "directory.volume_sequence_number.bounds",
    message: `directory record at ${path} references volume sequence number ${entry.volumeSequenceNumber} outside volume set size ${volumeSetSize}`,
    path,
  }];
}

function validateDirectoryRecordVolumeSequence(record: DecodedDirectoryRecord, path: string, volumeSetSize: number): ValidationIssue[] {
  if (record.volumeSequenceNumber >= 1 && record.volumeSequenceNumber <= volumeSetSize) {
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
    code: "directory.volume_sequence_number.bounds",
    message: `directory record at ${path} references volume sequence number ${record.volumeSequenceNumber} outside volume set size ${volumeSetSize}`,
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
      (issue.code === "descriptor.primary_duplicate" || issue.code === "descriptor.unknown")
      && issue.message === message
    ) {
      return true;
    }
    if (issue.code === "descriptor.sequence.order" && issue.message === message) {
      return true;
    }
    if (issue.code.endsWith(".root_directory_record.identifier") && issue.message === message) {
      return true;
    }
    if (
      (issue.code === "pvd.volume_space_size" || issue.code === "pvd.volume_space_size.lower_bound")
      && issue.message === message
    ) {
      return true;
    }
    if (
      (issue.code.endsWith(".unused") || issue.code.endsWith(".reserved") || issue.code === "descriptor.terminator_reserved")
      && issue.message === message
    ) {
      return true;
    }
    if (
      (issue.code === "directory.record_malformed" || issue.code === "directory.record_padding")
      && (message.includes("directory record has invalid length")
        || message.includes("directory record identifier length is inconsistent")
        || message.includes("directory record file identifier padding byte must be zero"))
    ) {
      return true;
    }
    if (issue.code.startsWith("directory.") && issue.code.endsWith(".endian_mismatch") && message.includes("both-endian uint")) {
      return true;
    }
    if (issue.code === "extended_attribute_record.bounds" && message.includes("invalid extent bounds")) {
      return true;
    }
    if (issue.code === "directory.file_extent_bounds" && message.includes("invalid extent bounds")) {
      return true;
    }
    if (issue.code === "directory.unused_bytes" && message.includes("unused directory bytes after the last record")) {
      return true;
    }
    if (issue.code === "directory.directory_identifier.length" && message.includes("directory record directory identifier length")) {
      return true;
    }
    if (issue.code === "directory.hierarchy_depth" && message.includes("primary directory hierarchy depth")) {
      return true;
    }
    if (issue.code === "directory.file_path_length" && message.includes("file path length")) {
      return true;
    }
    if (issue.code.includes("_path_table.") && issue.code.endsWith(".identifier.length") && message.includes("path table record")) {
      return true;
    }
    if (
      (issue.code === "supplementary.logical_block_size" || issue.code === "enhanced.logical_block_size")
      && message.includes(`${issue.code.split(".")[0]} volume descriptor logical block size must be 2048`)
    ) {
      return true;
    }
    if (
      (issue.code === "supplementary.volume_flags" || issue.code === "enhanced.volume_flags")
      && message.includes(`${issue.code.split(".")[0]} volume descriptor flags bits 1 through 7 must be zero`)
    ) {
      return true;
    }
    if (
      (issue.code === "supplementary.volume_set_size.mismatch" || issue.code === "enhanced.volume_set_size.mismatch")
      && message.includes(`${issue.code.split(".")[0]} volume descriptor volume set size must match primary volume descriptor`)
    ) {
      return true;
    }
    if (
      (issue.code === "supplementary.volume_sequence_number.mismatch" || issue.code === "enhanced.volume_sequence_number.mismatch")
      && message.includes(`${issue.code.split(".")[0]} volume descriptor volume sequence number must match primary volume descriptor`)
    ) {
      return true;
    }
    if (
      (issue.code === "supplementary.escape_sequences.value" || issue.code === "enhanced.escape_sequences.value")
      && message.includes(`${issue.code.split(".")[0]} volume descriptor escape sequences contain an unsupported value`)
    ) {
      return true;
    }
    if (
      (issue.code === "supplementary.escape_sequences.start" || issue.code === "enhanced.escape_sequences.start")
      && message.includes(`${issue.code.split(".")[0]} volume descriptor escape sequences must start at BP 89`)
    ) {
      return true;
    }
    if (
      (issue.code === "supplementary.escape_sequences.padding" || issue.code === "enhanced.escape_sequences.padding")
      && message.includes(`${issue.code.split(".")[0]} volume descriptor escape sequences field must be zero after the last escape sequence byte`)
    ) {
      return true;
    }
    if (
      (issue.code === "directory.multi_extent_sequence" || issue.code === "directory.multi_extent_final_missing")
      && secondaryDescriptorPathlessMessage(issue.message).includes(message)
    ) {
      return true;
    }
    return message.includes(issue.message) || issue.message.includes(message);
  });
}

function secondaryDescriptorPathlessMessage(message: string): string {
  return message
    .replace(/\b(?:supplementary|enhanced):\.\//gu, "")
    .replace(/\b(?:supplementary|enhanced):\./gu, ".");
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

function readUint16LEAt(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint16BEAt(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}
