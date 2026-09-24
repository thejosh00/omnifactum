/**
 * Projects: the list, one project in full, and starting a new one.
 *
 * A project is an outcome that needs more than one action. What makes it worth more than
 * a tag is the outcome statement and the stalled check: a project with nothing in `next`
 * or `waiting` is not moving, and this page says so where you will see it, with a box
 * right there to add the next action.
 *
 * Every change goes through the same rules as `omni project`: renaming repoints the
 * member tasks, and finishing a project with open actions asks first.
 */
import {useCallback, useEffect, useState} from 'react';
import {timeAgo} from '../core/format.ts';
import {TASK_STATES} from '../core/types.ts';
import {api, ApiError, type ProjectDetail, type ProjectJson, type ProjectState, type TaskJson} from './api.ts';
import {Modal} from './Dialogs.tsx';

const SECTIONS: Array<{state: ProjectState; title: string}> = [
  {state: 'active', title: 'Active'},
  {state: 'someday', title: 'Someday'},
  {state: 'done', title: 'Done'},
];

function ProjectRow({project, now, onOpen}: {project: ProjectJson; now: string; onOpen: () => void}) {
  return (
    <li className="row project-row" onClick={onOpen}>
      <span className="row-title">
        {project.title}
        {project.outcome.trim().length > 0 ? (
          <span className="project-outcome"> — {project.outcome}</span>
        ) : (
          <span className="project-outcome warn"> — no outcome yet</span>
        )}
      </span>
      <span className="row-meta">
        {project.state === 'active' &&
          (project.stalled ? (
            <span className="meta stalled">stalled</span>
          ) : (
            <span className="meta">
              {project.live_actions} live action{project.live_actions === 1 ? '' : 's'}
            </span>
          ))}
        {project.state === 'done' && project.done !== undefined ? (
          <span className="meta">finished {timeAgo(project.done, now)}</span>
        ) : (
          <span className="meta">
            {project.reviewed === undefined ? 'never reviewed' : `reviewed ${timeAgo(project.reviewed, now)}`}
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * The list of projects. With `activeOnly`, just the active ones and no chrome, for the
 * weekly review's projects step.
 */
export function ProjectsView({
  now,
  revision,
  activeOnly = false,
  onOpen,
  onNew,
}: {
  now: string;
  revision: number;
  activeOnly?: boolean;
  onOpen: (id: string) => void;
  onNew?: () => void;
}) {
  const [projects, setProjects] = useState<ProjectJson[]>();
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    api.projects().then(setProjects, () => setProjects([]));
  }, [revision]);

  if (projects === undefined) return null;

  if (activeOnly) {
    const active = projects.filter(project => project.state === 'active');
    if (active.length === 0) {
      return <p className="empty">No active projects. Anything that takes more than one action could be one.</p>;
    }
    return (
      <ul className="rows projects">
        {active.map(project => (
          <ProjectRow key={project.id} project={project} now={now} onOpen={() => onOpen(project.id)} />
        ))}
      </ul>
    );
  }

  const stalled = projects.filter(project => project.state === 'active' && project.stalled).length;
  return (
    <>
      <div className="list-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">
            Outcomes that take more than one action
            {stalled > 0 && <span className="stalled-note"> · {stalled} stalled</span>}
          </p>
        </div>
        <div className="list-tools">
          <button className="primary" onClick={onNew}>
            New project
          </button>
        </div>
      </div>
      {projects.length === 0 ? (
        <p className="empty">No projects yet. Anything that takes more than one action to finish is one.</p>
      ) : (
        SECTIONS.map(section => {
          const inSection = projects.filter(project => project.state === section.state);
          if (inSection.length === 0) return null;
          const collapsed = section.state === 'done' && !showDone;
          return (
            <section key={section.state} className="project-section">
              <h2>
                {section.state === 'done' ? (
                  <button className="link" onClick={() => setShowDone(value => !value)}>
                    {section.title} ({inSection.length}) {collapsed ? '▸' : '▾'}
                  </button>
                ) : (
                  <>
                    {section.title} <span className="muted">{inSection.length}</span>
                  </>
                )}
              </h2>
              {!collapsed && (
                <ul className="rows projects">
                  {inSection.map(project => (
                    <ProjectRow key={project.id} project={project} now={now} onOpen={() => onOpen(project.id)} />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </>
  );
}

export function NewProjectDialog({onCreated, onClose}: {onCreated: (project: ProjectJson) => void; onClose: () => void}) {
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (title.trim().length === 0) return setError('A project needs a title.');
    if (outcome.trim().length === 0) return setError('Say what done looks like. That is what makes it a project.');
    try {
      onCreated(await api.createProject(title, outcome));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <Modal title="New project" onClose={onClose}>
      <form
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="project-title">What is it?</label>
        <input id="project-title" autoFocus value={title} placeholder="Renovate the kitchen" onChange={e => setTitle(e.target.value)} />
        <label htmlFor="project-outcome" className="spaced">
          What does done look like?
        </label>
        <input
          id="project-outcome"
          value={outcome}
          placeholder="Cooking dinner in the new kitchen"
          onChange={e => setOutcome(e.target.value)}
        />
        {error !== undefined && <p className="field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

type Field = 'outcome' | 'body';

export function ProjectPanel({
  id,
  revision,
  now,
  onClose,
  onOpenTask,
  onChanged,
  toast,
}: {
  id: string;
  revision: number;
  now: string;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  onChanged: () => void;
  toast: (text: string, tone?: 'info' | 'error') => void;
}) {
  const [detail, setDetail] = useState<ProjectDetail>();
  const [missing, setMissing] = useState(false);
  const [body, setBody] = useState('');
  const [bodyBase, setBodyBase] = useState<{text: string; version: number}>();
  const [next, setNext] = useState('');
  const [clash, setClash] = useState<{field: Field; mine: string; theirs: ProjectJson}>();
  const [finishing, setFinishing] = useState<TaskJson[]>();

  const dirty = bodyBase !== undefined && body !== bodyBase.text;

  const load = useCallback(
    async (keepDraft: boolean) => {
      try {
        const loaded = await api.project(id);
        setDetail(loaded);
        setMissing(false);
        if (!keepDraft) {
          setBody(loaded.body);
          setBodyBase({text: loaded.body, version: loaded.project.version});
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) setMissing(true);
      }
    },
    [id],
  );

  useEffect(() => {
    void load(dirty);
    // `dirty` is read, not reacted to: only a new id or revision refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, revision, load]);

  const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error');

  /** Save a replaced field; re-send quietly if someone else changed something else. */
  const save = async (field: Field, value: string, base: {value: string; version: number}) => {
    const send = (version: number) => api.patchProject(id, version, {[field]: value});
    try {
      await send(base.version);
    } catch (error) {
      const theirs = error instanceof ApiError && error.status === 409 ? (error.body['project'] as ProjectJson | undefined) : undefined;
      if (theirs === undefined) return fail(error);
      const fresh = await api.project(id);
      const theirValue = field === 'body' ? fresh.body : fresh.project.outcome;
      if (theirValue !== base.value) {
        setDetail(fresh);
        setClash({field, mine: value, theirs: fresh.project});
        return;
      }
      try {
        await send(fresh.project.version);
      } catch (retry) {
        return fail(retry);
      }
    }
    await load(false);
    onChanged();
  };

  const move = async (to: ProjectState, force = false) => {
    try {
      await api.moveProject(id, to, force);
      setFinishing(undefined);
      toast(to === 'done' ? 'Project finished' : `Moved to ${to}`);
      await load(dirty);
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && Array.isArray(error.body['open'])) {
        setFinishing(error.body['open'] as TaskJson[]);
        return;
      }
      fail(error);
    }
  };

  const addNext = async () => {
    const title = next.trim();
    if (title.length === 0 || detail === undefined) return;
    try {
      await api.create({title, state: 'next', project: detail.project.stem});
      setNext('');
      await load(dirty);
      onChanged();
    } catch (error) {
      fail(error);
    }
  };

  if (missing) {
    return (
      <aside className="detail">
        <header className="detail-head">
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="empty">This project no longer exists.</p>
      </aside>
    );
  }
  if (detail === undefined) return <aside className="detail" aria-busy="true" />;

  const {project, tasks, log} = detail;
  const open = tasks.filter(task => task.state !== 'done');
  const finished = tasks.filter(task => task.state === 'done');

  return (
    <aside className="detail" aria-label={project.title}>
      <header className="detail-head">
        <span className={`state-pill project-${project.state}`}>{project.state}</span>
        <span className="muted">
          {project.stem} · v{project.version}
        </span>
        <button className="icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {clash !== undefined && (
        <div className="clash" role="alert">
          <p>
            <strong>Someone else changed the {clash.field === 'body' ? 'notes' : 'outcome'}</strong> while you were editing it.
          </p>
          <div className="clash-actions">
            <button
              className="primary"
              onClick={() => {
                const {field, mine, theirs} = clash;
                setClash(undefined);
                void save(field, mine, {value: field === 'body' ? detail.body : theirs.outcome, version: theirs.version});
              }}
            >
              Keep mine
            </button>
            <button
              className="quiet"
              onClick={() => {
                setClash(undefined);
                void load(false);
              }}
            >
              Use theirs
            </button>
          </div>
        </div>
      )}

      <input
        className="detail-title"
        key={`${project.id}-${project.title}`}
        defaultValue={project.title}
        aria-label="Project title"
        onBlur={event => {
          const value = event.target.value.trim();
          const input = event.target;
          if (value.length === 0 || value === project.title) {
            input.value = project.title;
            return;
          }
          api.renameProject(id, value).then(
            result => {
              toast(result.repointed > 0 ? `Renamed; ${result.repointed} task${result.repointed === 1 ? '' : 's'} repointed` : 'Renamed');
              void load(dirty);
              onChanged();
            },
            error => {
              // Nothing was saved, so do not leave it looking as if it was.
              input.value = project.title;
              fail(error);
            },
          );
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />

      <label className="field outcome-field">
        <span>Done looks like</span>
        <input
          key={`${project.id}-${project.outcome}`}
          defaultValue={project.outcome}
          placeholder="What will be true when this is finished?"
          onBlur={event => {
            const value = event.target.value.trim();
            if (value.length === 0) {
              event.target.value = project.outcome;
              toast('A project needs an outcome.', 'error');
              return;
            }
            if (value !== project.outcome) void save('outcome', value, {value: project.outcome, version: project.version});
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
        />
      </label>

      <div className="detail-actions project-states" role="group" aria-label="Project state">
        {(['active', 'someday', 'done'] as const).map(state => (
          <button
            key={state}
            className={state === project.state ? 'chosen' : ''}
            disabled={state === project.state}
            onClick={() => void move(state)}
          >
            {state === 'done' ? 'Finished' : state === 'active' ? 'Active' : 'Someday'}
          </button>
        ))}
      </div>

      {finishing !== undefined && (
        <div className="clash" role="alert">
          <p>
            <strong>
              {finishing.length} action{finishing.length === 1 ? ' is' : 's are'} still open.
            </strong>{' '}
            An outcome is not usually reached while work towards it is still waiting.
          </p>
          <ul className="open-actions">
            {finishing.map(task => (
              <li key={task.id}>
                <button className="link" onClick={() => onOpenTask(task.id)}>
                  {task.title}
                </button>{' '}
                <span className="muted small">{task.state}</span>
              </li>
            ))}
          </ul>
          <div className="clash-actions">
            <button className="primary" onClick={() => void move('done', true)}>
              Finish anyway
            </button>
            <button className="quiet" onClick={() => setFinishing(undefined)}>
              Not yet
            </button>
          </div>
        </div>
      )}

      {project.state === 'active' && project.stalled && (
        <p className="stalled-banner">Nothing in next or waiting moves this forward. What is the very next action?</p>
      )}

      {project.state !== 'done' && (
        <form
          className="add-next"
          onSubmit={event => {
            event.preventDefault();
            void addNext();
          }}
        >
          <input value={next} placeholder="Add the next action…" aria-label="Add the next action" onChange={e => setNext(e.target.value)} />
          <button className="primary" disabled={next.trim().length === 0}>
            Add
          </button>
        </form>
      )}

      <section className="notes">
        <h3>Actions</h3>
        {open.length === 0 && finished.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="project-tasks">
            {[...open]
              .sort((a, b) => TASK_STATES.indexOf(a.state as never) - TASK_STATES.indexOf(b.state as never))
              .map(task => (
                <li key={task.id}>
                  <button className="link" onClick={() => onOpenTask(task.id)}>
                    {task.title}
                  </button>
                  <span className={`state-pill state-${task.state}`}>{task.state}</span>
                </li>
              ))}
            {finished.length > 0 && (
              <li className="muted small">
                {finished.length} finished action{finished.length === 1 ? '' : 's'}
              </li>
            )}
          </ul>
        )}
      </section>

      <section className="notes">
        <h3>Notes</h3>
        <textarea
          value={body}
          placeholder="Plans, links, anything worth keeping with the project."
          rows={Math.min(14, Math.max(3, body.split('\n').length + 1))}
          onChange={event => setBody(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              (event.target as HTMLTextAreaElement).blur();
              event.stopPropagation();
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && dirty && bodyBase !== undefined) {
              void save('body', body, {value: bodyBase.text, version: bodyBase.version});
            }
          }}
        />
        {dirty && bodyBase !== undefined && (
          <div className="notes-actions">
            <button className="primary" onClick={() => void save('body', body, {value: bodyBase.text, version: bodyBase.version})}>
              Save notes
            </button>
            <button className="quiet" onClick={() => setBody(bodyBase.text)}>
              Discard
            </button>
          </div>
        )}
      </section>

      <section className="log">
        <h3>Log</h3>
        {log.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ol>
            {[...log].reverse().map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <div className="log-meta">
                  <span className={entry.actor.startsWith('agent:') ? 'actor agent' : 'actor'}>{entry.actor || 'someone'}</span>
                  <time dateTime={entry.at}>{entry.at === '' ? '' : timeAgo(entry.at, now)}</time>
                </div>
                <p>{entry.text}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="muted small">
        Started {timeAgo(project.created, now)}
        {project.reviewed !== undefined && ` · reviewed ${timeAgo(project.reviewed, now)}`}
      </p>
    </aside>
  );
}
