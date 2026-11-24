import { crc32, deflateSync } from 'node:zlib';

import qrcode from 'qrcode-generator';

// E11.7-11: the partner's QR code, generated on the server from the
// `/r/{CODE}` link. `qrcode-generator` (MIT) only computes the module matrix;
// this file writes the SVG and PNG itself, so nothing reaches the browser but
// the finished image. Error correction is M (about 15% of the symbol can be
// lost), which survives a printed flyer's creases and smudges.
//
// The modules are pure black on pure white with a four-module quiet zone,
// as ISO/IEC 18004 asks for reliable scanning. These are the image's own
// pixels, not brand colours: a scanner needs the contrast in every theme.

const quietZone = 4;
const pngModulePixels = 10;
const dark = '#000';
const light = '#fff';

export interface QrMatrix {
  readonly size: number;
  isDark(row: number, column: number): boolean;
}

export function qrMatrix(text: string): QrMatrix {
  if (!/^[\x21-\x7e]+$/u.test(text)) {
    throw new RangeError('A QR code encodes one printable ASCII link.');
  }
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  const size = code.getModuleCount();
  return { size, isDark: (row, column) => code.isDark(row, column) };
}

function escapeAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * A standalone SVG document. With `label`, the same markup is fit to inline
 * in a page as one labelled image, with no request of its own.
 */
export function qrSvg(text: string, label?: string): string {
  const matrix = qrMatrix(text);
  const extent = matrix.size + quietZone * 2;
  let path = '';
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (matrix.isDark(row, column)) {
        path += `M${column + quietZone} ${row + quietZone}h1v1h-1z`;
      }
    }
  }
  const labelled =
    label === undefined
      ? ''
      : ` role="img" aria-label="${escapeAttribute(label)}"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" ` +
    `width="${extent * pngModulePixels}" height="${extent * pngModulePixels}" ` +
    `shape-rendering="crispEdges"${labelled}>` +
    `<rect width="${extent}" height="${extent}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** A 1-bit greyscale PNG, ten pixels a module, quiet zone included. */
export function qrPng(text: string): Buffer {
  const matrix = qrMatrix(text);
  const width = (matrix.size + quietZone * 2) * pngModulePixels;
  const rowBytes = Math.ceil(width / 8);
  const raw = Buffer.alloc((rowBytes + 1) * width);
  for (let y = 0; y < width; y += 1) {
    const offset = y * (rowBytes + 1);
    // Filter type 0 (none) leads every scanline.
    raw[offset] = 0;
    const row = Math.floor(y / pngModulePixels) - quietZone;
    for (let x = 0; x < width; x += 1) {
      const column = Math.floor(x / pngModulePixels) - quietZone;
      const inside =
        row >= 0 && row < matrix.size && column >= 0 && column < matrix.size;
      // In 1-bit greyscale, 1 is white.
      if (!(inside && matrix.isDark(row, column))) {
        const index = offset + 1 + (x >> 3);
        raw[index] = (raw[index] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // greyscale
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Same-document download targets: no route, no second bearer request. */
export function qrDownloads(text: string) {
  return {
    png: `data:image/png;base64,${qrPng(text).toString('base64')}`,
    svg: `data:image/svg+xml;base64,${Buffer.from(qrSvg(text)).toString('base64')}`,
  };
}
