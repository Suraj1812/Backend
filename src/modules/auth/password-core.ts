import { hmac } from '../../core/crypto';

// Keep the tagged format exact: corrupted/unrecognized parameters never become
// user-controlled KDF work factors. The WASM engine fixes Argon2id v19,
// m=19 MiB, t=2, p=1, and produces a 32-byte key.
export const PASSWORD_FORMAT = 'argon2id-peppered-v1$v=19$m=19456,t=2,p=1';
const CHECK_MESSAGE = new TextEncoder().encode('api-foundation:password-verification:v1');
const DUMMY_HASH = `${PASSWORD_FORMAT}$${'00'.repeat(16)}$${'00'.repeat(32)}`;
const FORMAT_PATTERN = /^argon2id-peppered-v1\$v=19\$m=19456,t=2,p=1\$[a-f0-9]{32}\$[a-f0-9]{64}$/;
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) =>
  Uint8Array.from(value.match(/../g)!, (b) => Number.parseInt(b, 16));
export type PasswordDerive = (material: Uint8Array, salt: Uint8Array) => Uint8Array;

// Dependency injection lets the seed script load the exact same static WASM
// bytes with Node's filesystem without importing a platform-specific WASM loader.
export function createPasswordHelpers(derive: PasswordDerive) {
  async function passwordKey(
    password: string,
    pepper: string,
    salt: Uint8Array,
  ): Promise<CryptoKey> {
    const material = await hmac(password, pepper);
    const input = new TextEncoder().encode(material);
    let derived: Uint8Array | undefined;
    let importBytes: Uint8Array<ArrayBuffer> | undefined;
    try {
      try {
        derived = derive(input, salt);
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        const known = [
          'The password hashing engine has an unsupported ABI',
          'The password hashing engine could not allocate memory',
          'The password hashing engine could not complete the derivation',
          'The password hashing engine is not initialized',
          'The password hashing engine accessed invalid memory',
          'The password hashing engine returned invalid memory',
        ];
        console.error(
          JSON.stringify({
            event: 'password_derivation_failed',
            reason: known.includes(reason) ? reason : 'runtime_failure',
          }),
        );
        throw error;
      }
      if (derived.byteLength !== 32) throw new Error('Invalid password KDF output');
      importBytes = new Uint8Array(derived);
      return await crypto.subtle.importKey(
        'raw',
        importBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      );
    } finally {
      input.fill(0);
      derived?.fill(0);
      importBytes?.fill(0);
    }
  }

  async function hashPassword(password: string, pepper: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await passwordKey(password, pepper, salt);
    const verifier = await crypto.subtle.sign('HMAC', key, CHECK_MESSAGE);
    return `${PASSWORD_FORMAT}$${hex(salt)}$${hex(verifier)}`;
  }

  async function verifyPassword(
    password: string,
    stored: string | null | undefined,
    pepper: string,
  ): Promise<boolean> {
    const validFormat = typeof stored === 'string' && FORMAT_PATTERN.test(stored);
    const [, , , salt, verifier] = (validFormat ? stored! : DUMMY_HASH).split('$');
    const key = await passwordKey(password, pepper, unhex(salt!));
    // A missing/corrupt account still performs the same expensive derivation.
    // Native HMAC verification compares the verifier in constant time.
    const matches = await crypto.subtle.verify('HMAC', key, unhex(verifier!), CHECK_MESSAGE);
    return validFormat && matches;
  }

  return { hashPassword, verifyPassword };
}
