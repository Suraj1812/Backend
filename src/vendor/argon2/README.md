# Pinned Argon2 WebAssembly binary

`argon2.wasm` is copied without changes from the MIT-licensed
[`argon2-browser@1.18.0`](https://github.com/antelle/argon2-browser) distribution:

- Registry artifact: https://registry.npmjs.org/argon2-browser/-/argon2-browser-1.18.0.tgz
- File inside the artifact: `package/dist/argon2.wasm`
- File size: 25,725 bytes
- SHA-256: `0c2149886c13e4eae4a6ca25ee71d47423c5c8740a874cf04ff816d1b2c901d7`
- License: adjacent `LICENSE`, retained unchanged

The upstream binary compiles the Argon2 reference implementation. Its minified
export names are a version-specific ABI: `c` is memory, `d` initializes the runtime,
`e` is `argon2_hash`, `f` is `malloc`, and `g` is `free`. The only imports are
`a.a` (`emscripten_memcpy_big`) and `a.b` (`emscripten_resize_heap`).

`src/core/argon2-engine.ts` supplies these two synchronous imports and limits the
heap to 32 MiB. It derives a 32-byte Argon2id v19 hash using 19 MiB, two iterations,
one lane, and a 16-byte salt, following the
[OWASP minimum Argon2id parameters](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#argon2id).
Password peppering and constant-time verification
belong to the authentication module. The engine wipes and frees its WASM input
and output allocations; callers own and should clear their temporary buffers.

`embedded.ts` contains base64 generated directly from the pinned binary above.
Supabase's Deno Edge Function compiles those embedded bytes once during module
initialization through `src/core/argon2.ts`. This avoids external asset packaging
or a Docker-only build step. The original `.wasm` file is retained for provenance,
checksum verification, and Node seed tooling. The binary is never downloaded or
selected from an untrusted request. There is no browser loader, WASI, or native
addon. The shared instance's entire hashing call is synchronous, so requests
cannot interleave its mutable memory.

Before replacing the binary, verify its source, license, SHA-256 and ABI, then run
the known-vector tests in Node and the deployed Deno runtime. Do not substitute a binary simply
because its export names match.

The independent `hash-wasm@4.12.0` Argon2id implementation gives this test vector
for `password` and salt `1234567890123456` with the configured parameters:

```
f1cf9cb471ea9a3aeb6cb39ece04f8ea5a87033066989e0a86366c702986caa2
```
