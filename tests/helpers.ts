import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SECTOR_SIZE = 2048;
export const PVD_SECTOR = 16;
export const TERMINATOR_SECTOR = 17;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const entryCandidates = [
  resolve(root, "src/index.ts"),
  resolve(root, "src/index.js"),
  resolve(root, "dist/index.js"),
];

type Ecma119Module = Record<string, unknown>;

export interface ImageFileInput {
  path: string;
  data: Uint8Array;
}

export interface ImageMetadataInput {
  volumeIdentifier: string;
}

export interface IsoRecord {
  length: number;
  extent: number;
  dataLength: number;
  flags: number;
  fileUnitSize: number;
  interleaveGapSize: number;
  fileIdentifier: Uint8Array;
}

export interface PathTableRecord {
  identifierLength: number;
  extendedAttributeRecordLength: number;
  extent: number;
  parentDirectoryNumber: number;
  identifier: Uint8Array;
}

export async function loadEcma119Module(): Promise<Ecma119Module | undefined> {
  const entry = entryCandidates.find((candidate) => existsSync(candidate));
  if (!entry) {
    return undefined;
  }

  return import(pathToFileURL(entry).href) as Promise<Ecma119Module>;
}

export function hasEcma119Entry(): boolean {
  return entryCandidates.some((candidate) => existsSync(candidate));
}

export function findImageCreator(
  module: Ecma119Module,
): ((files: ImageFileInput[], options: ImageMetadataInput) => unknown) | undefined {
  const candidates = [
    module.createImage,
    module.createIsoImage,
    module.createEcma119Image,
    module.buildImage,
    module.writeImage,
  ];

  return candidates.find(
    (candidate): candidate is (files: ImageFileInput[], options: ImageMetadataInput) => unknown =>
      typeof candidate === "function",
  );
}

export function findIsoParser(module: Ecma119Module): ((image: Uint8Array, options?: { includeData?: boolean }) => unknown) | undefined {
  return typeof module.parseIsoImage === "function"
    ? module.parseIsoImage as (image: Uint8Array, options?: { includeData?: boolean }) => unknown
    : undefined;
}

export function findIsoValidator(module: Ecma119Module): ((image: Uint8Array) => unknown) | undefined {
  return typeof module.validateIsoImage === "function"
    ? module.validateIsoImage as (image: Uint8Array) => unknown
    : undefined;
}

export async function createFixtureImage(
  createImage: (files: ImageFileInput[], options: ImageMetadataInput) => unknown,
  files: ImageFileInput[] = [
    {
      path: "README.TXT",
      data: new TextEncoder().encode("hello ecma-119\n"),
    },
  ],
  options: ImageMetadataInput = {
    volumeIdentifier: "ECMA119_FIXTURE",
  },
): Promise<Uint8Array> {
  const result = await createImage(files, options);

  return asBytes(result);
}

export function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  throw new TypeError("Expected image creator to return Uint8Array, ArrayBuffer, or another ArrayBuffer view");
}

export function sector(image: Uint8Array, logicalBlockNumber: number): Uint8Array {
  const start = logicalBlockNumber * SECTOR_SIZE;
  return image.subarray(start, start + SECTOR_SIZE);
}

export function ascii(bytes: Uint8Array, start = 0, end = bytes.length): string {
  return new TextDecoder("ascii").decode(bytes.subarray(start, end));
}

export function trimRightSpace(value: string): string {
  return value.replace(/\s+$/u, "");
}

export function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

export function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
  ) >>> 0;
}

export function readBothEndianUint16(bytes: Uint8Array, offset: number): number {
  const littleEndian = readUint16LE(bytes, offset);
  const bigEndian = readUint16BE(bytes, offset + 2);

  if (littleEndian !== bigEndian) {
    throw new Error(`Both-endian uint16 mismatch at ${offset}: ${littleEndian} !== ${bigEndian}`);
  }

  return littleEndian;
}

export function readBothEndianUint32(bytes: Uint8Array, offset: number): number {
  const littleEndian = readUint32LE(bytes, offset);
  const bigEndian = readUint32BE(bytes, offset + 4);

  if (littleEndian !== bigEndian) {
    throw new Error(`Both-endian uint32 mismatch at ${offset}: ${littleEndian} !== ${bigEndian}`);
  }

  return littleEndian;
}

export function readDirectoryRecord(bytes: Uint8Array, offset: number): IsoRecord {
  const length = bytes[offset];
  if (length === 0) {
    throw new Error(`Missing directory record at ${offset}`);
  }

  const identifierLength = bytes[offset + 32];

  return {
    length,
    extent: readBothEndianUint32(bytes, offset + 2),
    dataLength: readBothEndianUint32(bytes, offset + 10),
    flags: bytes[offset + 25],
    fileUnitSize: bytes[offset + 26],
    interleaveGapSize: bytes[offset + 27],
    fileIdentifier: bytes.subarray(offset + 33, offset + 33 + identifierLength),
  };
}

export function readPathTableRecord(bytes: Uint8Array, offset: number): PathTableRecord {
  const identifierLength = bytes[offset];
  if (identifierLength === 0) {
    throw new Error(`Missing path table record at ${offset}`);
  }

  return {
    identifierLength,
    extendedAttributeRecordLength: bytes[offset + 1],
    extent: readUint32LE(bytes, offset + 2),
    parentDirectoryNumber: readUint16LE(bytes, offset + 6),
    identifier: bytes.subarray(offset + 8, offset + 8 + identifierLength),
  };
}

export function findDirectoryRecord(directory: Uint8Array, identifier: string): IsoRecord | undefined {
  let offset = 0;

  while (offset < directory.length) {
    const length = directory[offset];
    if (length === 0) {
      offset = Math.ceil((offset + 1) / SECTOR_SIZE) * SECTOR_SIZE;
      continue;
    }

    const record = readDirectoryRecord(directory, offset);
    if (ascii(record.fileIdentifier) === identifier) {
      return record;
    }

    offset += length;
  }

  return undefined;
}

export function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}
