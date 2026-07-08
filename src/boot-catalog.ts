import { isAscii, readAsciiTrimmed, readUint16LE, readUint32LE, sectorOffset, writeAsciiPadded, writeUint16LE, writeUint32LE } from "./binary.js";
import { SECTOR_SIZE, type IsoBootCatalog, type IsoBootCatalogBootEntry, type IsoBootCatalogEntry, type IsoBootCatalogExtensionEntry, type IsoBootCatalogSectionHeaderEntry, type IsoBootCatalogUnknownEntry, type IsoBootCatalogValidationEntry, type ValidationIssue } from "./types.js";

export const EL_TORITO_BOOT_SYSTEM_IDENTIFIER = "EL TORITO SPECIFICATION";

export const BOOT_CATALOG_ENTRY_SIZE = 0x20;
export const BOOT_CATALOG_ENTRIES_PER_SECTOR = SECTOR_SIZE / BOOT_CATALOG_ENTRY_SIZE;
export const EL_TORITO_LOAD_SECTOR_SIZE = 512;

export type ElToritoCatalogInput = {
  platformId: number;
  manufacturer: string;
  initialEntry: ElToritoCatalogBootEntryInput;
  sections: ElToritoCatalogSectionInput[];
};

export type ElToritoCatalogSectionInput = {
  platformId: number;
  identifier: string;
  entries: ElToritoCatalogSectionEntryInput[];
};

export type ElToritoCatalogBootEntryInput = {
  bootable: boolean;
  mediaType: number;
  loadSegment: number;
  systemType: number;
  loadSectorCount: number;
  loadRba: number;
};

export type ElToritoCatalogSectionEntryInput = ElToritoCatalogBootEntryInput & {
  extensions: ElToritoCatalogExtensionEntryInput[];
};

export type ElToritoCatalogExtensionEntryInput = {
  selectionCriteria: Uint8Array;
  extensionFollows?: boolean;
};

export function encodeElToritoBootCatalog(input: ElToritoCatalogInput): Uint8Array {
  assertCatalogFitsInOneSector(input);
  const bytes = new Uint8Array(SECTOR_SIZE);
  encodeValidationEntry(bytes.subarray(0, BOOT_CATALOG_ENTRY_SIZE), input);
  encodeBootEntry(bytes.subarray(BOOT_CATALOG_ENTRY_SIZE, BOOT_CATALOG_ENTRY_SIZE * 2), input.initialEntry);

  let entryIndex = 2;
  for (const [sectionIndex, section] of input.sections.entries()) {
    encodeSectionHeaderEntry(
      bytes.subarray(entryIndex * BOOT_CATALOG_ENTRY_SIZE, (entryIndex + 1) * BOOT_CATALOG_ENTRY_SIZE),
      section,
      sectionIndex < input.sections.length - 1,
    );
    entryIndex += 1;
    for (const entry of section.entries) {
      encodeBootEntry(bytes.subarray(entryIndex * BOOT_CATALOG_ENTRY_SIZE, (entryIndex + 1) * BOOT_CATALOG_ENTRY_SIZE), entry);
      entryIndex += 1;
      for (const [extensionIndex, extension] of entry.extensions.entries()) {
        encodeExtensionEntry(
          bytes.subarray(entryIndex * BOOT_CATALOG_ENTRY_SIZE, (entryIndex + 1) * BOOT_CATALOG_ENTRY_SIZE),
          extension,
          extension.extensionFollows ?? extensionIndex < entry.extensions.length - 1,
        );
        entryIndex += 1;
      }
    }
  }
  return bytes;
}

function encodeValidationEntry(entry: Uint8Array, input: ElToritoCatalogInput): void {
  entry[0] = 0x01;
  entry[1] = input.platformId;
  if (!isAscii(input.manufacturer)) {
    throw new Error("El Torito manufacturer must contain only ASCII characters");
  }
  writeAsciiPadded(entry, 4, 24, input.manufacturer, 0x00);
  entry[30] = 0x55;
  entry[31] = 0xaa;
  writeUint16LE(entry, 28, checksumWordForValidationEntry(entry));
}

function encodeBootEntry(entry: Uint8Array, input: ElToritoCatalogBootEntryInput): void {
  entry[0] = input.bootable ? 0x88 : 0x00;
  entry[1] = input.mediaType;
  writeUint16LE(entry, 2, input.loadSegment);
  entry[4] = input.systemType;
  writeUint16LE(entry, 6, input.loadSectorCount);
  writeUint32LE(entry, 8, input.loadRba);
}

function encodeSectionHeaderEntry(entry: Uint8Array, input: ElToritoCatalogSectionInput, moreHeadersFollow: boolean): void {
  entry[0] = moreHeadersFollow ? 0x90 : 0x91;
  entry[1] = input.platformId;
  writeUint16LE(entry, 2, sectionCatalogEntryCount(input));
  if (!isAscii(input.identifier)) {
    throw new Error("El Torito section identifier must contain only ASCII characters");
  }
  writeAsciiPadded(entry, 4, 28, input.identifier, 0x00);
}

function encodeExtensionEntry(entry: Uint8Array, input: ElToritoCatalogExtensionEntryInput, extensionFollows: boolean): void {
  if (input.selectionCriteria.byteLength > 30) {
    throw new Error("El Torito extension selection criteria exceeds 30 bytes");
  }
  entry[0] = 0x44;
  entry[1] = extensionFollows ? 0x20 : 0x00;
  entry.set(input.selectionCriteria, 2);
}

