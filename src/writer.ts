import {
  normalizeACharacters,
  normalizeDCharacters,
  sectorOffset,
  sectorsForBytes,
  writeAsciiPadded,
  writeUint16Both,
  writeUint32BE,
  writeUint32Both,
  writeUint32LE,
} from "./binary.js";
import { encodeDirectoryRecord, FILE_FLAG_DIRECTORY } from "./directory-record.js";
import { normalizeFilePath } from "./identifiers.js";
import { encodePathTable, type PathTableRecord } from "./path-table.js";
import { type BootRecordOptions, CreateIsoOptions, IsoInputFile, SECTOR_SIZE, STANDARD_IDENTIFIER, SYSTEM_AREA_SECTORS, type VolumePartitionOptions } from "./types.js";
import { encodeVolumeDate } from "./binary.js";

type FileNode = {
  kind: "file";
  name: string;
  isoIdentifier: string;
  data: Uint8Array;
  date: Date;
  extent: number;
};

type DirectoryNode = {
  kind: "directory";
  name: string;
  isoIdentifier: string;
  parent?: DirectoryNode;
  children: Map<string, DirectoryNode | FileNode>;
  date: Date;
  extent: number;
  dataLength: number;
  pathTableIndex: number;
};

type PreparedVolumePartition = {
  options: VolumePartitionOptions;
  data?: Uint8Array | undefined;
  location: number;
  size: number;
};

export function createIsoImage(filesOrOptions: IsoInputFile[] | ({ files: IsoInputFile[] } & CreateIsoOptions), maybeOptions: CreateIsoOptions = {}): Uint8Array {
  const files = Array.isArray(filesOrOptions) ? filesOrOptions : filesOrOptions.files;
  const options = Array.isArray(filesOrOptions) ? maybeOptions : filesOrOptions;
  const now = options.createdAt ?? new Date();
  const root = buildTree(files, now);
  const directories = collectDirectories(root);
  const pathRecords: PathTableRecord[] = directories.map((directory) => ({
    identifier: directory === root ? Uint8Array.of(0) : asciiBytes(directory.isoIdentifier),
    extent: 0,
    parentDirectoryNumber: directory.parent ? directory.parent.pathTableIndex : 1,
  }));

  const pathTableBytesL = encodePathTable(pathRecords, "little");
  const pathTableBytesM = encodePathTable(pathRecords, "big");
  const pathTableSectors = sectorsForBytes(pathTableBytesL.length);
  const volumePartitions = normalizeVolumePartitions(options);
  const descriptorSectorCount = 2 + (options.bootRecord ? 1 : 0) + volumePartitions.length;

  let nextSector = SYSTEM_AREA_SECTORS + descriptorSectorCount;
  const typeLPathTableSector = nextSector;
  nextSector += pathTableSectors;
  const typeMPathTableSector = nextSector;
  nextSector += pathTableSectors;

  for (const directory of directories) {
    directory.extent = nextSector;
    const dataLength = directoryDataLength(directory);
    directory.dataLength = Math.max(SECTOR_SIZE, dataLength === 0 ? SECTOR_SIZE : Math.ceil(dataLength / SECTOR_SIZE) * SECTOR_SIZE);
    nextSector += directory.dataLength / SECTOR_SIZE;
  }

  for (const [index, directory] of directories.entries()) {
    pathRecords[index]!.extent = directory.extent;
  }

  const fileNodes = collectFiles(root);
  for (const file of fileNodes) {
    file.extent = nextSector;
    nextSector += Math.max(1, sectorsForBytes(file.data.byteLength));
  }
  const preparedPartitions: PreparedVolumePartition[] = [];
  for (const partition of volumePartitions) {
    const prepared = prepareVolumePartition(partition, nextSector);
    preparedPartitions.push(prepared);
    nextSector += prepared.size;
  }

  const image = new Uint8Array(nextSector * SECTOR_SIZE);
  image.set(padToSector(encodePathTable(pathRecords, "little")), sectorOffset(typeLPathTableSector));
  image.set(padToSector(encodePathTable(pathRecords, "big")), sectorOffset(typeMPathTableSector));

  for (const directory of directories) {
    image.set(encodeDirectoryExtent(directory), sectorOffset(directory.extent));
  }

  for (const file of fileNodes) {
    image.set(file.data, sectorOffset(file.extent));
  }
  for (const partition of preparedPartitions) {
    if (partition.data) {
      image.set(partition.data, sectorOffset(partition.location));
    }
  }

  let descriptorSector = SYSTEM_AREA_SECTORS;
  image.set(encodePrimaryVolumeDescriptor({
    options,
    now,
    volumeSpaceSize: nextSector,
    pathTableSize: pathTableBytesL.length,
    typeLPathTableSector,
    typeMPathTableSector,
    root,
  }), sectorOffset(descriptorSector++));
  if (options.bootRecord) {
    image.set(encodeBootVolumeDescriptor(options.bootRecord), sectorOffset(descriptorSector++));
  }
  for (const partition of preparedPartitions) {
    image.set(encodeVolumePartitionDescriptor(partition.options, partition.location, partition.size), sectorOffset(descriptorSector++));
  }
  image.set(encodeTerminator(), sectorOffset(descriptorSector));

  return image;
}

