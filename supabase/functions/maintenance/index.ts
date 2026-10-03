import { createMaintenanceHandler } from './app.js';
Deno.serve(createMaintenanceHandler(Deno.env.toObject()));
