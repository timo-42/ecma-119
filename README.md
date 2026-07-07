# ecma-119

TypeScript utilities for reading and writing ECMA-119 4th edition / ISO 9660 CD-ROM volume images.

This package is in initial development. The supported profile targets ECMA-119 images with 2,048-byte logical sectors, one primary volume descriptor, one or more volume descriptor set terminators, optional supplementary/enhanced volume descriptors with mirrored directory trees and optional UCS-2BE identifier authoring, structured boot and partition descriptors with opaque use/payload bytes, El Torito boot catalog metadata parsing, path tables, Level 1 primary identifier authoring by default, optional Level 2 primary identifiers, regular file sections including generated non-interleaved, generated multi-extent, generated interleaved, and read-side compatible multi-extent/interleaved sections, writer-generated directory records with optional interleaving and child-directory multi-extent sections, read-side compatible multi-extent/interleaved directory records, writer-authored external file and directory records within a volume set, unresolved read-side metadata for external records within a volume set, and multi-image resolution for external directory children and regular file payloads.

The implementation targets ECMA-119 4th edition, June 2019. Tests exercise generated write-then-read ISO images, handcrafted in-memory reader images that are not produced by the writer, and checked-in ISO byte fixtures produced by an independent external tool.

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

`createIsoImage(files, options)` and `createIsoImage({ files, ...options })` are equivalent authoring forms.

The root package entry intentionally exposes these API groups:

- image creation: `createIsoImage` and the related input/option types
- image reading and validation: `parseIsoImage`, `parseIsoVolumeSet`, `parseVolumeDescriptors`, `validateIsoImage`, descriptor/node types, and validation issues
- constants and flags: sector and standard identifier constants, directory record file flag constants, and Extended Attribute Record constants
- low-level ECMA-119 helpers: binary/date/string helpers, directory record codecs, Extended Attribute Record codecs, identifier helpers, and path table codecs

Byte input fields accept strings, `ArrayBuffer`, and `ArrayBufferView` values such as `Uint8Array`, sliced typed arrays, and `DataView`. String inputs are encoded as UTF-8 bytes.

`timeZoneOffsetMinutes` is signed minutes east of UTC, must be divisible by 15, supports -720 through 780, and defaults to 0. File, directory, and structured Extended Attribute Record inputs can override the global value for their own ECMA-119 date/time fields.

Primary descriptor file-reference fields remain constrained to ECMA-119 Level 1 file identifiers even when `identifierLevel: 2` is used for authored primary directory records. Publisher, data preparer, and application identifiers that begin with `_` are treated as root-directory file references and must also use Level 1 file identifiers.

`systemArea` may be supplied as up to 32,768 bytes copied into logical sectors 0 through 15. Shorter values are zero-padded by the writer, omitted values leave the System Area all zeroes, and `parseIsoImage(image).systemArea` exposes the 16-sector byte range.

Use `bootRecord` for a single Boot Record descriptor or `bootRecords` for additional Boot Record descriptors. The package preserves Boot Record descriptor fields and opaque Boot System Use bytes. When a parsed Boot Record uses the El Torito boot system identifier, `parseIsoImage` reads one boot catalog sector and exposes validation/default-entry metadata under descriptor `bootCatalog`; catalog boot entries include raw initial-load `data` bytes when payload loading is enabled. `parseVolumeDescriptors` remains descriptor-only. Executable boot semantics are left to consuming systems.

Use `volumePartition` for a single raw Volume Partition Descriptor or `volumePartitions` for additional partition descriptors. Partition payloads are written as opaque sector-aligned byte ranges and parsed back as descriptor `data` when payload loading is enabled.

`terminatorCount` defaults to 1 and may be set from 1 through 255 to emit one or more Volume Descriptor Set Terminators.

Generated and parsed descriptor sequences follow the ECMA-119 Volume Descriptor Set order: one Primary Volume Descriptor, zero or more Supplementary Volume Descriptors, zero or more Enhanced Volume Descriptors, zero or more Volume Partition Descriptors, zero or more Boot Records, and one or more Volume Descriptor Set Terminators.

Supplementary and enhanced descriptor inputs default to `identifierEncoding: "primary"`, which mirrors the primary ECMA-119 identifier bytes into their separate directory trees and path tables. Use `identifierEncoding: "ucs2-be"` with supported escape sequences such as `%/@`, `%/C`, or `%/E` to write secondary directory and file identifiers as UCS-2BE bytes. This is a byte-level supplementary/enhanced descriptor feature; it does not enable full Joliet profile semantics.

