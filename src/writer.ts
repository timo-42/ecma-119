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
import { directoryRecordLength, encodeDirectoryRecord, FILE_FLAG_ASSOCIATED, FILE_FLAG_DIRECTORY, FILE_FLAG_HIDDEN } from "./directory-record.js";
import { decodeExtendedAttributeRecord, encodeExtendedAttributeRecord, extendedAttributeRecordFileFlags } from "./extended-attribute-record.js";
import { normalizeDirectoryPath, normalizeFilePath } from "./identifiers.js";
import { encodePathTable, type PathTableRecord } from "./path-table.js";
import { type BootRecordOptions, CreateIsoOptions, type EnhancedVolumeDescriptorOptions, type ExtendedAttributeRecordInput, type IsoInputDirectory, IsoInputFile, SECTOR_SIZE, STANDARD_IDENTIFIER, SYSTEM_AREA_SECTORS, type SupplementaryVolumeDescriptorOptions, type VolumePartitionOptions } from "./types.js";
import { encodeVolumeDate } from "./binary.js";

type FileNode = {
  kind: "file";
  name: string;
  isoIdentifier: string;
  data: Uint8Array;
  extendedAttributeRecord?: Uint8Array;
  extendedAttributeRecordLength: number;
  date: Date;
  timeZoneOffsetMinutes: number;
  extent: number;
  flags: number;
  systemUse?: Uint8Array;
};

type DirectoryNode = {
  kind: "directory";
  name: string;
  isoIdentifier: string;
  parent?: DirectoryNode;
  children: Map<string, DirectoryNode | FileNode>;
  date: Date;
  timeZoneOffsetMinutes: number;
  extent: number;
  dataLength: number;
  extendedAttributeRecord?: Uint8Array;
  extendedAttributeRecordLength: number;
  flags: number;
  pathTableIndex: number;
  systemUse?: Uint8Array;
};

type PreparedVolumePartition = {
  options: VolumePartitionOptions;
  data?: Uint8Array | undefined;
  location: number;
  size: number;
};

type PreparedSecondaryDescriptor = {
  kind: "supplementary" | "enhanced";
  options: SupplementaryVolumeDescriptorOptions | EnhancedVolumeDescriptorOptions;
  pathRecords: PathTableRecord[];
  pathTableBytesL: Uint8Array;
  pathTableBytesM: Uint8Array;
  pathTableSectors: number;
  typeLPathTableSector: number;
  typeMPathTableSector: number;
  directoryExtents: Map<DirectoryNode, number>;
  directoryDataLengths: Map<DirectoryNode, number>;
};