function assertCatalogFitsInOneSector(input: ElToritoCatalogInput): void {
  const count = bootCatalogEntryCount(input);
  if (count > BOOT_CATALOG_ENTRIES_PER_SECTOR) {
    throw new Error(`El Torito boot catalog requires ${count} entries; maximum is ${BOOT_CATALOG_ENTRIES_PER_SECTOR}`);
  }
}

function bootCatalogEntryCount(input: ElToritoCatalogInput): number {
  return 2 + input.sections.reduce((sum, section) => sum + 1 + sectionCatalogEntryCount(section), 0);
}

function sectionCatalogEntryCount(input: ElToritoCatalogSectionInput): number {
  return input.entries.reduce((sum, entry) => sum + 1 + entry.extensions.length, 0);
}

function checksumWordForValidationEntry(entry: Uint8Array): number {
  let sum = 0;
  for (let offset = 0; offset < BOOT_CATALOG_ENTRY_SIZE; offset += 2) {
    if (offset === 28) {
      continue;
    }
    sum = (sum + readUint16LE(entry, offset)) & 0xffff;
  }
  return (0x10000 - sum) & 0xffff;
}

export function parseElToritoBootCatalog(image: Uint8Array, location: number, options: { includeData?: boolean } = {}): IsoBootCatalog {
  const issues = validateElToritoBootCatalog(image, location);
  if (issues.length > 0) {
    throw new Error(issues[0]!.message);
  }
  const raw = bootCatalogSector(image, location);
  const entries = parseBootCatalogEntries(raw, image, options.includeData ?? false);
  const validationEntry = entries[0];
  const initialEntry = entries[1];
  if (!validationEntry || validationEntry.kind !== "validation") {
    throw new Error("El Torito boot catalog is missing the validation entry");
  }
  if (!initialEntry || initialEntry.kind !== "initial") {
    throw new Error("El Torito boot catalog is missing the initial/default entry");
  }
  return {
    location,
    raw,
    validationEntry,
    initialEntry,
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
  for (const [index, entry] of parseBootCatalogEntries(raw, image, false).entries()) {
    if (entry.kind === "initial" || entry.kind === "section") {
      issues.push(...validateBootImageExtent(image, entry, bootEntryLabel(entry, index)));
    }
  }
  return issues;
}

function bootCatalogSector(image: Uint8Array, location: number): Uint8Array {
  const offset = sectorOffset(location);
  return image.slice(offset, offset + SECTOR_SIZE);
}

function parseBootCatalogEntries(raw: Uint8Array, image: Uint8Array, includeImages: boolean): IsoBootCatalogEntry[] {
  const entries: IsoBootCatalogEntry[] = [parseValidationEntry(raw.subarray(0, BOOT_CATALOG_ENTRY_SIZE))];
  entries.push(parseBootEntry(raw.subarray(BOOT_CATALOG_ENTRY_SIZE, BOOT_CATALOG_ENTRY_SIZE * 2), "initial", image, includeImages));

  for (let index = 2; index < BOOT_CATALOG_ENTRIES_PER_SECTOR; index += 1) {
    const entry = raw.subarray(index * BOOT_CATALOG_ENTRY_SIZE, (index + 1) * BOOT_CATALOG_ENTRY_SIZE);
    if (allZero(entry)) {
      break;
    }
    entries.push(parseBootCatalogEntry(entry, image, includeImages));
  }
  return entries;
}

function parseBootCatalogEntry(entry: Uint8Array, image: Uint8Array, includeImages: boolean): IsoBootCatalogEntry {
  if (entry[0] === 0x90 || entry[0] === 0x91) {
    return parseSectionHeaderEntry(entry);
  }
  if (entry[0] === 0x44) {
    return parseExtensionEntry(entry);
  }
  if (entry[0] === 0x00 || entry[0] === 0x88) {
    return parseBootEntry(entry, "section", image, includeImages);
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

function parseBootEntry(entry: Uint8Array, kind: IsoBootCatalogBootEntry["kind"], image?: Uint8Array, includeImage = false): IsoBootCatalogBootEntry {
  const bootEntry: IsoBootCatalogBootEntry = {
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
  if (includeImage && image && bootEntry.sectorCount > 0) {
    bootEntry.data = readBootImage(image, bootEntry);
  }
  return bootEntry;
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

function validateBootImageExtent(image: Uint8Array, entry: IsoBootCatalogBootEntry, label: string): ValidationIssue[] {
  if (entry.sectorCount === 0) {
    return [];
  }
  if (entry.loadRba < 0 || sectorOffset(entry.loadRba) + entry.sectorCount * EL_TORITO_LOAD_SECTOR_SIZE > image.byteLength) {
    return [{
      code: `boot.catalog.${label}.image_bounds`,
      message: `El Torito ${label} boot image extent ${entry.loadRba}+${entry.sectorCount} is out of bounds`,
    }];
  }
  return [];
}

function bootEntryLabel(entry: IsoBootCatalogBootEntry, index: number): string {
  return entry.kind === "initial" ? "initial" : `entry_${index}`;
}

function readBootImage(image: Uint8Array, entry: IsoBootCatalogBootEntry): Uint8Array {
  const start = sectorOffset(entry.loadRba);
  const end = start + entry.sectorCount * EL_TORITO_LOAD_SECTOR_SIZE;
  return image.slice(start, end);
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}