function buildTree(files: IsoInputFile[], now: Date): DirectoryNode {
  const root: DirectoryNode = {
    kind: "directory",
    name: "",
    isoIdentifier: "",
    children: new Map(),
    date: now,
    extent: 0,
    dataLength: 0,
    pathTableIndex: 1,
  };

  for (const file of files) {
    const normalized = normalizeFilePath(file.path);
    let directory = root;
    for (const part of normalized.parts.slice(0, -1)) {
      const existing = directory.children.get(part);
      if (existing && existing.kind !== "directory") {
        throw new Error(`path segment conflicts with a file: ${part}`);
      }
      if (existing) {
        directory = existing;
        continue;
      }
      const child: DirectoryNode = {
        kind: "directory",
        name: part,
        isoIdentifier: part,
        parent: directory,
        children: new Map(),
        date: file.date ?? now,
        extent: 0,
        dataLength: 0,
        pathTableIndex: 0,
      };
      directory.children.set(part, child);
      directory = child;
    }
    if (directory.children.has(normalized.isoIdentifier)) {
      throw new Error(`duplicate ISO identifier: ${file.path}`);
    }
    directory.children.set(normalized.isoIdentifier, {
      kind: "file",
      name: normalized.fileName,
      isoIdentifier: normalized.isoIdentifier,
      data: toBytes(file.data),
      date: file.date ?? now,
      extent: 0,
    });
  }

  return root;
}

function collectDirectories(root: DirectoryNode): DirectoryNode[] {
  const directories: DirectoryNode[] = [];
  const visit = (directory: DirectoryNode): void => {
    directory.pathTableIndex = directories.length + 1;
    directories.push(directory);
    for (const child of [...directory.children.values()].filter((node): node is DirectoryNode => node.kind === "directory").sort(compareNode)) {
      visit(child);
    }
  };
  visit(root);
  return directories;
}

function collectFiles(root: DirectoryNode): FileNode[] {
  const files: FileNode[] = [];
  const visit = (directory: DirectoryNode): void => {
    for (const child of [...directory.children.values()].sort(compareNode)) {
      if (child.kind === "file") {
        files.push(child);
      } else {
        visit(child);
      }
    }
  };
  visit(root);
  return files;
}

function directoryDataLength(directory: DirectoryNode): number {
  let offset = 0;
  offset = nextRecordOffset(offset, 34);
  offset = nextRecordOffset(offset, 34);
  for (const child of [...directory.children.values()].sort(compareNode)) {
    const recordLength = 33 + child.isoIdentifier.length + ((33 + child.isoIdentifier.length) % 2 === 0 ? 0 : 1);
    offset = nextRecordOffset(offset, recordLength);
  }
  return offset;
}

