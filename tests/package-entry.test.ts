import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
});
