export const SECTOR_SIZE = 2048;
export const SYSTEM_AREA_SECTORS = 16;
export const STANDARD_IDENTIFIER = "CD001";

export type IsoInputFile = {
  path: string;
  data: Uint8Array | Buffer | string;
  date?: Date;
};

export type CreateIsoOptions = {
  volumeIdentifier?: string;
  systemIdentifier?: string;
  volumeSetIdentifier?: string;
  publisherIdentifier?: string;
  dataPreparerIdentifier?: string;
  applicationIdentifier?: string;
  createdAt?: Date;
  modifiedAt?: Date;
  effectiveAt?: Date;
  expiresAt?: Date | null;
};

export type IsoFileEntry = {
  path: string;
  identifier: string;
  extent: number;
  size: number;
  date: Date;
  flags: number;
  data?: Uint8Array;
};

export type IsoDirectoryEntry = {
  path: string;
  identifier: string;
  extent: number;
  size: number;
  date: Date;
  flags: number;
  children: IsoNode[];
};

export type IsoNode = IsoFileEntry | IsoDirectoryEntry;

export type VolumeDescriptor = {
  type: number;
  identifier: string;
  version: number;
  offset: number;
};

export type PrimaryVolumeDescriptor = VolumeDescriptor & {
  type: 1;
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

export type IsoImage = {
  primaryVolumeDescriptor: PrimaryVolumeDescriptor;
  files: IsoFileEntry[];
  root: IsoDirectoryEntry;
};

export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
};
