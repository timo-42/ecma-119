import { describe, expect, test } from "vitest";

import {
  createIsoImage,
  parseIsoImage,
  parseVolumeDescriptors,
  readUint32Both,
  SECTOR_SIZE,
  validateIsoImage,
  writeUint32Both,
  type CreateIsoOptions,
  type IsoInputFile,
  type VolumePartitionDescriptor,
} from "../src/index";

const encoder = new TextEncoder();
const decoder = new TextDecoder("ascii");

type ExpectedVolumePartitionOptions = {
  systemIdentifier?: string;
  volumePartitionIdentifier?: string;
  data?: Uint8Array | Buffer | string;
  systemUse?: Uint8Array | Buffer | string;
  size?: number;
};

describe("volume partition descriptor writing", () => {
  test("writes an optional partition descriptor with sector-aligned partition data", () => {
    const systemIdentifier = "PARTITION SYSTEM";
    const volumePartitionIdentifier = "PARTITION_DATA";
    const partitionData = encoder.encode("opaque partition payload\n");
    const systemUse = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    const fileContents = encoder.encode("regular file contents\n");

    const image = createWithVolumePartition(
      [{ path: "README.TXT", data: fileContents }],
      {
        systemIdentifier,
        volumePartitionIdentifier,
        data: partitionData,
        systemUse,
      },
    );

    const descriptors = parseVolumeDescriptors(image);
    const terminatorIndex = descriptors.findIndex((descriptor) => descriptor.kind === "terminator");
    const partitionIndex = descriptors.findIndex((descriptor) => descriptor.kind === "partition");

    expect(terminatorIndex).toBeGreaterThan(-1);
    expect(partitionIndex).toBeGreaterThan(-1);
    expect(partitionIndex).toBeLessThan(terminatorIndex);

    const partition = descriptors[partitionIndex] as VolumePartitionDescriptor;
    expect(partition).toMatchObject({
      type: 3,
      kind: "partition",
      identifier: "CD001",
      version: 1,
      systemIdentifier,
      volumePartitionIdentifier,
      volumePartitionSize: 1,
    });
    expect(partition.volumePartitionLocation).toBeGreaterThan(partition.sector);
    expect(partition.volumePartitionLocation + partition.volumePartitionSize).toBeLessThanOrEqual(image.byteLength / SECTOR_SIZE);

    expect(partition.raw.byteLength).toBe(SECTOR_SIZE);
    expect(partition.raw[0]).toBe(3);
    expect(ascii(partition.raw, 1, 6)).toBe("CD001");
    expect(partition.raw[6]).toBe(1);
    expect(ascii(partition.raw, 8, 40)).toBe(systemIdentifier.padEnd(32, " "));
    expect(ascii(partition.raw, 40, 72)).toBe(volumePartitionIdentifier.padEnd(32, " "));
    expect(readUint32Both(partition.raw, 72)).toBe(partition.volumePartitionLocation);
    expect(readUint32Both(partition.raw, 80)).toBe(partition.volumePartitionSize);
    expect(partition.raw.subarray(88, 88 + systemUse.byteLength)).toEqual(systemUse);
    expect(partition.systemUse.subarray(0, systemUse.byteLength)).toEqual(systemUse);

    const partitionOffset = partition.volumePartitionLocation * SECTOR_SIZE;
    expect(partitionOffset % SECTOR_SIZE).toBe(0);
    const partitionBytes = image.subarray(partitionOffset, partitionOffset + partition.volumePartitionSize * SECTOR_SIZE);
    expect(partitionBytes.subarray(0, partitionData.byteLength)).toEqual(partitionData);
    expect(partitionBytes.subarray(partitionData.byteLength).every((byte) => byte === 0)).toBe(true);

    const parsed = parseIsoImage(image, { includeData: true });
    const parsedPartition = parsed.descriptors.find(
      (descriptor): descriptor is VolumePartitionDescriptor => descriptor.kind === "partition",
    );
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "README.TXT",
      identifier: "README.TXT;1",
      size: fileContents.byteLength,
    });
    expect(parsed.files[0]?.data).toEqual(fileContents);
    expect(parsedPartition?.data?.byteLength).toBe(SECTOR_SIZE);
    expect(parsedPartition?.data?.subarray(0, partitionData.byteLength)).toEqual(partitionData);
    expect(parsedPartition?.data?.subarray(partitionData.byteLength).every((byte) => byte === 0)).toBe(true);
  });

  test("omits parsed partition payloads when includeData is false", () => {
    const image = createWithVolumePartition([{ path: "README.TXT", data: "regular\n" }], {
      volumePartitionIdentifier: "PARTITION",
      data: "partition payload\n",
    });
    const parsed = parseIsoImage(image, { includeData: false });
    const partition = parsed.descriptors.find(
      (descriptor): descriptor is VolumePartitionDescriptor => descriptor.kind === "partition",
    );

    expect(partition).toBeDefined();
    expect(partition?.data).toBeUndefined();
  });

  test("rejects invalid partition descriptor identifiers", () => {
    expect(() => createWithVolumePartition([{ path: "BAD.TXT", data: "x" }], {
      systemIdentifier: "S".repeat(33),
      volumePartitionIdentifier: "PARTITION",
    })).toThrow(/32-byte|too long|system identifier/i);

    expect(() => createWithVolumePartition([{ path: "BAD.TXT", data: "x" }], {
      systemIdentifier: "SYSTEM",
      volumePartitionIdentifier: "P".repeat(33),
    })).toThrow(/32-byte|too long|partition identifier/i);

    expect(() => createWithVolumePartition([{ path: "BAD.TXT", data: "x" }], {
      systemIdentifier: "invalid#identifier",
      volumePartitionIdentifier: "PARTITION",
    })).toThrow(/a-characters|system identifier/i);

    expect(() => createWithVolumePartition([{ path: "BAD.TXT", data: "x" }], {
      systemIdentifier: "SYSTEM",
      volumePartitionIdentifier: "PARTITION DATA",
    })).toThrow(/d-characters|partition identifier/i);
  });

  test("writes multiple partition descriptors with distinct payload extents", () => {
    const image = createIsoImage(
      [{ path: "README.TXT", data: "regular\n" }],
      {
        volumePartitions: [
          {
            systemIdentifier: "SYSTEM",
            volumePartitionIdentifier: "PART_A",
            data: encoder.encode("first partition\n"),
          },
          {
            systemIdentifier: "SYSTEM",
            volumePartitionIdentifier: "PART_B",
            size: 2,
          },
        ],
      },
    );

    const partitions = parseVolumeDescriptors(image).filter(
      (descriptor): descriptor is VolumePartitionDescriptor => descriptor.kind === "partition",
    );

    expect(partitions).toHaveLength(2);
    expect(partitions[0]?.volumePartitionIdentifier).toBe("PART_A");
    expect(partitions[0]?.volumePartitionSize).toBe(1);
    expect(partitions[1]?.volumePartitionIdentifier).toBe("PART_B");
    expect(partitions[1]?.volumePartitionSize).toBe(2);
    expect(partitions[1]?.volumePartitionLocation).toBe((partitions[0]?.volumePartitionLocation ?? 0) + 1);

    const secondOffset = partitions[1]!.volumePartitionLocation * SECTOR_SIZE;
    const secondBytes = image.subarray(secondOffset, secondOffset + partitions[1]!.volumePartitionSize * SECTOR_SIZE);
    expect(validateIsoImage(image)).toEqual([]);
    expect(secondBytes.every((byte) => byte === 0)).toBe(true);
    expect(parseIsoImage(image).files.map((file) => file.path)).toEqual(["README.TXT"]);
  });

  test("validates partition payload sizing and system use bounds", () => {
    expect(() => createWithVolumePartition([{ path: "BAD.TXT", data: "x" }], {
      volumePartitionIdentifier: "EMPTY",
      data: new Uint8Array(),
    })).toThrow(/empty|size/i);

    expect(() => createWithVolumePartition([{ path: "BAD.TXT", data: "x" }], {
      volumePartitionIdentifier: "TOO_SMALL",
      data: new Uint8Array(SECTOR_SIZE + 1),
      size: 1,
    })).toThrow(/exceeds declared size/i);

    expect(() => createWithVolumePartition([{ path: "BAD.TXT", data: "x" }], {
      volumePartitionIdentifier: "BAD_SIZE",
      size: 0,
    })).toThrow(/size/i);

    expect(() => createWithVolumePartition([{ path: "BAD.TXT", data: "x" }], {
      volumePartitionIdentifier: "SYSUSE",
      data: "x",
      systemUse: new Uint8Array(1961),
    })).toThrow(/system use/i);
  });

  test("validateIsoImage reports partition extents outside the image", () => {
    const image = createWithVolumePartition([{ path: "README.TXT", data: "x" }], {
      volumePartitionIdentifier: "PARTITION",
      data: "partition\n",
    });
    expect(parseIsoImage(image, { includeData: false }).files.map((file) => file.path)).toEqual(["README.TXT"]);
    expect(validateIsoImage(image)).toEqual([]);

    const partition = parseVolumeDescriptors(image).find(
      (descriptor): descriptor is VolumePartitionDescriptor => descriptor.kind === "partition",
    );
    expect(partition).toBeDefined();

    writeUint32Both(partition!.raw, 72, 0xfffffff0);
    writeUint32Both(partition!.raw, 80, 0x20);
    image.set(partition!.raw, partition!.offset);

    expect(parseVolumeDescriptors(image).some((descriptor) => descriptor.kind === "partition")).toBe(true);
    expect(() => parseIsoImage(image, { includeData: false })).toThrow(/volume partition extent 4294967280\+32 is out of bounds/i);
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "partition.bounds",
          message: expect.stringMatching(/out of bounds/i),
        }),
      ]),
    );
    expect(validateIsoImage(image)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "image.parse",
        }),
      ]),
    );
  });

  test("parseIsoImage rejects partition extents outside the primary volume space", () => {
    const image = createWithVolumePartition([{ path: "README.TXT", data: "x" }], {
      volumePartitionIdentifier: "PARTITION",
      data: "partition\n",
    });
    expect(parseIsoImage(image, { includeData: false }).files.map((file) => file.path)).toEqual(["README.TXT"]);
    expect(validateIsoImage(image)).toEqual([]);

    const partition = parseVolumeDescriptors(image).find(
      (descriptor): descriptor is VolumePartitionDescriptor => descriptor.kind === "partition",
    );
    expect(partition).toBeDefined();
    writeUint32Both(image, 16 * SECTOR_SIZE + 80, partition!.volumePartitionLocation + partition!.volumePartitionSize - 1);

    expect(parseVolumeDescriptors(image).some((descriptor) => descriptor.kind === "partition")).toBe(true);
    expect(() => parseIsoImage(image, { includeData: false })).toThrow(
      new RegExp(`volume partition extent ${partition!.volumePartitionLocation}\\+${partition!.volumePartitionSize} is out of bounds`, "i"),
    );
    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "partition.bounds",
          message: expect.stringMatching(/out of bounds/i),
        }),
      ]),
    );
    expect(validateIsoImage(image)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "image.parse",
        }),
      ]),
    );
  });

  test.each([
    { fieldOffset: 72, code: "partition.volume_partition_location.endian_mismatch", label: "volume partition location" },
    { fieldOffset: 80, code: "partition.volume_partition_size.endian_mismatch", label: "volume partition size" },
  ])("validateIsoImage reports partition descriptor both-endian mismatch for $label", ({ fieldOffset, code, label }) => {
    const image = createWithVolumePartition([{ path: "README.TXT", data: "x" }], {
      volumePartitionIdentifier: "PARTITION",
      data: "partition\n",
    });
    const partition = parseVolumeDescriptors(image).find(
      (descriptor): descriptor is VolumePartitionDescriptor => descriptor.kind === "partition",
    );
    expect(partition).toBeDefined();
    image[partition!.offset + fieldOffset + 7] ^= 0xff;

    expect(validateIsoImage(image)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code,
          message: expect.stringContaining(`volume partition descriptor ${label} must store matching little- and big-endian values`),
        }),
        expect.objectContaining({
          code: "descriptor.sequence",
          message: expect.stringMatching(/both-endian uint32 mismatch/i),
        }),
      ]),
    );
  });
});

function createWithVolumePartition(
  files: IsoInputFile[],
  volumePartition: ExpectedVolumePartitionOptions,
): Uint8Array {
  return createIsoImage(files, {
    volumePartition,
  } as CreateIsoOptions & { volumePartition: ExpectedVolumePartitionOptions });
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return decoder.decode(bytes.subarray(start, end));
}
