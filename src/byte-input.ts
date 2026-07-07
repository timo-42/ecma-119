import type { ByteInput, IsoImageInput } from "./types.js";

export function bytesFromInput(data: ByteInput): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return bytesFromImageInput(data);
}

export function bytesFromImageInput(data: IsoImageInput): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
