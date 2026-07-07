import { normalizeDCharacters } from "./binary.js";

export type IdentifierLevel = 1 | 2;

export type NormalizedPath = {
  parts: string[];
  fileName: string;
  isoIdentifier: string;
};

export type NormalizedDirectoryPath = {
  parts: string[];
};

const MAX_FILE_PATH_LENGTH = 255;

export function normalizeFilePath(path: string, identifierLevel: IdentifierLevel = 1, version = 1): NormalizedPath {
  const cleaned = path.replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (cleaned.length === 0) {
    throw new Error("file path must not be empty");
  }
  if (cleaned.includes("//") || cleaned.split("/").includes(".") || cleaned.split("/").includes("..")) {
    throw new Error(`file path must not contain empty, current, or parent segments: ${path}`);
  }

  const rawParts = cleaned.split("/");
  if (rawParts.length > 8) {
    throw new Error("ECMA-119 directory hierarchy depth must not exceed 8");
  }

  const directoryParts = rawParts.slice(0, -1).map((part) => normalizeDCharacters(part.toUpperCase(), "path segment"));
  const directoryLimit = identifierLevel === 1 ? 8 : 31;
  for (const directory of directoryParts) {
    if (directory.length > directoryLimit) {
      throw new Error(`directory identifier exceeds ${directoryLimit} d-characters: ${directory}`);
    }
  }

  const fileName = rawParts.at(-1)!;
  const isoIdentifier = identifierLevel === 1 ? toLevelOneFileIdentifier(fileName, version) : toLevelTwoFileIdentifier(fileName, version);
  const filePathLength = directoryParts.reduce((sum, part) => sum + part.length, 0) + directoryParts.length + isoIdentifier.length;
  if (filePathLength > MAX_FILE_PATH_LENGTH) {
    throw new Error(`ECMA-119 file path length must not exceed ${MAX_FILE_PATH_LENGTH} bytes: ${path}`);
  }
  return { parts: [...directoryParts, isoIdentifier], fileName, isoIdentifier };
}

export function normalizeFileIdentifierReference(value: string, identifierLevel: IdentifierLevel = 1): string {
  const versionSeparator = value.lastIndexOf(";");
  if (versionSeparator === -1) {
    return normalizeFilePath(value, identifierLevel).isoIdentifier;
  }
  const versionText = value.slice(versionSeparator + 1);
  if (!/^[1-9][0-9]*$/u.test(versionText)) {
    throw new RangeError("file version number must be an integer from 1 to 32767");
  }
  const version = checkedFileVersionNumber(Number(versionText));
  return normalizeFilePath(value.slice(0, versionSeparator), identifierLevel, version).isoIdentifier;
}

export function normalizeDirectoryPath(path: string, identifierLevel: IdentifierLevel = 1): NormalizedDirectoryPath {
  const cleaned = path.replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (cleaned.length === 0) {
    return { parts: [] };
  }
  if (cleaned.includes("//") || cleaned.split("/").includes(".") || cleaned.split("/").includes("..")) {
    throw new Error(`directory path must not contain empty, current, or parent segments: ${path}`);
  }
  const parts = cleaned.split("/").map((part) => normalizeDCharacters(part.toUpperCase(), "directory path segment"));
  if (parts.length > 7) {
    throw new Error("ECMA-119 directory hierarchy depth must not exceed 8");
  }
  const directoryLimit = identifierLevel === 1 ? 8 : 31;
  for (const directory of parts) {
    if (directory.length > directoryLimit) {
      throw new Error(`directory identifier exceeds ${directoryLimit} d-characters: ${directory}`);
    }
  }
  return { parts };
}

export function toLevelOneFileIdentifier(name: string, version = 1): string {
  const versionText = String(checkedFileVersionNumber(version));
  const original = name.toUpperCase();
  const pieces = original.split(".");
  if (pieces.length > 2 || pieces[0]!.length === 0) {
    throw new Error(`invalid ECMA-119 Level 1 file name: ${name}`);
  }
  const base = normalizeDCharacters(pieces[0]!, "file name");
  const extension = pieces.length === 2 ? normalizeDCharacters(pieces[1]!, "file extension") : "";
  if (base.length > 8) {
    throw new Error(`file name exceeds 8 d-characters: ${name}`);
  }
  if (extension.length > 3) {
    throw new Error(`file extension exceeds 3 d-characters: ${name}`);
  }
  return `${base}.${extension};${versionText}`;
}

export function toLevelTwoFileIdentifier(name: string, version = 1): string {
  const versionText = String(checkedFileVersionNumber(version));
  const original = name.toUpperCase();
  const pieces = original.split(".");
  if (pieces.length > 2 || pieces[0]!.length === 0) {
    throw new Error(`invalid ECMA-119 Level 2 file name: ${name}`);
  }
  const base = normalizeDCharacters(pieces[0]!, "file name");
  const extension = pieces.length === 2 ? normalizeDCharacters(pieces[1]!, "file extension") : "";
  if (base.length + extension.length > 30) {
    throw new Error(`file name and extension exceed 30 d-characters: ${name}`);
  }
  return `${base}.${extension};${versionText}`;
}

export function isLevelOneDirectoryIdentifier(identifier: Uint8Array): boolean {
  return identifier.byteLength >= 1
    && identifier.byteLength <= 8
    && identifier.every(isDCharacterByte);
}

export function isLevelOneFileIdentifier(identifier: Uint8Array): boolean {
  const text = asciiString(identifier);
  if (text === undefined) {
    return false;
  }
  const match = /^([A-Z0-9_]{1,8})\.([A-Z0-9_]{0,3});([1-9][0-9]{0,4})$/u.exec(text);
  return match !== null && Number(match[3]) <= 32767;
}

export function isLevelTwoDirectoryIdentifier(identifier: Uint8Array): boolean {
  return identifier.byteLength >= 1
    && identifier.byteLength <= 31
    && identifier.every(isDCharacterByte);
}

export function isLevelTwoFileIdentifier(identifier: Uint8Array): boolean {
  const text = asciiString(identifier);
  if (text === undefined) {
    return false;
  }
  const match = /^([A-Z0-9_]{1,30})\.([A-Z0-9_]{0,30});([1-9][0-9]{0,4})$/u.exec(text);
  if (match === null || Number(match[3]) > 32767) {
    return false;
  }
  return match[1]!.length + (match[2]?.length ?? 0) <= 30;
}

export function isSupportedPrimaryDirectoryIdentifier(identifier: Uint8Array): boolean {
  return isLevelTwoDirectoryIdentifier(identifier);
}

export function isSupportedPrimaryFileIdentifier(identifier: Uint8Array): boolean {
  return isLevelTwoFileIdentifier(identifier);
}

export function decodeFileIdentifier(identifier: Uint8Array): string {
  if (identifier.length === 1 && identifier[0] === 0) {
    return ".";
  }
  if (identifier.length === 1 && identifier[0] === 1) {
    return "..";
  }
  return new TextDecoder("ascii").decode(identifier);
}

export function stripVersion(identifier: string): string {
  return identifier.replace(/\.?;[0-9]+$/u, "");
}

function isDCharacterByte(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x5f;
}

function asciiString(bytes: Uint8Array): string | undefined {
  let value = "";
  for (const byte of bytes) {
    if (byte > 0x7f) {
      return undefined;
    }
    value += String.fromCharCode(byte);
  }
  return value;
}

function checkedFileVersionNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 32767) {
    throw new RangeError("file version number must be an integer from 1 to 32767");
  }
  return value;
}