export function createIsoImage(filesOrOptions: IsoInputFile[] | ({ files: IsoInputFile[] } & CreateIsoOptions), maybeOptions: CreateIsoOptions = {}): Uint8Array {
  const files = Array.isArray(filesOrOptions) ? filesOrOptions : filesOrOptions.files;
  const options = Array.isArray(filesOrOptions) ? maybeOptions : filesOrOptions;
  const now = options.createdAt ?? new Date();
  const timeZoneOffsetMinutes = options.timeZoneOffsetMinutes ?? 0;
  const root = buildTree(files, options.directories ?? [], now, timeZoneOffsetMinutes);
  const directories = collectDirectories(root);
  const pathRecords: PathTableRecord[] = directories.map((directory) => ({
    identifier: directory === root ? Uint8Array.of(0) : asciiBytes(directory.isoIdentifier),
    extent: 0,
    extendedAttributeRecordLength: directory.extendedAttributeRecordLength,
    parentDirectoryNumber: directory.parent ? directory.parent.pathTableIndex : 1,
  }));

  const pathTableBytesL = encodePathTable(pathRecords, "little");
  const pathTableBytesM = encodePathTable(pathRecords, "big");
  const pathTableSectors = sectorsForBytes(pathTableBytesL.length);
  const volumePartitions = normalizeVolumePartitions(options);
  const secondaryDescriptors = normalizeSecondaryDescriptors(options, directories);
  const descriptorSectorCount = 2 + (options.bootRecord ? 1 : 0) + secondaryDescriptors.length + volumePartitions.length;

  let nextSector = SYSTEM_AREA_SECTORS + descriptorSectorCount;
  const typeLPathTableSector = nextSector;
  nextSector += pathTableSectors;
  const typeMPathTableSector = nextSector;
  nextSector += pathTableSectors;
  for (const descriptor of secondaryDescriptors) {
    descriptor.typeLPathTableSector = nextSector;
    nextSector += descriptor.pathTableSectors;
    descriptor.typeMPathTableSector = nextSector;
    nextSector += descriptor.pathTableSectors;
  }

  for (const directory of directories) {
    directory.extent = nextSector;
    nextSector += directory.extendedAttributeRecordLength;
    const dataLength = directoryDataLength(directory);
    directory.dataLength = Math.max(SECTOR_SIZE, dataLength === 0 ? SECTOR_SIZE : Math.ceil(dataLength / SECTOR_SIZE) * SECTOR_SIZE);
    nextSector += directory.dataLength / SECTOR_SIZE;
  }
  for (const descriptor of secondaryDescriptors) {
    for (const directory of directories) {
      descriptor.directoryExtents.set(directory, nextSector);
      nextSector += directory.extendedAttributeRecordLength;
      const dataLength = directoryDataLength(directory);
      const paddedLength = Math.max(SECTOR_SIZE, dataLength === 0 ? SECTOR_SIZE : Math.ceil(dataLength / SECTOR_SIZE) * SECTOR_SIZE);
      descriptor.directoryDataLengths.set(directory, paddedLength);
      nextSector += paddedLength / SECTOR_SIZE;
    }
  }

  for (const [index, directory] of directories.entries()) {
    pathRecords[index]!.extent = directory.extent;
  }
  for (const descriptor of secondaryDescriptors) {
    for (const [index, directory] of directories.entries()) {
      descriptor.pathRecords[index]!.extent = descriptor.directoryExtents.get(directory)!;
    }
    descriptor.pathTableBytesL = encodePathTable(descriptor.pathRecords, "little");
    descriptor.pathTableBytesM = encodePathTable(descriptor.pathRecords, "big");
  }

  const fileNodes = collectFiles(root);
  for (const file of fileNodes) {
    file.extent = nextSector;
    nextSector += file.extendedAttributeRecordLength;
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
  for (const descriptor of secondaryDescriptors) {
    image.set(padToSector(descriptor.pathTableBytesL), sectorOffset(descriptor.typeLPathTableSector));
    image.set(padToSector(descriptor.pathTableBytesM), sectorOffset(descriptor.typeMPathTableSector));
  }

  for (const directory of directories) {
    if (directory.extendedAttributeRecord) {
      image.set(directory.extendedAttributeRecord, sectorOffset(directory.extent));
    }
    image.set(encodeDirectoryExtent(directory), sectorOffset(directory.extent + directory.extendedAttributeRecordLength));
  }
  for (const descriptor of secondaryDescriptors) {
    for (const directory of directories) {
      const extent = descriptor.directoryExtents.get(directory)!;
      if (directory.extendedAttributeRecord) {
        image.set(directory.extendedAttributeRecord, sectorOffset(extent));
      }
      image.set(encodeDirectoryExtent(directory, descriptor), sectorOffset(extent + directory.extendedAttributeRecordLength));
    }
  }

  for (const file of fileNodes) {
    if (file.extendedAttributeRecord) {
      image.set(file.extendedAttributeRecord, sectorOffset(file.extent));
    }
    image.set(file.data, sectorOffset(file.extent + file.extendedAttributeRecordLength));
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
  for (const descriptor of secondaryDescriptors) {
    image.set(encodeSupplementaryLikeVolumeDescriptor({
      options: descriptor.options,
      baseOptions: options,
      now,
      volumeSpaceSize: nextSector,
      pathTableSize: descriptor.pathTableBytesL.length,
      typeLPathTableSector: descriptor.typeLPathTableSector,
      typeMPathTableSector: descriptor.typeMPathTableSector,
      root,
      layout: descriptor,
    }), sectorOffset(descriptorSector++));
  }
  for (const partition of preparedPartitions) {
    image.set(encodeVolumePartitionDescriptor(partition.options, partition.location, partition.size), sectorOffset(descriptorSector++));
  }
  image.set(encodeTerminator(), sectorOffset(descriptorSector));

  return image;
}

function buildTree(files: IsoInputFile[], directories: IsoInputDirectory[], now: Date, defaultTimeZoneOffsetMinutes: number): DirectoryNode {
  const root: DirectoryNode = {
    kind: "directory",
    name: "",
    isoIdentifier: "",
    children: new Map(),
    date: now,
    timeZoneOffsetMinutes: defaultTimeZoneOffsetMinutes,
    extent: 0,
    dataLength: 0,
    extendedAttributeRecordLength: 0,
    flags: FILE_FLAG_DIRECTORY,
    pathTableIndex: 1,
  };

  for (const file of files) {
    const normalized = normalizeFilePath(file.path);
    const fileTimeZoneOffsetMinutes = file.timeZoneOffsetMinutes ?? defaultTimeZoneOffsetMinutes;
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
        timeZoneOffsetMinutes: fileTimeZoneOffsetMinutes,
        extent: 0,
        dataLength: 0,
        extendedAttributeRecordLength: 0,
        flags: FILE_FLAG_DIRECTORY,
        pathTableIndex: 0,
      };
      directory.children.set(part, child);
      directory = child;
    }
    if (directory.children.has(normalized.isoIdentifier)) {
      throw new Error(`duplicate ISO identifier: ${file.path}`);
    }
    const fileNode: FileNode = {
      kind: "file",
      name: normalized.fileName,
      isoIdentifier: normalized.isoIdentifier,
      data: toBytes(file.data),
      extendedAttributeRecordLength: 0,
      date: file.date ?? now,
      timeZoneOffsetMinutes: fileTimeZoneOffsetMinutes,
      extent: 0,
      flags: inputFileFlags(file),
    };
    if (file.extendedAttributeRecord !== undefined) {
      fileNode.extendedAttributeRecord = isExtendedAttributeRecordInput(file.extendedAttributeRecord)
        ? encodeExtendedAttributeRecord(file.extendedAttributeRecord, {
          defaultDate: file.date ?? now,
          defaultTimeZoneOffsetMinutes: fileTimeZoneOffsetMinutes,
        })
        : toBytes(file.extendedAttributeRecord);
      if (fileNode.extendedAttributeRecord.byteLength === 0) {
        throw new Error("extended attribute record must contain at least one byte");
      }
      fileNode.extendedAttributeRecordLength = sectorsForBytes(fileNode.extendedAttributeRecord.byteLength);
      if (fileNode.extendedAttributeRecordLength > 0xff) {
        throw new Error("extended attribute record exceeds 255 logical blocks");
      }
      const fields = decodeOptionalExtendedAttributeRecord(fileNode.extendedAttributeRecord);
      if (fields) {
        fileNode.flags |= extendedAttributeRecordFileFlags(fields);
      }
    }
    if (file.systemUse !== undefined) {
      fileNode.systemUse = toBytes(file.systemUse);
    }
    directory.children.set(normalized.isoIdentifier, fileNode);
  }

  for (const input of directories) {
    const directoryTimeZoneOffsetMinutes = input.timeZoneOffsetMinutes ?? defaultTimeZoneOffsetMinutes;
    const directory = ensureDirectory(root, normalizeDirectoryPath(input.path).parts, input.date ?? now, directoryTimeZoneOffsetMinutes);
    directory.date = input.date ?? directory.date;
    directory.timeZoneOffsetMinutes = directoryTimeZoneOffsetMinutes;
    directory.flags = inputDirectoryFlags(directory.flags, input);
    if (input.extendedAttributeRecord !== undefined) {
      directory.extendedAttributeRecord = isExtendedAttributeRecordInput(input.extendedAttributeRecord)
        ? encodeExtendedAttributeRecord(input.extendedAttributeRecord, {
          defaultDate: input.date ?? now,
          defaultTimeZoneOffsetMinutes: directoryTimeZoneOffsetMinutes,
        })
        : toBytes(input.extendedAttributeRecord);
      if (directory.extendedAttributeRecord.byteLength === 0) {
        throw new Error("directory extended attribute record must contain at least one byte");
      }
      directory.extendedAttributeRecordLength = sectorsForBytes(directory.extendedAttributeRecord.byteLength);
      if (directory.extendedAttributeRecordLength > 0xff) {
        throw new Error("directory extended attribute record exceeds 255 logical blocks");
      }
      const fields = decodeOptionalExtendedAttributeRecord(directory.extendedAttributeRecord);
      if (fields) {
        directory.flags |= extendedAttributeRecordFileFlags(fields) & 0x10;
      }
    }
    if (input.systemUse !== undefined) {
      directory.systemUse = toBytes(input.systemUse);
    }
  }

  return root;
}

