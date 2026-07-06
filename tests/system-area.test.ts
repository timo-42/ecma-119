import { describe, expect, test } from "vitest";

import { createIsoImage, parseIsoImage, validateIsoImage } from "../src/index";
import { SECTOR_SIZE, SYSTEM_AREA_SECTORS } from "../src/types";

const SYSTEM_AREA_SIZE = SYSTEM_AREA_SECTORS * SECTOR_SIZE;

describe("system area", () => {
  test("leaves the generated system area zero-filled by default", () => {
    const image = createIsoImage([{ path: "README.TXT", data: "default system area\n" }]);
    const parsed = parseIsoImage(image, { includeData: false });

    expect(validateIsoImage(image)).toEqual([]);
    expect(image.subarray(0, SYSTEM_AREA_SIZE).every((byte) => byte === 0)).toBe(true);
    expect(parsed.systemArea).toEqual(new Uint8Array(SYSTEM_AREA_SIZE));
  });

  test("writes, zero-pads, and parses supplied system area bytes", () => {
    const systemArea = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    const image = createIsoImage([{ path: "README.TXT", data: "custom system area\n" }], {
      systemArea,
    });
    const parsed = parseIsoImage(image, { includeData: false });

    expect(validateIsoImage(image)).toEqual([]);
    expect(image.subarray(0, systemArea.byteLength)).toEqual(systemArea);
    expect(image.subarray(systemArea.byteLength, SYSTEM_AREA_SIZE).every((byte) => byte === 0)).toBe(true);
    expect(parsed.systemArea).toEqual(image.slice(0, SYSTEM_AREA_SIZE));
  });

  test("accepts a full 16-sector system area", () => {
    const systemArea = new Uint8Array(SYSTEM_AREA_SIZE);
    systemArea[0] = 0x42;
    systemArea[SYSTEM_AREA_SIZE - 1] = 0x24;
    const image = createIsoImage([{ path: "README.TXT", data: "full system area\n" }], {
      systemArea,
    });
    const parsed = parseIsoImage(image, { includeData: false });

    expect(validateIsoImage(image)).toEqual([]);
    expect(parsed.systemArea).toEqual(systemArea);
  });

  test("rejects system area input larger than 16 sectors", () => {
    expect(() => createIsoImage([{ path: "README.TXT", data: "oversized system area\n" }], {
      systemArea: new Uint8Array(SYSTEM_AREA_SIZE + 1),
    })).toThrow(/system area exceeds 32768 bytes/i);
  });
});
