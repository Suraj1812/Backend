import { readFileSync, writeFileSync } from 'node:fs';
import { openApiDocument } from '../src/openapi';
import SwaggerParser from '@apidevtools/swagger-parser';

await SwaggerParser.validate(JSON.parse(readFileSync('docs/maintenance-openapi.json', 'utf8')));

// Validate standards compliance, including references, before checking or exporting.
await SwaggerParser.validate(JSON.parse(JSON.stringify(openApiDocument)));

const output = JSON.stringify(openApiDocument, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync('docs/openapi.json', 'utf8') !== output)
    throw new Error('OpenAPI export is stale. Run npm run openapi:export');
  console.log('OpenAPI export matches the runtime specification.');
} else {
  writeFileSync('docs/openapi.json', output);
  console.log('Exported docs/openapi.json');
}
