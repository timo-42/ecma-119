import { readAsciiTrimmed, readUint16LE, readUint32LE, sectorOffset } from "./binary.js";
import { SECTOR_SIZE, type IsoBootCatalog, type IsoBootCatalogBootEntry, type IsoBootCatalogEntry, type IsoBootCatalogExtensionEntry, type IsoBootCatalogSectionHeaderEntry, type IsoBootCatalogUnknownEntry, type IsoBootCatalogValidationEntry, type ValidationIssue } from "./types.js";

export const EL_TORITO_BOOT_SYSTEM_IDENTIFIER = "EL TORITO SPECIFICATION";

const BOOT_CATALOG_ENTRY_SIZE = 0x20;
const BOOT_CATALOG_ENTRIES_PER_SECTOR = SECTOR_SIZE / BOOT_CATALOG_ENTRY_SIZE;

export function parseElToritoBootCatalog(image: Uint8Array, location: number): IsoBootCatalog {
  const issues = validateElToritoBootCatalog(image, location);
  if (issues.length > 0) {
    throw new Error(issues[0]!.message);
  }
  const raw = bootCatalogSector(image, location);
  const entries = parseBootCatalogEntries(raw);
  return {
    location,
    raw,
    validationEntry: parseValidationEntry(raw.subarray(0, BOOT_CATALOG_ENTRY_SIZE)),
    initialEntry: parseBootEntry(raw.subarray(BOOT_CATALOG_ENTRY_SIZE, BOOT_CATALOG_ENTRY_SIZE * 2), "initial"),
    entries,
  };
}

export function validateElToritoBootCatalog(image: Uint8Array, location: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Number.isInteger(location) || location < 0 || sectorOffset(location + 1) > image.byteLength) {
    return [{
      code: "boot.catalog.location",
      message: `El Torito boot catalog location ${location} is out of bounds`,
    }];
  }

  const raw = bootCatalogSector(image, location);
  const validation = raw.subarray(0, BOOT_CATALOG_ENTRY_SIZE);
  if (validation[0] !== 0x01) {
    issues.push({ code: "boot.catalog.validation.header_id", message: "El Torito boot catalog validation entry header ID must be 1" });
  }
  if (readUint16LE(validation, 2) !== 0) {
    issues.push({ code: "boot.catalog.validation.reserved", message: "El Torito boot catalog validation entry reserved word must be zero" });
  }
  if (validation[30] !== 0x55 || validation[31] !== 0xaa) {
    issues.push({ code: "boot.catalog.validation.key", message: "El Torito boot catalog validation entry key bytes must be 55 AA" });
  }
  if (bootCatalogValidationChecksum(validation) !== 0) {
    issues.push({ code: "boot.catalog.validation.checksum", message: "El Torito boot catalog validation entry checksum must sum to zero" });
  }

  const initial = raw.subarray(BOOT_CATALOG_ENTRY_SIZE, BOOT_CATALOG_ENTRY_SIZE * 2);
  if (initial[0] !== 0x00 && initial[0] !== 0x88) {
    issues.push({ code: "boot.catalog.initial.boot_indicator", message: "El Torito initial/default entry boot indicator must be 00 or 88" });
  }
  if ((initial[1]! & 0xf0) !== 0 || (initial[1]! & 0x0f) > 4) {
    issues.push({ code: "boot.catalog.initial.media_type", message: "El Torito initial/default entry media type must be 0 through 4 with reserved bits zero" });
  }
  if (initial[5] !== 0) {
    issues.push({ code: "boot.catalog.initial.unused", message: "El Torito initial/default entry unused byte must be zero" });
  }
  if (!allZero(initial.subarray(12))) {
    issues.push({ code: "boot.catalog.initial.unused", message: "El Torito initial/default entry trailing unused bytes must be zero" });
  }
  return issues;
}

function bootCatalogSector(image: Uint8Array, location: number): Uint8Array {
  const offset = sectorOffset(location);
  return image.slice(offset, offset + SECTOR_SIZE);
}

function parseBootCatalogEntries(raw: Uint8Array): IsoBootCatalogEntry[] {
  const entries: IsoBootCatalogEntry[] = [parseValidationEntry(raw.subarray(0, BOOT_CATALOG_ENTRY_SIZE))];
  entries.push(parseBootEntry(raw.subarray(BOOT_CATALOG_ENTRY_SIZE, BOOT_CATALOG_ENTRY_SIZE * 2), "initial"));

  for (let index = 2; index < BOOT_CATALOG_ENTRIES_PER_SECTOR; index += 1) {
    const entry = raw.subarray(index * BOOT_CATALOG_ENTRY_SIZE, (index + 1) * BOOT_CATALOG_ENTRY_SIZE);
    if (allZero(entry)) {
      break;
    }
    entries.push(parseBootCatalogEntry(entry));
  }
  return entries;
}

function parseBootCatalogEntry(entry: Uint8Array): IsoBootCatalogEntry {
  if (entry[0] === 0x90 || entry[0] === 0x91) {
    return parseSectionHeaderEntry(entry);
  }
  if (entry[0] === 0x44) {
    return parseExtensionEntry(entry);
  }
  if (entry[0] === 0x00 || entry[0] === 0x88) {
    return parseBootEntry(entry, "section");
  }
  return parseUnknownEntry(entry);
}

function parseValidationEntry(entry: Uint8Array): IsoBootCatalogValidationEntry {
  return {
    kind: "validation",
    headerId: entry[0]!,
    platformId: entry[1]!,
    manufacturer: readAsciiTrimmed(entry, 4, 24),
    checksum: readUint16LE(entry, 28),
    key55: entry[30]!,
    keyAA: entry[31]!,
    raw: entry.slice(),
  };
}

function parseBootEntry(entry: Uint8Array, kind: IsoBootCatalogBootEntry["kind"]): IsoBootCatalogBootEntry {
  return {
    kind,
    bootIndicator: entry[0]!,
    bootable: entry[0] === 0x88,
    mediaType: entry[1]! & 0x0f,
    loadSegment: readUint16LE(entry, 2),
    systemType: entry[4]!,
    sectorCount: readUint16LE(entry, 6),
    loadRba: readUint32LE(entry, 8),
    raw: entry.slice(),
  };
}

function parseSectionHeaderEntry(entry: Uint8Array): IsoBootCatalogSectionHeaderEntry {
  return {
    kind: "section-header",
    headerIndicator: entry[0]!,
    moreHeadersFollow: entry[0] === 0x90,
    platformId: entry[1]!,
    sectionEntryCount: readUint16LE(entry, 2),
    identifier: readAsciiTrimmed(entry, 4, 28),
    raw: entry.slice(),
  };
}

function parseExtensionEntry(entry: Uint8Array): IsoBootCatalogExtensionEntry {
  return {
    kind: "extension",
    extensionIndicator: entry[0]!,
    extensionFollows: (entry[1]! & 0x20) !== 0,
    selectionCriteria: entry.slice(2),
    raw: entry.slice(),
  };
}

function parseUnknownEntry(entry: Uint8Array): IsoBootCatalogUnknownEntry {
  return {
    kind: "unknown",
    indicator: entry[0]!,
    raw: entry.slice(),
  };
}

function bootCatalogValidationChecksum(entry: Uint8Array): number {
  let sum = 0;
  for (let offset = 0; offset < BOOT_CATALOG_ENTRY_SIZE; offset += 2) {
    sum = (sum + readUint16LE(entry, offset)) & 0xffff;
  }
  return sum;
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}
