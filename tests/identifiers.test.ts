import { describe, expect, test } from "vitest";

import {
  isLevelOneDirectoryIdentifier,
  isLevelOneFileIdentifier,
  isLevelTwoDirectoryIdentifier,
  isLevelTwoFileIdentifier,
  isSupportedPrimaryDirectoryIdentifier,
  isSupportedPrimaryFileIdentifier,
  normalizeFileIdentifierReference,
  normalizeFilePath,
  toLevelOneFileIdentifier,
  toLevelTwoFileIdentifier,
} from "../src/index";

const encoder = new TextEncoder();

describe("Level 1 identifier predicates", () => {
  test("validates directory identifiers", () => {
    expect(isLevelOneDirectoryIdentifier(bytes("DIR_1234"))).toBe(true);
    expect(isLevelOneDirectoryIdentifier(bytes("TOO_LONG1"))).toBe(false);
    expect(isLevelOneDirectoryIdentifier(bytes("lower"))).toBe(false);
    expect(isLevelOneDirectoryIdentifier(bytes("BAD-DIR"))).toBe(false);
    expect(isLevelOneDirectoryIdentifier(new Uint8Array())).toBe(false);
  });

  test("validates versioned file identifiers", () => {
    expect(isLevelOneFileIdentifier(bytes("README.TXT;1"))).toBe(true);
    expect(isLevelOneFileIdentifier(bytes("README.;32767"))).toBe(true);
    expect(isLevelOneFileIdentifier(bytes("README;32767"))).toBe(false);
    expect(isLevelOneFileIdentifier(bytes("README.TXT;0"))).toBe(false);
    expect(isLevelOneFileIdentifier(bytes("README.TXT;32768"))).toBe(false);
    expect(isLevelOneFileIdentifier(bytes("TOO_LONG1.TXT;1"))).toBe(false);
    expect(isLevelOneFileIdentifier(bytes("README.TOOL;1"))).toBe(false);
    expect(isLevelOneFileIdentifier(bytes("README.TXT"))).toBe(false);
  });

  test("normalizes file identifiers with explicit versions", () => {
    expect(toLevelOneFileIdentifier("readme.txt", 12)).toBe("README.TXT;12");
    expect(toLevelOneFileIdentifier("readme", 32767)).toBe("README.;32767");
    expect(() => toLevelOneFileIdentifier("README.TXT", 0)).toThrow(/file version number/i);
    expect(() => toLevelOneFileIdentifier("README.TXT", 32768)).toThrow(/file version number/i);
  });

  test("normalizes descriptor file references with explicit versions", () => {
    expect(normalizeFileIdentifierReference("copy.txt;2")).toBe("COPY.TXT;2");
    expect(normalizeFileIdentifierReference("readme.;32767")).toBe("README.;32767");
    expect(normalizeFileIdentifierReference("copy.txt")).toBe("COPY.TXT;1");
    expect(() => normalizeFileIdentifierReference("COPY.TXT;0")).toThrow(/file version number/i);
    expect(() => normalizeFileIdentifierReference("COPY.TXT;32768")).toThrow(/file version number/i);
    expect(() => normalizeFileIdentifierReference("COPY.TXT;01")).toThrow(/file version number/i);
  });
});

describe("Level 2 identifier predicates", () => {
  test("validates directory identifiers", () => {
    expect(isLevelTwoDirectoryIdentifier(bytes("D".repeat(31)))).toBe(true);
    expect(isLevelTwoDirectoryIdentifier(bytes("D".repeat(32)))).toBe(false);
    expect(isLevelTwoDirectoryIdentifier(bytes("lower"))).toBe(false);
    expect(isLevelTwoDirectoryIdentifier(bytes("BAD-DIR"))).toBe(false);
    expect(isSupportedPrimaryDirectoryIdentifier(bytes("D".repeat(31)))).toBe(true);
  });

  test("validates versioned file identifiers", () => {
    expect(isLevelTwoFileIdentifier(bytes("LONGFILENAME1234567890.TXT;1"))).toBe(true);
    expect(isLevelTwoFileIdentifier(bytes("README.;32767"))).toBe(true);
    expect(isLevelTwoFileIdentifier(bytes("README;32767"))).toBe(false);
    expect(isLevelTwoFileIdentifier(bytes("README.TXT;0"))).toBe(false);
    expect(isLevelTwoFileIdentifier(bytes("README.TXT;32768"))).toBe(false);
    expect(isLevelTwoFileIdentifier(bytes(`${"A".repeat(28)}.TXT;1`))).toBe(false);
    expect(isLevelTwoFileIdentifier(bytes("README.BAD-EXT;1"))).toBe(false);
    expect(isLevelTwoFileIdentifier(bytes("README.TXT"))).toBe(false);
    expect(isSupportedPrimaryFileIdentifier(bytes("LONGFILENAME1234567890.TXT;1"))).toBe(true);
  });

  test("normalizes file identifiers", () => {
    expect(toLevelTwoFileIdentifier("longfilename1234567890.txt")).toBe("LONGFILENAME1234567890.TXT;1");
    expect(toLevelTwoFileIdentifier("longfilename1234567890.txt", 42)).toBe("LONGFILENAME1234567890.TXT;42");
    expect(toLevelTwoFileIdentifier("longfilename1234567890", 42)).toBe("LONGFILENAME1234567890.;42");
    expect(toLevelTwoFileIdentifier("readme.", 32767)).toBe("README.;32767");
    expect(() => toLevelTwoFileIdentifier(`${"A".repeat(28)}.TXT`)).toThrow(/30 d-characters/i);
  });

  test("normalizes Level 2 descriptor file references with explicit versions", () => {
    expect(normalizeFileIdentifierReference("longfilename1234567890.txt;42", 2)).toBe("LONGFILENAME1234567890.TXT;42");
    expect(normalizeFileIdentifierReference("longfilename1234567890;42", 2)).toBe("LONGFILENAME1234567890.;42");
    expect(normalizeFileIdentifierReference("readme.;32767", 2)).toBe("README.;32767");
  });

  test("rejects file paths whose ECMA-119 path length exceeds 255 bytes", () => {
    const directories = Array.from({ length: 7 }, () => "D".repeat(31));
    const fileName = `${"F".repeat(26)}.TXT`;

    expect(() => normalizeFilePath([...directories, fileName].join("/"), 2)).toThrow(/file path length must not exceed 255 bytes/i);
  });
});

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}
