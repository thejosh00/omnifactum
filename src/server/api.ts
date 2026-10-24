/**
 * The JSON API the web app uses, and that anything else is welcome to.
 *
 * Every write here goes through the same pure planners as the command line, inside one
 * transaction that resolves the task and changes it. Responses use the same envelopes
 * the CLI prints with `--json` — `{"ok": true, "task": {...}}` or
 * `{"ok": false, "error": "...", "code": 3}` — with an HTTP status to match.
 *
 * Two kinds of write, deliberately:
 *
 *   - Intentions (move, done, submit, note, tags) are re-planned against the row as it
 *     is now, so they never undo what someone else just did. No version check needed.
 *   - Replacements (PATCH of title, body, dates) overwrite a field with what the caller
 *     typed. Re-planning cannot tell what they meant, so these carry `If-Match: <version>`
 *     and are refused with 409 if the task changed underneath them.
 */
import type {Database} from 'bun:sqlite';
import {parseQuery} from '../core/filter.ts';
import {filterTasks} from '../core/filter.ts';
import {
  planAddTags,
  planComplete,
  planMove,
  planNewTask,
  planNote,
  planRemoveTags,
  planSetTitle,
  planSubmit,
} from '../core/mutation.ts';
import {failure, ok, projectToJson, taskToJson} from '../core/serialize.ts';
import {countsByState, type Snapshot} from '../core/snapshot.ts';
import {normalizeTag} from '../core/tags.ts';
import {isProjectState, isTaskState, taskStateList, TASK_STATES, type Task, type TaskFile, type TaskState} from '../core/types.ts';
import {agentsDocument} from '../core/agentsDoc.ts';
import {applyClarify, type ClarifyOutcome} from '../core/clarify.ts';
import {asSchedule, parseSchedule, ticklerToJson, type Schedule, type TicklerFile} from '../core/recurrence.ts';
import {createTickler, editTickler, findTickler, sweepRecurring} from '../db/tickler.ts';
import {
  EXIT_BUSY,
  EXIT_ERROR,
  EXIT_NOT_FOUND,
  EXIT_USAGE,
  resolveTask,
} from '../commands/context.ts';
import {runCommand} from '../commands/run.ts';
import {isBusy} from '../db/busy.ts';
import {latestEventSeq, type EventHub} from '../db/events.ts';
import {
  createProject,
  editProject,
  ensureProject,
  moveProject,
  ProjectError,
  projectJson,
  renameProject,
  requireProject,
} from '../db/projects.ts';
import {Store, type Updated} from '../db/store.ts';
import {planToJson, recordWeekly, weeklyState} from '../db/weekly.ts';
import type {Caller} from '../db/auth.ts';
import {BOTH, refusalMessage, roleOf, YOU_ONLY, type Role} from '../core/roles.ts';

export interface ApiContext {
  db: Database;
  hub: EventHub;
  caller: Caller;
  now: () => string;
}

/** An error the handler wants to report, with the CLI's exit code for the envelope. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const usage = (message: string, extra: Record<string, unknown> = {}) =>
  new ApiError(message, EXIT_USAGE, 400, extra);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8', ...headers},
  });
}

export function errorResponse(message: string, code: number, status: number, extra: Record<string, unknown> = {}): Response {
  return json(failure(message, code, extra), status);
}

function storeFor(ctx: ApiContext): Store {
  return new Store(ctx.db, ctx.caller.account, {actor: ctx.caller.actor, hub: ctx.hub, now: ctx.now});
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.method === 'GET' || request.method === 'DELETE') return {};
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Reported below.
  }
  throw usage('the request body must be a JSON object');
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw usage(`"${key}" must be a string`);
  return value;
}

/** A field that may be set to a string or cleared with null; absent means untouched. */
function clearableField(input: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in input)) return undefined;
  const value = input[key];
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw usage(`"${key}" must be a string or null`);
  return value.trim();
}

function stringList(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value as string[];
  throw usage(`"${key}" must be a list of strings`);
}

function requireFile(snapshot: Snapshot, ref: string): TaskFile {
  const found = resolveTask(snapshot, decodeURIComponent(ref));
  if (found.kind === 'ok') return found.file;
  const ambiguous = found.candidates !== undefined;
  throw new ApiError(
    found.message,
    found.code,
    ambiguous ? 409 : found.code === EXIT_USAGE ? 400 : 404,
    ambiguous ? {candidates: found.candidates} : {},
  );
}

