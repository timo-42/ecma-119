import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import * as sourceEntry from "../src/index";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  exports?: {
    "."?: {
      import?: string;
      types?: string;
    };
  };
  main?: string;
  types?: string;
};
const builtEntryPath = resolve(root, "dist/index.js");
const maybeTest = existsSync(builtEntryPath) ? test : test.skip;

type PackDryRunOutput = Array<{
  files: Array<{
    path: string;
  }>;
}>;

type SourceMap = {
  sources?: unknown;
};

describe("package entry", () => {
  test("points root exports at the built entry and declarations", () => {
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports?.["."]?.import).toBe("./dist/index.js");
    expect(packageJson.exports?.["."]?.types).toBe("./dist/index.d.ts");
  });

  maybeTest("matches the source root runtime exports after build", async () => {
    const builtEntry = await import(pathToFileURL(builtEntryPath).href) as typeof sourceEntry;

    expect(Object.keys(builtEntry).sort((left, right) => left.localeCompare(right))).toEqual(
      Object.keys(sourceEntry).sort((left, right) => left.localeCompare(right)),
    );
  });

  maybeTest("built package entry writes validates and reads an image", async () => {
    const builtEntry = await import(pathToFileURL(builtEntryPath).href) as typeof sourceEntry;
    const image = builtEntry.createIsoImage([{
      path: "PACKAGE.TXT",
      data: "package entry roundtrip\n",
    }], {
      volumeIdentifier: "PACKAGE_ENTRY",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const parsed = builtEntry.parseIsoImage(image, { includeData: true });

    expect(builtEntry.validateIsoImage(image)).toEqual([]);
    expect(parsed.primaryVolumeDescriptor.volumeIdentifier).toBe("PACKAGE_ENTRY");
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "PACKAGE.TXT",
      identifier: "PACKAGE.TXT;1",
      size: "package entry roundtrip\n".length,
    });
    expect(new TextDecoder("ascii").decode(parsed.files[0]?.data)).toBe("package entry roundtrip\n");
  });

  maybeTest("published package contains files referenced by emitted source maps", () => {
    const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
    });
    const [{ files }] = JSON.parse(packOutput) as PackDryRunOutput;
    const packedFiles = new Set(files.map((file) => normalize(file.path)));
    const mapFiles = files
      .map((file) => normalize(file.path))
      .filter((path) => path.startsWith("dist/") && path.endsWith(".map"));

    expect(mapFiles.length).toBeGreaterThan(0);
    for (const mapFile of mapFiles) {
      const map = JSON.parse(readFileSync(resolve(root, mapFile), "utf8")) as SourceMap;
      expect(Array.isArray(map.sources), `${mapFile} must declare source paths`).toBe(true);

      for (const source of map.sources as string[]) {
        if (/^(?:[a-z]+:)?\/\//iu.test(source) || source.startsWith("data:")) {
          continue;
        }
        const referencedPath = normalize(`${dirname(mapFile)}/${source}`).replace(/\\/gu, "/");
        expect(
          packedFiles.has(referencedPath),
          `${mapFile} references ${source}, but ${referencedPath} is not included in the package`,
        ).toBe(true);
      }
    }
  });
});
