import { bytesFromInput } from "../byte-input.js";
import { writeUint16LE, writeUint32LE } from "../binary.js";
import { UDF_DESCRIPTOR_TAG_IDENTIFIER } from "../udf-tag.js";
import {
  encodeDstring,
  encodeEcmaTimestamp,
  encodeEntityIdentifier,
  encodeLongAd,
  encodeOstaCompressedUnicode,
  encodeShortAd,
  finalizeUdfDescriptor,
  writeUint64LE,
} from "./codec.js";
import { UDF_LOGICAL_BLOCK_SIZE, type CreateUdfOptions, type UdfInputDirectory, type UdfInputFile } from "./types.js";

const VRS_START = 16;
const ANCHOR_SECTOR = 256;
const MAIN_VDS_SECTOR = 257;
const LVID_SECTOR = 273;
const PARTITION_START = 274;
const VDS_SECTORS = 16;
const FE_SIZE = 176;
const DIRECTORY_FILE_TYPE = 4;
const REGULAR_FILE_TYPE = 5;
const PARENT_FID_CHARACTERISTICS = 0x0a;
const DIRECTORY_FID_CHARACTERISTICS = 0x02;
const MAX_ALLOCATION_LENGTH = 0x3fff_ffff;

type Node = {
  kind: "directory" | "file";
  name: string;
  parent?: Node;
  children: Node[];
  data?: Uint8Array;
  options?: UdfInputFile | UdfInputDirectory;
  feBlock: number;
  dataBlock: number;
  dataBytes: Uint8Array;
  uniqueId: number;
};

/** Creates a UDF 2.01 image using ECMA-167 3rd-edition structures. */
export function createUdfImage(
  filesOrOptions: UdfInputFile[] | ({ files: UdfInputFile[] } & CreateUdfOptions),
  maybeOptions: CreateUdfOptions = {},
): Uint8Array {
  const files = Array.isArray(filesOrOptions) ? filesOrOptions : filesOrOptions.files;
  const options = Array.isArray(filesOrOptions) ? maybeOptions : filesOrOptions;
  if (options.revision !== undefined && options.revision !== "2.01") {
    throw new Error("createUdfImage currently supports UDF revision 2.01 only");
  }
  if (options.logicalBlockSize !== undefined && options.logicalBlockSize !== UDF_LOGICAL_BLOCK_SIZE) {
    throw new Error(`createUdfImage currently requires a ${UDF_LOGICAL_BLOCK_SIZE}-byte logical block size`);
  }

  const root = buildTree(files, options.directories ?? []);
  const nodes = collectNodes(root);
  let nextBlock = 1;
  for (const node of nodes) {
    if (node === root) {
      node.feBlock = 1;
      continue;
    }
    node.feBlock = ++nextBlock;
  }
  nextBlock += 1;
  let uniqueId = 16;
  for (const node of nodes) {
    node.uniqueId = node === root ? 0 : uniqueId++;
  }
  for (const node of nodes.filter((node) => node.kind === "directory")) {
    node.dataBlock = nextBlock;
    node.dataBytes = encodeDirectoryData(node);
    nextBlock += sectorsForBytes(node.dataBytes.byteLength);
  }
  for (const node of nodes.filter((node) => node.kind === "file")) {
    node.dataBytes = node.data ?? new Uint8Array();
    node.dataBlock = nextBlock;
    nextBlock += sectorsForBytes(node.dataBytes.byteLength);
  }
  const partitionLength = Math.max(nextBlock, 1);
  const reserveVdsSector = PARTITION_START + partitionLength;
  const lastSector = Math.max(1024, reserveVdsSector + VDS_SECTORS + 256);
  const image = new Uint8Array((lastSector + 1) * UDF_LOGICAL_BLOCK_SIZE);
  writeVolumeRecognitionSequence(image);

  const volumeIdentifier = options.volumeIdentifier ?? "UDF_VOLUME";
  const volumeSetIdentifier = options.volumeSetIdentifier ?? volumeIdentifier;
  const fileSetIdentifier = options.fileSetIdentifier ?? volumeIdentifier;
  const implementationIdentifier = options.implementationIdentifier ?? "*ecma-119";
  const now = options.createdAt ?? new Date();
  const mainVds = encodeVolumeDescriptorSequence({
    volumeIdentifier,
    volumeSetIdentifier,
    fileSetIdentifier,
    implementationIdentifier,
    partitionLength,
    reserveVdsSector,
    fileCount: nodes.filter((node) => node.kind === "file").length,
    directoryCount: nodes.filter((node) => node.kind === "directory").length,
    nextUniqueId: uniqueId,
    now,
  }, MAIN_VDS_SECTOR);
  image.set(mainVds, MAIN_VDS_SECTOR * UDF_LOGICAL_BLOCK_SIZE);
  const reserveVds = encodeVolumeDescriptorSequence({
    volumeIdentifier,
    volumeSetIdentifier,
    fileSetIdentifier,
    implementationIdentifier,
    partitionLength,
    reserveVdsSector,
    fileCount: nodes.filter((node) => node.kind === "file").length,
    directoryCount: nodes.filter((node) => node.kind === "directory").length,
    nextUniqueId: uniqueId,
    now,
  }, reserveVdsSector);
  image.set(reserveVds, reserveVdsSector * UDF_LOGICAL_BLOCK_SIZE);
  image.set(encodeLogicalVolumeIntegrityDescriptor(partitionLength, uniqueId, nodes, now, LVID_SECTOR), LVID_SECTOR * UDF_LOGICAL_BLOCK_SIZE);
  for (const anchor of [ANCHOR_SECTOR, lastSector - 256, lastSector]) {
    image.set(encodeAnchorDescriptor(MAIN_VDS_SECTOR, reserveVdsSector, anchor), anchor * UDF_LOGICAL_BLOCK_SIZE);
  }
  image.set(encodeFileSetDescriptor(volumeIdentifier, fileSetIdentifier, root.feBlock, PARTITION_START), PARTITION_START * UDF_LOGICAL_BLOCK_SIZE);
  for (const node of nodes) {
    image.set(encodeFileEntry(node, now), (PARTITION_START + node.feBlock) * UDF_LOGICAL_BLOCK_SIZE);
    if (node.dataBytes.byteLength > 0) {
      image.set(node.dataBytes, (PARTITION_START + node.dataBlock) * UDF_LOGICAL_BLOCK_SIZE);
    }
  }
  return image;
}