function settle(result: Updated<TaskFile>): Response {
  switch (result.kind) {
    case 'ok':
      return json(ok({task: taskToJson(result.file)}));
    case 'not-found':
      throw new ApiError('that task is no longer there', EXIT_NOT_FOUND, 404);
    case 'failed':
      throw usage(result.reason);
    case 'stale':
      throw new ApiError(
        'someone else changed this task while you were editing it',
        EXIT_BUSY,
        409,
        {task: taskToJson(result.file)},
      );
  }
}

/** Resolve and change a task in one transaction, the web twin of `withTask`. */
function change(ctx: ApiContext, ref: string, run: (store: Store, file: TaskFile) => Response): Response {
  const store = storeFor(ctx);
  return store.batch(() => run(store, requireFile(store.load(), ref)));
}

/** The stem to store for a project named on a task, starting the project if it is new. */
function projectStemFor(ctx: ApiContext, store: Store, ref: string): string {
  try {
    return ensureProject(store, ref, ctx.now()).stem;
  } catch (error) {
    if (error instanceof ProjectError) throw projectFailure(error);
    throw error;
  }
}

// --- handlers --------------------------------------------------------------------

function listTasks(ctx: ApiContext, url: URL): Response {
  const store = storeFor(ctx);
  const snapshot = store.load();
  const nowIso = ctx.now();

  const stateParam = url.searchParams.get('state');
  if (stateParam !== null && stateParam !== 'all' && !isTaskState(stateParam)) {
    throw usage(`state must be one of ${taskStateList()}, or all`);
  }

  const parsed = parseQuery(url.searchParams.get('q') ?? '');
  let files = snapshot.tasks;
  if (stateParam !== null && stateParam !== 'all') files = files.filter(f => f.task.state === stateParam);
  files = filterTasks(files, parsed.query, {nowIso});

  // Done piles up forever; newest first is the only useful order for it.
  if (stateParam === 'done') {
    files = [...files].sort((a, b) => (b.task.done ?? '').localeCompare(a.task.done ?? ''));
  }

  // Counts per list for the same query, so the tabs agree with what the list shows.
  const counts = countsByState({...snapshot, byState: groupByState(filterTasks(snapshot.tasks, parsed.query, {nowIso}))});

  return json({
    ok: true,
    tasks: files.map(taskToJson),
    counts,
    warnings: parsed.warnings,
    seq: latestEventSeq(ctx.db, ctx.caller.account.id),
  });
}

function groupByState(files: TaskFile[]): Map<TaskState, TaskFile[]> {
  const byState = new Map<TaskState, TaskFile[]>();
  for (const state of TASK_STATES) byState.set(state, []);
  for (const file of files) byState.get(file.task.state)!.push(file);
  return byState;
}

function showTask(ctx: ApiContext, ref: string): Response {
  return json(ok({task: taskToJson(requireFile(storeFor(ctx).load(), ref))}));
}

async function createTask(ctx: ApiContext, request: Request): Promise<Response> {
  const input = await body(request);
  const title = stringField(input, 'title')?.trim() ?? '';
  if (title.length === 0) throw usage('a task needs a title');

  const state = stringField(input, 'state') ?? 'inbox';
  if (!isTaskState(state)) throw usage(`state must be one of ${taskStateList()}`);

  const defer = stringField(input, 'defer');
  if (defer !== undefined && state !== 'someday') {
    throw usage('a defer date only applies to someday tasks');
  }

  const store = storeFor(ctx);
  return store.batch(() => {
    const projectRef = stringField(input, 'project');
    const optional = (key: string, value: string | undefined) => (value === undefined ? {} : {[key]: value});
    let planned: Task;
    try {
      planned = planNewTask({
        id: store.mintId(),
        title,
        state,
        nowIso: ctx.now(),
        actor: ctx.caller.actor,
        tags: stringList(input, 'tags').map(normalizeTag),
        ...optional('body', stringField(input, 'body')),
        ...optional('project', projectRef === undefined ? undefined : projectStemFor(ctx, store, projectRef)),
        ...optional('due', stringField(input, 'due')),
        ...optional('defer', defer),
        ...optional('waitingOn', stringField(input, 'waiting_on')),
        ...optional('note', stringField(input, 'note')),
      });
    } catch (error) {
      throw usage(error instanceof Error ? error.message : String(error));
    }
    const result = store.createTask(planned);
    if (result.kind !== 'ok') throw new ApiError('could not create the task', EXIT_ERROR, 500);
    return json(ok({task: taskToJson(result.file)}), 201);
  });
}

