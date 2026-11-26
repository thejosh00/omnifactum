/** R30: the banner renders its line when the daily backup is stale and nothing otherwise (I26). */
import {expect, test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {BackupWarning} from '../../src/web/BackupWarning.tsx';

test('the backup banner renders its line when stale and nothing otherwise', () => {
  const stale = renderToStaticMarkup(<BackupWarning backup={{last: '2026-09-10T12:00:00.000Z', stale: true}} />);
  console.log(`stale:  ${stale}`);
  expect(stale).toStartWith('<p class="backup-warning" role="alert">No backup since ');
  expect(stale).toContain('2026');
  expect(stale).toEndWith(' — see serve.log</p>');
  const never = renderToStaticMarkup(<BackupWarning backup={{last: null, stale: true}} />);
  console.log(`never:  ${never}`);
  expect(never).toBe('<p class="backup-warning" role="alert">No backup has been taken — see serve.log</p>');
  expect(renderToStaticMarkup(<BackupWarning backup={{last: '2026-09-12T12:00:00.000Z', stale: false}} />)).toBe('');
  expect(renderToStaticMarkup(<BackupWarning backup={undefined} />)).toBe('');
});

test('the banner is its own full-width row, so the tabs, list and detail keep their places', async () => {
  const css = await Bun.file(new URL('../../src/web/styles.css', import.meta.url)).text();
  const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.()>]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  expect(rule('.app')).toContain('grid-template-rows: auto auto 1fr;');
  expect(rule('.app:has(> .backup-warning)')).toContain('grid-template-rows: auto auto auto 1fr;');
  expect(rule('.backup-warning')).toContain('grid-column: 1 / -1;');
  expect(rule('.detail')).toContain('grid-row: -2;');
});
