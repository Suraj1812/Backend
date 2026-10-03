import { hmac } from '../../core/crypto';

// Deployed Workers currently cap a single native PBKDF2 call at 100,000 iterations.
// See SECURITY.md for this platform tradeoff and the external-IdP upgrade path.
export const PASSWORD_ITERATIONS = 100_000;
const FORMAT = 'pbkdf2-sha256-peppered-v1';
const CHECK_MESSAGE = new TextEncoder().encode('api-foundation:password-verification:v1');
const DUMMY_HASH = `${FORMAT}$${PASSWORD_ITERATIONS}$${'00'.repeat(16)}$${'00'.repeat(32)}`;
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/../g)!, b => Number.parseInt(b, 16));

async function passwordKey(password: string, pepper: string, salt: Uint8Array): Promise<CryptoKey> {
  // A pepper is a separate Worker secret; a database dump does not expose it.
  const material = await hmac(password, pepper);
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(material), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: PASSWORD_ITERATIONS, salt }, baseKey, 256);
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hashPassword(password: string, pepper: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await passwordKey(password, pepper, salt);
  const verifier = await crypto.subtle.sign('HMAC', key, CHECK_MESSAGE);
  return `${FORMAT}$${PASSWORD_ITERATIONS}$${hex(salt)}$${hex(verifier)}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined, pepper: string): Promise<boolean> {
  const validFormat = typeof stored === 'string' && new RegExp(`^${FORMAT}\\$${PASSWORD_ITERATIONS}\\$[a-f0-9]{32}\\$[a-f0-9]{64}$`).test(stored);
  const [, , salt, verifier] = (validFormat ? stored! : DUMMY_HASH).split('$');
  const key = await passwordKey(password, pepper, unhex(salt!));
  // Native HMAC verification compares the verifier in constant time. A missing
  // account still performs the same expensive derivation as an existing account.
  const matches = await crypto.subtle.verify('HMAC', key, unhex(verifier!), CHECK_MESSAGE);
  return validFormat && matches;
}