async function moveTask(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const to = stringField(input, 'to');
  if (to === undefined || !isTaskState(to)) throw usage(`"to" must be one of ${taskStateList()}`);
  if (to === 'done') return completeTask(ctx, ref, input);
  const note = stringField(input, 'note');

  return change(ctx, ref, (store, file) =>
    settle(
      store.updateTask(file.task.id, task =>
        planMove(task, to, {nowIso: ctx.now(), actor: ctx.caller.actor, ...(note === undefined ? {} : {note})}),
      ),
    ),
  );
}

function completeTask(ctx: ApiContext, ref: string, input: Record<string, unknown>): Response {
  // Accepting work is a person's call. The route declarations refuse an agent before it
  // gets here (both `done` and `move` to done); this is the backstop if one ever doesn't.
  if (roleOf(ctx.caller.actor) !== 'you') throw refused('completing a task', YOU_ONLY, ref);
  const note = stringField(input, 'note');

  return change(ctx, ref, (store, file) => {
    if (file.task.state === 'done') {
      throw new ApiError(`"${file.task.title}" is already done`, EXIT_ERROR, 409, {task: taskToJson(file)});
    }
    return settle(
      store.updateTask(file.task.id, task =>
        planComplete(task, {nowIso: ctx.now(), actor: ctx.caller.actor, ...(note === undefined ? {} : {note})}),
      ),
    );
  });
}

async function submitTask(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const note = stringField(input, 'note')?.trim() ?? '';
  if (note.length === 0) throw usage('submitting needs a note: what did you do?');

  return change(ctx, ref, (store, file) => {
    if (file.task.state === 'review' || file.task.state === 'done') {
      throw new ApiError(
        `"${file.task.title}" is already ${file.task.state === 'done' ? 'done' : 'waiting to be reviewed'}`,
        EXIT_ERROR,
        409,
        {task: taskToJson(file)},
      );
    }
    return settle(
      store.updateTask(file.task.id, task => planSubmit(task, {nowIso: ctx.now(), actor: ctx.caller.actor, note})),
    );
  });
}

async function noteTask(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const note = stringField(input, 'note')?.trim() ?? '';
  if (note.length === 0) throw usage('a note needs some text');
  return change(ctx, ref, (store, file) =>
    settle(store.updateTask(file.task.id, task => planNote(task, {nowIso: ctx.now(), actor: ctx.caller.actor, note}))),
  );
}

/** Put a task just before or after another in its list: `{"before": ref}` or `{"after": ref}`. */
async function placeTask(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const before = stringField(input, 'before');
  const after = stringField(input, 'after');
  if ((before === undefined) === (after === undefined)) throw usage('give one of "before" or "after"');

  return change(ctx, ref, (store, file) => {
    const anchor = requireFile(store.load(), (before ?? after)!);
    const place = before === undefined ? {after: anchor.task.id} : {before: anchor.task.id};
    const result = store.placeTask(file.task.id, place);
    if (result.kind === 'failed') throw new ApiError(result.reason, EXIT_ERROR, 409, {task: taskToJson(file)});
    return settle(result);
  });
}

async function tagTask(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const add = stringList(input, 'add').map(normalizeTag);
  const remove = stringList(input, 'remove').map(normalizeTag);
  if (add.length === 0 && remove.length === 0) throw usage('give "add" or "remove"');
  return change(ctx, ref, (store, file) =>
    settle(store.updateTask(file.task.id, task => planRemoveTags(planAddTags(task, add), remove))),
  );
}