function ensureDirectory(root: DirectoryNode, parts: string[], date: Date, timeZoneOffsetMinutes: number): DirectoryNode {
  let directory = root;
  for (const part of parts) {
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
      date,
      timeZoneOffsetMinutes,
      extent: 0,
      dataLength: 0,
      extendedAttributeRecordLength: 0,
      flags: FILE_FLAG_DIRECTORY,
      pathTableIndex: 0,
    };
    directory.children.set(part, child);
    directory = child;
  }
  return directory;
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
  offset = nextRecordOffset(offset, directoryRecordLengthForDirectory(directory, Uint8Array.of(0)));
  offset = nextRecordOffset(offset, directoryRecordLengthForDirectory(directory.parent ?? directory, Uint8Array.of(1)));
  for (const child of [...directory.children.values()].sort(compareNode)) {
    const recordLength = directoryRecordLengthForNode(child, asciiBytes(child.isoIdentifier));
    offset = nextRecordOffset(offset, recordLength);
  }
  return offset;
}

function encodeDirectoryExtent(directory: DirectoryNode, layout?: PreparedSecondaryDescriptor): Uint8Array {
  const bytes = new Uint8Array(directoryDataLengthFor(directory, layout));
  let offset = 0;
  offset = appendRecord(bytes, offset, directoryRecordForDirectory(directory, Uint8Array.of(0), layout));
  offset = appendRecord(bytes, offset, directoryRecordForDirectory(directory.parent ?? directory, Uint8Array.of(1), layout));
  for (const child of [...directory.children.values()].sort(compareNode)) {
    const identifier = asciiBytes(child.isoIdentifier);
    let record: Uint8Array;
    if (child.kind === "directory") {
      record = directoryRecordForDirectory(child, identifier, layout);
    } else {
      const input = {
        extent: child.extent,
        extendedAttributeRecordLength: child.extendedAttributeRecordLength,
        dataLength: child.data.byteLength,
        flags: child.flags,
        identifier,
        date: child.date,
        timeZoneOffsetMinutes: child.timeZoneOffsetMinutes,
      };
      record = child.systemUse ? encodeDirectoryRecord({ ...input, systemUse: child.systemUse }) : encodeDirectoryRecord(input);
    }
    offset = appendRecord(bytes, offset, record);
  }
  return bytes;
}

