import { normalizeDCharacters } from "./binary.js";

export type NormalizedPath = {
  parts: string[];
  fileName: string;
  isoIdentifier: string;
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