function expectedVersion(request: Request, input: Record<string, unknown>): number | undefined {
  const header = request.headers.get('if-match');
  const raw = header ?? (input['version'] === undefined ? undefined : String(input['version']));
  if (raw === undefined) return undefined;
  const version = Number(raw.replace(/"/g, ''));
  if (!Number.isInteger(version)) throw usage('If-Match must be a task version number');
  return version;
}

async function patchTask(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const version = expectedVersion(request, input);

  const title = stringField(input, 'title');
  const text = stringField(input, 'body');
  const due = clearableField(input, 'due');
  const defer = clearableField(input, 'defer');
  const waitingOn = clearableField(input, 'waiting_on');
  const project = clearableField(input, 'project');

  return change(ctx, ref, (store, file) => {
    const projectStem =
      project === undefined || project === null ? project : projectStemFor(ctx, store, project);

    return settle(
      store.updateTask(
        file.task.id,
        current => {
          let next: Task = title === undefined ? {...current} : planSetTitle(current, title);
          if (text !== undefined) next.body = text;

          const apply = (key: 'due' | 'defer' | 'waitingOn' | 'project', value: string | null | undefined) => {
            if (value === undefined) return;
            if (value === null) delete next[key];
            else next[key] = value;
          };
          apply('due', due);
          apply('project', projectStem);

          // The same placement rules the planners keep: next/ must be readable at face
          // value, so a defer date lives only in someday/ and a delegation only in waiting/.
          if (defer !== undefined && defer !== null && next.state !== 'someday') {
            throw new Error('a defer date only applies to someday tasks; move it to someday first');
          }
          if (waitingOn !== undefined && waitingOn !== null && next.state !== 'waiting') {
            throw new Error('only a task in waiting can be waiting on someone');
          }
          apply('defer', defer);
          apply('waitingOn', waitingOn);
          return next;
        },
        version === undefined ? {} : {expectVersion: version},
      ),
    );
  });
}

function deleteTask(ctx: ApiContext, ref: string): Response {
  return change(ctx, ref, (store, file) => {
    const result = store.removeTask(file.task.id);
    if (result.kind !== 'ok') throw new ApiError('that task is no longer there', EXIT_NOT_FOUND, 404);
    return json(ok({deleted: taskToJson(result.file)}));
  });
}

/**
 * Apply what the clarify walk decided. The walk itself runs in the browser — it is only
 * questions — and this is the one write at the end of it, through the same
 * `applyClarify` the terminal used, so a clarified task is filed exactly as it was there.
 *
 * `from` is the state the item was in when the walk reached it. If it has moved since,
 * someone else already dealt with it, and neither a refile nor — especially — a delete
 * should go ahead on the strength of answers given about how it used to be.
 */
async function clarifyTask(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const outcome = parseOutcome(input['outcome']);
  const from = stringField(input, 'from');
  if (from !== undefined && !isTaskState(from)) throw usage(`"from" must be one of ${taskStateList()}`);

  return change(ctx, ref, (store, file) => {
    if (from !== undefined && file.task.state !== from) {
      throw new ApiError(
        `"${file.task.title}" was moved to ${file.task.state} while you were clarifying it`,
        EXIT_BUSY,
        409,
        {task: taskToJson(file)},
      );
    }
    if (outcome.kind === 'discard') {
      const removed = store.removeTask(file.task.id);
      if (removed.kind !== 'ok') throw new ApiError('that task is no longer there', EXIT_NOT_FOUND, 404);
      return json(ok({deleted: taskToJson(removed.file)}));
    }
    const filed: ClarifyOutcome =
      outcome.project === undefined ? outcome : {...outcome, project: projectStemFor(ctx, store, outcome.project)};
    return settle(
      store.updateTask(file.task.id, task => applyClarify(task, filed, {nowIso: ctx.now(), actor: ctx.caller.actor})),
    );
  });
}

const CLARIFY_STATES: readonly TaskState[] = ['next', 'waiting', 'someday'];

function parseOutcome(value: unknown): ClarifyOutcome {
  if (typeof value !== 'object' || value === null) throw usage('"outcome" must be an object');
  const input = value as Record<string, unknown>;
  if (input['kind'] === 'discard') return {kind: 'discard'};
  if (input['kind'] !== 'file') throw usage('"outcome.kind" must be "file" or "discard"');

  const state = input['state'];
  if (typeof state !== 'string' || !(CLARIFY_STATES as readonly string[]).includes(state)) {
    throw usage(`"outcome.state" must be one of ${CLARIFY_STATES.join(', ')}`);
  }
  const outcome: ClarifyOutcome = {kind: 'file', state: state as TaskState, tags: stringList(input, 'tags').map(normalizeTag)};
  const project = stringField(input, 'project')?.trim();
  if (project) outcome.project = project;
  const title = stringField(input, 'title')?.trim();
  if (title) outcome.title = title;
  const waitingOn = stringField(input, 'waitingOn')?.trim();
  if (waitingOn) outcome.waitingOn = waitingOn;
  return outcome;
}

function listProjects(ctx: ApiContext): Response {
  const snapshot = storeFor(ctx).load();
  return json({
    ok: true,
    projects: snapshot.membership.projects.map(entry =>
      projectToJson(entry.project, {liveActions: entry.live.length, stalled: entry.stalled}),
    ),
  });
}

function showProject(ctx: ApiContext, ref: string): Response {
  const store = storeFor(ctx);
  return projecting(() => {
    const snapshot = store.load();
    const file = requireProject(snapshot, decodeURIComponent(ref));
    const entry = snapshot.membership.projects.find(e => e.project.project.id === file.project.id);
    return json(
      ok({
        project: projectToJson(file, {liveActions: entry?.live.length ?? 0, stalled: entry?.stalled ?? false}),
        body: file.project.body,
        log: file.project.log.map(e => ({at: e.at, actor: e.actor, text: e.text})),
        tasks: (entry?.tasks ?? []).map(taskToJson),
      }),
    );
  });
}

/** What the shared project module refused, as an HTTP answer. */
function projectFailure(error: ProjectError): ApiError {
  switch (error.kind) {
    case 'not-found':
      return new ApiError(error.message, EXIT_NOT_FOUND, 404);
    case 'ambiguous':
      return new ApiError(error.message, EXIT_NOT_FOUND, 409, {
        candidates: (error.detail.candidates ?? []).map(f => `${f.stem}  ${f.project.title}`),
      });
    case 'open-actions':
      return new ApiError(error.message, EXIT_USAGE, 409, {open: (error.detail.open ?? []).map(taskToJson)});
    case 'stale':
      return new ApiError(error.message, EXIT_BUSY, 409, {
        ...(error.detail.current === undefined ? {} : {project: projectToJson(error.detail.current, {liveActions: 0, stalled: false})}),
      });
    default:
      return usage(error.message);
  }
}

function projecting(run: () => Response): Response {
  try {
    return run();
  } catch (error) {
    if (error instanceof ProjectError) throw projectFailure(error);
    throw error;
  }
}

async function createProjectRoute(ctx: ApiContext, request: Request): Promise<Response> {
  const input = await body(request);
  const store = storeFor(ctx);
  const due = stringField(input, 'due');
  return projecting(() => {
    const file = createProject(store, {
      title: stringField(input, 'title') ?? '',
      outcome: stringField(input, 'outcome') ?? '',
      nowIso: ctx.now(),
      tags: stringList(input, 'tags').map(normalizeTag),
      ...(due === undefined || due === '' ? {} : {due}),
    });
    return json(ok({project: projectJson(store, file)}), 201);
  });
}

async function patchProject(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const version = expectedVersion(request, input);
  const store = storeFor(ctx);
  const outcome = stringField(input, 'outcome');
  const text = stringField(input, 'body');
  const due = clearableField(input, 'due');
  return projecting(() => {
    const file = editProject(store, decodeURIComponent(ref), version, {
      ...(outcome === undefined ? {} : {outcome}),
      ...(text === undefined ? {} : {body: text}),
      ...(due === undefined ? {} : {due}),
    });
    return json(ok({project: projectJson(store, file)}));
  });
}

async function renameProjectRoute(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const title = stringField(input, 'title')?.trim() ?? '';
  if (title.length === 0) throw usage('a project needs a title');
  const store = storeFor(ctx);
  return projecting(() => {
    const {file, previousStem, repointed} = renameProject(store, decodeURIComponent(ref), title);
    return json(ok({project: projectJson(store, file), previous_stem: previousStem, repointed}));
  });
}

async function moveProjectRoute(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const to = stringField(input, 'to');
  if (to === undefined || !isProjectState(to)) throw usage('"to" must be one of active, someday, done');
  const note = stringField(input, 'note');
  const store = storeFor(ctx);
  return projecting(() => {
    const file = moveProject(store, decodeURIComponent(ref), to, {
      nowIso: ctx.now(),
      actor: ctx.caller.actor,
      force: input['force'] === true,
      ...(note === undefined || note.trim() === '' ? {} : {note}),
    });
    return json(ok({project: projectJson(store, file)}));
  });
}

async function cli(ctx: ApiContext, request: Request): Promise<Response> {
  const input = await body(request);
  const argv = input['argv'];
  if (!Array.isArray(argv) || !argv.every(item => typeof item === 'string')) {
    throw usage('"argv" must be a list of strings');
  }
  const actor = stringField(input, 'actor');
  const result = runCommand(storeFor(ctx), {argv, now: ctx.now, ...(actor === undefined ? {} : {actor})});
  return json(result);
}

// --- tickler items ---------------------------------------------------------------

/** A schedule from a request: the text form (`weekly:mon`) or the object form. */
function scheduleField(ctx: ApiContext, input: Record<string, unknown>): Schedule | undefined {
  const value = input['schedule'];
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const parsed = parseSchedule(value, ctx.now());
    if (!parsed.ok) throw usage(parsed.error);
    return parsed.schedule;
  }
  const schedule = asSchedule(value);
  if (schedule === undefined) throw usage('"schedule" must be weekly:<day>, monthly:<1-31>, a date, or {kind, ...}');
  return schedule;
}

function requireTickler(store: Store, ref: string): TicklerFile {
  const found = findTickler(store, ref);
  if (found === undefined) throw new ApiError(`no tickler item matches "${ref}"`, EXIT_NOT_FOUND, 404);
  if ('ambiguous' in found) throw usage(`"${ref}" matches more than one tickler item`);
  return found;
}

function listTicklersRoute(ctx: ApiContext): Response {
  const store = storeFor(ctx);
  sweepRecurring(store, ctx.now());
  return json({ok: true, ticklers: store.listTicklers().map(ticklerToJson)});
}

async function createTicklerRoute(ctx: ApiContext, request: Request): Promise<Response> {
  const input = await body(request);
  const title = stringField(input, 'title')?.trim() ?? '';
  if (title.length === 0) throw usage('a tickler item needs a title');
  const schedule = scheduleField(ctx, input);
  if (schedule === undefined) throw usage('a tickler item needs a schedule');
  const store = storeFor(ctx);
  const file = createTickler(store, title, schedule, ctx.now());
  // One that was due today has already fired: a repeating one remembers the task it
  // made, and a one-off is gone.
  const fired = file.tickler.lastTaskId !== undefined || store.getTickler(file.tickler.id) === undefined;
  return json(ok({tickler: ticklerToJson(file), fired}), 201);
}

async function patchTicklerRoute(ctx: ApiContext, ref: string, request: Request): Promise<Response> {
  const input = await body(request);
  const version = expectedVersion(request, input);
  const title = stringField(input, 'title');
  if (title !== undefined && title.trim().length === 0) throw usage('a tickler item needs a title');
  const schedule = scheduleField(ctx, input);
  const store = storeFor(ctx);
  const current = requireTickler(store, ref);
  const result = editTickler(
    store,
    current.tickler.id,
    {...(title === undefined ? {} : {title}), ...(schedule === undefined ? {} : {schedule})},
    ctx.now(),
    version,
  );
  switch (result.kind) {
    case 'ok':
      return json(ok({tickler: ticklerToJson(result.file)}));
    case 'stale':
      throw new ApiError('someone else changed this tickler item while you were editing it', EXIT_BUSY, 409, {
        tickler: ticklerToJson(result.file),
      });
    default:
      throw new ApiError('that tickler item is no longer there', EXIT_NOT_FOUND, 404);
  }
}

function deleteTicklerRoute(ctx: ApiContext, ref: string): Response {
  const store = storeFor(ctx);
  const current = requireTickler(store, ref);
  const removed = store.removeTickler(current.tickler.id);
  if (removed.kind !== 'ok') throw new ApiError('that tickler item is no longer there', EXIT_NOT_FOUND, 404);
  return json(ok({deleted: ticklerToJson(removed.file)}));
}

/** The refusal envelope: exit 2, HTTP 403, and where the agent should go instead. */
function refused(what: string, allow: readonly Role[] | undefined, ref?: string): ApiError {
  return new ApiError(refusalMessage(what, allow), EXIT_USAGE, 403, {
    refused: true,
    hint:
      ref === undefined
        ? 'agents hand work back for a person to finish: POST /api/tasks/<task>/submit with a note'
        : `agents hand work back for review rather than completing it; use submit: POST /api/tasks/${ref}/submit with a note`,
  });
}

interface Params {
  ref: string;
}

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** The path with `:ref` for the task, project or tickler, e.g. `/api/tasks/:ref/move`. */
  path: string;
  /** What it does, for refusals. */
  what: string;
  /**
   * Who may call it. GETs read and are open to every caller. Any other route without a
   * declaration is refused for everyone — nobody's — so a new write is closed until
   * someone decides who it is for.
   */
  allow?: readonly Role[];
  /**
   * For a route an agent may call in general but not with every body (`move` to done,
   * clarify by discarding): what the agent asked for that is not theirs, or undefined.
   */
  agentRefuses?: (input: Record<string, unknown>) => string | undefined;
  handler: (ctx: ApiContext, params: Params, request: Request, url: URL) => Response | Promise<Response>;
}