`volumeSetSize` and `volumeSequenceNumber` default to 1. They may be set to describe the generated image as a local member of a larger volume set; generated local directory records use the same local sequence number. Use `externalFiles` and `externalDirectories` to write directory records whose target extent and data length live on another member of the same volume set. External directory records are also included in the referring member's primary path tables, using the target extent; because directory extents are descriptor-tree-specific, `externalDirectories` cannot currently be combined with supplementary or enhanced descriptors. When parsing a single image, directory and file records whose volume sequence number is within the descriptor volume set but differs from the local volume are returned as unresolved external entries with `external: true`; their metadata is preserved, but file payloads and external directory children are not loaded from the local image. Use `parseIsoVolumeSet(images)` to parse all supplied members and populate external directory children and regular file payloads from the matching volume sequence number, using the external record extent, size, and section metadata to read bytes from the referenced member. Supplied members must agree on declared volume set size and primary volume set identifier.

File input `version` defaults to 1 and may be set from 1 through 32767 to write a non-default ECMA-119 file version number. The parser preserves the full identifier, such as `README.TXT;2`, while `path` omits the version suffix.

Files marked with `associated: true` may share the same path, identifier, and version as a regular file in the same directory. The parser returns both records with the same `path` and `identifier`; the associated file is distinguished by the Associated File flag.

Directory records are written as a single file section by default and may be recorded in interleaved mode. Child directories may also be written as multi-extent directory sections. An empty directory path targets the root directory; descriptor root directory records are not authored as multi-extent records.

`parseIsoImage(image)` includes regular file payloads, volume partition payloads, and El Torito boot image payloads by default. Use `parseIsoImage(image, { includeData: false })` to read descriptors and directory trees without loading those payload bytes.

When parsing Extended Attribute Records, raw bytes are preserved on the parsed file or directory entry. Structured `extendedAttributeRecordFields` are populated only when those bytes decode as a valid ECMA-119 Extended Attribute Record; use `validateIsoImage` for diagnostics when raw EAR bytes contain malformed structured fields.

Parsed primary, supplementary, and enhanced volume descriptors expose decoded path table records under `pathTables`, including mandatory Type L/Type M tables and any optional copies present in the descriptor.

## Scope

Implemented support is intentionally explicit:

- ECMA-119 logical sectors of 2,048 bytes
- primary volume descriptor and one or more descriptor set terminators
- volume descriptor metadata and file identifier fields
- optional boot record volume descriptors
- read-side El Torito boot catalog validation, initial/default entry metadata, and boot image payload loading
- opaque System Area authoring and parsing
- optional supplementary volume descriptors with separate mirrored path tables and directory hierarchy
- optional enhanced volume descriptors with separate mirrored path tables and directory hierarchy
- optional UCS-2BE identifier bytes in supplementary/enhanced path tables and directory records when requested
- per-descriptor metadata and date/time overrides for supplementary and enhanced volume descriptors
- optional raw volume partition descriptor and payload
- Type L and Type M path tables
- optional Type L and Type M path table copies when requested by the writer
- local volume set member metadata and same-volume directory records
- writer-authored external file and directory records that reference another member of the declared volume set
- read-side unresolved external-volume directory and file record metadata within the declared volume set
- read-side multi-image resolution for external directory children and regular file payloads within a supplied volume set
- validation that descriptor file-reference fields resolve to files described in the root directory
- parse-time rejection of descriptor file-reference fields that do not resolve or do not use the required Level 1 shape
- Level 1 primary identifier authoring by default, with `identifierLevel: 2` support for longer primary directory and file identifiers
- file version number authoring from 1 through 32767
- directory records with standard `.` and `..` entries, written as directory sections with optional interleaving and child-directory multi-extent authoring, and parsed from compatible multi-extent/interleaved directory sections
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

Executable boot semantics, partition filesystem semantics, and Rock Ridge/Joliet extensions are outside the supported profile. Boot record descriptors, enhanced volume descriptors, raw volume partition descriptors/payloads, and external-volume records are supported as descriptor/data structures.

## Not Yet Supported

Known gaps in the current package:

- executable boot behavior beyond exposing El Torito boot catalog metadata and boot image bytes
- filesystem parsing inside Volume Partition Descriptor payloads; partition data is exposed as opaque bytes
- Rock Ridge metadata semantics, including POSIX names, permissions, links, and relocation records
- full Joliet extension semantics; supplementary/enhanced descriptors can author and parse UCS-2-style identifiers, but Joliet-specific behavior is not implemented as a separate profile
- writer-authored multi-extent descriptor root directory records; generated descriptor root directories remain single-section ECMA-119 directory files
- complete compatibility with arbitrary extension-heavy ISO 9660 images outside the documented ECMA-119 profile
