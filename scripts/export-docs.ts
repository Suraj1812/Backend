import { readFileSync, writeFileSync } from 'node:fs';
import { format } from 'prettier';
import { apiReference, referenceCss } from '../src/core/api-reference';
const options = JSON.parse(readFileSync('.prettierrc.json', 'utf8'));
writeFileSync('docs/index.html', await format(apiReference(), { ...options, parser: 'html' }));
writeFileSync('docs/docs.css', await format(referenceCss, { ...options, parser: 'css' }));
console.log('Exported portable HTML API reference.');