const discarding = (input: Record<string, unknown>) => {
  const outcome = input['outcome'];
  return typeof outcome === 'object' && outcome !== null && (outcome as Record<string, unknown>)['kind'] === 'discard';
};

/** Every route the API answers, with who may call it. */
export const ROUTES: readonly Route[] = [
  {method: 'GET', path: '/api/tasks', what: 'listing tasks', handler: (ctx, _p, _r, url) => listTasks(ctx, url)},
  {
    method: 'POST',
    path: '/api/tasks',
    what: 'capturing a task',
    allow: BOTH,
    agentRefuses: input => (input['state'] === 'done' ? 'capturing a task straight into done' : undefined),
    handler: (ctx, _p, request) => createTask(ctx, request),
  },
  {method: 'GET', path: '/api/tasks/:ref', what: 'reading a task', handler: (ctx, p) => showTask(ctx, p.ref)},
  {method: 'PATCH', path: '/api/tasks/:ref', what: 'editing a task', allow: BOTH, handler: (ctx, p, request) => patchTask(ctx, p.ref, request)},
  {method: 'DELETE', path: '/api/tasks/:ref', what: 'deleting a task', allow: YOU_ONLY, handler: (ctx, p) => deleteTask(ctx, p.ref)},
  {
    method: 'POST',
    path: '/api/tasks/:ref/move',
    what: 'moving a task',
    allow: BOTH,
    agentRefuses: input => (input['to'] === 'done' ? 'moving a task to done' : undefined),
    handler: (ctx, p, request) => moveTask(ctx, p.ref, request),
  },
  {
    method: 'POST',
    path: '/api/tasks/:ref/done',
    what: 'completing a task',
    allow: YOU_ONLY,
    handler: async (ctx, p, request) => completeTask(ctx, p.ref, await body(request)),
  },
  {method: 'POST', path: '/api/tasks/:ref/submit', what: 'submitting a task', allow: BOTH, handler: (ctx, p, request) => submitTask(ctx, p.ref, request)},
  {method: 'POST', path: '/api/tasks/:ref/note', what: 'adding a note', allow: BOTH, handler: (ctx, p, request) => noteTask(ctx, p.ref, request)},
  {method: 'POST', path: '/api/tasks/:ref/tags', what: 'changing tags', allow: BOTH, handler: (ctx, p, request) => tagTask(ctx, p.ref, request)},
  {method: 'POST', path: '/api/tasks/:ref/place', what: 'reordering a list', allow: YOU_ONLY, handler: (ctx, p, request) => placeTask(ctx, p.ref, request)},
  {
    method: 'POST',
    path: '/api/tasks/:ref/clarify',
    what: 'clarifying a task',
    allow: BOTH,
    agentRefuses: input => (discarding(input) ? 'discarding a task while clarifying it' : undefined),
    handler: (ctx, p, request) => clarifyTask(ctx, p.ref, request),
  },
  {method: 'GET', path: '/api/projects', what: 'listing projects', handler: ctx => listProjects(ctx)},
  {method: 'POST', path: '/api/projects', what: 'starting a project', allow: YOU_ONLY, handler: (ctx, _p, request) => createProjectRoute(ctx, request)},
  {method: 'GET', path: '/api/projects/:ref', what: 'reading a project', handler: (ctx, p) => showProject(ctx, p.ref)},
  {method: 'PATCH', path: '/api/projects/:ref', what: 'editing a project', allow: YOU_ONLY, handler: (ctx, p, request) => patchProject(ctx, p.ref, request)},
  {method: 'POST', path: '/api/projects/:ref/rename', what: 'renaming a project', allow: YOU_ONLY, handler: (ctx, p, request) => renameProjectRoute(ctx, p.ref, request)},
  {method: 'POST', path: '/api/projects/:ref/move', what: 'moving a project', allow: YOU_ONLY, handler: (ctx, p, request) => moveProjectRoute(ctx, p.ref, request)},
  {method: 'GET', path: '/api/ticklers', what: 'listing tickler items', handler: ctx => listTicklersRoute(ctx)},
  {method: 'POST', path: '/api/ticklers', what: 'creating a tickler item', allow: YOU_ONLY, handler: (ctx, _p, request) => createTicklerRoute(ctx, request)},
  {method: 'PATCH', path: '/api/ticklers/:ref', what: 'editing a tickler item', allow: YOU_ONLY, handler: (ctx, p, request) => patchTicklerRoute(ctx, p.ref, request)},
  {method: 'DELETE', path: '/api/ticklers/:ref', what: 'deleting a tickler item', allow: YOU_ONLY, handler: (ctx, p) => deleteTicklerRoute(ctx, p.ref)},
  {
    method: 'GET',
    path: '/api/weekly',
    what: 'reading the weekly review',
    handler: ctx => json({ok: true, ...planToJson(weeklyState(storeFor(ctx), ctx.now()))}),
  },
  {
    method: 'POST',
    path: '/api/weekly/record',
    what: 'recording the weekly review',
    allow: YOU_ONLY,
    handler: ctx => {
      const {plan, stamped} = recordWeekly(storeFor(ctx), ctx.now());
      return json(ok({at: plan.at, projects_stamped: stamped, needs_attention: plan.needingAttention}));
    },
  },
  {
    method: 'GET',
    path: '/api/tags',
    what: 'listing tags',
    handler: ctx => {
      const tags = storeFor(ctx).load().tags;
      return json({ok: true, tags: tags.map(use => ({tag: use.tag, count: use.count}))});
    },
  },
  {method: 'GET', path: '/api/agents', what: 'reading the agent contract', handler: () => json({ok: true, contract: agentsDocument()})},
  {method: 'GET', path: '/api/agents/:ref', what: 'reading the agent contract', handler: () => json({ok: true, contract: agentsDocument()})},
  // Each command declares its own roles, and the dispatcher checks them before it runs.
  {method: 'POST', path: '/api/cli', what: 'running a command', allow: BOTH, handler: (ctx, _p, request) => cli(ctx, request)},
];

