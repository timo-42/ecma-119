export const SECTOR_SIZE = 2048;
export const SYSTEM_AREA_SECTORS = 16;
export const STANDARD_IDENTIFIER = "CD001";

export type IsoInputFile = {
  path: string;
  data: Uint8Array | Buffer | string;
  multiExtent?: boolean | IsoInputFileMultiExtentOptions;
  interleave?: IsoInputFileInterleaveOptions;
  date?: Date;
  timeZoneOffsetMinutes?: number;
  hidden?: boolean;
  associated?: boolean;
  extendedAttributeRecord?: Uint8Array | Buffer | string | ExtendedAttributeRecordInput;
  systemUse?: Uint8Array | Buffer | string;
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
  date?: Date;
  timeZoneOffsetMinutes?: number;
  hidden?: boolean;
  associated?: boolean;
  extendedAttributeRecord?: Uint8Array | Buffer | string | ExtendedAttributeRecordInput;
  systemUse?: Uint8Array | Buffer | string;
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
  systemUse?: Uint8Array | Buffer | string;
  version?: number;
  applicationUse?: Uint8Array | Buffer | string;
  escapeSequences?: Uint8Array | Buffer | string;
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
  identifierLevel?: 1 | 2;
  systemArea?: Uint8Array | Buffer | string;
  volumeIdentifier?: string;
  systemIdentifier?: string;
  volumeSetIdentifier?: string;
  publisherIdentifier?: string;
  dataPreparerIdentifier?: string;
  applicationIdentifier?: string;
  copyrightFileIdentifier?: string;
  abstractFileIdentifier?: string;
  bibliographicFileIdentifier?: string;
  volumeDescriptorApplicationUse?: Uint8Array | Buffer | string;
  optionalPathTables?: OptionalPathTableCopies;
  bootRecord?: BootRecordOptions;
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
  escapeSequences?: Uint8Array | Buffer | string;
  volumeSetIdentifier?: string;
  publisherIdentifier?: string;
  dataPreparerIdentifier?: string;
  applicationIdentifier?: string;
  copyrightFileIdentifier?: string;
  abstractFileIdentifier?: string;
  bibliographicFileIdentifier?: string;
  volumeDescriptorApplicationUse?: Uint8Array | Buffer | string;
  optionalPathTables?: OptionalPathTableCopies;
};

export type EnhancedVolumeDescriptorOptions = SupplementaryVolumeDescriptorOptions;

export type BootRecordOptions = {
  bootSystemIdentifier?: string;
  bootIdentifier?: string;
  bootSystemUse?: Uint8Array | Buffer | string;
};

export type VolumePartitionOptions = {
  systemIdentifier?: string;
  volumePartitionIdentifier?: string;
  systemUse?: Uint8Array | Buffer | string;
  data?: Uint8Array | Buffer | string;
  size?: number;
};

export type IsoFileEntry = {
  path: string;
  identifier: string;
  extent: number;
  extendedAttributeRecordLength: number;
  size: number;
  date: Date;
  flags: number;
  fileUnitSize: number;
  interleaveGapSize: number;
  volumeSequenceNumber: number;
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
};

export type IsoDirectoryEntry = {
  path: string;
  identifier: string;
  extent: number;
  extendedAttributeRecordLength: number;
  size: number;
  date: Date;
  flags: number;
  fileUnitSize: number;
  interleaveGapSize: number;
  volumeSequenceNumber: number;
  children: IsoNode[];
  extendedAttributeRecord?: Uint8Array;
  extendedAttributeRecordFields?: ExtendedAttributeRecord;
  systemUse?: Uint8Array;
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

export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
};
