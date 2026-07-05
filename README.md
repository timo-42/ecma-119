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
  { path: "README.TXT", data: "Hello from ECMA-119\n" }
], {
  volumeIdentifier: "EXAMPLE"
});

const parsed = parseIsoImage(image);
console.log(parsed.files.map((file) => file.path));
```

## Scope

Implemented support is intentionally explicit:

- ECMA-119 logical sectors of 2,048 bytes
- primary volume descriptor and descriptor set terminator
- Type L and Type M path tables
- directory records with standard `.` and `..` entries
- non-interleaved file sections
- byte-level parser for generated and compatible ECMA-119 images

Supplementary/enhanced descriptors, boot records, extended attributes, multi-volume sets, interleaving, and Rock Ridge/Joliet extensions are outside the first supported profile.
