import { build } from 'esbuild';
// Bundle local modules and npm packages for Deno: no Docker/static-file loader.
for (const name of ['backend', 'maintenance']) {
  await build({
    entryPoints: ['src/runtime/handler.ts'],
    outfile: `supabase/functions/${name}/app.js`,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['node:*'],
    plugins: [
      {
        name: 'deno-postgres',
        setup(builder) {
          builder.onResolve({ filter: /^postgres$/ }, () => ({
            path: 'npm:postgres@3.4.9',
            external: true,
          }));
        },
      },
    ],
    packages: 'bundle',
    logLevel: 'warning',
  });
}
console.log('Built both Supabase Edge Function bundles.');
