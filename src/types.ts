import type { PathTableRecord } from "./path-table.js";

export const SECTOR_SIZE = 2048;
export const SYSTEM_AREA_SECTORS = 16;
export const STANDARD_IDENTIFIER = "CD001";

export type ByteInput = string | ArrayBuffer | ArrayBufferView;
export type IsoImageInput = ArrayBuffer | ArrayBufferView;

export type IsoInputFile = {
  path: string;
  data: ByteInput;
  version?: number;
  multiExtent?: boolean | IsoInputFileMultiExtentOptions;
  interleave?: IsoInputFileInterleaveOptions;
  date?: Date;
  timeZoneOffsetMinutes?: number;
  hidden?: boolean;
  associated?: boolean;
  extendedAttributeRecord?: ByteInput | ExtendedAttributeRecordInput;
  systemUse?: ByteInput;
};

export type IsoInputFileMultiExtentOptions = {
  sectionSize?: number;
};

export type IsoInputFileInterleaveOptions = {
  fileUnitSize: number;
  interleaveGapSize: number;
};

export type IsoInputDirectory = {
  path: string;
  interleave?: IsoInputFileInterleaveOptions;
  date?: Date;
  timeZoneOffsetMinutes?: number;
  hidden?: boolean;
  extendedAttributeRecord?: ByteInput | ExtendedAttributeRecordInput;
  systemUse?: ByteInput;
};

export type IsoInputExternalFile = {
  path: string;
  version?: number;
  targetVolumeSequenceNumber: number;
  targetExtent: number;
  size?: number;
  extendedAttributeRecordLength?: number;
  fileUnitSize?: number;
  interleaveGapSize?: number;
  date?: Date;
  timeZoneOffsetMinutes?: number;
  hidden?: boolean;
  associated?: boolean;
  systemUse?: ByteInput;
};

export type IsoInputExternalDirectory = {
  path: string;
  targetVolumeSequenceNumber: number;
  targetExtent: number;
  size?: number;
  extendedAttributeRecordLength?: number;
  fileUnitSize?: number;
  interleaveGapSize?: number;
  date?: Date;
  timeZoneOffsetMinutes?: number;
  hidden?: boolean;
  systemUse?: ByteInput;
};

export type ExtendedAttributeRecordInput = {
  ownerIdentification?: number;
  groupIdentification?: number;
  permissions?: number;
  createdAt?: Date;
  modifiedAt?: Date;
  expiresAt?: Date | null;
  effectiveAt?: Date | null;
  timeZoneOffsetMinutes?: number;
  recordFormat?: number;
  recordAttributes?: number;
  recordLength?: number;
  systemIdentifier?: string;
  systemUse?: ByteInput;
  version?: number;
  applicationUse?: ByteInput;
  escapeSequences?: ByteInput;
};

export type ExtendedAttributeRecord = {
  ownerIdentification: number;
  groupIdentification: number;
  permissions: number;
  createdAt: Date;
  modifiedAt: Date;
  expiresAt: Date | null;
  effectiveAt: Date | null;
  recordFormat: number;
  recordAttributes: number;
  recordLength: number;
  systemIdentifier: string;
  systemUse: Uint8Array;
  version: number;
  applicationUse: Uint8Array;
  escapeSequences: Uint8Array;
};

export type CreateIsoOptions = {
  directories?: IsoInputDirectory[];
  externalFiles?: IsoInputExternalFile[];
  externalDirectories?: IsoInputExternalDirectory[];
  identifierLevel?: 1 | 2;
  systemArea?: ByteInput;
  terminatorCount?: number;
  volumeSetSize?: number;
  volumeSequenceNumber?: number;
  volumeIdentifier?: string;
  systemIdentifier?: string;
  volumeSetIdentifier?: string;
  publisherIdentifier?: string;
  dataPreparerIdentifier?: string;
  applicationIdentifier?: string;
  copyrightFileIdentifier?: string;
  abstractFileIdentifier?: string;
  bibliographicFileIdentifier?: string;
  volumeDescriptorApplicationUse?: ByteInput;
  optionalPathTables?: OptionalPathTableCopies;
  bootRecord?: BootRecordOptions;
  bootRecords?: BootRecordOptions[];
  supplementaryVolumeDescriptors?: SupplementaryVolumeDescriptorOptions[];
  enhancedVolumeDescriptors?: EnhancedVolumeDescriptorOptions[];
  volumePartition?: VolumePartitionOptions;
  volumePartitions?: VolumePartitionOptions[];
  timeZoneOffsetMinutes?: number;
  createdAt?: Date;
  modifiedAt?: Date;
  effectiveAt?: Date;
  expiresAt?: Date | null;
};

export type OptionalPathTableCopies = boolean | {
  typeL?: boolean;
  typeM?: boolean;
};

