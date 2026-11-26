/** One line under the header while the daily backup has stopped (I26); nothing otherwise. */
export function BackupWarning({backup}: {backup: {last: string | null; stale: boolean} | undefined}) {
  if (backup?.stale !== true) return null;
  return (
    <p className="backup-warning" role="alert">
      {backup.last === null ? 'No backup has been taken' : `No backup since ${new Date(backup.last).toLocaleDateString(undefined, {dateStyle: 'medium'})}`} — see serve.log
    </p>
  );
}