function encodeDirectoryExtent(directory: DirectoryNode): Uint8Array {
  const bytes = new Uint8Array(directory.dataLength);
  let offset = 0;
  offset = appendRecord(bytes, offset, directoryRecordForDirectory(directory, Uint8Array.of(0)));
  offset = appendRecord(bytes, offset, directoryRecordForDirectory(directory.parent ?? directory, Uint8Array.of(1)));
  for (const child of [...directory.children.values()].sort(compareNode)) {
    const identifier = asciiBytes(child.isoIdentifier);
    const record = child.kind === "directory"
      ? directoryRecordForDirectory(child, identifier)
      : encodeDirectoryRecord({
        extent: child.extent,
        dataLength: child.data.byteLength,
        flags: 0,
        identifier,
        date: child.date,
      });
    offset = appendRecord(bytes, offset, record);
  }
  return bytes;
}

function directoryRecordForDirectory(directory: DirectoryNode, identifier: Uint8Array): Uint8Array {
  return encodeDirectoryRecord({
    extent: directory.extent,
    dataLength: directory.dataLength,
    flags: FILE_FLAG_DIRECTORY,
    identifier,
    date: directory.date,
  });
}

function appendRecord(bytes: Uint8Array, offset: number, record: Uint8Array): number {
  const sectorRemaining = SECTOR_SIZE - (offset % SECTOR_SIZE);
  if (record.byteLength > sectorRemaining) {
    offset += sectorRemaining;
  }
  bytes.set(record, offset);
  return offset + record.byteLength;
}

function nextRecordOffset(offset: number, recordLength: number): number {
  const sectorRemaining = SECTOR_SIZE - (offset % SECTOR_SIZE);
  if (recordLength > sectorRemaining) {
    offset += sectorRemaining;
  }
  return offset + recordLength;
}

function encodePrimaryVolumeDescriptor(input: {
  options: CreateIsoOptions;
  now: Date;
  volumeSpaceSize: number;
  pathTableSize: number;
  typeLPathTableSector: number;
  typeMPathTableSector: number;
  root: DirectoryNode;
}): Uint8Array {
  const bytes = new Uint8Array(SECTOR_SIZE);
  bytes[0] = 1;
  writeAsciiPadded(bytes, 1, 5, STANDARD_IDENTIFIER, 0x00);
  bytes[6] = 1;
  writeAField(bytes, 8, 32, input.options.systemIdentifier ?? "");
  writeDField(bytes, 40, 32, input.options.volumeIdentifier ?? "ECMA_119");
  writeUint32Both(bytes, 80, input.volumeSpaceSize);
  writeUint16Both(bytes, 120, 1);
  writeUint16Both(bytes, 124, 1);
  writeUint16Both(bytes, 128, SECTOR_SIZE);
  writeUint32Both(bytes, 132, input.pathTableSize);
  writeUint32LE(bytes, 140, input.typeLPathTableSector);
  writeUint32LE(bytes, 144, 0);
  writeUint32BE(bytes, 148, input.typeMPathTableSector);
  writeUint32BE(bytes, 152, 0);
  bytes.set(directoryRecordForDirectory(input.root, Uint8Array.of(0)), 156);
  writeDField(bytes, 190, 128, input.options.volumeSetIdentifier ?? "");
  writeAField(bytes, 318, 128, input.options.publisherIdentifier ?? "");
  writeAField(bytes, 446, 128, input.options.dataPreparerIdentifier ?? "");
  writeAField(bytes, 574, 128, input.options.applicationIdentifier ?? "ECMA-119");
  bytes.set(encodeVolumeDate(input.options.createdAt ?? input.now), 813);
  bytes.set(encodeVolumeDate(input.options.modifiedAt ?? input.options.createdAt ?? input.now), 830);
  bytes.set(encodeVolumeDate(input.options.expiresAt), 847);
  bytes.set(encodeVolumeDate(input.options.effectiveAt ?? input.options.createdAt ?? input.now), 864);
  bytes[881] = 1;
  return bytes;
}

function encodeTerminator(): Uint8Array {
  const bytes = new Uint8Array(SECTOR_SIZE);
  bytes[0] = 255;
  writeAsciiPadded(bytes, 1, 5, STANDARD_IDENTIFIER, 0x00);
  bytes[6] = 1;
  return bytes;
}

