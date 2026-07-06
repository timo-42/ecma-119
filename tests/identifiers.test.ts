import { describe, expect, test } from "vitest";

import {
  isLevelOneDirectoryIdentifier,
  isLevelOneFileIdentifier,
  isLevelTwoDirectoryIdentifier,
  isLevelTwoFileIdentifier,
  isSupportedPrimaryDirectoryIdentifier,
  isSupportedPrimaryFileIdentifier,
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
    expect(isLevelOneFileIdentifier(bytes("README;32767"))).toBe(true);
    expect(isLevelOneFileIdentifier(bytes("README.TXT;0"))).toBe(false);
    expect(isLevelOneFileIdentifier(bytes("README.TXT;32768"))).toBe(false);
    expect(isLevelOneFileIdentifier(bytes("TOO_LONG1.TXT;1"))).toBe(false);
    expect(isLevelOneFileIdentifier(bytes("README.TOOL;1"))).toBe(false);
    expect(isLevelOneFileIdentifier(bytes("README.TXT"))).toBe(false);
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
    expect(isLevelTwoFileIdentifier(bytes("README;32767"))).toBe(true);
    expect(isLevelTwoFileIdentifier(bytes("README.TXT;0"))).toBe(false);
    expect(isLevelTwoFileIdentifier(bytes("README.TXT;32768"))).toBe(false);
    expect(isLevelTwoFileIdentifier(bytes(`${"A".repeat(28)}.TXT;1`))).toBe(false);
    expect(isLevelTwoFileIdentifier(bytes("README.BAD-EXT;1"))).toBe(false);
    expect(isLevelTwoFileIdentifier(bytes("README.TXT"))).toBe(false);
    expect(isSupportedPrimaryFileIdentifier(bytes("LONGFILENAME1234567890.TXT;1"))).toBe(true);
  });

  test("normalizes file identifiers", () => {
    expect(toLevelTwoFileIdentifier("longfilename1234567890.txt")).toBe("LONGFILENAME1234567890.TXT;1");
    expect(() => toLevelTwoFileIdentifier(`${"A".repeat(28)}.TXT`)).toThrow(/30 d-characters/i);
  });
});

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}
