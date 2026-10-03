import { ApiError } from '../../core/errors';

export const acceptedContentTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type FileContentType = (typeof acceptedContentTypes)[number];
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 40_000_000;

function invalidImage(message = 'The body does not contain a valid supported image'): never {
  throw new ApiError(422, 'INVALID_FILE', message);
}

function dimensions(width: number, height: number) {
  if (
    !width ||
    !height ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    invalidImage(
      'Images must have positive dimensions, at most 16384 pixels per side and 40 million pixels in total',
    );
  }
}

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const crcTable = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function png(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 57 || signature.some((value, index) => bytes[index] !== value)) invalidImage();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header = false;
  let imageData = false;
  let dataEnded = false;
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + size;
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type)) invalidImage();
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end - 4; i++)
      crc = crcTable[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
    if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(end - 4))
      invalidImage('The PNG contains a corrupt chunk');
    if (!header && type !== 'IHDR') invalidImage();
    if (type === 'IHDR') {
      if (header || size !== 13) invalidImage();
      dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
      const depth = bytes[offset + 16]!;
      const color = bytes[offset + 17]!;
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !depths[color]?.includes(depth) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20]! > 1
      )
        invalidImage();
      header = true;
    } else if (type === 'IDAT') {
      if (dataEnded) invalidImage();
      imageData ||= size > 0;
    } else if (type === 'IEND') {
      if (size !== 0 || !imageData || end !== bytes.length) invalidImage();
      return;
    } else {
      if (imageData) dataEnded = true;
      // APNG is intentionally excluded to keep the upload limits predictable.
      if (
        ['acTL', 'fcTL', 'fdAT'].includes(type) ||
        (type[0] === type[0]?.toUpperCase() && type !== 'PLTE')
      )
        invalidImage();
    }
    offset = end;
  }
  invalidImage();
}

function jpeg(bytes: Uint8Array) {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalidImage();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let frame = false;
  let scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalidImage();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scan || offset !== bytes.length) invalidImage();
      return;
    }
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      invalidImage();
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.length) invalidImage();
    const size = view.getUint16(offset);
    if (size < 2 || offset + size > bytes.length) invalidImage();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || size < 8 || bytes[offset + 2] !== 8) invalidImage();
      const components = bytes[offset + 7]!;
      if (![1, 3, 4].includes(components) || size !== 8 + components * 3) invalidImage();
      dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      frame = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      invalidImage('Only baseline and progressive 8-bit JPEG images are supported');
    }
    offset += size;
    if (marker === 0xda) {
      if (!frame || size < 6) invalidImage();
      scan = true;
      let foundMarker = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        const markerStart = offset++;
        while (bytes[offset] === 0xff) offset++;
        const next = bytes[offset++];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) continue;
        offset = markerStart;
        foundMarker = true;
        break;
      }
      if (!foundMarker) invalidImage();
    }
  }
  invalidImage();
}

function webp(bytes: Uint8Array) {
  if (bytes.length < 26 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP')
    invalidImage();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) invalidImage();
  const uint24 = (offset: number) =>
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
  let offset = 12;
  let image = false;
  let extended: [number, number] | undefined;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size + (size & 1);
    if (end > bytes.length || (size & 1 && bytes[end - 1] !== 0)) invalidImage();
    let width: number | undefined;
    let height: number | undefined;
    if (type === 'VP8X') {
      if (
        offset !== 12 ||
        size !== 10 ||
        (bytes[start]! & 0xc3) !== 0 ||
        bytes[start + 1] !== 0 ||
        bytes[start + 2] !== 0 ||
        bytes[start + 3] !== 0
      ) {
        invalidImage('Animated WebP images and malformed containers are not supported');
      }
      extended = [uint24(start + 4) + 1, uint24(start + 7) + 1];
      dimensions(...extended);
    } else if (type === 'VP8 ') {
      if (
        image ||
        size < 10 ||
        (bytes[start]! & 1) !== 0 ||
        ascii(bytes, start + 3, 3) !== '\u009d\u0001\u002a'
      )
        invalidImage();
      width = view.getUint16(start + 6, true) & 0x3fff;
      height = view.getUint16(start + 8, true) & 0x3fff;
    } else if (type === 'VP8L') {
      if (image || size < 5 || bytes[start] !== 0x2f || bytes[start + 4]! >> 5 !== 0)
        invalidImage();
      width = 1 + (bytes[start + 1]! | ((bytes[start + 2]! & 0x3f) << 8));
      height =
        1 +
        ((bytes[start + 2]! >> 6) | (bytes[start + 3]! << 2) | ((bytes[start + 4]! & 0x0f) << 10));
    } else if (type === 'ANIM' || type === 'ANMF') {
      invalidImage('Animated WebP images are not supported');
    }
    if (width !== undefined && height !== undefined) {
      dimensions(width, height);
      if (extended && (extended[0] !== width || extended[1] !== height)) invalidImage();
      image = true;
    }
    offset = end;
  }
  if (!image || offset !== bytes.length) invalidImage();
}

export function validateUpload(
  bytes: Uint8Array,
  contentType: string | undefined,
  filename: string | undefined,
  maxBytes: number,
) {
  if (!acceptedContentTypes.includes(contentType as FileContentType)) {
    throw new ApiError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Upload a PNG, JPEG, or WebP image using its exact Content-Type',
    );
  }
  if (!bytes.length)
    throw new ApiError(400, 'EMPTY_FILE', 'The request body must contain file bytes');
  if (bytes.length > maxBytes)
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Files must be at most ${maxBytes} bytes`);
  if (!filename)
    throw new ApiError(
      400,
      'FILE_NAME_REQUIRED',
      'Send the original filename in the X-File-Name header',
    );
  const trimmed = filename.trim();
  if (filename.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(trimmed)) {
    throw new ApiError(
      422,
      'INVALID_FILE_NAME',
      'Use a filename of at most 120 ASCII letters, digits, spaces, dots, underscores, or hyphens; begin with a letter or digit',
    );
  }
  const extension = trimmed.split('.').at(-1)?.toLowerCase();
  const extensions: Record<FileContentType, string[]> = {
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/webp': ['webp'],
  };
  if (!extensions[contentType as FileContentType].includes(extension ?? '')) {
    throw new ApiError(
      422,
      'INVALID_FILE_NAME',
      'The filename extension must match the Content-Type',
    );
  }
  if (contentType === 'image/png') png(bytes);
  if (contentType === 'image/jpeg') jpeg(bytes);
  if (contentType === 'image/webp') webp(bytes);
  return { filename: trimmed.replaceAll(' ', '_'), contentType: contentType as FileContentType };
}
