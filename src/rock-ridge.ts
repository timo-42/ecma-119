import { dateTimeToDate, dateToDirectoryDateTime, decodeVolumeDate, readAscii, readDirectoryDateTime, readUint32Both, writeDirectoryDateTime, writeUint32Both } from "./binary.js";
import type { RockRidgeInput, RockRidgeMetadata, RockRidgeSymlinkComponent, RockRidgeTimestamps, SuspEntry } from "./types.js";
import { SECTOR_SIZE } from "./types.js";

const ASCII_ENCODER = new TextEncoder();
const ASCII_DECODER = new TextDecoder("ascii");

const SUSP_HEADER_LENGTH = 4;
const SUSP_ENTRY_MIN_LENGTH = 4;
const CE_DATA_LENGTH = 24;
const TF_LONG_FORM = 0x80;

export type SuspParseOptions = {
  image?: Uint8Array;
  logicalBlockSize?: number;
  maxContinuations?: number;
  skipBytes?: number;
};

export function parseSuspEntries(systemUse: Uint8Array, options: SuspParseOptions = {}): SuspEntry[] {
  const skipBytes = checkedSkipBytes(options.skipBytes ?? 0, systemUse.byteLength);
  return parseSuspEntrySequence(systemUse, {
    options,
    source: "system-use",
    offset: skipBytes,
    baseOffset: 0,
    continuationsSeen: 0,
  });
}

export function parseRockRidgeMetadata(systemUse: Uint8Array, options: SuspParseOptions = {}): RockRidgeMetadata | undefined {
  if (systemUse.byteLength === 0) {
    return undefined;
  }
  const entries = parseSuspEntries(systemUse, options);
  if (!entries.some((entry) => isRockRidgeOrSuspEntry(entry.signature))) {
    return undefined;
  }
  return metadataFromEntries(entries);
}

export function tryParseRockRidgeMetadata(systemUse: Uint8Array, options: SuspParseOptions = {}): RockRidgeMetadata | undefined {
  const skipBytes = options.skipBytes ?? 0;
  if ("skipBytes" in options) {
    if (systemUse.byteLength === 0) {
      return undefined;
    }
    const entries = parseSuspEntries(systemUse, options);
    return entries.length === 0 ? undefined : metadataFromEntries(entries);
  }
  if (!startsWithKnownSuspSignature(systemUse.subarray(skipBytes))) {
    return undefined;
  }
  try {
    return parseRockRidgeMetadata(systemUse, options);
  } catch (error) {
    if ("skipBytes" in options) {
      throw error;
    }
    return undefined;
  }
}

export function encodeRockRidgeSystemUse(input: RockRidgeInput): Uint8Array {
  const entries: Uint8Array[] = [];

  if (
    input.mode !== undefined
    || input.links !== undefined
    || input.uid !== undefined
    || input.gid !== undefined
    || input.serial !== undefined
  ) {
    const data = new Uint8Array(40);
    writeUint32Both(data, 0, checkedUint32(input.mode ?? 0, "rockRidge.mode"));
    writeUint32Both(data, 8, checkedUint32(input.links ?? 1, "rockRidge.links"));
    writeUint32Both(data, 16, checkedUint32(input.uid ?? 0, "rockRidge.uid"));
    writeUint32Both(data, 24, checkedUint32(input.gid ?? 0, "rockRidge.gid"));
    writeUint32Both(data, 32, checkedUint32(input.serial ?? 1, "rockRidge.serial"));
    entries.push(encodeSuspEntry("PX", data));
  }

  if (input.name !== undefined) {
    const name = encodeAscii(input.name, "rockRidge.name");
    if (name.byteLength > 250) {
      throw new Error("rockRidge.name is too long for inline NM entry");
    }
    const data = new Uint8Array(1 + name.byteLength);
    data[0] = 0;
    data.set(name, 1);
    entries.push(encodeSuspEntry("NM", data));
  }

  if (input.symlink !== undefined) {
    const target = typeof input.symlink === "string" ? input.symlink : input.symlink.target;
    const flags = typeof input.symlink === "string" ? 0 : input.symlink.flags ?? 0;
    entries.push(encodeSymlinkEntry(target, flags));
  }

  if (input.timestamps) {
    entries.push(encodeTimestampEntry(input.timestamps));
  }

  if (input.device) {
    const data = new Uint8Array(16);
    writeUint32Both(data, 0, checkedUint32(input.device.major, "rockRidge.device.major"));
    writeUint32Both(data, 8, checkedUint32(input.device.minor, "rockRidge.device.minor"));
    entries.push(encodeSuspEntry("PN", data));
  }

  if (input.childLinkExtent !== undefined) {
    const data = new Uint8Array(8);
    writeUint32Both(data, 0, checkedUint32(input.childLinkExtent, "rockRidge.childLinkExtent"));
    entries.push(encodeSuspEntry("CL", data));
  }

  if (input.parentLinkExtent !== undefined) {
    const data = new Uint8Array(8);
    writeUint32Both(data, 0, checkedUint32(input.parentLinkExtent, "rockRidge.parentLinkExtent"));
    entries.push(encodeSuspEntry("PL", data));
  }

  if (input.relocated) {
    entries.push(encodeSuspEntry("RE", new Uint8Array()));
  }

  return concat(entries);
}