function matches(route: Route, parts: string[]): Params | undefined {
  const pattern = route.path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  if (pattern.length !== parts.length) return undefined;
  let ref = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === ':ref') ref = parts[i]!;
    else if (pattern[i] !== parts[i]) return undefined;
  }
  return {ref};
}

/** Refuse the caller before the handler runs, if the route is not theirs. */
async function authorise(ctx: ApiContext, route: Route, request: Request, ref: string): Promise<void> {
  if (route.method === 'GET') return;
  const role = roleOf(ctx.caller.actor);
  if (route.allow === undefined || role === undefined || !route.allow.includes(role)) {
    throw refused(route.what, route.allow, route.what === 'completing a task' ? ref : undefined);
  }
  if (role !== 'agent') return;
  // Peek at the body without using it up; the handler reads its own copy.
  const input = await body(request.clone());
  // Overriding a guard is a person's decision on every route.
  if (input['force'] === true) throw refused(`${route.what} with "force"`, YOU_ONLY);
  const specific = route.agentRefuses?.(input);
  if (specific !== undefined) throw refused(specific, YOU_ONLY, input['to'] === 'done' ? ref : undefined);
}

/**
 * Route one authenticated API request. Returns undefined when nothing matched, so the
 * caller can answer 404 in the same shape as everything else.
 */
export async function handleApi(ctx: ApiContext, request: Request, url: URL): Promise<Response | undefined> {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  try {
    for (const route of ROUTES) {
      if (route.method !== request.method) continue;
      const params = matches(route, parts);
      if (params === undefined) continue;
      await authorise(ctx, route, request, params.ref);
      return await route.handler(ctx, params, request, url);
    }
    return undefined;
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.message, error.code, error.status, error.extra);
    if (isBusy(error)) return errorResponse('the database was busy; try again', EXIT_BUSY, 503);
    return errorResponse(error instanceof Error ? error.message : String(error), EXIT_ERROR, 500);
  }
}
