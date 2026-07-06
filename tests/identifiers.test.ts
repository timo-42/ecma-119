import { describe, expect, test } from "vitest";

import { isLevelOneDirectoryIdentifier, isLevelOneFileIdentifier } from "../src/index";

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

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}