export function encodeRockRidgeDiscoverySystemUse(): Uint8Array {
  return concat([
    encodeSuspEntry("SP", Uint8Array.of(0xbe, 0xef, 0)),
    encodeSuspEntry("ER", encodeErData({
      identifier: "RRIP_1991A",
      descriptor: "THE ROCK RIDGE INTERCHANGE PROTOCOL PROVIDES SUPPORT FOR POSIX FILE SYSTEM SEMANTICS",
      source: "IEEE P1282",
      version: 1,
    })),
  ]);
}

function parseSuspEntrySequence(
  bytes: Uint8Array,
  state: {
    options: SuspParseOptions;
    source: SuspEntry["source"];
    offset: number;
    baseOffset: number;
    continuationsSeen: number;
  },
): SuspEntry[] {
  const entries: SuspEntry[] = [];
  let offset = state.offset;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < SUSP_HEADER_LENGTH) {
      throw new Error(`SUSP entry header at offset ${state.baseOffset + offset} is truncated`);
    }
    const length = bytes[offset + 2]!;
    if (length < SUSP_ENTRY_MIN_LENGTH) {
      throw new Error(`SUSP entry at offset ${state.baseOffset + offset} has invalid length ${length}`);
    }
    if (offset + length > bytes.byteLength) {
      throw new Error(`SUSP entry at offset ${state.baseOffset + offset} extends beyond its containing area`);
    }

    const signature = readAscii(bytes, offset, 2);
    const raw = bytes.slice(offset, offset + length);
    const entry: SuspEntry = {
      signature,
      length,
      version: bytes[offset + 3]!,
      data: bytes.slice(offset + SUSP_HEADER_LENGTH, offset + length),
      raw,
      source: state.source,
      offset: state.baseOffset + offset,
    };
    entries.push(entry);
    offset += length;

    if (signature === "ST") {
      break;
    }
    if (signature === "PD") {
      continue;
    }
    if (signature === "CE") {
      entries.push(...readContinuationEntries(entry, state));
    }
  }
  return entries;
}

function readContinuationEntries(
  entry: SuspEntry,
  state: {
    options: SuspParseOptions;
    continuationsSeen: number;
  },
): SuspEntry[] {
  if (entry.data.byteLength !== CE_DATA_LENGTH) {
    throw new Error(`SUSP CE entry at offset ${entry.offset} must contain ${CE_DATA_LENGTH} bytes`);
  }
  const image = state.options.image;
  if (!image) {
    throw new Error("SUSP CE entry requires an image for continuation parsing");
  }
  const maxContinuations = state.options.maxContinuations ?? 32;
  if (state.continuationsSeen >= maxContinuations) {
    throw new Error(`SUSP continuation count exceeds ${maxContinuations}`);
  }
  const logicalBlockSize = state.options.logicalBlockSize ?? SECTOR_SIZE;
  const block = readUint32Both(entry.data, 0);
  const offset = readUint32Both(entry.data, 8);
  const length = readUint32Both(entry.data, 16);
  const start = block * logicalBlockSize + offset;
  const end = start + length;
  if (length === 0) {
    return [];
  }
  if (offset >= logicalBlockSize) {
    throw new Error(`SUSP CE entry at offset ${entry.offset} has continuation offset outside its logical block`);
  }
  if (start < 0 || end > image.byteLength || end < start) {
    throw new Error(`SUSP CE entry at offset ${entry.offset} points outside the image`);
  }
  return parseSuspEntrySequence(image.subarray(start, end), {
      options: state.options,
      source: "continuation",
      offset: 0,
      baseOffset: start,
      continuationsSeen: state.continuationsSeen + 1,
    });
}

