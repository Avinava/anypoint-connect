/**
 * Point HOME at an empty directory for every test file, so no test reads the developer's real
 * ~/.anypoint-connect (profiles, tokens, production approvals).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