export type SupplementaryVolumeDescriptorOptions = {
  volumeFlags?: number;
  systemIdentifier?: string;
  volumeIdentifier?: string;
  escapeSequences?: ByteInput;
  identifierEncoding?: "primary" | "ucs2-be";
  volumeSetIdentifier?: string;
  publisherIdentifier?: string;
  dataPreparerIdentifier?: string;
  applicationIdentifier?: string;
  copyrightFileIdentifier?: string;
  abstractFileIdentifier?: string;
  bibliographicFileIdentifier?: string;
  volumeDescriptorApplicationUse?: ByteInput;
  optionalPathTables?: OptionalPathTableCopies;
  timeZoneOffsetMinutes?: number;
  createdAt?: Date;
  modifiedAt?: Date;
  effectiveAt?: Date;
  expiresAt?: Date | null;
};

export type EnhancedVolumeDescriptorOptions = SupplementaryVolumeDescriptorOptions;

export type BootRecordOptions = {
  bootSystemIdentifier?: string;
  bootIdentifier?: string;
  bootSystemUse?: ByteInput;
};

export type VolumePartitionOptions = {
  systemIdentifier?: string;
  volumePartitionIdentifier?: string;
  systemUse?: ByteInput;
  data?: ByteInput;
  size?: number;
};

export type IsoFileEntry = {
  path: string;
  identifier: string;
  extent: number;
  extendedAttributeRecordLength: number;
  size: number;
  date: Date | null;
  flags: number;
  fileUnitSize: number;
  interleaveGapSize: number;
  volumeSequenceNumber: number;
  external?: boolean;
  extendedAttributeRecord?: Uint8Array;
  extendedAttributeRecordFields?: ExtendedAttributeRecord;
  data?: Uint8Array;
  systemUse?: Uint8Array;
  sections?: IsoFileSection[];
};

export type IsoFileSection = {
  extent: number;
  extendedAttributeRecordLength: number;
  size: number;
  flags: number;
  fileUnitSize: number;
  interleaveGapSize: number;
  volumeSequenceNumber: number;
  external?: boolean;
};

export type IsoDirectoryEntry = {
  path: string;
  identifier: string;
  extent: number;
  extendedAttributeRecordLength: number;
  size: number;
  date: Date | null;
  flags: number;
  fileUnitSize: number;
  interleaveGapSize: number;
  volumeSequenceNumber: number;
  external?: boolean;
  children: IsoNode[];
  extendedAttributeRecord?: Uint8Array;
  extendedAttributeRecordFields?: ExtendedAttributeRecord;
  systemUse?: Uint8Array;
  sections?: IsoFileSection[];
};

export type IsoNode = IsoFileEntry | IsoDirectoryEntry;

export type BaseVolumeDescriptor = {
  type: number;
  kind: string;
  identifier: string;
  version: number;
  offset: number;
  sector: number;
  raw: Uint8Array;
};

export type BootVolumeDescriptor = BaseVolumeDescriptor & {
  type: 0;
  kind: "boot";
  bootSystemIdentifier: string;
  bootIdentifier: string;
  bootSystemUse: Uint8Array;
  bootCatalog?: IsoBootCatalog;
};

export type IsoBootCatalog = {
  location: number;
  raw: Uint8Array;
  validationEntry: IsoBootCatalogValidationEntry;
  initialEntry: IsoBootCatalogBootEntry;
  entries: IsoBootCatalogEntry[];
};

export type IsoBootCatalogEntry =
  | IsoBootCatalogValidationEntry
  | IsoBootCatalogBootEntry
  | IsoBootCatalogSectionHeaderEntry
  | IsoBootCatalogExtensionEntry
  | IsoBootCatalogUnknownEntry;

export type IsoBootCatalogValidationEntry = {
  kind: "validation";
  headerId: number;
  platformId: number;
  manufacturer: string;
  checksum: number;
  key55: number;
  keyAA: number;
  raw: Uint8Array;
};

export type IsoBootCatalogBootEntry = {
  kind: "initial" | "section";
  bootIndicator: number;
  bootable: boolean;
  mediaType: number;
  loadSegment: number;
  systemType: number;
  sectorCount: number;
  loadRba: number;
  data?: Uint8Array;
  raw: Uint8Array;
};

export type IsoBootCatalogSectionHeaderEntry = {
  kind: "section-header";
  headerIndicator: number;
  moreHeadersFollow: boolean;
  platformId: number;
  sectionEntryCount: number;
  identifier: string;
  raw: Uint8Array;
};

export type IsoBootCatalogExtensionEntry = {
  kind: "extension";
  extensionIndicator: number;
  extensionFollows: boolean;
  selectionCriteria: Uint8Array;
  raw: Uint8Array;
};

export type IsoBootCatalogUnknownEntry = {
  kind: "unknown";
  indicator: number;
  raw: Uint8Array;
};

