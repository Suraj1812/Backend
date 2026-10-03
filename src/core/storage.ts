export interface StoredObject {
  key: string;
  size: number;
  uploaded: Date;
}
export interface StoredObjectBody extends StoredObject {
  body: ReadableStream<Uint8Array>;
}
export interface ObjectStore {
  put(
    key: string,
    bytes: Uint8Array,
    options: {
      httpMetadata: { contentType: string; contentDisposition: string };
      customMetadata: { fileId: string };
    },
  ): Promise<StoredObject | null>;
  get(key: string): Promise<StoredObjectBody | null>;
  head(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<{ objects: StoredObject[]; truncated: boolean; cursor: string }>;
}
export interface RateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}
