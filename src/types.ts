export const SECTOR_SIZE = 2048;
export const SYSTEM_AREA_SECTORS = 16;
export const STANDARD_IDENTIFIER = "CD001";

export type IsoInputFile = {
  path: string;
  data: Uint8Array | Buffer | string;
  date?: Date;
  extendedAttributeRecord?: Uint8Array | Buffer | string;
  systemUse?: Uint8Array | Buffer | string;
};

export type CreateIsoOptions = {
  volumeIdentifier?: string;
  systemIdentifier?: string;
  volumeSetIdentifier?: string;
  publisherIdentifier?: string;
  dataPreparerIdentifier?: string;
  applicationIdentifier?: string;
  bootRecord?: BootRecordOptions;
  volumePartition?: VolumePartitionOptions;
  volumePartitions?: VolumePartitionOptions[];
  createdAt?: Date;
  modifiedAt?: Date;
  effectiveAt?: Date;
  expiresAt?: Date | null;
};

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
  extendedAttributeRecord?: Uint8Array;
  data?: Uint8Array;
  systemUse?: Uint8Array;
};

export type IsoDirectoryEntry = {
  path: string;
  identifier: string;
  extent: number;
  extendedAttributeRecordLength: number;
  size: number;
  date: Date;
  flags: number;
  children: IsoNode[];
  extendedAttributeRecord?: Uint8Array;
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
  typeMPathTableLocation: number;
  rootDirectoryRecord: IsoDirectoryEntry;
  volumeSetIdentifier: string;
  publisherIdentifier: string;
  dataPreparerIdentifier: string;
  applicationIdentifier: string;
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
  escapeSequences: Uint8Array;
};

export type EnhancedVolumeDescriptor = BaseVolumeDescriptor & {
  type: 2;
  kind: "enhanced";
  version: 2;
  volumeFlags: number;
  systemIdentifier: string;
  volumeIdentifier: string;
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
