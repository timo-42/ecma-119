import { bytesFromImageInput } from "../byte-input.js";
import { readUint16LE, readUint32LE } from "../binary.js";
import { UDF_DESCRIPTOR_TAG_IDENTIFIER, validateUdfDescriptorTag } from "../udf-tag.js";
import { decodeDstring, decodeLongAd, decodeShortAd, decodeOstaCompressedUnicode, readUint64LE } from "./codec.js";
import {
  UDF_LOGICAL_BLOCK_SIZE,
  type ParseUdfOptions,
  type UdfDescriptor,
  type UdfDirectoryEntry,
  type UdfFileEntry,
  type UdfFileEntryDescriptor,
  type UdfFileSetDescriptor,
  type UdfImage,
  type UdfImageInput,
  type UdfLogicalVolumeDescriptor,
  type UdfNode,
  type UdfPartition,
  type UdfPartitionDescriptor,
  type UdfPrimaryVolumeDescriptor,
  type UdfTerminatingDescriptor,
  type UdfValidationIssue,
  type UdfVolumeSet,
  type UdfVolumeStructure,
} from "./types.js";

const ANCHOR_SECTOR = 256;

type ParsedContext = {
  image: Uint8Array;
  partition: UdfPartition;
  includeData: boolean;
  seen: Set<number>;
};

export function parseUdfImage(imageInput: UdfImageInput, options: ParseUdfOptions = {}): UdfImage {
  const image = bytesFromImageInput(imageInput);
  assertBlockAligned(image);
  const volumeStructures = parseUdfVolumeStructures(image);
  const anchor = readDescriptor(image, ANCHOR_SECTOR, UDF_DESCRIPTOR_TAG_IDENTIFIER.ANCHOR_VOLUME_DESCRIPTOR_POINTER);
  const mainVdsLocation = readUint32LE(anchor, 20);
  const mainVdsLength = readUint32LE(anchor, 16);
  if (mainVdsLength === 0 || mainVdsLength % UDF_LOGICAL_BLOCK_SIZE !== 0) throw new Error("anchor main volume descriptor sequence extent is invalid");
  const descriptors = parseDescriptorSequence(image, mainVdsLocation, mainVdsLength / UDF_LOGICAL_BLOCK_SIZE);
  const primaryVolumeDescriptors = descriptors.filter((descriptor): descriptor is UdfPrimaryVolumeDescriptor => descriptor.kind === "primary-volume");
  const logicalVolumeDescriptors = descriptors.filter((descriptor): descriptor is UdfLogicalVolumeDescriptor => descriptor.kind === "logical-volume");
  const partitionDescriptors = descriptors.filter((descriptor): descriptor is UdfPartitionDescriptor => descriptor.kind === "partition");
  const primaryVolumeDescriptorIndex = options.primaryVolumeDescriptorIndex ?? 0;
  const logicalVolumeDescriptorIndex = options.logicalVolumeDescriptorIndex ?? 0;
  const primaryVolumeDescriptor = select(primaryVolumeDescriptors, primaryVolumeDescriptorIndex, "primaryVolumeDescriptorIndex", "primary volume descriptor");
  const logicalVolumeDescriptor = select(logicalVolumeDescriptors, logicalVolumeDescriptorIndex, "logicalVolumeDescriptorIndex", "logical volume descriptor");
  if (logicalVolumeDescriptor.logicalBlockSize !== UDF_LOGICAL_BLOCK_SIZE) throw new Error(`UDF logical block size ${logicalVolumeDescriptor.logicalBlockSize} is not supported; expected ${UDF_LOGICAL_BLOCK_SIZE}`);
  const partitions = resolvePartitions(logicalVolumeDescriptor, partitionDescriptors);
  const fileSetDescriptor = parseFileSetDescriptor(image, logicalVolumeDescriptor.fileSetDescriptorLocation, partitions, options.fileSetDescriptorIndex ?? 0);
  const selectedPartition = partitions[fileSetDescriptor.rootDirectoryIcb.partitionReferenceNumber];
  if (!selectedPartition) throw new Error(`file set root directory uses unknown partition reference ${fileSetDescriptor.rootDirectoryIcb.partitionReferenceNumber}`);
  const context: ParsedContext = { image, partition: selectedPartition, includeData: options.includeData ?? true, seen: new Set() };
  const root = parseDirectory(context, fileSetDescriptor.rootDirectoryIcb.location, "", "");
  return {
    volumeStructures,
    descriptors,
    primaryVolumeDescriptors,
    primaryVolumeDescriptorIndex,
    primaryVolumeDescriptor,
    logicalVolumeDescriptors,
    logicalVolumeDescriptorIndex,
    logicalVolumeDescriptor,
    fileSetDescriptors: [fileSetDescriptor],
    fileSetDescriptorIndex: 0,
    fileSetDescriptor,
    partitions,
    root,
    files: collectFiles(root),
  };
}