function buildTree(files: UdfInputFile[], directories: UdfInputDirectory[]): Node {
  const root: Node = { kind: "directory", name: "", children: [], feBlock: 1, dataBlock: 0, dataBytes: new Uint8Array(), uniqueId: 0 };
  for (const directory of directories) {
    ensureDirectory(root, directory.path, directory);
  }
  for (const file of files) {
    const parts = splitPath(file.path);
    if (parts.length === 0) {
      throw new Error("UDF file path must not be empty");
    }
    const name = parts.pop()!;
    const parent = ensureDirectory(root, parts.join("/"));
    if (parent.children.some((child) => child.name === name)) {
      throw new Error(`duplicate UDF path ${file.path}`);
    }
    parent.children.push({
      kind: "file",
      name,
      parent,
      children: [],
      data: bytesFromInput(file.data),
      options: file,
      feBlock: 0,
      dataBlock: 0,
      dataBytes: new Uint8Array(),
      uniqueId: 0,
    });
  }
  return root;
}

function ensureDirectory(root: Node, path: string, options?: UdfInputDirectory): Node {
  let directory = root;
  for (const name of splitPath(path)) {
    let child = directory.children.find((candidate) => candidate.name === name);
    if (!child) {
      child = { kind: "directory", name, parent: directory, children: [], ...(options ? { options } : {}), feBlock: 0, dataBlock: 0, dataBytes: new Uint8Array(), uniqueId: 0 };
      directory.children.push(child);
    }
    const existingChild = child;
    if (existingChild.kind !== "directory") {
      throw new Error(`UDF path ${path} conflicts with a file`);
    }
    directory = existingChild;
  }
  return directory;
}

function splitPath(path: string): string[] {
  if (path === "") return [];
  if (path.startsWith("/") || path.endsWith("/")) throw new Error(`UDF path ${path} must be relative without a trailing slash`);
  return path.split("/").map((part) => {
    if (part === "" || part === "." || part === ".." || part.includes("\0")) throw new Error(`UDF path ${path} contains an invalid component`);
    return part;
  });
}

