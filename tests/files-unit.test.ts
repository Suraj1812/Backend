import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppContext, AppEnv, Env } from '../src/core/types';
import { downloadFile, removeFile, uploadFile } from '../src/modules/files/service';
import type { FileRow } from '../src/modules/files/repository';
import { validateUpload } from '../src/modules/files/validation';

const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const png = decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
);
const webp = decode('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA');
// A one-pixel baseline JPEG, exported by macOS ImageIO with ancillary profiles removed.
const jpeg = decode(
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/APwDr//Z',
);

afterEach(() => vi.restoreAllMocks());

describe('file upload boundary', () => {
  it('accepts a PNG and turns the safe original name into an attachment filename', () => {
    expect(validateUpload(png, 'image/png', 'my image.png', 1024)).toEqual({
      filename: 'my_image.png',
      contentType: 'image/png',
    });
  });

  it('accepts a structurally valid baseline JPEG', () => {
    expect(validateUpload(jpeg, 'image/jpeg', 'pixel.jpg', 1024).contentType).toBe('image/jpeg');
  });

  it('accepts a static WebP container and rejects a forged RIFF length or excessive dimensions', () => {
    expect(validateUpload(webp, 'image/webp', 'pixel.webp', 1024).contentType).toBe('image/webp');
    const malformed = webp.slice();
    malformed[4] = 0xff;
    expect(() => validateUpload(malformed, 'image/webp', 'pixel.webp', 1024)).toThrow(
      'supported image',
    );
    const oversized = webp.slice();
    oversized.set([0xff, 0x3f, 0xff, 0x3f], 26);
    expect(() => validateUpload(oversized, 'image/webp', 'pixel.webp', 1024)).toThrow('40 million');
  });

  it('rejects HTML and SVG regardless of the supplied file name', () => {
    expect(() =>
      validateUpload(
        new TextEncoder().encode('<svg onload="alert(1)"/>'),
        'image/svg+xml',
        'avatar.svg',
        1024,
      ),
    ).toThrow('Upload a PNG');
    expect(() =>
      validateUpload(
        new TextEncoder().encode('<html>payload</html>'),
        'image/png',
        'avatar.png',
        1024,
      ),
    ).toThrow('supported image');
  });

  it('does not trust a forged content type', () => {
    expect(() => validateUpload(png, 'image/jpeg', 'avatar.jpg', 1024)).toThrow('supported image');
  });

  it('checks actual bytes even when no Content-Length was supplied', () => {
    expect(() => validateUpload(png, 'image/png', 'pixel.png', png.length - 1)).toThrow('at most');
    expect(() => validateUpload(new Uint8Array(), 'image/png', 'empty.png', 1024)).toThrow(
      'file bytes',
    );
  });

  it.each([
    '../image.png',
    'image\r\nInjected: yes.png',
    'image".png',
    '.hidden.png',
    'photo.svg',
    `${'a'.repeat(121)}.png`,
  ])('rejects unsafe or mismatched filename %s', (filename) => {
    expect(() => validateUpload(png, 'image/png', filename, 1024)).toThrow('filename');
  });

  it('rejects corrupt PNG chunks, truncation and appended payloads', () => {
    const corrupt = png.slice();
    corrupt[45] = corrupt[45]! ^ 1;
    expect(() => validateUpload(corrupt, 'image/png', 'pixel.png', 1024)).toThrow('corrupt chunk');
    expect(() => validateUpload(png.slice(0, -1), 'image/png', 'pixel.png', 1024)).toThrow(
      'supported image',
    );
    const appended = new Uint8Array(png.length + 8);
    appended.set(png);
    appended.set(new TextEncoder().encode('<script>'), png.length);
    expect(() => validateUpload(appended, 'image/png', 'pixel.png', 1024)).toThrow(
      'supported image',
    );
  });

  it('requires a real JPEG frame, scan, and terminal marker', () => {
    expect(() => validateUpload(jpeg.slice(0, -2), 'image/jpeg', 'pixel.jpg', 1024)).toThrow(
      'supported image',
    );
    const appended = new Uint8Array(jpeg.length + 1);
    appended.set(jpeg);
    expect(() => validateUpload(appended, 'image/jpeg', 'pixel.jpg', 1024)).toThrow(
      'supported image',
    );
  });
});

