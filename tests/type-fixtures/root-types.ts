import {
  createIsoImage,
  parseIsoImage,
  parseVolumeDescriptors,
  validateIsoImage,
  type BootRecordOptions,
  type ByteInput,
  type CreateIsoOptions,
  type EnhancedVolumeDescriptor,
  type ExtendedAttributeRecordInput,
  type IsoDirectoryEntry,
  type IsoFileEntry,
  type IsoImage,
  type IsoImageInput,
  type IsoInputDirectory,
  type IsoInputFile,
  type IsoNode,
  type PrimaryVolumeDescriptor,
  type SupplementaryVolumeDescriptor,
  type ValidationIssue,
  type VolumeDescriptor,
  type VolumePartitionDescriptor,
} from "../../dist/index.js";

const byteInput: ByteInput = new DataView(new ArrayBuffer(4));
const imageInput: IsoImageInput = new Uint8Array(2048 * 18).buffer;

const file: IsoInputFile = {
  path: "README.TXT",
  data: byteInput,
  version: 2,
  multiExtent: { sectionSize: 2048 },
  interleave: { fileUnitSize: 1, interleaveGapSize: 0 },
  extendedAttributeRecord: {
    systemIdentifier: "FIXTURE",
    applicationUse: byteInput,
  } satisfies ExtendedAttributeRecordInput,
  systemUse: byteInput,
};

const directory: IsoInputDirectory = {
  path: "DIR",
  hidden: true,
  extendedAttributeRecord: byteInput,
  systemUse: byteInput,
};

const options: CreateIsoOptions = {
  directories: [directory],
  systemArea: byteInput,
  bootRecord: {
    bootSystemIdentifier: "BOOT",
    bootSystemUse: byteInput,
  } satisfies BootRecordOptions,
  volumePartition: {
    volumePartitionIdentifier: "PART",
    data: byteInput,
  },
  supplementaryVolumeDescriptors: [{
    volumeIdentifier: "SUPP",
    escapeSequences: Uint8Array.of(0x25, 0x2f, 0x40),
  }],
  enhancedVolumeDescriptors: [{
    volumeIdentifier: "ENH",
    escapeSequences: Uint8Array.of(0x25, 0x2f, 0x45),
  }],
};

const image = createIsoImage([file], options);
const parsed: IsoImage = parseIsoImage(image);
const parsedFromView: IsoImage = parseIsoImage(imageInput, { includeData: false });
const descriptors: VolumeDescriptor[] = parseVolumeDescriptors(image);
const issues: ValidationIssue[] = validateIsoImage(image);

const primary: PrimaryVolumeDescriptor = parsed.primaryVolumeDescriptor;
const node: IsoNode | undefined = parsed.root.children[0];
const entryPath: string | undefined = node?.path;
const fileEntry: IsoFileEntry | undefined = parsed.files[0];
const directoryEntry: IsoDirectoryEntry = parsed.root;
const supplementary: SupplementaryVolumeDescriptor | undefined = parsed.descriptors.find(
  (descriptor): descriptor is SupplementaryVolumeDescriptor => descriptor.kind === "supplementary",
);
const enhanced: EnhancedVolumeDescriptor | undefined = parsed.descriptors.find(
  (descriptor): descriptor is EnhancedVolumeDescriptor => descriptor.kind === "enhanced",
);
const partition: VolumePartitionDescriptor | undefined = parsed.descriptors.find(
  (descriptor): descriptor is VolumePartitionDescriptor => descriptor.kind === "partition",
);

void descriptors;
void directoryEntry;
void enhanced;
void entryPath;
void fileEntry;
void issues;
void parsedFromView;
void partition;
void primary;
void supplementary;
