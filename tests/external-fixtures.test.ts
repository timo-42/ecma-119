import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { parseIsoImage, validateIsoImage } from "../src/index";
import { SECTOR_SIZE } from "../src/types";

const fixtureUrl = new URL("./fixtures/external/minimal-genisoimage.iso", import.meta.url);
const manifestUrl = new URL("./fixtures/external/minimal-genisoimage.json", import.meta.url);

interface ExternalFixtureManifest {
  sha256: string;
  expectedVolumeIdentifier: string;
  expectedFiles: Array<{
    path: string;
    identifier: string;
    size: number;
  }>;
}

describe("external ISO byte fixtures", () => {
  test("reads and validates a genisoimage-authored ISO image", () => {
    const image = readFileSync(fixtureUrl);
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as ExternalFixtureManifest;

    expect(createHash("sha256").update(image).digest("hex")).toBe(manifest.sha256);
    expect(image.byteLength % SECTOR_SIZE).toBe(0);
    expect(validateIsoImage(image)).toEqual([]);

    const parsed = parseIsoImage(image, { includeData: true });
    expect(parsed.primaryVolumeDescriptor.volumeIdentifier).toBe(manifest.expectedVolumeIdentifier);
    expect(parsed.primaryVolumeDescriptor.logicalBlockSize).toBe(SECTOR_SIZE);
    expect(parsed.descriptors.map((descriptor) => descriptor.kind)).toEqual(["primary", "terminator"]);
    expect(parsed.primaryVolumeDescriptor.pathTables?.typeL).toHaveLength(2);
    expect(parsed.primaryVolumeDescriptor.pathTables?.typeM).toHaveLength(2);

    expect(parsed.files.map(({ path, identifier, size }) => ({ path, identifier, size }))).toEqual(manifest.expectedFiles);
    expect(new TextDecoder("ascii").decode(parsed.files.find((file) => file.path === "README.TXT")?.data)).toBe(
      "hello from genisoimage\n",
    );
    expect(new TextDecoder("ascii").decode(parsed.files.find((file) => file.path === "DIR/NESTED.TXT")?.data)).toBe(
      "nested external fixture\n",
    );
  });
});