function collectNodes(root: Node): Node[] {
  const result: Node[] = [];
  const visit = (node: Node): void => {
    result.push(node);
    for (const child of node.children.sort((left, right) => left.name.localeCompare(right.name))) visit(child);
  };
  visit(root);
  return result;
}

function encodeDirectoryData(directory: Node): Uint8Array {
  const entries = [encodeFileIdentifier(directory, directory, "", PARENT_FID_CHARACTERISTICS), ...directory.children.map((child) => encodeFileIdentifier(directory, child, child.name, child.kind === "directory" ? DIRECTORY_FID_CHARACTERISTICS : 0))];
  return concat(entries);
}

function encodeFileIdentifier(owner: Node, target: Node, name: string, characteristics: number): Uint8Array {
  const identifier = name === "" ? new Uint8Array() : encodeOstaCompressedUnicode(name);
  if (identifier.byteLength > 0xff) throw new RangeError(`UDF file identifier ${name} exceeds 255 bytes`);
  const size = align4(38 + identifier.byteLength);
  const bytes = new Uint8Array(size);
  writeUint16LE(bytes, 16, 1);
  bytes[18] = characteristics;
  bytes[19] = identifier.byteLength;
  bytes.set(encodeLongAd({ length: UDF_LOGICAL_BLOCK_SIZE, location: target.feBlock, partitionReferenceNumber: 0, implementationUse: uniqueIdUse(target.uniqueId) }), 20);
  writeUint16LE(bytes, 36, 0);
  bytes.set(identifier, 38);
  return finalizeUdfDescriptor(bytes, { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.FILE_IDENTIFIER_DESCRIPTOR, tagLocation: owner.dataBlock });
}

function encodeFileEntry(node: Node, now: Date): Uint8Array {
  const hasData = node.dataBytes.byteLength > 0;
  const allocationDescriptors = hasData ? encodeShortAd({ length: node.dataBytes.byteLength, location: node.dataBlock }) : new Uint8Array();
  if (node.dataBytes.byteLength > MAX_ALLOCATION_LENGTH) throw new RangeError(`UDF file ${node.name} exceeds the contiguous allocation limit`);
  const bytes = new Uint8Array(FE_SIZE + allocationDescriptors.byteLength);
  writeUint16LE(bytes, 20, 4);
  writeUint16LE(bytes, 24, 1);
  bytes[27] = node.kind === "directory" ? DIRECTORY_FILE_TYPE : REGULAR_FILE_TYPE;
  writeUint32LE(bytes, 36, node.options && "uid" in node.options && node.options.uid !== undefined ? node.options.uid : 0);
  writeUint32LE(bytes, 40, node.options && "gid" in node.options && node.options.gid !== undefined ? node.options.gid : 0);
  writeUint32LE(bytes, 44, node.options && "permissions" in node.options && node.options.permissions !== undefined ? node.options.permissions : 0x1ff);
  writeUint16LE(bytes, 48, node.kind === "directory" ? 2 : 1);
  writeUint64LE(bytes, 56, BigInt(node.dataBytes.byteLength));
  writeUint64LE(bytes, 64, BigInt(sectorsForBytes(node.dataBytes.byteLength)));
  bytes.set(encodeEcmaTimestamp(node.options?.accessedAt ?? now), 72);
  bytes.set(encodeEcmaTimestamp(node.options?.modifiedAt ?? now), 84);
  bytes.set(encodeEcmaTimestamp(node.options?.attributesAt ?? now), 96);
  bytes.set(implementationRegid("*ecma-119"), 128);
  writeUint64LE(bytes, 160, BigInt(node.uniqueId));
  writeUint32LE(bytes, 172, allocationDescriptors.byteLength);
  bytes.set(allocationDescriptors, FE_SIZE);
  return finalizeUdfDescriptor(bytes, { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.FILE_ENTRY, tagLocation: node.feBlock });
}

function encodeFileSetDescriptor(volumeIdentifier: string, fileSetIdentifier: string, rootBlock: number, location: number): Uint8Array {
  const bytes = new Uint8Array(512);
  writeUint16LE(bytes, 28, 3); writeUint16LE(bytes, 30, 3);
  writeUint32LE(bytes, 32, 1); writeUint32LE(bytes, 36, 1);
  bytes.set(characterSet(), 48); bytes.set(encodeDstring(volumeIdentifier, 128), 112); bytes.set(characterSet(), 240); bytes.set(encodeDstring(fileSetIdentifier, 32), 304);
  bytes.set(encodeLongAd({ length: UDF_LOGICAL_BLOCK_SIZE, location: rootBlock, partitionReferenceNumber: 0, implementationUse: uniqueIdUse(0) }), 400);
  bytes.set(udfDomainRegid(), 416);
  return finalizeUdfDescriptor(bytes, { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.FILE_SET_DESCRIPTOR, tagLocation: 0 });
}