function metadataFromEntries(entries: SuspEntry[]): RockRidgeMetadata {
  const metadata: RockRidgeMetadata = {
    entries,
    rawEntries: entries,
  };
  const nameParts: string[] = [];

  for (const entry of entries) {
    switch (entry.signature) {
      case "SP":
        metadata.susp = {
          ...metadata.susp,
          skipBytes: parseSpEntry(entry),
        };
        break;
      case "ER":
        metadata.susp = {
          ...metadata.susp,
          extensions: [...metadata.susp?.extensions ?? [], parseErEntry(entry)],
        };
        break;
      case "PX":
        metadata.posix = parsePxEntry(entry);
        break;
      case "NM":
        nameParts.push(parseNmEntry(entry));
        metadata.name = nameParts.join("");
        break;
      case "SL":
        metadata.symlink = parseSlEntry(entry);
        break;
      case "TF":
        metadata.timestamps = parseTfEntry(entry);
        break;
      case "PN":
        metadata.device = parsePnEntry(entry);
        break;
      case "CL":
        metadata.childLinkExtent = parseSingleBothEndianField(entry, "CL");
        break;
      case "PL":
        metadata.parentLinkExtent = parseSingleBothEndianField(entry, "PL");
        break;
      case "RE":
        metadata.relocated = true;
        break;
    }
  }

  return metadata;
}

function parseSpEntry(entry: SuspEntry): number {
  if (entry.data.byteLength < 3 || entry.data[0] !== 0xbe || entry.data[1] !== 0xef) {
    throw new Error("SUSP SP entry has invalid check bytes");
  }
  return entry.data[2]!;
}

function parseErEntry(entry: SuspEntry): { identifier: string; descriptor: string; source: string; version: number } {
  if (entry.data.byteLength < 4) {
    throw new Error("SUSP ER entry is truncated");
  }
  const identifierLength = entry.data[0]!;
  const descriptorLength = entry.data[1]!;
  const sourceLength = entry.data[2]!;
  const version = entry.data[3]!;
  const end = 4 + identifierLength + descriptorLength + sourceLength;
  if (end > entry.data.byteLength) {
    throw new Error("SUSP ER entry length fields exceed entry data");
  }
  return {
    identifier: decodeAscii(entry.data.subarray(4, 4 + identifierLength)),
    descriptor: decodeAscii(entry.data.subarray(4 + identifierLength, 4 + identifierLength + descriptorLength)),
    source: decodeAscii(entry.data.subarray(4 + identifierLength + descriptorLength, end)),
    version,
  };
}

function parsePxEntry(entry: SuspEntry): NonNullable<RockRidgeMetadata["posix"]> {
  if (entry.data.byteLength !== 32 && entry.data.byteLength !== 40) {
    throw new Error("RRIP PX entry must be 32 or 40 data bytes");
  }
  const posix: NonNullable<RockRidgeMetadata["posix"]> = {
    mode: readUint32Both(entry.data, 0),
    links: readUint32Both(entry.data, 8),
    uid: readUint32Both(entry.data, 16),
    gid: readUint32Both(entry.data, 24),
  };
  if (entry.data.byteLength >= 40) {
    posix.serial = readUint32Both(entry.data, 32);
  }
  return posix;
}

function parseNmEntry(entry: SuspEntry): string {
  if (entry.data.byteLength < 1) {
    throw new Error("RRIP NM entry is truncated");
  }
  const flags = entry.data[0]!;
  if ((flags & 0x02) !== 0) {
    return ".";
  }
  if ((flags & 0x04) !== 0) {
    return "..";
  }
  return decodeAscii(entry.data.subarray(1));
}

