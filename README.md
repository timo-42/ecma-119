# ecma-119

TypeScript utilities for reading and writing ECMA-119 / ISO 9660 CD-ROM volume images.

This package is in initial development. The supported profile targets ECMA-119 images with 2,048-byte logical sectors, one primary volume descriptor, one or more volume descriptor set terminators, optional supplementary/enhanced volume descriptors with mirrored directory trees, optional raw boot and partition descriptors, non-interleaved file extents including read-side multi-extent file sections, path tables, Level 1 primary identifier authoring by default, optional Level 2 primary identifiers, and unresolved read-side metadata for external records within a volume set.

## Install

```sh
npm install ecma-119
```

## API

```ts
import { createIsoImage, parseIsoImage } from "ecma-119";

const image = createIsoImage([
  {
    path: "README.TXT",
    data: "Hello from ECMA-119\n",
    version: 1,
    interleave: { fileUnitSize: 1, interleaveGapSize: 0 },
    hidden: false,
    associated: false,
    extendedAttributeRecord: {
      systemIdentifier: "EXAMPLE",
      applicationUse: new Uint8Array([0x01, 0x02])
    },
    systemUse: new Uint8Array([0x53, 0x55])
  }
], {
  volumeIdentifier: "EXAMPLE",
  bootRecord: {
    bootSystemIdentifier: "EL TORITO SPECIFICATION",
    bootIdentifier: "BOOT CATALOG"
  },
  volumePartition: {
    volumePartitionIdentifier: "PARTITION",
    data: new Uint8Array([1, 2, 3, 4])
  },
  optionalPathTables: true,
  timeZoneOffsetMinutes: 0
});

const parsed = parseIsoImage(image);
console.log(parsed.files.map((file) => file.path));
const partition = parsed.descriptors.find((descriptor) => descriptor.kind === "partition");
console.log(partition?.data?.subarray(0, 4));
```

The root package entry intentionally exposes these API groups:

- image creation: `createIsoImage` and the related input/option types
- image reading and validation: `parseIsoImage`, `parseVolumeDescriptors`, `validateIsoImage`, descriptor/node types, and validation issues
- constants and flags: sector and standard identifier constants, directory record file flag constants, and Extended Attribute Record constants
- low-level ECMA-119 helpers: binary/date/string helpers, directory record codecs, Extended Attribute Record codecs, identifier helpers, and path table codecs

`timeZoneOffsetMinutes` is signed minutes east of UTC, must be divisible by 15, supports -720 through 780, and defaults to 0. File, directory, and structured Extended Attribute Record inputs can override the global value for their own ECMA-119 date/time fields.

`systemArea` may be supplied as up to 32,768 bytes copied into logical sectors 0 through 15. Shorter values are zero-padded by the writer, omitted values leave the System Area all zeroes, and `parseIsoImage(image).systemArea` exposes the 16-sector byte range.

Use `bootRecord` for a single Boot Record descriptor or `bootRecords` for additional Boot Record descriptors. The package preserves Boot Record descriptor fields and opaque Boot System Use bytes, but executable boot semantics are left to consuming systems.

`terminatorCount` defaults to 1 and may be set from 1 through 255 to emit one or more Volume Descriptor Set Terminators.

`volumeSetSize` and `volumeSequenceNumber` default to 1. They may be set to describe the generated image as a local member of a larger volume set; generated directory records use the same local sequence number. When parsing, directory and file records whose volume sequence number is within the descriptor volume set but differs from the local volume are returned as unresolved external entries with `external: true`; their metadata is preserved, but file payloads and external directory children are not loaded from the local image.

File input `version` defaults to 1 and may be set from 1 through 32767 to write a non-default ECMA-119 file version number. The parser preserves the full identifier, such as `README.TXT;2`, while `path` omits the version suffix.

Files marked with `associated: true` may share the same path, identifier, and version as a regular file in the same directory. The parser returns both records with the same `path` and `identifier`; the associated file is distinguished by the Associated File flag.

Directory records are written as a single non-interleaved file section as required by ECMA-119. An empty directory path targets the root directory.

`parseIsoImage(image)` includes regular file payloads and volume partition payloads by default. Use `parseIsoImage(image, { includeData: false })` to read descriptors and directory trees without loading those payload bytes.

Parsed primary, supplementary, and enhanced volume descriptors expose decoded path table records under `pathTables`, including mandatory Type L/Type M tables and any optional copies present in the descriptor.

## Scope

Implemented support is intentionally explicit:

- ECMA-119 logical sectors of 2,048 bytes
- primary volume descriptor and one or more descriptor set terminators
- volume descriptor metadata and file identifier fields
- optional boot record volume descriptors
- opaque System Area authoring and parsing
- optional supplementary volume descriptors with separate mirrored path tables and directory hierarchy
- optional enhanced volume descriptors with separate mirrored path tables and directory hierarchy
- per-descriptor metadata and date/time overrides for supplementary and enhanced volume descriptors
- optional raw volume partition descriptor and payload
- Type L and Type M path tables
- optional Type L and Type M path table copies when requested by the writer
- local volume set member metadata and same-volume directory records
- read-side unresolved external-volume directory and file record metadata within the declared volume set
- validation that descriptor file-reference fields resolve to files described in the root directory
- Level 1 primary identifier authoring by default, with `identifierLevel: 2` support for longer primary directory and file identifiers
- file version number authoring from 1 through 32767
- directory records with standard `.` and `..` entries, written and parsed as single non-interleaved directory sections
- hidden flags for generated files and directories, associated file flags for generated files, and regular/associated file pairs with the same identifier
- ECMA-119 date/time offset bytes for volume descriptors, directory records, and structured Extended Attribute Records
- opaque directory record System Use bytes
- raw and structured file and directory Extended Attribute Records
- non-interleaved file sections
- writer-generated compatible non-interleaved multi-extent file sections
- writer-generated interleaved regular file sections, including Extended Attribute Records that fit within the assigned file unit
- read-side reconstruction of compatible interleaved regular file sections
- read-side coalescing of compatible non-interleaved multi-extent file sections
- byte-level parser for generated and compatible ECMA-119 images

Executable boot semantics, partition filesystem semantics, cross-volume payload resolution across multiple images, and Rock Ridge/Joliet extensions are outside the supported profile. Boot record descriptors, enhanced volume descriptors, raw volume partition descriptors/payloads, and external-volume records are supported as descriptor/data structures only.
