import type { Buffer } from 'node:buffer';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 1_048_576;
const REQUIRED_WIDTH = 1024;
const REQUIRED_HEIGHT = 1024;
const FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

type Dimensions = { width: number; height: number };

function invalid(reason: string): never {
  throw new Error(`Invalid copied entry image: ${reason}`);
}

function validateJpeg(bytes: Buffer): Dimensions {
  if (bytes.length > MAX_BYTES) {
    invalid(`${bytes.length} bytes exceeds the ${MAX_BYTES}-byte (1 MiB) limit.`);
  }
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) {
    invalid('expected JPEG data with a start-of-image marker.');
  }
  if (bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    invalid('JPEG is truncated or missing its end-of-image marker.');
  }

  let offset = 2;
  let dimensions: Dimensions | undefined;
  let sawScan = false;

  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid('malformed JPEG marker.');
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) invalid('truncated JPEG marker.');
    const marker = bytes[offset++];

    if (marker === 0xd9) {
      if (offset !== bytes.length) invalid('unexpected data after the JPEG end marker.');
      if (!dimensions || !sawScan) invalid('JPEG has no image frame or scan.');
      if (dimensions.width !== REQUIRED_WIDTH || dimensions.height !== REQUIRED_HEIGHT) {
        invalid(`JPEG is ${dimensions.width}x${dimensions.height}; expected 1024x1024.`);
      }
      return dimensions;
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      invalid('unexpected JPEG marker outside image scan data.');
    }
    if (marker === 0x01) continue; // TEM is the only other standalone marker here.
    if (offset + 2 > bytes.length) invalid('truncated JPEG segment length.');
    const length = bytes.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalid('invalid or truncated JPEG segment.');

    if (FRAME_MARKERS.has(marker)) {
      if (dimensions) invalid('unexpected duplicate JPEG image frame.');
      if (length < 8 || bytes[offset + 7] === 0 || length !== 8 + 3 * bytes[offset + 7]) {
        invalid('malformed JPEG frame header.');
      }
      dimensions = {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }

    offset = end;
    if (marker === 0xda) {
      const scanStart = end - length;
      if (!dimensions) invalid('JPEG scan appears before its image frame.');
      if (length < 6 || bytes[scanStart + 2] === 0 || length !== 6 + 2 * bytes[scanStart + 2]) {
        invalid('malformed JPEG scan header.');
      }
      sawScan = true;
      let scanBytes = 0;

      // Scan data uses FF 00 for a literal FF byte and FF D0–D7 for restarts.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          scanBytes++;
          continue;
        }
        const markerStart = offset;
        while (bytes[offset] === 0xff) offset++;
        if (offset >= bytes.length) invalid('truncated JPEG scan data.');
        const scanMarker = bytes[offset];
        if (scanMarker === 0x00) {
          offset++;
          scanBytes++;
        } else if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          offset++;
        } else {
          offset = markerStart;
          break;
        }
      }
      if (scanBytes === 0) invalid('JPEG image scan is empty.');
    }
  }

  invalid('JPEG has no end-of-image marker.');
}

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'entry.png');
const outputDirectory = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const outputPath = join(outputDirectory, 'entry.png');

await mkdir(outputDirectory, { recursive: true });
await copyFile(sourcePath, outputPath);
const bytes = await readFile(outputPath);
const { width, height } = validateJpeg(bytes);
console.log(`Wrote ${outputPath}: JPEG ${width}x${height}, ${bytes.length} bytes.`);