export function parseUdfVolumeStructures(imageInput: UdfImageInput): UdfVolumeStructure[] {
  const image = bytesFromImageInput(imageInput);
  assertBlockAligned(image);
  const structures: UdfVolumeStructure[] = [];
  for (let sector = 16; sector < Math.min(image.byteLength / UDF_LOGICAL_BLOCK_SIZE, 64); sector += 1) {
    const offset = sector * UDF_LOGICAL_BLOCK_SIZE;
    const identifier = ascii(image, offset + 1, 5);
    if (identifier === "") continue;
    if (!["BEA01", "NSR02", "NSR03", "TEA01"].includes(identifier)) continue;
    structures.push({ sector, structureType: image[offset]!, identifier, version: image[offset + 6]!, raw: image.slice(offset, offset + UDF_LOGICAL_BLOCK_SIZE) });
  }
  if (!structures.some((structure) => structure.identifier === "NSR02" || structure.identifier === "NSR03")) throw new Error("missing UDF NSR02 or NSR03 volume recognition structure");
  return structures;
}

export function parseUdfVolumeSet(imageInputs: UdfImageInput[], options: ParseUdfOptions = {}): UdfVolumeSet {
  const images = imageInputs.map((image) => parseUdfImage(image, options));
  return { images, files: images.flatMap((image) => image.files) };
}

export function validateUdfImage(imageInput: UdfImageInput): UdfValidationIssue[] {
  try {
    parseUdfImage(imageInput, { includeData: false });
    return [];
  } catch (error) {
    return [{ code: "udf.parse", message: error instanceof Error ? error.message : String(error) }];
  }
}

function parseDescriptorSequence(image: Uint8Array, start: number, sectors: number): UdfDescriptor[] {
  const descriptors: UdfDescriptor[] = [];
  for (let index = 0; index < sectors; index += 1) {
    const sector = start + index;
    const offset = sector * UDF_LOGICAL_BLOCK_SIZE;
    if (offset + 16 > image.byteLength || image.slice(offset, offset + 16).every((byte) => byte === 0)) continue;
    const raw = readDescriptor(image, sector);
    const tag = validateUdfDescriptorTag(raw, { expectedTagLocation: sector });
    switch (tag.tagIdentifier) {
      case UDF_DESCRIPTOR_TAG_IDENTIFIER.PRIMARY_VOLUME_DESCRIPTOR:
        descriptors.push({ kind: "primary-volume", tag, sector, raw, volumeDescriptorSequenceNumber: readUint32LE(raw, 16), primaryVolumeDescriptorNumber: readUint32LE(raw, 20), volumeIdentifier: decodeDstring(raw, 24, 32), volumeSequenceNumber: readUint16LE(raw, 56), maximumVolumeSequenceNumber: readUint16LE(raw, 58), volumeSetIdentifier: decodeDstring(raw, 72, 128) });
        break;
      case UDF_DESCRIPTOR_TAG_IDENTIFIER.PARTITION_DESCRIPTOR:
        descriptors.push({ kind: "partition", tag, sector, raw, volumeDescriptorSequenceNumber: readUint32LE(raw, 16), partitionNumber: readUint16LE(raw, 22), accessType: readUint32LE(raw, 184), startLocation: readUint32LE(raw, 188), length: readUint32LE(raw, 192) });
        break;
      case UDF_DESCRIPTOR_TAG_IDENTIFIER.LOGICAL_VOLUME_DESCRIPTOR:
        descriptors.push(parseLogicalVolumeDescriptor(raw, sector, tag));
        break;
      case UDF_DESCRIPTOR_TAG_IDENTIFIER.TERMINATING_DESCRIPTOR:
        descriptors.push({ kind: "terminating", tag, sector, raw } satisfies UdfTerminatingDescriptor);
        break;
      default:
        descriptors.push({ kind: "unknown", tag, sector, raw });
    }
  }
  return descriptors;
}

