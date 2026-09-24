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
  // Accepting work is a person's call; the same rule as `omni done`.
  if (ctx.caller.actor.startsWith('agent:') && input['force'] !== true) {
    throw new ApiError(
      'agents hand work back for review rather than completing it; use submit',
      EXIT_USAGE,
      403,
      {hint: `POST /api/tasks/${ref}/submit with a note (or "force": true to override)`},
    );
  }
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

/**
 * Route one authenticated API request. Returns undefined when nothing matched, so the
 * caller can answer 404 in the same shape as everything else.
 */
export async function handleApi(ctx: ApiContext, request: Request, url: URL): Promise<Response | undefined> {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = request.method;
  const [resource, ref, action] = parts;

  try {
    if (resource === 'tasks') {
      if (ref === undefined) {
        if (method === 'GET') return listTasks(ctx, url);
        if (method === 'POST') return await createTask(ctx, request);
      } else if (action === undefined) {
        if (method === 'GET') return showTask(ctx, ref);
        if (method === 'PATCH') return await patchTask(ctx, ref, request);
        if (method === 'DELETE') return deleteTask(ctx, ref);
      } else if (method === 'POST') {
        switch (action) {
          case 'move':
            return await moveTask(ctx, ref, request);
          case 'done':
            return completeTask(ctx, ref, await body(request));
          case 'submit':
            return await submitTask(ctx, ref, request);
          case 'note':
            return await noteTask(ctx, ref, request);
          case 'tags':
            return await tagTask(ctx, ref, request);
          case 'clarify':
            return await clarifyTask(ctx, ref, request);
        }
      }
    }
    if (resource === 'projects') {
      if (ref === undefined) {
        if (method === 'GET') return listProjects(ctx);
        if (method === 'POST') return await createProjectRoute(ctx, request);
      } else if (action === undefined) {
        if (method === 'GET') return showProject(ctx, ref);
        if (method === 'PATCH') return await patchProject(ctx, ref, request);
      } else if (method === 'POST') {
        if (action === 'rename') return await renameProjectRoute(ctx, ref, request);
        if (action === 'move') return await moveProjectRoute(ctx, ref, request);
      }
    }
    if (resource === 'ticklers') {
      if (ref === undefined) {
        if (method === 'GET') return listTicklersRoute(ctx);
        if (method === 'POST') return await createTicklerRoute(ctx, request);
      } else if (action === undefined) {
        if (method === 'PATCH') return await patchTicklerRoute(ctx, ref, request);
        if (method === 'DELETE') return deleteTicklerRoute(ctx, ref);
      }
    }
    if (resource === 'weekly') {
      const store = storeFor(ctx);
      if (ref === undefined && method === 'GET') {
        return json({ok: true, ...planToJson(weeklyState(store, ctx.now()))});
      }
      if (ref === 'record' && method === 'POST') {
        const {plan, stamped} = recordWeekly(store, ctx.now());
        return json(ok({at: plan.at, projects_stamped: stamped, needs_attention: plan.needingAttention}));
      }
    }
    if (resource === 'tags' && ref === undefined && method === 'GET') {
      const tags = storeFor(ctx).load().tags;
      return json({ok: true, tags: tags.map(use => ({tag: use.tag, count: use.count}))});
    }
    if (resource === 'agents' && method === 'GET') {
      return json({ok: true, contract: agentsDocument()});
    }
    if (resource === 'cli' && method === 'POST') return await cli(ctx, request);
    return undefined;
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.message, error.code, error.status, error.extra);
    if (isBusy(error)) return errorResponse('the database was busy; try again', EXIT_BUSY, 503);
    return errorResponse(error instanceof Error ? error.message : String(error), EXIT_ERROR, 500);
  }
}
