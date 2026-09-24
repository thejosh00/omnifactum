/**
 * The weekly review walk: a banner over the ordinary lists.
 *
 * A weekly review is a tour of lists you already have, with a different question asked
 * of each, so the walk does not replace the list — it sits above it and switches it. Every
 * key that works on a list works during the walk, so finding a problem and fixing it does
 * not cost you your place. The plan is re-read after every change, so a step you have just
 * cleared says so.
 *
 * The projects step has no list of tasks to show, so it shows the active projects instead.
 */
import type {WeeklyPlan} from './api.ts';

export function WeeklyBanner({
  plan,
  index,
  recorded,
  onStep,
  onFinish,
  onExit,
  onOpenTask,
}: {
  plan: WeeklyPlan;
  index: number;
  /** Set once the pass has been recorded, with how many projects were stamped. */
  recorded: number | undefined;
  onStep: (index: number) => void;
  onFinish: () => void;
  onExit: () => void;
  onOpenTask: (id: string) => void;
}) {
  const total = plan.steps.length;

  if (recorded !== undefined) {
    return (
      <section className="weekly weekly-finished" aria-label="Weekly review">
        <div>
          <h2>Review recorded.</h2>
          <p className="muted">
            {recorded > 0 ? `${recorded} active project${recorded === 1 ? '' : 's'} stamped as reviewed. ` : ''}
            See you next week.
          </p>
        </div>
        <button className="primary" onClick={onExit} autoFocus>
          Done
        </button>
      </section>
    );
  }

  const step = plan.steps[index];
  if (step === undefined) return null;
  const clear = step.flags.length === 0;
  const last = index === total - 1;

  return (
    <section className="weekly" aria-label="Weekly review">
      <header className="weekly-head">
        <span className="muted small">
          Weekly review · {index + 1} of {total}
        </span>
        <ol className="weekly-dots" aria-hidden="true">
          {plan.steps.map((s, i) => (
            <li
              key={s.step}
              className={`${i === index ? 'current' : ''} ${s.flags.length === 0 ? 'clear' : 'attention'}`}
              title={s.title}
              onClick={() => onStep(i)}
            />
          ))}
        </ol>
        <button className="icon" onClick={onExit} aria-label="Leave the review">
          ✕
        </button>
      </header>

      <h2>
        {step.title} <span className="muted weekly-count">{step.count}</span>
        {clear && <span className="weekly-clear">clear</span>}
      </h2>
      <p className="weekly-prompt">{step.prompt}</p>

      {step.flags.length > 0 && (
        <ul className="weekly-flags">
          {step.flags.map((flag, i) => {
            const task = step.flag_tasks[i];
            return (
              <li key={flag}>
                {task === null || task === undefined ? (
                  flag
                ) : (
                  <button className="link" onClick={() => onOpenTask(task)}>
                    {flag}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <footer className="weekly-foot">
        <button className="quiet small" onClick={() => onStep(index - 1)} disabled={index === 0}>
          ← Back <kbd>b</kbd>
        </button>
        {last ? (
          <button className="primary" onClick={onFinish}>
            Finish and record
          </button>
        ) : (
          <button className="primary" onClick={() => onStep(index + 1)}>
            Next: {plan.steps[index + 1]?.title} <kbd>n</kbd>
          </button>
        )}
      </footer>
    </section>
  );
}