function parseSlEntry(entry: SuspEntry): NonNullable<RockRidgeMetadata["symlink"]> {
  if (entry.data.byteLength < 1) {
    throw new Error("RRIP SL entry is truncated");
  }
  const flags = entry.data[0]!;
  const components: RockRidgeSymlinkComponent[] = [];
  let offset = 1;
  while (offset < entry.data.byteLength) {
    if (entry.data.byteLength - offset < 2) {
      throw new Error("RRIP SL component header is truncated");
    }
    const componentFlags = entry.data[offset]!;
    const componentLength = entry.data[offset + 1]!;
    offset += 2;
    if (offset + componentLength > entry.data.byteLength) {
      throw new Error("RRIP SL component extends beyond entry data");
    }
    const component = symlinkComponent(componentFlags, entry.data.subarray(offset, offset + componentLength));
    components.push(component);
    offset += componentLength;
  }
  const target = symlinkTarget(components);
  return {
    flags,
    components,
    ...(target === undefined ? {} : { target }),
  };
}

function parseTfEntry(entry: SuspEntry): RockRidgeTimestamps {
  if (entry.data.byteLength < 1) {
    throw new Error("RRIP TF entry is truncated");
  }
  const flags = entry.data[0]!;
  const longForm = (flags & TF_LONG_FORM) === TF_LONG_FORM;
  const width = longForm ? 17 : 7;
  let offset = 1;
  const timestamps: RockRidgeTimestamps = {};
  for (const field of timestampFields) {
    if ((flags & field.flag) === 0) {
      continue;
    }
    if (offset + width > entry.data.byteLength) {
      throw new Error("RRIP TF timestamp data is truncated");
    }
    const timestamp = longForm
      ? decodeVolumeDate(entry.data, offset) ?? undefined
      : dateTimeToDate(readDirectoryDateTime(entry.data, offset)!);
    if (timestamp !== undefined) {
      timestamps[field.key] = timestamp;
    }
    offset += width;
  }
  return timestamps;
}

function parsePnEntry(entry: SuspEntry): { major: number; minor: number } {
  if (entry.data.byteLength !== 16) {
    throw new Error("RRIP PN entry must contain 16 data bytes");
  }
  return {
    major: readUint32Both(entry.data, 0),
    minor: readUint32Both(entry.data, 8),
  };
}

function parseSingleBothEndianField(entry: SuspEntry, signature: string): number {
  if (entry.data.byteLength !== 8) {
    throw new Error(`RRIP ${signature} entry must contain 8 data bytes`);
  }
  return readUint32Both(entry.data, 0);
}

function encodeSuspEntry(signature: string, data: Uint8Array): Uint8Array {
  if (!/^[A-Z0-9]{2}$/u.test(signature)) {
    throw new Error(`invalid SUSP signature: ${signature}`);
  }
  const length = SUSP_HEADER_LENGTH + data.byteLength;
  if (length > 0xff) {
    throw new Error(`SUSP ${signature} entry is too long for inline System Use`);
  }
  const bytes = new Uint8Array(length);
  bytes.set(ASCII_ENCODER.encode(signature), 0);
  bytes[2] = length;
  bytes[3] = 1;
  bytes.set(data, SUSP_HEADER_LENGTH);
  return bytes;
}

function encodeSymlinkEntry(target: string, flags: number): Uint8Array {
  const targetBytes = encodeAscii(target, "rockRidge.symlink target");
  if (targetBytes.byteLength > 249) {
    throw new Error("rockRidge.symlink target is too long for inline SL entry");
  }
  const data = new Uint8Array(3 + targetBytes.byteLength);
  data[0] = checkedByte(flags, "rockRidge.symlink.flags");
  data[1] = 0;
  data[2] = targetBytes.byteLength;
  data.set(targetBytes, 3);
  return encodeSuspEntry("SL", data);
}

function encodeErData(input: { identifier: string; descriptor: string; source: string; version: number }): Uint8Array {
  const identifier = encodeAscii(input.identifier, "Rock Ridge ER identifier");
  const descriptor = encodeAscii(input.descriptor, "Rock Ridge ER descriptor");
  const source = encodeAscii(input.source, "Rock Ridge ER source");
  if (identifier.byteLength > 0xff || descriptor.byteLength > 0xff || source.byteLength > 0xff) {
    throw new Error("Rock Ridge ER fields must not exceed 255 bytes");
  }
  const bytes = new Uint8Array(4 + identifier.byteLength + descriptor.byteLength + source.byteLength);
  bytes[0] = identifier.byteLength;
  bytes[1] = descriptor.byteLength;
  bytes[2] = source.byteLength;
  bytes[3] = checkedByte(input.version, "Rock Ridge ER version");
  bytes.set(identifier, 4);
  bytes.set(descriptor, 4 + identifier.byteLength);
  bytes.set(source, 4 + identifier.byteLength + descriptor.byteLength);
  return bytes;
}

