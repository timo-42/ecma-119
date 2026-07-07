import { describe, expect, test } from "vitest";

import { createIsoImage, encodeExtendedAttributeRecord, parseIsoImage, parseVolumeDescriptors, validateIsoImage } from "../src/index";
import { SECTOR_SIZE, SYSTEM_AREA_SECTORS } from "../src/types";

describe("byte input handling", () => {
  test("writes ArrayBuffer and ArrayBufferView inputs and reads them back", () => {
    const fileBacking = Uint8Array.of(0x00, 0x41, 0x42, 0x43, 0xff);
    const fileData = new DataView(fileBacking.buffer, 1, 3);
    const systemUseBacking = Uint8Array.of(0x00, 0x53, 0x55, 0xff);
    const systemUse = new DataView(systemUseBacking.buffer, 1, 2);
    const systemAreaBacking = Uint8Array.of(0x00, 0xde, 0xad, 0xbe, 0xef);
    const systemArea = systemAreaBacking.buffer.slice(1);
    const partitionBacking = Uint8Array.of(0x50, 0x51);
    const partitionData = new Uint16Array(partitionBacking.buffer);
    const extendedAttributeRecord = encodeExtendedAttributeRecord({
      systemIdentifier: "ARRAYBUFFER",
      applicationUse: Uint8Array.of(0x61, 0x62),
    }).buffer;

    const image = createIsoImage([{
      path: "BYTES.BIN",
      data: fileData,
      systemUse,
      extendedAttributeRecord,
    }], {
      systemArea,
      volumeIdentifier: "BYTE_INPUT",
      volumePartition: {
        volumePartitionIdentifier: "BYTEPART",
        data: partitionData,
      },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const wrappedImage = new Uint8Array(image.byteLength + 2);
    wrappedImage.set(image, 1);
    const imageView = new DataView(wrappedImage.buffer, 1, image.byteLength);
    const parsed = parseIsoImage(imageView, { includeData: true });
    const partition = parsed.descriptors.find((descriptor) => descriptor.kind === "partition");

    expect(validateIsoImage(imageView)).toEqual([]);
    expect(parseVolumeDescriptors(imageView).map((descriptor) => descriptor.kind)).toEqual(["primary", "partition", "terminator"]);
    expect(parsed.systemArea.subarray(0, 4)).toEqual(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    expect(parsed.systemArea.subarray(4, SYSTEM_AREA_SECTORS * SECTOR_SIZE).every((byte) => byte === 0)).toBe(true);
    expect(partition?.kind === "partition" ? partition.data?.subarray(0, 2) : undefined).toEqual(Uint8Array.of(0x50, 0x51));
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: "BYTES.BIN",
      identifier: "BYTES.BIN;1",
      size: 3,
      extendedAttributeRecordLength: 1,
    });
    expect(parsed.files[0]?.data).toEqual(Uint8Array.of(0x41, 0x42, 0x43));
    expect(parsed.files[0]?.systemUse).toEqual(Uint8Array.of(0x53, 0x55));
    expect(parsed.files[0]?.extendedAttributeRecordFields).toMatchObject({
      systemIdentifier: "ARRAYBUFFER",
    });
    expect(parsed.files[0]?.extendedAttributeRecordFields?.applicationUse).toEqual(Uint8Array.of(0x61, 0x62));
  });
});