export type IsoPathTables = {
  typeL: PathTableRecord[];
  typeM: PathTableRecord[];
  optionalTypeL?: PathTableRecord[];
  optionalTypeM?: PathTableRecord[];
};

export type PrimaryVolumeDescriptor = BaseVolumeDescriptor & {
  type: 1;
  kind: "primary";
  systemIdentifier: string;
  volumeIdentifier: string;
  volumeSpaceSize: number;
  volumeSetSize: number;
  volumeSequenceNumber: number;
  logicalBlockSize: number;
  pathTableSize: number;
  typeLPathTableLocation: number;
  optionalTypeLPathTableLocation: number;
  typeMPathTableLocation: number;
  optionalTypeMPathTableLocation: number;
  pathTables?: IsoPathTables;
  rootDirectoryRecord: IsoDirectoryEntry;
  volumeSetIdentifier: string;
  publisherIdentifier: string;
  dataPreparerIdentifier: string;
  applicationIdentifier: string;
  copyrightFileIdentifier: string;
  abstractFileIdentifier: string;
  bibliographicFileIdentifier: string;
  fileStructureVersion: number;
  applicationUse: Uint8Array;
  createdAt: Date | null;
  modifiedAt: Date | null;
  expiresAt: Date | null;
  effectiveAt: Date | null;
};

export type SupplementaryVolumeDescriptor = BaseVolumeDescriptor & {
  type: 2;
  kind: "supplementary";
  version: 1;
  volumeFlags: number;
  systemIdentifier: string;
  volumeIdentifier: string;
  volumeSpaceSize: number;
  volumeSetSize: number;
  volumeSequenceNumber: number;
  logicalBlockSize: number;
  pathTableSize: number;
  typeLPathTableLocation: number;
  optionalTypeLPathTableLocation: number;
  typeMPathTableLocation: number;
  optionalTypeMPathTableLocation: number;
  pathTables?: IsoPathTables;
  rootDirectoryRecord: IsoDirectoryEntry;
  volumeSetIdentifier: string;
  publisherIdentifier: string;
  dataPreparerIdentifier: string;
  applicationIdentifier: string;
  copyrightFileIdentifier: string;
  abstractFileIdentifier: string;
  bibliographicFileIdentifier: string;
  fileStructureVersion: number;
  applicationUse: Uint8Array;
  createdAt: Date | null;
  modifiedAt: Date | null;
  expiresAt: Date | null;
  effectiveAt: Date | null;
  escapeSequences: Uint8Array;
};

export type EnhancedVolumeDescriptor = BaseVolumeDescriptor & {
  type: 2;
  kind: "enhanced";
  version: 2;
  volumeFlags: number;
  systemIdentifier: string;
  volumeIdentifier: string;
  volumeSpaceSize: number;
  volumeSetSize: number;
  volumeSequenceNumber: number;
  logicalBlockSize: number;
  pathTableSize: number;
  typeLPathTableLocation: number;
  optionalTypeLPathTableLocation: number;
  typeMPathTableLocation: number;
  optionalTypeMPathTableLocation: number;
  pathTables?: IsoPathTables;
  rootDirectoryRecord: IsoDirectoryEntry;
  volumeSetIdentifier: string;
  publisherIdentifier: string;
  dataPreparerIdentifier: string;
  applicationIdentifier: string;
  copyrightFileIdentifier: string;
  abstractFileIdentifier: string;
  bibliographicFileIdentifier: string;
  fileStructureVersion: number;
  applicationUse: Uint8Array;
  createdAt: Date | null;
  modifiedAt: Date | null;
  expiresAt: Date | null;
  effectiveAt: Date | null;
  escapeSequences: Uint8Array;
};

export type VolumePartitionDescriptor = BaseVolumeDescriptor & {
  type: 3;
  kind: "partition";
  systemIdentifier: string;
  volumePartitionIdentifier: string;
  volumePartitionLocation: number;
  volumePartitionSize: number;
  systemUse: Uint8Array;
  data?: Uint8Array;
};

export type VolumeDescriptorSetTerminator = BaseVolumeDescriptor & {
  type: 255;
  kind: "terminator";
};

export type UnknownVolumeDescriptor = BaseVolumeDescriptor & {
  kind: "unknown";
};

export type VolumeDescriptor =
  | BootVolumeDescriptor
  | PrimaryVolumeDescriptor
  | SupplementaryVolumeDescriptor
  | EnhancedVolumeDescriptor
  | VolumePartitionDescriptor
  | VolumeDescriptorSetTerminator
  | UnknownVolumeDescriptor;

export type IsoImage = {
  systemArea: Uint8Array;
  descriptors: VolumeDescriptor[];
  primaryVolumeDescriptor: PrimaryVolumeDescriptor;
  files: IsoFileEntry[];
  root: IsoDirectoryEntry;
};

export type IsoVolumeSet = {
  images: IsoImage[];
  files: IsoFileEntry[];
};

export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
};
