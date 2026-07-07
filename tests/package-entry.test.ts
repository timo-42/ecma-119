import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, posix as pathPosix, resolve } from "node:path";
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

type PackDryRunOutput = Array<{
  files: Array<{
    path: string;
  }>;
}>;

type SourceMap = {
  sources?: unknown;
};

function requiredPackageEntryPaths(): string[] {
  return [
    packageJson.main,
    packageJson.types,
    packageJson.exports?.["."]?.import,
    packageJson.exports?.["."]?.types,
  ]
    .filter((path): path is string => typeof path === "string")
    .map((path) => pathPosix.normalize(path.replace(/^\.\//u, "")));
}

function buildPackage(): void {
  execFileSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "pipe",
  });
}

function dryRunPacklist(): Set<string> {
  const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  });
  const [{ files }] = JSON.parse(packOutput) as PackDryRunOutput;
  return new Set(files.map((file) => pathPosix.normalize(file.path)));
}

describe("package entry", () => {
  test("points root exports at the built entry and declarations", () => {
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports?.["."]?.import).toBe("./dist/index.js");
    expect(packageJson.exports?.["."]?.types).toBe("./dist/index.d.ts");
  });

  test("package packlist includes manifest entry targets after a clean build", () => {
    rmSync(resolve(root, "dist"), { force: true, recursive: true });
    buildPackage();
    const packedFiles = dryRunPacklist();

    for (const requiredPath of requiredPackageEntryPaths()) {
      expect(
        packedFiles.has(requiredPath),
        `package manifest references ${requiredPath}, but it is not included in the packed files`,
      ).toBe(true);
    }
  }, 20_000);

  test("matches the source root runtime exports after build", async () => {
    buildPackage();
    const builtEntry = await import(pathToFileURL(builtEntryPath).href) as typeof sourceEntry;

    expect(Object.keys(builtEntry).sort((left, right) => left.localeCompare(right))).toEqual(
      Object.keys(sourceEntry).sort((left, right) => left.localeCompare(right)),
    );
  }, 20_000);

  test("built package entry writes validates and reads an image", async () => {
    buildPackage();
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
  }, 20_000);

  test("published package contains files referenced by emitted source maps", () => {
    buildPackage();
    const packedFiles = dryRunPacklist();
    const mapFiles = [...packedFiles]
      .filter((path) => path.startsWith("dist/") && path.endsWith(".map"));

    expect(mapFiles.length).toBeGreaterThan(0);
    for (const mapFile of mapFiles) {
      const map = JSON.parse(readFileSync(resolve(root, mapFile), "utf8")) as SourceMap;
      expect(Array.isArray(map.sources), `${mapFile} must declare source paths`).toBe(true);

      for (const source of map.sources as string[]) {
        if (/^(?:[a-z]+:)?\/\//iu.test(source) || source.startsWith("data:")) {
          continue;
        }
        const referencedPath = pathPosix.normalize(`${pathPosix.dirname(mapFile)}/${source}`);
        expect(
          packedFiles.has(referencedPath),
          `${mapFile} references ${source}, but ${referencedPath} is not included in the package`,
        ).toBe(true);
      }
    }
  }, 20_000);
});