function parseLogicalVolumeDescriptor(raw: Uint8Array, sector: number, tag: ReturnType<typeof validateUdfDescriptorTag>): UdfLogicalVolumeDescriptor {
  const mapLength = readUint32LE(raw, 264);
  const mapCount = readUint32LE(raw, 268);
  if (440 + mapLength > raw.byteLength) throw new Error("logical volume descriptor partition map table exceeds descriptor length");
  const partitionMaps = [];
  let offset = 440;
  for (let index = 0; index < mapCount; index += 1) {
    const type = raw[offset]!; const length = raw[offset + 1]!;
    if (length < 2 || offset + length > 440 + mapLength) throw new Error("logical volume descriptor has an invalid partition map");
    const mapRaw = raw.slice(offset, offset + length);
    partitionMaps.push({ type, length, ...(type === 1 && length === 6 ? { volumeSequenceNumber: readUint16LE(raw, offset + 2), partitionNumber: readUint16LE(raw, offset + 4) } : {}), raw: mapRaw });
    offset += length;
  }
  return { kind: "logical-volume", tag, sector, raw, volumeDescriptorSequenceNumber: readUint32LE(raw, 16), logicalVolumeIdentifier: decodeDstring(raw, 84, 128), logicalBlockSize: readUint32LE(raw, 212), fileSetDescriptorLocation: decodeLongAd(raw, 248), partitionMaps };
}

function resolvePartitions(lvd: UdfLogicalVolumeDescriptor, descriptors: UdfPartitionDescriptor[]): UdfPartition[] {
  return lvd.partitionMaps.map((map, mapIndex) => {
    if (map.type !== 1 || map.partitionNumber === undefined) throw new Error(`unsupported UDF partition map type ${map.type}`);
    const descriptor = descriptors.find((candidate) => candidate.partitionNumber === map.partitionNumber);
    if (!descriptor) throw new Error(`partition map ${mapIndex} references missing partition ${map.partitionNumber}`);
    return { ...descriptor, mapIndex };
  });
}

function parseFileSetDescriptor(image: Uint8Array, location: { location: number; partitionReferenceNumber: number }, partitions: UdfPartition[], index: number): UdfFileSetDescriptor {
  if (index !== 0) throw new Error(`fileSetDescriptorIndex ${index} is out of range; image contains 1 file set descriptor`);
  const partition = partitions[location.partitionReferenceNumber];
  if (!partition) throw new Error(`file set descriptor uses unknown partition reference ${location.partitionReferenceNumber}`);
  const sector = partition.startLocation + location.location;
  const raw = readDescriptor(image, sector, UDF_DESCRIPTOR_TAG_IDENTIFIER.FILE_SET_DESCRIPTOR, location.location);
  const tag = validateUdfDescriptorTag(raw, { expectedTagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.FILE_SET_DESCRIPTOR, expectedTagLocation: location.location });
  return { kind: "file-set", tag, sector, raw, fileSetNumber: readUint32LE(raw, 40), fileSetDescriptorNumber: readUint32LE(raw, 44), logicalVolumeIdentifier: decodeDstring(raw, 112, 128), fileSetIdentifier: decodeDstring(raw, 304, 32), rootDirectoryIcb: decodeLongAd(raw, 400) };
}

function parseDirectory(context: ParsedContext, block: number, name: string, path: string): UdfDirectoryEntry {
  const descriptor = parseFileEntry(context, block);
  if (descriptor.fileType !== 4) throw new Error(`UDF ICB ${block} is not a directory`);
  if (context.seen.has(block)) throw new Error(`UDF directory cycle at ${path || "."}`);
  context.seen.add(block);
  const bytes = readAllocationData(context, descriptor);
  const children: UdfNode[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = validateUdfDescriptorTag(bytes.subarray(offset), { expectedTagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.FILE_IDENTIFIER_DESCRIPTOR, expectedTagLocation: descriptor.allocationDescriptors[0]?.location ?? 0 });
    const identifierLength = bytes[offset + 19]!;
    const implementationUseLength = readUint16LE(bytes, offset + 36);
    const entryLength = align4(38 + implementationUseLength + identifierLength);
    if (offset + entryLength > bytes.byteLength) throw new Error("UDF file identifier descriptor exceeds directory information length");
    const characteristics = bytes[offset + 18]!;
    if ((characteristics & 0x08) === 0) {
      const identifier = decodeOstaCompressedUnicode(bytes, offset + 38 + implementationUseLength, identifierLength);
      const icb = decodeLongAd(bytes, offset + 20);
      const childPath = path === "" ? identifier : `${path}/${identifier}`;
      const childPartition = context.partition;
      if (icb.partitionReferenceNumber !== childPartition.mapIndex) throw new Error("UDF multi-partition directory references are not supported");
      const childDescriptor = parseFileEntry(context, icb.location);
      children.push(childDescriptor.fileType === 4 ? parseDirectory(context, icb.location, identifier, childPath) : parseFile(context, icb.location, identifier, childPath));
    }
    offset += entryLength;
    void tag;
  }
  context.seen.delete(block);
  return { kind: "directory", name, path, descriptor, children };
}

