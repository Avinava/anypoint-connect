/**
 * Package version
 * Single source of truth — read from package.json at build time
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION = pkg.version;
