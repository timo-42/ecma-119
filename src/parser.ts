import { decodeVolumeDate, readAscii, readAsciiTrimmed, readUint16Both, readUint32Both, sectorOffset } from "./binary.js";
import { decodeDirectoryRecord, FILE_FLAG_DIRECTORY, type DecodedDirectoryRecord } from "./directory-record.js";
import { decodeFileIdentifier, stripVersion } from "./identifiers.js";
import { decodePathTable } from "./path-table.js";
import {
  type IsoDirectoryEntry,
  type IsoFileEntry,
  type IsoImage,
  type IsoNode,
  type PrimaryVolumeDescriptor,
  SECTOR_SIZE,
  STANDARD_IDENTIFIER,
  SYSTEM_AREA_SECTORS,
  type ValidationIssue,
} from "./types.js";

export function parseIsoImage(imageInput: Uint8Array | ArrayBuffer, options: { includeData?: boolean } = {}): IsoImage {
  const image = imageInput instanceof Uint8Array ? imageInput : new Uint8Array(imageInput);
  const pvd = parsePrimaryVolumeDescriptor(image);
  const root = readDirectoryTree(image, pvd.rootDirectoryRecord, "", options.includeData ?? true, new Set());
  return {
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
  try {
    parseIsoImage(image, { includeData: false });
  } catch (error) {
    issues.push({ code: "image.parse", message: error instanceof Error ? error.message : String(error) });
  }
  return issues;
}

function parsePrimaryVolumeDescriptor(image: Uint8Array): PrimaryVolumeDescriptor {
  const offset = sectorOffset(SYSTEM_AREA_SECTORS);
  assertDescriptorHeader(image, offset, 1);
  const rootRecord = decodeDirectoryRecord(image, offset + 156);
  const pvd: PrimaryVolumeDescriptor = {
    type: 1,
    identifier: STANDARD_IDENTIFIER,
    version: image[offset + 6]!,
    offset,
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
  const pathTable = image.subarray(
    pvd.typeLPathTableLocation * SECTOR_SIZE,
    pvd.typeLPathTableLocation * SECTOR_SIZE + pvd.pathTableSize,
  );
  decodePathTable(pathTable, "little");
  assertDescriptorHeader(image, sectorOffset(SYSTEM_AREA_SECTORS + 1), 255);
  return pvd;
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
    const record = decodeDirectoryRecord(bytes, offset);
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

function assertDescriptorHeader(image: Uint8Array, offset: number, type: number): void {
  if (image[offset] !== type) {
    throw new Error(`expected descriptor type ${type} at byte offset ${offset}`);
  }
  if (readAscii(image, offset + 1, 5) !== STANDARD_IDENTIFIER) {
    throw new Error(`expected ${STANDARD_IDENTIFIER} descriptor identifier at byte offset ${offset + 1}`);
  }
  if (image[offset + 6] !== 1) {
    throw new Error(`expected descriptor version 1 at byte offset ${offset + 6}`);
  }
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
