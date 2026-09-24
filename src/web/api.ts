/**
 * The browser's side of the JSON API.
 *
 * The session cookie does the authenticating, so every call is a plain same-origin
 * fetch. Failures come back in the same envelope the CLI prints, and are thrown as an
 * `ApiError` carrying it, so a caller can tell "someone else changed this" (409, with
 * the current task attached) from "that was not allowed".
 */
import type {ClarifyOutcome} from '../core/clarify.ts';
import type {ProjectJson, TaskJson} from '../core/serialize.ts';
import type {TaskState} from '../core/types.ts';

export type {ProjectJson, TaskJson};

export interface AccountInfo {
  name: string;
  has_pin: boolean;
}

export interface Session {
  account: string;
  actor: string;
  accounts: AccountInfo[];
}

export interface TaskList {
  tasks: TaskJson[];
  counts: Record<TaskState, number>;
  warnings: string[];
  seq: number;
}

/** A change someone made, as the event stream reports it. */
export interface ChangeEvent {
  seq: number;
  at: string;
  kind: 'completed' | 'added' | 'moved' | 'edited' | 'removed';
  id: string;
  title: string;
  from?: TaskState;
  to?: TaskState;
  actor?: string;
  note?: string;
}

export interface WeeklyStep {
  step: string;
  title: string;
  prompt: string;
  list?: TaskState;
  count: number;
  flags: string[];
  flag_tasks: Array<string | null>;
}

export interface WeeklyPlan {
  at: string;
  days_since_last_review?: number;
  needs_attention: number;
  steps: WeeklyStep[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }

  /** The task as it is now, when the server refused an edit made from a stale copy. */
  get current(): TaskJson | undefined {
    return this.status === 409 ? (this.body['task'] as TaskJson | undefined) : undefined;
  }
}

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {...(body === undefined ? {} : {'content-type': 'application/json'}), ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || json['ok'] === false) {
    throw new ApiError(String(json['error'] ?? `${response.status} ${response.statusText}`), response.status, json);
  }
  return json as T;
}

const ref = (task: string) => `/api/tasks/${encodeURIComponent(task)}`;

export const api = {
  accounts: () => call<{accounts: AccountInfo[]}>('GET', '/api/accounts').then(r => r.accounts),
  session: () => call<Session>('GET', '/api/session'),
  login: (account: string, pin?: string) =>
    call<{account: string}>('POST', '/api/session', {account, ...(pin === undefined ? {} : {pin})}),
  logout: () => call<unknown>('DELETE', '/api/session'),

  list: (state: TaskState, q: string) =>
    call<TaskList>('GET', `/api/tasks?state=${state}&q=${encodeURIComponent(q)}`),
  show: (id: string) => call<{task: TaskJson}>('GET', ref(id)).then(r => r.task),

  create: (input: {title: string; state: TaskState; tags?: string[]; project?: string}) =>
    call<{task: TaskJson}>('POST', '/api/tasks', input).then(r => r.task),
  move: (id: string, to: TaskState, note?: string) =>
    call<{task: TaskJson}>('POST', `${ref(id)}/move`, {to, ...(note ? {note} : {})}).then(r => r.task),
  done: (id: string, note?: string) =>
    call<{task: TaskJson}>('POST', `${ref(id)}/done`, note ? {note} : {}).then(r => r.task),
  note: (id: string, note: string) => call<{task: TaskJson}>('POST', `${ref(id)}/note`, {note}).then(r => r.task),
  tags: (id: string, add: string[], remove: string[]) =>
    call<{task: TaskJson}>('POST', `${ref(id)}/tags`, {add, remove}).then(r => r.task),
  /** Replace fields. Refused with a 409 `ApiError` if the task moved past `version`. */
  patch: (id: string, version: number, fields: Record<string, string | null>) =>
    call<{task: TaskJson}>('PATCH', ref(id), fields, {'if-match': String(version)}).then(r => r.task),
  remove: (id: string) => call<unknown>('DELETE', ref(id)),
  /** File a clarified item. Refused with 409 if it has left `from` in the meantime. */
  clarify: (id: string, from: TaskState, outcome: ClarifyOutcome) =>
    call<{task?: TaskJson; deleted?: TaskJson}>('POST', `${ref(id)}/clarify`, {from, outcome}),
  projects: () => call<{projects: ProjectJson[]}>('GET', '/api/projects').then(r => r.projects),
  weekly: () => call<WeeklyPlan>('GET', '/api/weekly'),
  recordWeekly: () => call<{projects_stamped: number; needs_attention: number}>('POST', '/api/weekly/record'),
};

/**
 * Listen for changes to this account. Reconnects on its own, and the server replays
 * anything missed while the connection was down.
 */
export function listen(onChange: (event: ChangeEvent) => void, onReconnect: () => void): () => void {
  const source = new EventSource('/api/events');
  let opened = false;
  source.addEventListener('change', message => {
    onChange(JSON.parse((message as MessageEvent<string>).data) as ChangeEvent);
  });
  source.addEventListener('hello', () => {
    // The first hello is the initial connection; any later one follows a drop.
    if (opened) onReconnect();
    opened = true;
  });
  return () => source.close();
}
