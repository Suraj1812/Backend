import { createArgon2Module } from '../vendor/argon2/embedded.ts';
import { createArgon2Engine } from './argon2-engine.ts';

// Supabase's Deno runtime permits module compilation. The pinned bytes are part
// of the TypeScript bundle, so deploying requires no external static asset.
export const derive = createArgon2Engine(createArgon2Module()).derive;