function parseFile(context: ParsedContext, block: number, name: string, path: string): UdfFileEntry {
  const descriptor = parseFileEntry(context, block);
  if (descriptor.fileType !== 5) throw new Error(`unsupported UDF file type ${descriptor.fileType} at ${path}`);
  return { kind: "file", name, path, size: Number(descriptor.informationLength), ...(context.includeData ? { data: readAllocationData(context, descriptor) } : {}), descriptor };
}

function parseFileEntry(context: ParsedContext, block: number): UdfFileEntryDescriptor {
  const sector = context.partition.startLocation + block;
  const raw = readDescriptor(context.image, sector, UDF_DESCRIPTOR_TAG_IDENTIFIER.FILE_ENTRY, block);
  const tag = validateUdfDescriptorTag(raw, { expectedTagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.FILE_ENTRY, expectedTagLocation: block });
  const allocationLength = readUint32LE(raw, 172);
  if (176 + allocationLength > raw.byteLength || allocationLength % 8 !== 0) throw new Error(`UDF file entry ${block} has invalid short allocation descriptors`);
  const allocationDescriptors = [];
  for (let offset = 176; offset < 176 + allocationLength; offset += 8) allocationDescriptors.push(decodeShortAd(raw, offset));
  return { kind: "file-entry", tag, sector, raw, fileType: raw[27]!, informationLength: readUint64LE(raw, 56), logicalBlocksRecorded: readUint64LE(raw, 64), uid: readUint32LE(raw, 36), gid: readUint32LE(raw, 40), permissions: readUint32LE(raw, 44), linkCount: readUint16LE(raw, 48), allocationDescriptors };
}

function readAllocationData(context: ParsedContext, descriptor: UdfFileEntryDescriptor): Uint8Array {
  if (descriptor.informationLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("UDF file information length exceeds JavaScript safe integer range");
  const length = Number(descriptor.informationLength);
  const bytes = new Uint8Array(length);
  let outputOffset = 0;
  for (const allocation of descriptor.allocationDescriptors) {
    if (allocation.type !== 0) throw new Error(`unsupported UDF allocation extent type ${allocation.type}`);
    const start = (context.partition.startLocation + allocation.location) * UDF_LOGICAL_BLOCK_SIZE;
    const end = start + allocation.length;
    if (end > context.image.byteLength || outputOffset + allocation.length > length) throw new Error("UDF allocation descriptor is out of bounds");
    if (context.includeData || descriptor.fileType === 4) bytes.set(context.image.subarray(start, end), outputOffset);
    outputOffset += allocation.length;
  }
  if (outputOffset !== length) throw new Error("UDF allocation descriptors do not cover the information length");
  return bytes;
}

function readDescriptor(image: Uint8Array, sector: number, expectedIdentifier?: number, expectedTagLocation = sector): Uint8Array {
  const offset = sector * UDF_LOGICAL_BLOCK_SIZE;
  if (!Number.isInteger(sector) || sector < 0 || offset + 16 > image.byteLength) throw new Error(`UDF descriptor sector ${sector} is out of bounds`);
  const crcLength = readUint16LE(image, offset + 10);
  const length = 16 + crcLength;
  if (offset + length > image.byteLength) throw new Error(`UDF descriptor at sector ${sector} exceeds image bounds`);
  const raw = image.slice(offset, offset + length);
  validateUdfDescriptorTag(raw, { ...(expectedIdentifier === undefined ? {} : { expectedTagIdentifier: expectedIdentifier }), expectedTagLocation });
  return raw;
}

function select<T>(values: T[], index: number, name: string, label: string): T {
  if (!Number.isInteger(index) || index < 0) throw new Error(`${name} must be a non-negative integer; received ${index}`);
  if (!values[index]) throw new Error(`${name} ${index} is out of range; image contains ${values.length} ${label}${values.length === 1 ? "" : "s"}`);
  return values[index]!;
}
function collectFiles(root: UdfDirectoryEntry): UdfFileEntry[] { const files: UdfFileEntry[] = []; const visit = (node: UdfNode): void => { if (node.kind === "file") files.push(node); else node.children.forEach(visit); }; root.children.forEach(visit); return files; }
function assertBlockAligned(image: Uint8Array): void { if (image.byteLength % UDF_LOGICAL_BLOCK_SIZE !== 0) throw new Error(`UDF image length must be a multiple of ${UDF_LOGICAL_BLOCK_SIZE} bytes`); }
function ascii(bytes: Uint8Array, offset: number, length: number): string { let result = ""; for (let index = 0; index < length; index += 1) result += String.fromCharCode(bytes[offset + index]!); return result; }
function align4(value: number): number { return (value + 3) & ~3; }