function directoryRecordForDirectory(directory: DirectoryNode, identifier: Uint8Array, layout?: PreparedSecondaryDescriptor): Uint8Array {
  const input = {
    extent: directoryExtentFor(directory, layout),
    extendedAttributeRecordLength: directory.extendedAttributeRecordLength,
    dataLength: directoryDataLengthFor(directory, layout),
    flags: directory.flags,
    identifier,
    date: directory.date,
    timeZoneOffsetMinutes: directory.timeZoneOffsetMinutes,
  };
  return directory.systemUse ? encodeDirectoryRecord({ ...input, systemUse: directory.systemUse }) : encodeDirectoryRecord(input);
}

function directoryRecordForDescriptorRoot(directory: DirectoryNode, layout?: PreparedSecondaryDescriptor): Uint8Array {
  return encodeDirectoryRecord({
    extent: directoryExtentFor(directory, layout),
    extendedAttributeRecordLength: directory.extendedAttributeRecordLength,
    dataLength: directoryDataLengthFor(directory, layout),
    flags: directory.flags,
    identifier: Uint8Array.of(0),
    date: directory.date,
    timeZoneOffsetMinutes: directory.timeZoneOffsetMinutes,
  });
}

function directoryRecordLengthForNode(node: DirectoryNode | FileNode, identifier: Uint8Array): number {
  return directoryRecordLength(identifier.byteLength, node.systemUse?.byteLength ?? 0);
}

function directoryRecordLengthForDirectory(directory: DirectoryNode, identifier: Uint8Array): number {
  return directoryRecordLength(identifier.byteLength, directory.systemUse?.byteLength ?? 0);
}

function directoryExtentFor(directory: DirectoryNode, layout?: PreparedSecondaryDescriptor): number {
  return layout ? layout.directoryExtents.get(directory)! : directory.extent;
}

