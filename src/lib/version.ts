import { createRequire } from 'node:module';

/** The package version, read from package.json (two levels up from both src/lib and dist/lib). */
export const VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
