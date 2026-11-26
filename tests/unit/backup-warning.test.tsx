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