function directoryDataLengthFor(directory: DirectoryNode, layout?: PreparedSecondaryDescriptor): number {
  return layout ? layout.directoryDataLengths.get(directory)! : directory.dataLength;
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
  bytes.set(directoryRecordForDescriptorRoot(input.root), 156);
  writeDField(bytes, 190, 128, input.options.volumeSetIdentifier ?? "");
  writeAField(bytes, 318, 128, input.options.publisherIdentifier ?? "");
  writeAField(bytes, 446, 128, input.options.dataPreparerIdentifier ?? "");
  writeAField(bytes, 574, 128, input.options.applicationIdentifier ?? "ECMA-119");
  writeFileIdentifierField(bytes, 702, input.options.copyrightFileIdentifier ?? "");
  writeFileIdentifierField(bytes, 739, input.options.abstractFileIdentifier ?? "");
  writeFileIdentifierField(bytes, 776, input.options.bibliographicFileIdentifier ?? "");
  const timeZoneOffsetMinutes = input.options.timeZoneOffsetMinutes ?? 0;
  bytes.set(encodeVolumeDate(input.options.createdAt ?? input.now, timeZoneOffsetMinutes), 813);
  bytes.set(encodeVolumeDate(input.options.modifiedAt ?? input.options.createdAt ?? input.now, timeZoneOffsetMinutes), 830);
  bytes.set(encodeVolumeDate(input.options.expiresAt, timeZoneOffsetMinutes), 847);
  bytes.set(encodeVolumeDate(input.options.effectiveAt ?? input.options.createdAt ?? input.now, timeZoneOffsetMinutes), 864);
  bytes[881] = 1;
  writeApplicationUse(bytes, input.options.volumeDescriptorApplicationUse);
  return bytes;
}