function encodeTimestampEntry(timestamps: RockRidgeTimestamps): Uint8Array {
  const selected = timestampFields.filter((field) => timestamps[field.key] !== undefined);
  if (selected.length === 0) {
    return encodeSuspEntry("TF", Uint8Array.of(0));
  }
  const data = new Uint8Array(1 + selected.length * 7);
  let flags = 0;
  let offset = 1;
  for (const field of selected) {
    flags |= field.flag;
    writeDirectoryDateTime(data, offset, dateToDirectoryDateTime(timestamps[field.key]!));
    offset += 7;
  }
  data[0] = flags;
  return encodeSuspEntry("TF", data);
}

const timestampFields: Array<{ flag: number; key: keyof RockRidgeTimestamps }> = [
  { flag: 0x01, key: "createdAt" },
  { flag: 0x02, key: "modifiedAt" },
  { flag: 0x04, key: "accessedAt" },
  { flag: 0x08, key: "attributesAt" },
  { flag: 0x10, key: "backupAt" },
  { flag: 0x20, key: "expiresAt" },
  { flag: 0x40, key: "effectiveAt" },
];

function symlinkComponent(flags: number, contentBytes: Uint8Array): RockRidgeSymlinkComponent {
  const special = symlinkSpecialKind(flags);
  return {
    flags,
    content: special ? "" : decodeAscii(contentBytes),
    ...(special ? { kind: special } : {}),
  };
}

function symlinkSpecialKind(flags: number): RockRidgeSymlinkComponent["kind"] | undefined {
  if ((flags & 0x02) !== 0) {
    return "current";
  }
  if ((flags & 0x04) !== 0) {
    return "parent";
  }
  if ((flags & 0x08) !== 0) {
    return "root";
  }
  if ((flags & 0x10) !== 0) {
    return "volume-root";
  }
  if ((flags & 0x20) !== 0) {
    return "host";
  }
  return undefined;
}

function symlinkTarget(components: RockRidgeSymlinkComponent[]): string | undefined {
  const parts = components.map((component) => {
    switch (component.kind) {
      case "current":
        return ".";
      case "parent":
        return "..";
      case "root":
      case "volume-root":
        return "/";
      case "host":
        return component.content;
      default:
        return component.content;
    }
  });
  if (parts.length === 0) {
    return undefined;
  }
  let target = "";
  for (const part of parts) {
    if (part === "/") {
      target = "/";
      continue;
    }
    if (target !== "" && target !== "/") {
      target += "/";
    }
    target += part;
  }
  return target;
}

function startsWithKnownSuspSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 2) {
    return false;
  }
  return isRockRidgeOrSuspEntry(readAscii(bytes, 0, 2));
}

function isRockRidgeOrSuspEntry(signature: string): boolean {
  return new Set(["SP", "ER", "ST", "PD", "CE", "PX", "NM", "SL", "TF", "PN", "CL", "PL", "RE"]).has(signature);
}

function decodeAscii(bytes: Uint8Array): string {
  for (const byte of bytes) {
    if (byte > 0x7f) {
      throw new Error("Rock Ridge text fields must contain only ASCII bytes");
    }
  }
  return ASCII_DECODER.decode(bytes);
}

function checkedSkipBytes(value: number, length: number): number {
  if (!Number.isInteger(value) || value < 0 || value > length) {
    throw new RangeError("SUSP skipBytes must be an integer within the System Use field");
  }
  return value;
}

function encodeAscii(value: string, label: string): Uint8Array {
  if (!/^[\x00-\x7f]*$/u.test(value)) {
    throw new Error(`${label} must contain only ASCII characters`);
  }
  return ASCII_ENCODER.encode(value);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function checkedUint32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be an integer from 0 to 4294967295`);
  }
  return value;
}

function checkedByte(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be an integer from 0 to 255`);
  }
  return value;
}
