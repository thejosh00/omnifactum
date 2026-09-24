/**
 * The clarify walk: one item, one question at a time, until the pile is gone.
 *
 * The screen holds nothing of its own. Which question is showing, what has been
 * answered and what the answers add up to all live in the reducer in `core/clarify.ts`
 * — the same one the terminal used — so this renders a value and forwards an answer.
 * Nothing is written until an item's walk is complete, and then it is one request.
 *
 * Walking the inbox is a pass, not a decision: filing one item brings up the next.
 * Clarifying a single task from anywhere else files that task and stops.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  answerClarify,
  backClarify,
  currentQuestion,
  startClarify,
  type ClarifyOutcome,
  type ClarifySession,
} from '../core/clarify.ts';
import {timeAgo} from '../core/format.ts';
import type {TaskState} from '../core/types.ts';
import {api, ApiError, type ProjectJson, type TaskJson} from './api.ts';

interface Tally {
  filed: number;
  dropped: number;
  skipped: number;
}

function describeOutcome(outcome: ClarifyOutcome): string {
  if (outcome.kind === 'discard') return 'Dropped';
  const where = outcome.state === 'waiting' && outcome.waitingOn !== undefined ? `waiting on ${outcome.waitingOn}` : outcome.state;
  return `Filed in ${where}`;
}

export function Clarify({
  ids,
  walking,
  now,
  onFiled,
  onClose,
  toast,
}: {
  /** The items to walk, in order. */
  ids: string[];
  /** A pass over the inbox, rather than one task. */
  walking: boolean;
  now: string;
  onFiled: () => void;
  onClose: () => void;
  toast: (text: string, tone?: 'info' | 'error') => void;
}) {
  const [position, setPosition] = useState(0);
  const [task, setTask] = useState<TaskJson>();
  const [session, setSession] = useState<ClarifySession>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectJson[]>([]);
  const [tally, setTally] = useState<Tally>({filed: 0, dropped: 0, skipped: 0});
  const input = useRef<HTMLInputElement>(null);

  const id = ids[position];
  const finished = id === undefined;
  const question = session === undefined ? undefined : currentQuestion(session);

  useEffect(() => {
    api.projects().then(
      list => setProjects(list.filter(project => project.state !== 'done')),
      () => setProjects([]),
    );
  }, []);

  const advance = useCallback(() => {
    setTask(undefined);
    setSession(undefined);
    setText('');
    setPosition(value => value + 1);
  }, []);

  // Load each item fresh when its turn comes. One that has gone, or been filed from
  // somewhere else while earlier ones were being answered, is passed over.
  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    api.show(id).then(
      loaded => {
        if (cancelled) return;
        if (walking && loaded.state !== 'inbox') {
          advance();
          return;
        }
        setTask(loaded);
        setSession(startClarify(loaded.id));
      },
      () => {
        if (!cancelled) advance();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, walking, advance]);

  // A single task that is done needs no summary: close as soon as it is filed.
  useEffect(() => {
    if (finished && !walking) onClose();
  }, [finished, walking, onClose]);

  const file = useCallback(
    async (item: TaskJson, outcome: ClarifyOutcome) => {
      setBusy(true);
      try {
        await api.clarify(item.id, item.state as TaskState, outcome);
        setTally(t => (outcome.kind === 'discard' ? {...t, dropped: t.dropped + 1} : {...t, filed: t.filed + 1}));
        toast(`${describeOutcome(outcome)}: "${item.title}"`);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) {
          toast(error instanceof Error ? error.message : String(error), 'error');
          setBusy(false);
          return;
        }
        // Someone else dealt with it first. Say so, and carry on.
        toast(error.message);
        setTally(t => ({...t, skipped: t.skipped + 1}));
      }
      setBusy(false);
      onFiled();
      advance();
    },
    [toast, onFiled, advance],
  );

  const answer = useCallback(
    (value: string) => {
      if (session === undefined || task === undefined || busy) return;
      const next = answerClarify(session, value);
      if (next === session) return;
      setText('');
      if (next.outcome === undefined) setSession(next);
      else void file(task, next.outcome);
    },
    [session, task, busy, file],
  );

  const back = useCallback(() => {
    if (session !== undefined) {
      setSession(backClarify(session));
      setText('');
    }
  }, [session]);

  const skip = useCallback(() => {
    setTally(t => ({...t, skipped: t.skipped + 1}));
    advance();
  }, [advance]);

  // Keys, taken before the rest of the app sees them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const typing = event.target instanceof HTMLInputElement;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (typing || question === undefined) return;
      const choice = question.choices.find(option => option.key === event.key);
      if (choice !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        answer(choice.answer);
      } else if (event.key === 'b' || event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        back();
      } else if (event.key === 'ArrowRight' && walking) {
        event.preventDefault();
        event.stopPropagation();
        skip();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [question, answer, back, skip, walking, onClose]);

  const textQuestion = question !== undefined && question.choices.length === 0;
  useEffect(() => {
    if (textQuestion) input.current?.focus();
  }, [textQuestion, session?.step]);

  const suggestions = useMemo(() => {
    if (session?.step === 'project') return projects.map(project => project.title);
    return [];
  }, [session?.step, projects]);

  const remaining = Math.max(0, ids.length - position - 1);

  return (
    <div className="scrim clarify-scrim">
      <section className="modal clarify" role="dialog" aria-modal="true" aria-label="Clarify">
        <header className="clarify-head">
          <span className="muted small">
            {walking ? (finished ? 'Inbox' : `Clarifying · ${remaining} more after this`) : 'Clarifying'}
          </span>
          <button className="icon" onClick={onClose} aria-label="Stop clarifying">
            ✕
          </button>
        </header>

        {finished ? (
          <div className="clarify-done">
            <h2>{tally.filed + tally.dropped === ids.length ? 'Inbox zero.' : 'That was everything.'}</h2>
            <p className="muted">
              {tally.filed} filed · {tally.dropped} dropped{tally.skipped > 0 ? ` · ${tally.skipped} left for later` : ''}
            </p>
            <div className="modal-actions">
              <button className="primary" autoFocus onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : task === undefined || question === undefined ? (
          <p className="muted" aria-busy="true">
            Loading…
          </p>
        ) : (
          <>
            <div className="clarify-item">
              <h2>{task.title}</h2>
              <p className="muted small">
                captured {timeAgo(task.created, now)}
                {task.tags.length > 0 && ` · ${task.tags.map(tag => `#${tag}`).join(' ')}`}
                {task.project !== undefined && ` · +${task.project}`}
              </p>
              {task.body.trim().length > 0 && <p className="clarify-body">{task.body.trim().split('\n').slice(0, 4).join('\n')}</p>}
            </div>

            <div className="clarify-question">
              <h3>{question.prompt}</h3>
              {question.hint !== undefined && <p className="muted small">{question.hint}</p>}

              {question.choices.length > 0 ? (
                <div className="choices">
                  {question.choices.map(choice => (
                    <button key={choice.key} className="choice" disabled={busy} onClick={() => answer(choice.answer)}>
                      <kbd>{choice.key}</kbd> {choice.label}
                    </button>
                  ))}
                </div>
              ) : (
                <form
                  onSubmit={event => {
                    event.preventDefault();
                    answer(text);
                  }}
                >
                  <input
                    ref={input}
                    value={text}
                    placeholder={question.placeholder}
                    list={suggestions.length > 0 ? 'clarify-suggestions' : undefined}
                    disabled={busy}
                    onChange={event => setText(event.target.value)}
                  />
                  {suggestions.length > 0 && (
                    <datalist id="clarify-suggestions">
                      {suggestions.map(value => (
                        <option key={value} value={value} />
                      ))}
                    </datalist>
                  )}
                  {session?.step === 'tags' && task.tags.length > 0 && (
                    <p className="muted small">Keeps {task.tags.map(tag => `#${tag}`).join(' ')}.</p>
                  )}
                </form>
              )}
            </div>

            <footer className="clarify-foot">
              <button className="quiet small" onClick={back} disabled={session?.history.length === 0}>
                ← Back <kbd>b</kbd>
              </button>
              {textQuestion && (
                <button className="primary small" onClick={() => answer(text)} disabled={busy}>
                  Next ↵
                </button>
              )}
              {walking && (
                <button className="quiet small" onClick={skip}>
                  Leave it for later <kbd>→</kbd>
                </button>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
