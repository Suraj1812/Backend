import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArgon2Module } from '../src/vendor/argon2/embedded';
import { derive } from '../src/core/argon2';
import { createArgon2Engine } from '../src/core/argon2-engine';

const material = new TextEncoder().encode('password');
const salt = new TextEncoder().encode('1234567890123456');
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
const expected = 'f1cf9cb471ea9a3aeb6cb39ece04f8ea5a87033066989e0a86366c702986caa2';
const module = createArgon2Module();

afterEach(() => vi.restoreAllMocks());

describe('portable Argon2id engine', () => {
  it('matches an independent reference vector using bundled bytes', () => {
    expect(hex(derive(material, salt))).toBe(expected);
  });

  it('reuses the heap without aliasing earlier output or later calls', () => {
    const first = derive(material, salt);
    expect(hex(derive(new TextEncoder().encode('different password'), salt))).not.toBe(expected);
    expect(hex(first)).toBe(expected);
    first.fill(0);
    expect(hex(derive(material, salt))).toBe(expected);
  });

  it('rejects oversized inputs and invalid salts before allocating a heap', () => {
    const grow = vi.spyOn(WebAssembly.Memory.prototype, 'grow');
    const engine = createArgon2Engine(module);
    expect(() => engine.derive(new Uint8Array(1025), salt)).toThrow('1024 bytes');
    expect(() => engine.derive(new Uint8Array(), salt)).toThrow('1024 bytes');
    expect(() => engine.derive(material, new Uint8Array(15))).toThrow('16 bytes');
    expect(grow).not.toHaveBeenCalled();
  });

  it('fails closed if the runtime cannot grow the heap and can recover on retry', () => {
    const engine = createArgon2Engine(module);
    const grow = vi.spyOn(WebAssembly.Memory.prototype, 'grow').mockImplementation(() => {
      throw new RangeError('Memory limit');
    });
    expect(() => engine.derive(material, salt)).toThrow('could not complete');
    grow.mockRestore();
    expect(hex(engine.derive(material, salt))).toBe(expected);
  });
});
