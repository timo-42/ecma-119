import { normalizeDCharacters } from "./binary.js";

export type NormalizedPath = {
  parts: string[];
  fileName: string;
  isoIdentifier: string;
};

export type NormalizedDirectoryPath = {
  parts: string[];
};

export function normalizeFilePath(path: string): NormalizedPath {
  const cleaned = path.replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (cleaned.length === 0) {
    throw new Error("file path must not be empty");
  }
  if (cleaned.includes("//") || cleaned.split("/").includes(".") || cleaned.split("/").includes("..")) {
    throw new Error(`file path must not contain empty, current, or parent segments: ${path}`);
  }

  const rawParts = cleaned.split("/");
  if (rawParts.length > 8) {
    throw new Error("ECMA-119 Level 1 directory hierarchy depth must not exceed 8");
  }

  const directoryParts = rawParts.slice(0, -1).map((part) => normalizeDCharacters(part.toUpperCase(), "path segment"));
  for (const directory of directoryParts) {
    if (directory.length > 8) {
      throw new Error(`directory identifier exceeds 8 d-characters: ${directory}`);
    }
  }

  const fileName = rawParts.at(-1)!;
  const isoIdentifier = toLevelOneFileIdentifier(fileName);
  return { parts: [...directoryParts, isoIdentifier], fileName, isoIdentifier };
}

export function normalizeDirectoryPath(path: string): NormalizedDirectoryPath {
  const cleaned = path.replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (cleaned.length === 0) {
    return { parts: [] };
  }
  if (cleaned.includes("//") || cleaned.split("/").includes(".") || cleaned.split("/").includes("..")) {
    throw new Error(`directory path must not contain empty, current, or parent segments: ${path}`);
  }
  const parts = cleaned.split("/").map((part) => normalizeDCharacters(part.toUpperCase(), "directory path segment"));
  if (parts.length > 8) {
    throw new Error("ECMA-119 Level 1 directory hierarchy depth must not exceed 8");
  }
  for (const directory of parts) {
    if (directory.length > 8) {
      throw new Error(`directory identifier exceeds 8 d-characters: ${directory}`);
    }
  }
  return { parts };
}

export function toLevelOneFileIdentifier(name: string): string {
  const upper = normalizeDCharacters(name.toUpperCase().replace(/\./gu, "_DOT_"), "file identifier");
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
  return extension ? `${base}.${extension};1` : `${upper};1`;
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
  const match = /^([A-Z0-9_]{1,8})(?:\.([A-Z0-9_]{1,3}))?;([1-9][0-9]{0,4})$/u.exec(text);
  return match !== null && Number(match[3]) <= 32767;
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
  return identifier.replace(/;[0-9]+$/u, "");
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