function encodeVolumeDescriptorSequence(input: { volumeIdentifier: string; volumeSetIdentifier: string; fileSetIdentifier: string; implementationIdentifier: string; partitionLength: number; reserveVdsSector: number; fileCount: number; directoryCount: number; nextUniqueId: number; now: Date }, startSector: number): Uint8Array {
  const result = new Uint8Array(VDS_SECTORS * UDF_LOGICAL_BLOCK_SIZE);
  const descriptors = [encodePrimaryVolumeDescriptor(input, startSector), encodeImplementationUseVolumeDescriptor(input, startSector + 1), encodePartitionDescriptor(input.partitionLength, startSector + 2), encodeLogicalVolumeDescriptor(input.volumeIdentifier, startSector + 3), encodeUnallocatedSpaceDescriptor(startSector + 4), encodeTerminatingDescriptor(startSector + 5)];
  descriptors.forEach((descriptor, index) => result.set(descriptor, index * UDF_LOGICAL_BLOCK_SIZE));
  return result;
}

function encodePrimaryVolumeDescriptor(input: { volumeIdentifier: string; volumeSetIdentifier: string; implementationIdentifier: string; now: Date }, sector: number): Uint8Array {
  const bytes = new Uint8Array(512);
  writeUint32LE(bytes, 16, 1); bytes.set(encodeDstring(input.volumeIdentifier, 32), 24); writeUint16LE(bytes, 56, 1); writeUint16LE(bytes, 58, 1); writeUint16LE(bytes, 60, 2); writeUint16LE(bytes, 62, 3); writeUint32LE(bytes, 64, 1); writeUint32LE(bytes, 68, 1); bytes.set(encodeDstring(input.volumeSetIdentifier, 128), 72); bytes.set(characterSet(), 200); bytes.set(characterSet(), 264); bytes.set(implementationRegid(input.implementationIdentifier), 388); bytes.set(encodeEcmaTimestamp(input.now), 376);
  return finalizeUdfDescriptor(bytes, { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.PRIMARY_VOLUME_DESCRIPTOR, tagLocation: sector });
}

function encodeImplementationUseVolumeDescriptor(input: { volumeIdentifier: string; implementationIdentifier: string }, sector: number): Uint8Array {
  const bytes = new Uint8Array(512);
  writeUint32LE(bytes, 16, 1); bytes.set(implementationRegid("*UDF LV Info"), 20); bytes.set(characterSet(), 52); bytes.set(encodeDstring(input.volumeIdentifier, 128), 116); bytes.set(implementationRegid(input.implementationIdentifier), 352);
  return finalizeUdfDescriptor(bytes, { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.IMPLEMENTATION_USE_VOLUME_DESCRIPTOR, tagLocation: sector });
}

function encodePartitionDescriptor(partitionLength: number, sector: number): Uint8Array {
  const bytes = new Uint8Array(512); writeUint32LE(bytes, 16, 1); writeUint16LE(bytes, 20, 1); bytes.set(implementationRegid("+NSR03"), 24); writeUint32LE(bytes, 184, 1); writeUint32LE(bytes, 188, PARTITION_START); writeUint32LE(bytes, 192, partitionLength); bytes.set(implementationRegid("*ecma-119"), 196);
  return finalizeUdfDescriptor(bytes, { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.PARTITION_DESCRIPTOR, tagLocation: sector });
}

