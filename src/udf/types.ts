import type { ByteInput } from "../types.js";
import type { UdfDescriptorTag } from "../udf-tag.js";

export const UDF_LOGICAL_BLOCK_SIZE = 2048;

export type UdfImageInput = ArrayBuffer | ArrayBufferView;

export type UdfRevision = "1.02" | "1.50" | "2.00" | "2.01" | "2.50" | "2.60";

export type UdfInputFile = {
  path: string;
  data: ByteInput;
  createdAt?: Date;
  modifiedAt?: Date;
  accessedAt?: Date;
  attributesAt?: Date;
  uid?: number;
  gid?: number;
  permissions?: number;
};

export type UdfInputDirectory = Omit<UdfInputFile, "data">;

export type CreateUdfOptions = {
  revision?: UdfRevision;
  directories?: UdfInputDirectory[];
  logicalBlockSize?: number;
  volumeIdentifier?: string;
  volumeSetIdentifier?: string;
  fileSetIdentifier?: string;
  applicationIdentifier?: string;
  implementationIdentifier?: string;
  createdAt?: Date;
  modifiedAt?: Date;
};

export type ParseUdfOptions = {
  includeData?: boolean;
  primaryVolumeDescriptorIndex?: number;
  logicalVolumeDescriptorIndex?: number;
  fileSetDescriptorIndex?: number;
};

export type UdfVolumeStructure = {
  sector: number;
  structureType: number;
  identifier: string;
  version: number;
  raw: Uint8Array;
};

export type UdfDescriptorBase = {
  tag: UdfDescriptorTag;
  sector: number;
  raw: Uint8Array;
};

export type UdfPrimaryVolumeDescriptor = UdfDescriptorBase & {
  kind: "primary-volume";
  volumeDescriptorSequenceNumber: number;
  primaryVolumeDescriptorNumber: number;
  volumeIdentifier: string;
  volumeSequenceNumber: number;
  maximumVolumeSequenceNumber: number;
  volumeSetIdentifier: string;
};

export type UdfPartitionDescriptor = UdfDescriptorBase & {
  kind: "partition";
  volumeDescriptorSequenceNumber: number;
  partitionNumber: number;
  accessType: number;
  startLocation: number;
  length: number;
};

export type UdfLogicalVolumeDescriptor = UdfDescriptorBase & {
  kind: "logical-volume";
  volumeDescriptorSequenceNumber: number;
  logicalVolumeIdentifier: string;
  logicalBlockSize: number;
  fileSetDescriptorLocation: UdfLongAllocationDescriptor;
  partitionMaps: UdfPartitionMap[];
};

export type UdfTerminatingDescriptor = UdfDescriptorBase & {
  kind: "terminating";
};

export type UdfUnknownDescriptor = UdfDescriptorBase & {
  kind: "unknown";
};

export type UdfDescriptor =
  | UdfPrimaryVolumeDescriptor
  | UdfPartitionDescriptor
  | UdfLogicalVolumeDescriptor
  | UdfTerminatingDescriptor
  | UdfUnknownDescriptor;

export type UdfPartitionMap = {
  type: number;
  length: number;
  volumeSequenceNumber?: number;
  partitionNumber?: number;
  raw: Uint8Array;
};

export type UdfLongAllocationDescriptor = {
  length: number;
  location: number;
  partitionReferenceNumber: number;
  implementationUse: Uint8Array;
};

export type UdfShortAllocationDescriptor = {
  length: number;
  location: number;
};

export type UdfFileSetDescriptor = UdfDescriptorBase & {
  kind: "file-set";
  fileSetNumber: number;
  fileSetDescriptorNumber: number;
  logicalVolumeIdentifier: string;
  fileSetIdentifier: string;
  rootDirectoryIcb: UdfLongAllocationDescriptor;
};

export type UdfFileEntryDescriptor = UdfDescriptorBase & {
  kind: "file-entry";
  fileType: number;
  informationLength: bigint;
  logicalBlocksRecorded: bigint;
  uid: number;
  gid: number;
  permissions: number;
  linkCount: number;
  allocationDescriptors: UdfShortAllocationDescriptor[];
};

export type UdfFileEntry = {
  kind: "file";
  name: string;
  path: string;
  size: number;
  data?: Uint8Array;
  descriptor: UdfFileEntryDescriptor;
};

export type UdfDirectoryEntry = {
  kind: "directory";
  name: string;
  path: string;
  descriptor: UdfFileEntryDescriptor;
  children: UdfNode[];
};

export type UdfNode = UdfFileEntry | UdfDirectoryEntry;

export type UdfPartition = UdfPartitionDescriptor & {
  mapIndex: number;
};

export type UdfImage = {
  volumeStructures: UdfVolumeStructure[];
  descriptors: UdfDescriptor[];
  primaryVolumeDescriptors: UdfPrimaryVolumeDescriptor[];
  primaryVolumeDescriptorIndex: number;
  primaryVolumeDescriptor: UdfPrimaryVolumeDescriptor;
  logicalVolumeDescriptors: UdfLogicalVolumeDescriptor[];
  logicalVolumeDescriptorIndex: number;
  logicalVolumeDescriptor: UdfLogicalVolumeDescriptor;
  fileSetDescriptors: UdfFileSetDescriptor[];
  fileSetDescriptorIndex: number;
  fileSetDescriptor: UdfFileSetDescriptor;
  partitions: UdfPartition[];
  root: UdfDirectoryEntry;
  files: UdfFileEntry[];
};

export type UdfVolumeSet = {
  images: UdfImage[];
  files: UdfFileEntry[];
};

export type UdfValidationIssue = {
  code: string;
  message: string;
  path?: string;
};
