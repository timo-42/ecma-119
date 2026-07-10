import { describe, expect, test } from "vitest";

import {
  crc16Ccitt,
  decodeUdfDescriptorTag,
  descriptorTagChecksum,
  encodeUdfDescriptorTag,
  UDF_DESCRIPTOR_COMPATIBLE_VERSIONS,
  UDF_DESCRIPTOR_TAG_IDENTIFIER,
  UDF_DESCRIPTOR_TAG_SIZE,
  UDF_DESCRIPTOR_VERSION,
  validateUdfDescriptorTag,
} from "../src/udf-tag";

describe("ECMA-167 descriptor tags", () => {
  test("defines the ECMA-167 tag constants", () => {
    expect(UDF_DESCRIPTOR_TAG_SIZE).toBe(16);
    expect(UDF_DESCRIPTOR_VERSION).toBe(3);
    expect(UDF_DESCRIPTOR_COMPATIBLE_VERSIONS).toEqual([2, 3]);
    expect(UDF_DESCRIPTOR_TAG_IDENTIFIER).toMatchObject({
      PRIMARY_VOLUME_DESCRIPTOR: 1,
      TERMINATING_DESCRIPTOR: 8,
      FILE_SET_DESCRIPTOR: 256,
      EXTENDED_FILE_ENTRY: 266,
    });
  });

  test("encodes and decodes the 16-byte little-endian tag format", () => {
    const encoded = encodeUdfDescriptorTag({
      tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.PRIMARY_VOLUME_DESCRIPTOR,
      descriptorVersion: 3,
      tagSerialNumber: 0x1234,
      descriptorCRC: 0x3299,
      descriptorCRCLength: 3,
      tagLocation: 0x11223344,
    });

    expect(encoded).toEqual(Uint8Array.of(
      0x01, 0x00, 0x03, 0x00, 0xc2, 0x00, 0x34, 0x12,
      0x99, 0x32, 0x03, 0x00, 0x44, 0x33, 0x22, 0x11,
    ));
    expect(decodeUdfDescriptorTag(encoded)).toEqual({
      tagIdentifier: 1,
      descriptorVersion: 3,
      tagChecksum: 0xc2,
      reserved: 0,
      tagSerialNumber: 0x1234,
      descriptorCRC: 0x3299,
      descriptorCRCLength: 3,
      tagLocation: 0x11223344,
    });
  });

  test("calculates the tag checksum while excluding checksum byte 4", () => {
    const tag = Uint8Array.of(
      0x01, 0x00, 0x03, 0x00, 0xff, 0x00, 0x34, 0x12,
      0x99, 0x32, 0x03, 0x00, 0x44, 0x33, 0x22, 0x11,
    );
    const prefixed = Uint8Array.of(0xde, 0xad, ...tag);

    expect(descriptorTagChecksum(tag)).toBe(0xc2);
    expect(descriptorTagChecksum(prefixed, 2)).toBe(0xc2);
  });

  test("calculates the ECMA-167 CRC-16/CCITT with a zero seed", () => {
    expect(crc16Ccitt(Uint8Array.of(0x70, 0x6a, 0x77))).toBe(0x3299);
    expect(crc16Ccitt(new TextEncoder().encode("123456789"))).toBe(0x31c3);
    expect(crc16Ccitt(new Uint8Array())).toBe(0);
  });

  test("validates an expected tag identifier, version, checksum, CRC, and location", () => {
    const body = Uint8Array.of(0x70, 0x6a, 0x77, 0xee);
    const tag = encodeUdfDescriptorTag({
      tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.LOGICAL_VOLUME_DESCRIPTOR,
      descriptorVersion: UDF_DESCRIPTOR_VERSION,
      tagSerialNumber: 7,
      descriptorCRC: crc16Ccitt(body.subarray(0, 3)),
      descriptorCRCLength: 3,
      tagLocation: 257,
    });
    const descriptor = Uint8Array.of(...tag, ...body);

    expect(validateUdfDescriptorTag(descriptor, {
      expectedTagIdentifier: [5, UDF_DESCRIPTOR_TAG_IDENTIFIER.LOGICAL_VOLUME_DESCRIPTOR],
      expectedDescriptorVersion: 3,
      expectedTagLocation: 257,
    })).toEqual(decodeUdfDescriptorTag(tag));
  });

  test("accepts version 2 by default but allows callers to require version 3", () => {
    const body = Uint8Array.of(0x70, 0x6a, 0x77);
    const tag = encodeUdfDescriptorTag({
      tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.TERMINATING_DESCRIPTOR,
      descriptorVersion: 2,
      tagSerialNumber: 0,
      descriptorCRC: crc16Ccitt(body),
      descriptorCRCLength: body.byteLength,
      tagLocation: 12,
    });
    const descriptor = Uint8Array.of(...tag, ...body);

    expect(validateUdfDescriptorTag(descriptor).descriptorVersion).toBe(2);
    expect(() => validateUdfDescriptorTag(descriptor, { expectedDescriptorVersion: 3 }))
      .toThrow(/descriptor tag version mismatch: expected 3, got 2/i);
  });

  test("reports identifier, version, reserved-byte, checksum, CRC, and location failures clearly", () => {
    const body = Uint8Array.of(0x70, 0x6a, 0x77);
    const validTag = encodeUdfDescriptorTag({
      tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.PRIMARY_VOLUME_DESCRIPTOR,
      descriptorVersion: 3,
      tagSerialNumber: 0,
      descriptorCRC: crc16Ccitt(body),
      descriptorCRCLength: body.byteLength,
      tagLocation: 42,
    });
    const validDescriptor = Uint8Array.of(...validTag, ...body);

    expect(() => validateUdfDescriptorTag(validDescriptor, { expectedTagIdentifier: 2 }))
      .toThrow(/identifier mismatch: expected 2, got 1/i);

    const badVersion = validDescriptor.slice();
    badVersion[2] = 1;
    badVersion[4] = descriptorTagChecksum(badVersion);
    expect(() => validateUdfDescriptorTag(badVersion)).toThrow(/version mismatch: expected 2 or 3, got 1/i);

    const badReserved = validDescriptor.slice();
    badReserved[5] = 1;
    badReserved[4] = descriptorTagChecksum(badReserved);
    expect(() => validateUdfDescriptorTag(badReserved)).toThrow(/reserved byte must be 0; got 0x01/i);

    const badChecksum = validDescriptor.slice();
    badChecksum[4] ^= 0xff;
    expect(() => validateUdfDescriptorTag(badChecksum)).toThrow(/checksum mismatch/i);

    const badCRC = validDescriptor.slice();
    badCRC[UDF_DESCRIPTOR_TAG_SIZE] ^= 0xff;
    expect(() => validateUdfDescriptorTag(badCRC)).toThrow(/CRC mismatch/i);

    expect(() => validateUdfDescriptorTag(validDescriptor, { expectedTagLocation: 43 }))
      .toThrow(/location mismatch: expected 43, got 42/i);
  });

  test("rejects CRC lengths beyond the supplied descriptor body and malformed tag input", () => {
    const tag = encodeUdfDescriptorTag({
      tagIdentifier: UDF_DESCRIPTOR_TAG_IDENTIFIER.FILE_ENTRY,
      descriptorVersion: 3,
      tagSerialNumber: 0,
      descriptorCRC: 0,
      descriptorCRCLength: 1,
      tagLocation: 0,
    });

    expect(() => validateUdfDescriptorTag(tag)).toThrow(/CRC length 1 exceeds available descriptor body length 0/i);
    expect(() => decodeUdfDescriptorTag(new Uint8Array(15))).toThrow(/need 16 bytes for a descriptor tag/i);
    expect(() => encodeUdfDescriptorTag({
      tagIdentifier: 0x10000,
      descriptorVersion: 3,
      tagSerialNumber: 0,
      descriptorCRC: 0,
      descriptorCRCLength: 0,
      tagLocation: 0,
    })).toThrow(/descriptor tag identifier must be an integer from 0 to 65535/i);
  });
});