function encodeBootVolumeDescriptor(options: BootRecordOptions): Uint8Array {
  const bytes = new Uint8Array(SECTOR_SIZE);
  bytes[0] = 0;
  writeAsciiPadded(bytes, 1, 5, STANDARD_IDENTIFIER, 0x00);
  bytes[6] = 1;
  writeAField(bytes, 7, 32, options.bootSystemIdentifier ?? "");
  writeAField(bytes, 39, 32, options.bootIdentifier ?? "");
  if (options.bootSystemUse) {
    const bootSystemUse = toBytes(options.bootSystemUse);
    if (bootSystemUse.byteLength > SECTOR_SIZE - 71) {
      throw new Error(`boot system use field exceeds ${SECTOR_SIZE - 71} bytes`);
    }
    bytes.set(bootSystemUse, 71);
  }
  return bytes;
}

function encodeVolumePartitionDescriptor(options: VolumePartitionOptions, location: number, size: number): Uint8Array {
  const bytes = new Uint8Array(SECTOR_SIZE);
  bytes[0] = 3;
  writeAsciiPadded(bytes, 1, 5, STANDARD_IDENTIFIER, 0x00);
  bytes[6] = 1;
  bytes[7] = 0;
  writeAField(bytes, 8, 32, options.systemIdentifier ?? "");
  writeDField(bytes, 40, 32, options.volumePartitionIdentifier ?? "");
  writeUint32Both(bytes, 72, location);
  writeUint32Both(bytes, 80, size);
  if (options.systemUse) {
    const systemUse = toBytes(options.systemUse);
    if (systemUse.byteLength > 1960) {
      throw new Error("volume partition system use field exceeds 1960 bytes");
    }
    bytes.set(systemUse, 88);
  }
  return bytes;
}

function normalizeVolumePartitions(options: CreateIsoOptions): VolumePartitionOptions[] {
  const partitions = [...(options.volumePartitions ?? [])];
  if (options.volumePartition) {
    partitions.unshift(options.volumePartition);
  }
  return partitions;
}

function prepareVolumePartition(options: VolumePartitionOptions, location: number): PreparedVolumePartition {
  assertVolumePartitionOptions(options);
  const data = options.data === undefined ? undefined : toBytes(options.data);
  const dataSectors = data === undefined ? 0 : sectorsForBytes(data.byteLength);
  const size = options.size ?? dataSectors;
  if (!Number.isInteger(size) || size < 1 || size > 0xffffffff) {
    throw new RangeError("volume partition size must be an integer from 1 to 4294967295 logical blocks");
  }
  if (data === undefined && options.size === undefined) {
    throw new Error("volume partition requires data or an explicit size");
  }
  if (data !== undefined && data.byteLength === 0 && options.size === undefined) {
    throw new Error("empty volume partition data requires an explicit size");
  }
  if (data !== undefined && data.byteLength > size * SECTOR_SIZE) {
    throw new Error("volume partition data exceeds declared size");
  }
  if (location + size > 0xffffffff) {
    throw new RangeError("volume partition location and size exceed uint32 range");
  }
  return { options, data, location, size };
}

function assertVolumePartitionOptions(options: VolumePartitionOptions): void {
  writeAField(new Uint8Array(32), 0, 32, options.systemIdentifier ?? "");
  writeDField(new Uint8Array(32), 0, 32, options.volumePartitionIdentifier ?? "");
  if (options.systemUse && toBytes(options.systemUse).byteLength > 1960) {
    throw new Error("volume partition system use field exceeds 1960 bytes");
  }
}

function writeDField(bytes: Uint8Array, offset: number, length: number, value: string): void {
  writeAsciiPadded(bytes, offset, length, normalizeDCharacters(value, "d-character field"));
}

function writeAField(bytes: Uint8Array, offset: number, length: number, value: string): void {
  writeAsciiPadded(bytes, offset, length, normalizeACharacters(value, "a-character field"));
}

function compareNode(left: DirectoryNode | FileNode, right: DirectoryNode | FileNode): number {
  return left.isoIdentifier.localeCompare(right.isoIdentifier, "en", { numeric: false });
}

function toBytes(data: Uint8Array | Buffer | string): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function padToSector(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.max(SECTOR_SIZE, Math.ceil(bytes.byteLength / SECTOR_SIZE) * SECTOR_SIZE));
  padded.set(bytes);
  return padded;
}
