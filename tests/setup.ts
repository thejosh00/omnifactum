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

// Calendar days are local. Running the suite somewhere that is not UTC is what proves
// it: on a UTC machine, a day counted in UTC and a day counted locally are the same day,
// and every test would pass either way. Chicago in September is UTC-5, so a task due
// "today" at 9pm there is already tomorrow in UTC.
process.env['TZ'] = 'America/Chicago';
delete process.env['OMNI_URL'];
delete process.env['OMNI_ACTOR'];
