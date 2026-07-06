# ecma-119

TypeScript utilities for reading and writing ECMA-119 / ISO 9660 CD-ROM volume images.

This package is in initial development. The first supported profile targets single-volume ECMA-119 images with 2,048-byte logical sectors, one primary volume descriptor, non-interleaved file extents, path tables, and Level 1 compatible file identifiers.

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
  timeZoneOffsetMinutes: 0
});

const parsed = parseIsoImage(image);
console.log(parsed.files.map((file) => file.path));
```

`timeZoneOffsetMinutes` is signed minutes east of UTC, must be divisible by 15, supports -720 through 780, and defaults to 0. File, directory, and structured Extended Attribute Record inputs can override the global value for their own ECMA-119 date/time fields.

## Scope

Implemented support is intentionally explicit:

- ECMA-119 logical sectors of 2,048 bytes
- primary volume descriptor and descriptor set terminator
- volume descriptor metadata and file identifier fields
- optional boot record volume descriptor
- optional supplementary volume descriptors with separate mirrored path tables and directory hierarchy
- optional enhanced volume descriptors with separate mirrored path tables and directory hierarchy
- optional raw volume partition descriptor and payload
- Type L and Type M path tables
- directory records with standard `.` and `..` entries
- ECMA-119 date/time offset bytes for volume descriptors, directory records, and structured Extended Attribute Records
- opaque directory record System Use bytes
- raw and structured file and directory Extended Attribute Records
- non-interleaved file sections
- byte-level parser for generated and compatible ECMA-119 images

Enhanced descriptors, executable boot semantics, partition filesystem semantics, multi-volume sets, interleaving, and Rock Ridge/Joliet extensions are outside the first supported profile. Boot record and volume partition descriptors are supported as raw descriptor metadata.
