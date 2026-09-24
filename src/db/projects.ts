/**
 * Changing projects, shared by `omni project` and the web app.
 *
 * Each operation resolves the project and changes it inside one transaction, so the
 * check and the write see the same world. Failures are thrown as `ProjectError` with a
 * kind the caller turns into an exit code or an HTTP status.
 */
import {
  planCompleteProject,
  planMoveProject,
  planNewProject,
  planRenameProject,
  planSetOutcome,
  resolveProjectRef,
} from '../core/project.ts';
import {projectToJson, type ProjectJson} from '../core/serialize.ts';
import {membershipFor, type Snapshot} from '../core/snapshot.ts';
import {titleFromStem} from '../core/task.ts';
import type {Project, ProjectFile, ProjectState, TaskFile} from '../core/types.ts';
import type {Store, Updated} from './store.ts';

export type ProjectErrorKind = 'usage' | 'not-found' | 'ambiguous' | 'open-actions' | 'stale';

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly kind: ProjectErrorKind,
    /** For `open-actions`, what is still open; for `ambiguous`, the candidates; for `stale`, the current project. */
    readonly detail: {open?: TaskFile[]; candidates?: ProjectFile[]; current?: ProjectFile} = {},
  ) {
    super(message);
  }
}

/** Find a project by stem, id, title, alias or id prefix, or throw. */
export function requireProject(snapshot: Snapshot, ref: string): ProjectFile {
  const match = resolveProjectRef(snapshot.projects, ref);
  if (match.kind === 'ok') return match.project;
  if (match.kind === 'ambiguous') {
    throw new ProjectError(`"${ref}" matches more than one project`, 'ambiguous', {candidates: match.candidates});
  }
  throw new ProjectError(`no project matches "${ref}"`, 'not-found');
}

/** A project as JSON, with its live actions and stalled flag worked out from the store. */
export function projectJson(store: Store, file: ProjectFile): ProjectJson {
  const entry = membershipFor(store.load(), file.project.id);
  return projectToJson(file, {liveActions: entry?.live.length ?? 0, stalled: entry?.stalled ?? false});
}

function settled(result: Updated<ProjectFile>): ProjectFile {
  switch (result.kind) {
    case 'ok':
      return result.file;
    case 'not-found':
      throw new ProjectError('that project is no longer there', 'not-found');
    case 'failed':
      throw new ProjectError(result.reason, 'usage');
    case 'stale':
      throw new ProjectError('someone else changed this project while you were editing it', 'stale', {
        current: result.file,
      });
  }
}

export interface NewProject {
  title: string;
  outcome: string;
  nowIso: string;
  tags?: string[];
  due?: string;
}

export function createProject(store: Store, input: NewProject): ProjectFile {
  let planned: Project;
  try {
    planned = planNewProject({id: store.mintId(), ...input});
  } catch (error) {
    throw new ProjectError(error instanceof Error ? error.message : String(error), 'usage');
  }
  return settled(store.createProjectSafely(planned));
}

/**
 * The stem a task should point at for `ref`, starting the project if there is none.
 *
 * A task's project is a link to a project you can open, not free text, so naming one
 * that does not exist — `+kitchen` in a capture, a new name in clarify — starts it
 * rather than leaving a dangling reference. It starts without an outcome; see
 * `outcomeLater`. A name that matches more than one project is refused, not guessed.
 */
export function ensureProject(store: Store, ref: string, nowIso: string): {stem: string; created?: ProjectFile} {
  return store.batch(() => {
    const match = resolveProjectRef(store.load().projects, ref);
    if (match.kind === 'ok') return {stem: match.project.stem};
    if (match.kind === 'ambiguous') {
      throw new ProjectError(`"${ref}" matches more than one project`, 'ambiguous', {candidates: match.candidates});
    }
    const name = ref.trim();
    // A capture token is a stem (`+kitchen-reno`); a typed name is already a title.
    const title = /\s/.test(name) ? name : titleFromStem(name);
    let planned: Project;
    try {
      planned = planNewProject({id: store.mintId(), title, outcome: '', nowIso, outcomeLater: true});
    } catch (error) {
      throw new ProjectError(error instanceof Error ? error.message : String(error), 'usage');
    }
    const created = settled(store.createProjectSafely(planned));
    return {stem: created.stem, created};
  });
}

