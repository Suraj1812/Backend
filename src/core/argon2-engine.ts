/** Fixed OWASP Argon2id parameters; no request or database row can select costs. */
export const ARGON2_PARAMETERS = {
  memoryKiB: 19_456,
  iterations: 2,
  parallelism: 1,
  version: 0x13,
  saltBytes: 16,
  hashBytes: 32,
  maxMaterialBytes: 1_024,
  maxMemoryBytes: 32 * 1_024 * 1_024,
} as const;

export type Argon2Derive = (material: Uint8Array, salt: Uint8Array) => Uint8Array;

interface Argon2Exports extends WebAssembly.Exports {
  c: WebAssembly.Memory;
  d: () => void;
  e: (...args: number[]) => number;
  f: (bytes: number) => number;
  g: (pointer: number) => void;
}

/**
 * Accept a compiled module: the Deno adapter compiles the bundled, pinned bytes
 * at startup; Node seed tooling can compile the same pinned binary from disk.
 * The engine itself never fetches or dynamically selects executable code.
 * The ABI is pinned to argon2-browser@1.18.0, documented with the vendor binary.
 */
export function createArgon2Engine(module: WebAssembly.Module): { derive: Argon2Derive } {
  let engine: Argon2Exports | undefined;

  function initialize() {
    let exports: Argon2Exports | undefined;
    const instance = new WebAssembly.Instance(module, {
      a: {
        // Emscripten memcpy and heap growth are the binary's only host imports.
        a(destination: number, source: number, length: number) {
          if (!exports) throw new Error('The password hashing engine is not initialized');
          const memory = new Uint8Array(exports.c.buffer);
          destination >>>= 0;
          source >>>= 0;
          length >>>= 0;
          if (destination + length > memory.length || source + length > memory.length) {
            throw new Error('The password hashing engine accessed invalid memory');
          }
          memory.copyWithin(destination, source, source + length);
          return destination;
        },
        b(requestedBytes: number) {
          requestedBytes >>>= 0;
          if (!exports || requestedBytes > ARGON2_PARAMETERS.maxMemoryBytes) return 0;
          const current = exports.c.buffer.byteLength;
          if (requestedBytes <= current) return 1;
          try {
            exports.c.grow(Math.ceil((requestedBytes - current) / 65_536));
            return 1;
          } catch {
            return 0;
          }
        },
      },
    });
    exports = instance.exports as Argon2Exports;
    if (
      // Supabase wraps the WASM constructors in a separate realm. A nominal
      // instanceof check can reject genuine exported memory in that runtime.
      !exports.c?.buffer ||
      typeof exports.c.grow !== 'function' ||
      exports.c.buffer.byteLength < 65_536 ||
      exports.c.buffer.byteLength > ARGON2_PARAMETERS.maxMemoryBytes ||
      ['d', 'e', 'f', 'g'].some((name) => typeof exports![name] !== 'function')
    ) {
      throw new Error('The password hashing engine has an unsupported ABI');
    }
    exports.d();
    return exports;
  }

  const derive: Argon2Derive = (material, salt) => {
    if (
      !(material instanceof Uint8Array) ||
      material.length < 1 ||
      material.length > ARGON2_PARAMETERS.maxMaterialBytes
    ) {
      throw new Error('Password hashing material must contain between 1 and 1024 bytes');
    }
    if (!(salt instanceof Uint8Array) || salt.length !== ARGON2_PARAMETERS.saltBytes) {
      throw new Error('Password hashing salt must contain exactly 16 bytes');
    }
    engine ??= initialize();
    const exports = engine;
    const allocations: { pointer: number; size: number }[] = [];
    const allocate = (size: number) => {
      const pointer = exports.f(size) >>> 0;
      if (!pointer) throw new Error('The password hashing engine could not allocate memory');
      allocations.push({ pointer, size });
      if (pointer + size > exports.c.buffer.byteLength)
        throw new Error('The password hashing engine returned invalid memory');
      return pointer;
    };
    // This entire section is synchronous: overlapping requests cannot interleave
    // mutable WASM memory. One lazily reused heap keeps the isolate memory bounded.
    try {
      const passwordPointer = allocate(material.length);
      const saltPointer = allocate(salt.length);
      const hashPointer = allocate(ARGON2_PARAMETERS.hashBytes);
      new Uint8Array(exports.c.buffer).set(material, passwordPointer);
      new Uint8Array(exports.c.buffer).set(salt, saltPointer);
      const result = exports.e(
        ARGON2_PARAMETERS.iterations,
        ARGON2_PARAMETERS.memoryKiB,
        ARGON2_PARAMETERS.parallelism,
        passwordPointer,
        material.length,
        saltPointer,
        salt.length,
        hashPointer,
        ARGON2_PARAMETERS.hashBytes,
        0,
        0,
        2,
        ARGON2_PARAMETERS.version,
      );
      if (result !== 0) {
        console.error(JSON.stringify({ event: 'argon2_runtime_failure', result }));
        throw new Error('The password hashing engine could not complete the derivation');
      }
      // Memory can grow during hashing; create a fresh view and copy the output.
      return new Uint8Array(exports.c.buffer, hashPointer, ARGON2_PARAMETERS.hashBytes).slice();
    } finally {
      for (const { pointer, size } of allocations) {
        new Uint8Array(exports.c.buffer).fill(0, pointer, pointer + size);
        exports.g(pointer);
      }
    }
  };

  return { derive };
}