function encodeSupplementaryLikeVolumeDescriptor(input: {
  options: SupplementaryVolumeDescriptorOptions;
  baseOptions: CreateIsoOptions;
  now: Date;
  volumeSpaceSize: number;
  pathTableSize: number;
  typeLPathTableSector: number;
  typeMPathTableSector: number;
  root: DirectoryNode;
  layout: PreparedSecondaryDescriptor;
}): Uint8Array {
  const bytes = new Uint8Array(SECTOR_SIZE);
  bytes[0] = 2;
  writeAsciiPadded(bytes, 1, 5, STANDARD_IDENTIFIER, 0x00);
  bytes[6] = input.layout.kind === "enhanced" ? 2 : 1;
  bytes[7] = checkedVolumeFlags(input.options.volumeFlags ?? 0);
  writeAField(bytes, 8, 32, input.options.systemIdentifier ?? input.baseOptions.systemIdentifier ?? "");
  writeDField(bytes, 40, 32, input.options.volumeIdentifier ?? input.baseOptions.volumeIdentifier ?? "ECMA_119");
  writeUint32Both(bytes, 80, input.volumeSpaceSize);
  const escapeSequences = input.options.escapeSequences === undefined ? new Uint8Array() : toBytes(input.options.escapeSequences);
  if (escapeSequences.byteLength > 32) {
    throw new Error("escape sequences field exceeds 32 bytes");
  }
  bytes.set(escapeSequences, 88);
  writeUint16Both(bytes, 120, 1);
  writeUint16Both(bytes, 124, 1);
  writeUint16Both(bytes, 128, SECTOR_SIZE);
  writeUint32Both(bytes, 132, input.pathTableSize);
  writeUint32LE(bytes, 140, input.typeLPathTableSector);
  writeUint32LE(bytes, 144, 0);
  writeUint32BE(bytes, 148, input.typeMPathTableSector);
  writeUint32BE(bytes, 152, 0);
  bytes.set(directoryRecordForDescriptorRoot(input.root, input.layout), 156);
  writeDField(bytes, 190, 128, input.options.volumeSetIdentifier ?? input.baseOptions.volumeSetIdentifier ?? "");
  writeAField(bytes, 318, 128, input.options.publisherIdentifier ?? input.baseOptions.publisherIdentifier ?? "");
  writeAField(bytes, 446, 128, input.options.dataPreparerIdentifier ?? input.baseOptions.dataPreparerIdentifier ?? "");
  writeAField(bytes, 574, 128, input.options.applicationIdentifier ?? input.baseOptions.applicationIdentifier ?? "ECMA-119");
  writeFileIdentifierField(bytes, 702, input.options.copyrightFileIdentifier ?? input.baseOptions.copyrightFileIdentifier ?? "");
  writeFileIdentifierField(bytes, 739, input.options.abstractFileIdentifier ?? input.baseOptions.abstractFileIdentifier ?? "");
  writeFileIdentifierField(bytes, 776, input.options.bibliographicFileIdentifier ?? input.baseOptions.bibliographicFileIdentifier ?? "");
  const timeZoneOffsetMinutes = input.baseOptions.timeZoneOffsetMinutes ?? 0;
  bytes.set(encodeVolumeDate(input.baseOptions.createdAt ?? input.now, timeZoneOffsetMinutes), 813);
  bytes.set(encodeVolumeDate(input.baseOptions.modifiedAt ?? input.baseOptions.createdAt ?? input.now, timeZoneOffsetMinutes), 830);
  bytes.set(encodeVolumeDate(input.baseOptions.expiresAt, timeZoneOffsetMinutes), 847);
  bytes.set(encodeVolumeDate(input.baseOptions.effectiveAt ?? input.baseOptions.createdAt ?? input.now, timeZoneOffsetMinutes), 864);
  bytes[881] = 1;
  writeApplicationUse(bytes, input.options.volumeDescriptorApplicationUse ?? input.baseOptions.volumeDescriptorApplicationUse);
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

function normalizeSecondaryDescriptors(options: CreateIsoOptions, directories: DirectoryNode[]): PreparedSecondaryDescriptor[] {
  const descriptors: Array<{
    kind: PreparedSecondaryDescriptor["kind"];
    options: SupplementaryVolumeDescriptorOptions | EnhancedVolumeDescriptorOptions;
  }> = [
    ...(options.supplementaryVolumeDescriptors ?? []).map((descriptor) => ({ kind: "supplementary" as const, options: descriptor })),
    ...(options.enhancedVolumeDescriptors ?? []).map((descriptor) => ({ kind: "enhanced" as const, options: descriptor })),
  ];

  return descriptors.map((descriptor) => {
    const pathRecords: PathTableRecord[] = directories.map((directory) => ({
      identifier: directory.parent ? asciiBytes(directory.isoIdentifier) : Uint8Array.of(0),
      extent: 0,
      extendedAttributeRecordLength: directory.extendedAttributeRecordLength,
      parentDirectoryNumber: directory.parent ? directory.parent.pathTableIndex : 1,
    }));
    const pathTableBytesL = encodePathTable(pathRecords, "little");
    const pathTableBytesM = encodePathTable(pathRecords, "big");
    return {
      kind: descriptor.kind,
      options: descriptor.options,
      pathRecords,
      pathTableBytesL,
      pathTableBytesM,
      pathTableSectors: sectorsForBytes(pathTableBytesL.length),
      typeLPathTableSector: 0,
      typeMPathTableSector: 0,
      directoryExtents: new Map(),
      directoryDataLengths: new Map(),
    };
  });
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

function writeFileIdentifierField(bytes: Uint8Array, offset: number, value: string): void {
  const identifier = value === "" ? "" : normalizeFilePath(value).isoIdentifier;
  writeAsciiPadded(bytes, offset, 37, identifier);
}

function writeApplicationUse(bytes: Uint8Array, value: Uint8Array | Buffer | string | undefined): void {
  if (value === undefined) {
    return;
  }
  const applicationUse = toBytes(value);
  if (applicationUse.byteLength > 512) {
    throw new Error("volume descriptor application use field exceeds 512 bytes");
  }
  bytes.set(applicationUse, 883);
}

function checkedByte(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be an integer from 0 to 255`);
  }
  return value;
}

function checkedVolumeFlags(value: number): number {
  const flags = checkedByte(value, "volume flags");
  if ((flags & 0xfe) !== 0) {
    throw new Error("secondary volume descriptor flags bits 1 through 7 must be zero");
  }
  return flags;
}

function inputFileFlags(input: Pick<IsoInputFile, "hidden" | "associated">): number {
  return inputFlags(0, input);
}

function inputDirectoryFlags(current: number, input: Pick<IsoInputDirectory, "hidden" | "associated">): number {
  return inputFlags(current | FILE_FLAG_DIRECTORY, input);
}

function inputFlags(current: number, input: { hidden?: boolean; associated?: boolean }): number {
  let flags = current;
  flags = setFlag(flags, FILE_FLAG_HIDDEN, input.hidden);
  flags = setFlag(flags, FILE_FLAG_ASSOCIATED, input.associated);
  return flags;
}

function setFlag(flags: number, bit: number, value: boolean | undefined): number {
  if (value === undefined) {
    return flags;
  }
  return value ? flags | bit : flags & ~bit;
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

function isExtendedAttributeRecordInput(data: Uint8Array | Buffer | string | ExtendedAttributeRecordInput): data is ExtendedAttributeRecordInput {
  return typeof data === "object" && !(data instanceof Uint8Array);
}

function decodeOptionalExtendedAttributeRecord(bytes: Uint8Array): ReturnType<typeof decodeExtendedAttributeRecord> | undefined {
  try {
    return decodeExtendedAttributeRecord(bytes);
  } catch {
    return undefined;
  }
}

function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function padToSector(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.max(SECTOR_SIZE, Math.ceil(bytes.byteLength / SECTOR_SIZE) * SECTOR_SIZE));
  padded.set(bytes);
  return padded;
}
