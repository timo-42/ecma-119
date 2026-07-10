import {
  createUdfImage,
  parseUdfImage,
  type CreateUdfOptions,
  type UdfImage,
  type UdfInputFile,
} from "ecma-119/udf";

const files: UdfInputFile[] = [{ path: "README.TXT", data: "UDF\n" }];
const options: CreateUdfOptions = { volumeIdentifier: "TYPE_UDF", revision: "2.01" };
const image = createUdfImage(files, options);
const parsed: UdfImage = parseUdfImage(image, { includeData: false });

void parsed;
