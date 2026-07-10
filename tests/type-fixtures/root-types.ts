import {
  createIsoImage,
  parseIsoImage,
  parseIsoVolumeSet,
  parseVolumeDescriptors,
  validateIsoImage,
  type BootRecordOptions,
  type ByteInput,
  type CreateIsoOptions,
  type ElToritoBootEntryOptions,
  type ElToritoOptions,
  type EnhancedVolumeDescriptor,
  type ExtendedAttributeRecordInput,
  type IsoExtensionList,
  type IsoExtensionName,
  type IsoExtensionOptions,
  type IsoProfile,
  type IsoBootCatalog,
  type IsoBootCatalogEntry,
  type IsoDirectoryEntry,
  type IsoFileEntry,
  type IsoImage,
  type IsoImageInput,
  type IsoInputDirectory,
  type IsoInputExternalDirectory,
  type IsoInputExternalFile,
  type IsoInputFile,
  type IsoNode,
  type IsoVolumeSet,
  type JolietOptions,
  type PrimaryVolumeDescriptor,
  type ParseIsoOptions,
  type RockRidgeInput,
  type RockRidgeMetadata,
  type SuspEntry,
  type SupplementaryVolumeDescriptor,
  type ValidationIssue,
  type VolumeDescriptor,
  type VolumePartitionDescriptor,
} from "../../dist/index.js";

const byteInput: ByteInput = new DataView(new ArrayBuffer(4));
const imageInput: IsoImageInput = new Uint8Array(2048 * 18).buffer;
const profile: IsoProfile = "ecma-119";
const extensionName: IsoExtensionName = "joliet";
const extensionList: IsoExtensionList = ["joliet"];
const jolietOptions: JolietOptions = {
  level: 3,
  descriptor: {
    volumeIdentifier: "JOLIET",
  },
};
const elToritoBootEntry: ElToritoBootEntryOptions = {
  data: byteInput,
  mediaType: "no-emulation",
  loadSegment: 0x7c0,
};
const elToritoOptions: ElToritoOptions = {
  platform: "x86",
  manufacturer: "FIXTURE",
  initial: elToritoBootEntry,
};
const extensionOptions: IsoExtensionOptions = {
  joliet: jolietOptions,
  elTorito: elToritoOptions,
};
const rockRidgeInput: RockRidgeInput = {
  name: "readme.txt",
  mode: 0o100644,
  timestamps: {
    modifiedAt: new Date("2024-01-01T00:00:00Z"),
  },
};

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
  rockRidge: rockRidgeInput,
};

const directory: IsoInputDirectory = {
  path: "DIR",
  interleave: { fileUnitSize: 1, interleaveGapSize: 0 },
  hidden: true,
  extendedAttributeRecord: byteInput,
  systemUse: byteInput,
};

const multiExtentDirectory: IsoInputDirectory = {
  path: "MULTI_DIR",
  // @ts-expect-error directory inputs do not support multi-extent authoring
  multiExtent: { sectionSize: 2048 },
};

const associatedDirectory: IsoInputDirectory = {
  path: "ASSOC_DIR",
  // @ts-expect-error directory inputs do not support the Associated File bit
  associated: true,
};

const externalFile: IsoInputExternalFile = {
  path: "REMOTE.TXT",
  targetVolumeSequenceNumber: 2,
  targetExtent: 20,
  size: 4,
  version: 1,
  hidden: true,
  associated: true,
  systemUse: byteInput,
};

const externalDirectory: IsoInputExternalDirectory = {
  path: "REMOTE_DIR",
  targetVolumeSequenceNumber: 2,
  targetExtent: 21,
  size: 2048,
  hidden: true,
  systemUse: byteInput,
};

const options: CreateIsoOptions = {
  profile,
  extensions: extensionOptions,
  directories: [directory],
  externalFiles: [externalFile],
  volumeSetSize: 2,
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
    identifierEncoding: "ucs2-be",
  }],
  enhancedVolumeDescriptors: [{
    volumeIdentifier: "ENH",
    escapeSequences: Uint8Array.of(0x25, 0x2f, 0x45),
  }],
};

const extensionListOptions: CreateIsoOptions = {
  extensions: extensionList,
};

const disabledJolietOptions: CreateIsoOptions = {
  extensions: {
    joliet: { enabled: false },
  },
};

const externalDirectoryOptions: CreateIsoOptions = {
  externalDirectories: [externalDirectory],
  volumeSetSize: 2,
};

const image = createIsoImage([file], options);
const imageFromObjectOverload = createIsoImage({
  files: [file],
  ...options,
});
const parsed: IsoImage = parseIsoImage(image);
const parsedFromView: IsoImage = parseIsoImage(imageInput, { includeData: false });
const interoperableParsed: IsoImage = parseIsoImage(image, { interoperability: true });
const parsedWithNonzeroPvdUnusedBytes: IsoImage = parseIsoImage(image, { allowNonzeroPrimaryVolumeDescriptorUnusedBytes: true });
const parsedWithPrimarySelection: IsoImage = parseIsoImage(image, { primaryVolumeDescriptorIndex: 0 } satisfies ParseIsoOptions);
const parsedWithDescriptorReservedBytes: IsoImage = parseIsoImage(image, {
  allowNonzeroDescriptorReservedBytes: true,
} satisfies ParseIsoOptions);
const volumeSet: IsoVolumeSet = parseIsoVolumeSet([image, imageInput], { includeData: false });
const descriptors: VolumeDescriptor[] = parseVolumeDescriptors(image);
const issues: ValidationIssue[] = validateIsoImage(image);

const primary: PrimaryVolumeDescriptor = parsed.primaryVolumeDescriptor;
const primaryDescriptors: PrimaryVolumeDescriptor[] = parsed.primaryVolumeDescriptors;
const primaryDescriptorIndex: number = parsed.primaryVolumeDescriptorIndex;
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
const bootCatalog: IsoBootCatalog | undefined = parsed.descriptors.find(
  (descriptor) => descriptor.kind === "boot",
)?.bootCatalog;
const bootCatalogEntry: IsoBootCatalogEntry | undefined = bootCatalog?.entries[0];
const bootCatalogData: Uint8Array | undefined = bootCatalog?.initialEntry.data;
const rockRidge: RockRidgeMetadata | undefined = fileEntry?.rockRidge;
const rockRidgeEntry: SuspEntry | undefined = rockRidge?.entries[0];

void bootCatalogData;
void bootCatalogEntry;
void descriptors;
void directoryEntry;
void enhanced;
void entryPath;
void extensionName;
void extensionListOptions;
void disabledJolietOptions;
void externalDirectoryOptions;
void fileEntry;
void imageFromObjectOverload;
void issues;
void parsedFromView;
void parsedWithDescriptorReservedBytes;
void partition;
void primary;
void rockRidge;
void rockRidgeEntry;
void associatedDirectory;
void multiExtentDirectory;
void supplementary;
void volumeSet;