const existingFile: FileRow = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: 'owner',
  object_key: 'uploads/owner/object',
  filename: 'pixel.png',
  content_type: 'image/png',
  size: png.length,
  created_at: '2026-01-01T00:00:00.000Z',
  status: 'ready',
};

function context(
  options: { persisted?: FileRow | null; readFailure?: boolean; deletionFailure?: boolean } = {},
) {
  const first = options.readFailure
    ? vi.fn().mockRejectedValue(new Error('PostgreSQL unavailable'))
    : vi.fn().mockResolvedValue(options.persisted ?? null);
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first,
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  const db = { prepare: vi.fn().mockReturnValue(statement), batch: vi.fn().mockResolvedValue([]) };
  const bucket = {
    put: vi.fn().mockResolvedValue({ size: png.length }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  if (options.deletionFailure) bucket.delete.mockRejectedValue(new Error('Storage unavailable'));
  const values: Record<string, unknown> = {
    bodyBytes: png,
    config: { maxUploadBytes: 1024 },
    principal: { user: { id: 'owner' } },
    requestId: 'test-request',
    ipHash: 'redacted',
  };
  const c = {
    env: { DB: db, FILES: bucket },
    get: (name: string) => values[name],
    req: {
      header: (name: string) => ({ 'Content-Type': 'image/png', 'X-File-Name': 'pixel.png' })[name],
    },
  } as unknown as AppContext;
  return { c, db, bucket };
}

describe('PostgreSQL/Storage failure reconciliation', () => {
  it('compensates the Storage object only when PostgreSQL confirms no metadata was committed', async () => {
    const { c, db, bucket } = context();
    db.batch.mockRejectedValueOnce(new Error('PostgreSQL transaction failed'));
    await expect(uploadFile(c)).rejects.toMatchObject({ status: 503 });
    expect(bucket.delete).toHaveBeenCalledOnce();
  });

  it('preserves an upload after an ambiguous RPC failure with committed metadata', async () => {
    const { c, db, bucket } = context({ persisted: existingFile });
    db.batch.mockRejectedValueOnce(new Error('PostgreSQL response lost'));
    await expect(uploadFile(c)).resolves.toMatchObject({
      id: existingFile.id,
      filename: 'pixel.png',
    });
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('preserves an unconfirmed upload for reconciliation when PostgreSQL is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { c, db, bucket } = context({ readFailure: true });
    db.batch.mockRejectedValueOnce(new Error('PostgreSQL response lost'));
    await expect(uploadFile(c)).rejects.toMatchObject({ code: 'FILE_STORAGE_UNAVAILABLE' });
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('keeps the durable deletion tombstone when Storage deletion fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { c, db } = context({ persisted: existingFile, deletionFailure: true });
    await expect(removeFile(c, existingFile.id)).rejects.toMatchObject({
      status: 503,
      code: 'FILE_DELETION_PENDING',
    });
    expect(db.batch).toHaveBeenCalledOnce();
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("SET status = 'deleting'"));
    expect(db.prepare).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM files'));
  });
});

it('keeps prepared request, CORS, and security headers on a streamed binary response', async () => {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'download-request');
    c.set('principal', {
      method: 'bearer',
      scopes: [],
      user: {
        id: 'owner',
        email: 'owner@example.test',
        name: 'Owner',
        role: 'member',
        createdAt: existingFile.created_at,
        updatedAt: existingFile.created_at,
      },
    });
    c.header('X-Request-Id', 'download-request');
    c.header('Access-Control-Allow-Origin', 'https://frontend.example.test');
    c.header('X-Frame-Options', 'DENY');
    await next();
  });
  app.get('/content', (c) => downloadFile(c, existingFile.id));
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(existingFile),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  const bindings = {
    DB: { prepare: vi.fn().mockReturnValue(statement) },
    FILES: {
      get: vi.fn().mockResolvedValue({
        size: png.length,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(png);
            controller.close();
          },
        }),
      }),
    },
  } as unknown as Env;
  const response = await app.request(
    'https://api.example.test/content',
    { headers: { Origin: 'https://frontend.example.test' } },
    bindings,
  );
  expect(response.headers.get('X-Request-Id')).toBe('download-request');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.example.test');
  expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Content-Length')).toBe(String(png.length));
  expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="pixel.png"');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
});
