import { createApiHandler } from './app.js';
Deno.serve(createApiHandler(Deno.env.toObject()));
