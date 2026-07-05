import { decodeVolumeDate, readAscii, readAsciiTrimmed, readUint16Both, readUint32Both, sectorOffset } from "./binary.js";
import { decodeDirectoryRecord, FILE_FLAG_DIRECTORY, type DecodedDirectoryRecord } from "./directory-record.js";
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
  validatePrimaryDescriptorReferences(image, pvd);
  const root = readDirectoryTree(image, pvd.rootDirectoryRecord, "", options.includeData ?? true, new Set());
  return {
    descriptors,
    primaryVolumeDescriptor: { ...pvd, rootDirectoryRecord: root },
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
      issues.push(...validatePrimaryVolumeDescriptor(image, pvd));
      issues.push(...validateDirectoryRecordLayout(image, pvd.rootDirectoryRecord, "."));
    }
  } catch (error) {
    descriptorSequenceFailed = true;
    issues.push({ code: "descriptor.sequence", message: error instanceof Error ? error.message : String(error) });
  }
  if (!descriptorSequenceFailed) {
    try {
      parseIsoImage(image, { includeData: false });
    } catch (error) {
      issues.push({ code: "image.parse", message: error instanceof Error ? error.message : String(error) });
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
      throw new Error(`missing volume descriptor set terminator before sector ${sector}: ${error instanceof Error ? error.message : String(error)}`);
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
  const rootRecord = decodeDirectoryRecord(image, offset + 156);
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
    typeMPathTableLocation: readUint32BEAt(image, offset + 148),
    rootDirectoryRecord: directoryEntryFromRecord(rootRecord, "", []),
    volumeSetIdentifier: readAsciiTrimmed(image, offset + 190, 128),
    publisherIdentifier: readAsciiTrimmed(image, offset + 318, 128),
    dataPreparerIdentifier: readAsciiTrimmed(image, offset + 446, 128),
    applicationIdentifier: readAsciiTrimmed(image, offset + 574, 128),
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

function validatePrimaryVolumeDescriptor(image: Uint8Array, pvd: PrimaryVolumeDescriptor): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (pvd.logicalBlockSize !== SECTOR_SIZE) {
    issues.push({ code: "pvd.logical_block_size", message: "logical block size must be 2048 for the supported profile" });
  }
  if (pvd.volumeSpaceSize * SECTOR_SIZE > image.byteLength) {
    issues.push({ code: "pvd.volume_space_size", message: "volume space size exceeds image length" });
  }
  const pathTableStart = pvd.typeLPathTableLocation * SECTOR_SIZE;
  const pathTableEnd = pathTableStart + pvd.pathTableSize;
  if (pathTableStart < 0 || pathTableEnd > image.byteLength) {
    issues.push({ code: "path_table.bounds", message: "Type L path table extent is out of bounds" });
    return issues;
  }
  let pathTable: PathTableRecord[];
  try {
    pathTable = decodePathTable(image.subarray(pathTableStart, pathTableEnd), "little");
  } catch (error) {
    issues.push({ code: "path_table.parse", message: error instanceof Error ? error.message : String(error) });
    return issues;
  }
  if (pathTable.length === 0) {
    issues.push({ code: "path_table.empty", message: "path table must contain the root directory record" });
    return issues;
  }
  const root = pathTable[0]!;
  if (root.parentDirectoryNumber !== 1 || root.identifier.length !== 1 || root.identifier[0] !== 0) {
    issues.push({ code: "path_table.root", message: "first path table record must be the root directory with parent number 1" });
  }
  for (const [index, record] of pathTable.entries()) {
    const isRoot = index === 0;
    const invalidParent = isRoot
      ? record.parentDirectoryNumber !== 1
      : record.parentDirectoryNumber < 1 || record.parentDirectoryNumber >= index + 1;
    if (invalidParent) {
      issues.push({
        code: "path_table.parent",
        message: `path table record ${index + 1} parent number ${record.parentDirectoryNumber} does not reference an earlier directory`,
      });
    }
  }
  return issues;
}

function validateDirectoryRecordLayout(image: Uint8Array, directory: IsoDirectoryEntry, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const start = directory.extent * SECTOR_SIZE;
  const end = start + directory.size;
  if (start < 0 || end > image.byteLength) {
    return [{ code: "directory.record_bounds", message: `directory extent for ${path} is out of bounds`, path }];
  }
  let offset = start;
  while (offset < end) {
    const length = image[offset]!;
    if (length === 0) {
      offset = Math.ceil((offset - start + 1) / SECTOR_SIZE) * SECTOR_SIZE + start;
      continue;
    }
    const relative = offset - start;
    if ((relative % SECTOR_SIZE) + length > SECTOR_SIZE) {
      issues.push({ code: "directory.record_crosses_sector", message: `directory record crosses a logical sector boundary at ${path}`, path });
      offset += 1;
      continue;
    }
    if (length < 34 || offset + length > end) {
      issues.push({ code: "directory.record_malformed", message: `directory record has invalid length at ${path}`, path });
      offset += Math.max(1, length);
      continue;
    }
    const identifierLength = image[offset + 32]!;
    const minimumLength = 33 + identifierLength + ((33 + identifierLength) % 2 === 0 ? 0 : 1);
    if (identifierLength === 0 || minimumLength > length) {
      issues.push({ code: "directory.record_malformed", message: `directory record identifier length is inconsistent with record length at ${path}`, path });
      offset += length;
      continue;
    }
    if ((image[offset + 25]! & 0x60) !== 0) {
      issues.push({ code: "directory.file_flags_reserved", message: `directory record has reserved file flag bits set at ${path}`, path });
    }
    offset += length;
  }
  return issues;
}

function parseSupplementaryLikeDescriptor(image: Uint8Array, offset: number, sector: number): SupplementaryVolumeDescriptor | EnhancedVolumeDescriptor {
  const common = {
    ...baseDescriptor(image, offset, sector, image[offset + 6] === 2 ? "enhanced" : "supplementary"),
    type: 2 as const,
    volumeFlags: image[offset + 7]!,
    systemIdentifier: readAsciiTrimmed(image, offset + 8, 32),
    volumeIdentifier: readAsciiTrimmed(image, offset + 40, 32),
    escapeSequences: image.slice(offset + 88, offset + 120),
  };
  return image[offset + 6] === 2
    ? { ...common, kind: "enhanced", version: 2 }
    : { ...common, kind: "supplementary", version: 1 };
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

function readDirectoryTree(image: Uint8Array, directory: IsoDirectoryEntry, path: string, includeData: boolean, visited: Set<number>): IsoDirectoryEntry {
  assertExtentInBounds(image, directory.extent, directory.size, path || ".");
  if (visited.has(directory.extent)) {
    throw new Error(`invalid directory cycle detected at ${path || "."}`);
  }
  visited.add(directory.extent);
  const start = directory.extent * SECTOR_SIZE;
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
    const record = decodeDirectoryRecord(bytes, offset);
    if ((record.flags & 0x60) !== 0) {
      throw new Error(`directory record has reserved file flag bits set at ${path || "."}`);
    }
    offset += record.length;

    if (recordIndex++ < 2) {
      continue;
    }

    const identifier = decodeFileIdentifier(record.identifier);
    if ((record.flags & FILE_FLAG_DIRECTORY) === FILE_FLAG_DIRECTORY) {
      const childPath = joinPath(path, identifier);
      const child = directoryEntryFromRecord(record, childPath, []);
      children.push(readDirectoryTree(image, child, childPath, includeData, new Set(visited)));
    } else {
      assertExtentInBounds(image, record.extent, record.dataLength, joinPath(path, stripVersion(identifier)));
      const cleanName = stripVersion(identifier);
      const filePath = joinPath(path, cleanName);
      const file: IsoFileEntry = {
        path: filePath,
        identifier,
        extent: record.extent,
        size: record.dataLength,
        date: record.date,
        flags: record.flags,
      };
      if (includeData) {
        file.data = image.slice(record.extent * SECTOR_SIZE, record.extent * SECTOR_SIZE + record.dataLength);
      }
      children.push(file);
    }
  }

  return { ...directory, children };
}

function assertExtentInBounds(image: Uint8Array, extent: number, length: number, path: string): void {
  const start = extent * SECTOR_SIZE;
  const end = start + length;
  if (!Number.isInteger(extent) || !Number.isInteger(length) || extent < 0 || length < 0 || start < 0 || end > image.byteLength) {
    throw new Error(`invalid extent bounds for ${path}`);
  }
}

function directoryEntryFromRecord(record: DecodedDirectoryRecord, path: string, children: IsoNode[]): IsoDirectoryEntry {
  return {
    path,
    identifier: decodeFileIdentifier(record.identifier),
    extent: record.extent,
    size: record.dataLength,
    date: record.date,
    flags: record.flags,
    children,
  };
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