export interface Renamed {
  file: ProjectFile;
  previousStem: string;
  /** Member tasks rewritten to point at the new stem. */
  repointed: number;
}

/**
 * Renaming is the one operation that reaches outside the project itself. Tasks refer to
 * a project by its stem, so a rename rewrites every member in the same transaction and
 * keeps the old stem as an alias. Nobody can see the project renamed but its tasks not
 * yet repointed.
 */
export function renameProject(store: Store, ref: string, title: string): Renamed {
  return store.batch(() => {
    const snapshot = store.load();
    const current = requireProject(snapshot, ref);
    const previousStem = current.stem;
    const members = membershipFor(snapshot, current.project.id)?.tasks ?? [];

    const file = settled(store.updateProject(current.project.id, project => planRenameProject(project, previousStem, title)));

    let repointed = 0;
    if (file.stem !== previousStem) {
      for (const member of members) {
        const result = store.updateTask(member.task.id, task => ({...task, project: file.stem}));
        if (result.kind === 'ok') repointed += 1;
      }
    }
    return {file, previousStem, repointed};
  });
}

export function setOutcome(store: Store, ref: string, outcome: string): ProjectFile {
  return store.batch(() => {
    const current = requireProject(store.load(), ref);
    return settled(store.updateProject(current.project.id, project => planSetOutcome(project, outcome)));
  });
}

export interface MoveOptions {
  nowIso: string;
  actor: string;
  note?: string;
  /** Complete even though actions are still open. */
  force?: boolean;
}

/**
 * Move a project between active, someday and done. Finishing one while its actions are
 * still open is refused unless forced: an outcome is not reached while the work towards
 * it is still sitting in `next`. Counted inside the transaction, so nobody can finish
 * the last open action between the check and the write.
 */
export function moveProject(store: Store, ref: string, to: ProjectState, options: MoveOptions): ProjectFile {
  return store.batch(() => {
    const snapshot = store.load();
    const current = requireProject(snapshot, ref);
    const change = {nowIso: options.nowIso, actor: options.actor, ...(options.note === undefined ? {} : {note: options.note})};

    if (to === 'done') {
      const open = (membershipFor(snapshot, current.project.id)?.tasks ?? []).filter(t => t.task.state !== 'done');
      if (open.length > 0 && options.force !== true) {
        throw new ProjectError(
          `${current.project.title} still has ${open.length} open action${open.length === 1 ? '' : 's'}`,
          'open-actions',
          {open},
        );
      }
      return settled(store.updateProject(current.project.id, project => planCompleteProject(project, change)));
    }
    return settled(store.updateProject(current.project.id, project => planMoveProject(project, to, change)));
  });
}

export interface ProjectEdit {
  outcome?: string;
  body?: string;
  due?: string | null;
}

/** Replace fields, refused if the project changed since `version` was read. */
export function editProject(store: Store, ref: string, version: number | undefined, edit: ProjectEdit): ProjectFile {
  return store.batch(() => {
    const current = requireProject(store.load(), ref);
    return settled(
      store.updateProject(
        current.project.id,
        project => {
          let next = edit.outcome === undefined ? {...project} : planSetOutcome(project, edit.outcome);
          if (edit.body !== undefined) next = {...next, body: edit.body};
          if (edit.due === null) {
            next = {...next};
            delete next.due;
          } else if (edit.due !== undefined) {
            next = {...next, due: edit.due};
          }
          return next;
        },
        version === undefined ? {} : {expectVersion: version},
      ),
    );
  });
}
