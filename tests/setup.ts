/**
 * Loaded before every test file. Nothing a test runs may ever reach the real
 * `~/.omnifactum`, so the default data directory is pointed somewhere disposable before
 * any code has a chance to read it. A test that forgets to pass its own directory then
 * writes here, not into someone's real database.
 */
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

process.env['OMNI_DIR'] = mkdtempSync(join(tmpdir(), 'omni-guard-'));
delete process.env['OMNI_TOKEN'];
delete process.env['OMNI_URL'];
delete process.env['OMNI_ACTOR'];