function encodeLogicalVolumeDescriptor(volumeIdentifier: string, sector: number): Uint8Array {
  const bytes = new Uint8Array(446); writeUint32LE(bytes, 16, 1); bytes.set(characterSet(), 20); bytes.set(encodeDstring(volumeIdentifier, 128), 84); writeUint32LE(bytes, 212, UDF_LOGICAL_BLOCK_SIZE); bytes.set(udfDomainRegid(), 216); bytes.set(encodeLongAd({ length: UDF_LOGICAL_BLOCK_SIZE, location: 0, partitionReferenceNumber: 0, implementationUse: uniqueIdUse(0) }), 248); writeUint32LE(bytes, 264, 6); writeUint32LE(bytes, 268, 1); bytes.set(implementationRegid("*ecma-119"), 272); bytes[440] = 1; bytes[441] = 6; writeUint16LE(bytes, 442, 1); writeUint16LE(bytes, 444, 0);
  return finalizeUdfDescriptor(bytes, { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.LOGICAL_VOLUME_DESCRIPTOR, tagLocation: sector });
}

function encodeUnallocatedSpaceDescriptor(sector: number): Uint8Array { const bytes = new Uint8Array(24); writeUint32LE(bytes, 16, 1); writeUint32LE(bytes, 20, 0); return finalizeUdfDescriptor(bytes, { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.UNALLOCATED_SPACE_DESCRIPTOR, tagLocation: sector }); }
function encodeTerminatingDescriptor(sector: number): Uint8Array { return finalizeUdfDescriptor(new Uint8Array(512), { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.TERMINATING_DESCRIPTOR, tagLocation: sector }); }
function encodeAnchorDescriptor(main: number, reserve: number, sector: number): Uint8Array { const bytes = new Uint8Array(512); writeUint32LE(bytes, 16, VDS_SECTORS * UDF_LOGICAL_BLOCK_SIZE); writeUint32LE(bytes, 20, main); writeUint32LE(bytes, 24, VDS_SECTORS * UDF_LOGICAL_BLOCK_SIZE); writeUint32LE(bytes, 28, reserve); return finalizeUdfDescriptor(bytes, { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.ANCHOR_VOLUME_DESCRIPTOR_POINTER, tagLocation: sector }); }
function encodeLogicalVolumeIntegrityDescriptor(partitionLength: number, nextUniqueId: number, nodes: Node[], now: Date, sector: number): Uint8Array { const bytes = new Uint8Array(134); bytes.set(encodeEcmaTimestamp(now), 16); writeUint32LE(bytes, 28, 1); writeUint64LE(bytes, 40, BigInt(nextUniqueId)); writeUint32LE(bytes, 72, 1); writeUint32LE(bytes, 76, 46); writeUint32LE(bytes, 80, 0); writeUint32LE(bytes, 84, partitionLength); bytes.set(implementationRegid("*ecma-119"), 88); writeUint32LE(bytes, 120, nodes.filter((node) => node.kind === "file").length); writeUint32LE(bytes, 124, nodes.filter((node) => node.kind === "directory").length); writeUint16LE(bytes, 128, 0x201); writeUint16LE(bytes, 130, 0x201); writeUint16LE(bytes, 132, 0x201); return finalizeUdfDescriptor(bytes, { tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.LOGICAL_VOLUME_INTEGRITY_DESCRIPTOR, tagLocation: sector }); }

function writeVolumeRecognitionSequence(image: Uint8Array): void { for (const [offset, identifier] of [[VRS_START, "BEA01"], [VRS_START + 1, "NSR03"], [VRS_START + 2, "TEA01"]] as const) { const sector = offset * UDF_LOGICAL_BLOCK_SIZE; image[sector] = 0; image.set(new TextEncoder().encode(identifier), sector + 1); image[sector + 6] = 1; } }
function characterSet(): Uint8Array { const bytes = new Uint8Array(64); bytes.set(new TextEncoder().encode("OSTA Compressed Unicode"), 1); return bytes; }
function implementationRegid(identifier: string): Uint8Array { return encodeEntityIdentifier({ flags: 0, identifier, identifierSuffix: new Uint8Array(8) }); }
function udfDomainRegid(): Uint8Array { return encodeEntityIdentifier({ flags: 0, identifier: "*OSTA UDF Compliant", identifierSuffix: Uint8Array.of(1, 2, 0, 0, 0, 0, 0, 0) }); }
function uniqueIdUse(uniqueId: number): Uint8Array { const bytes = new Uint8Array(6); writeUint32LE(bytes, 2, uniqueId); return bytes; }
function sectorsForBytes(value: number): number { return Math.ceil(value / UDF_LOGICAL_BLOCK_SIZE); }
function align4(value: number): number { return (value + 3) & ~3; }
function concat(chunks: Uint8Array[]): Uint8Array { const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes; }
