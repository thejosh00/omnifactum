/**
 * `omni serve`: the one process that owns the database.
 *
 * It serves the web app, the JSON API, the command line (which sends its arguments
 * here), and a stream of changes so every open browser updates the moment an agent
 * does something. It also runs the tickler on a timer, so deferred tasks surface on
 * their date even when nobody is running anything.
 */
import type {Database} from 'bun:sqlite';
import type {Server} from 'bun';
import {nowIso} from '../core/time.ts';
import {EXIT_NOT_FOUND, EXIT_USAGE} from '../commands/context.ts';
import {callerForSession, callerForToken, createSession, endSession, type Caller} from '../db/auth.ts';
import {checkPin, findAccount, listAccounts} from '../db/database.ts';
import {EventHub, eventToJson, eventsSince, latestEventSeq} from '../db/events.ts';
import {Store} from '../db/store.ts';
import {sweepTickler} from '../db/tickler.ts';
import {errorResponse, handleApi, json} from './api.ts';
import homepage from '../web/index.html';

export const SESSION_COOKIE = 'omni_session';
const TICKLER_INTERVAL_MS = 60_000;
const KEEPALIVE_MS = 20_000;

export interface ServeOptions {
  db: Database;
  port?: number;
  hostname?: string;
  now?: () => string;
  /** Serve the web app with hot reloading and unminified source. */
  development?: boolean;
  /** Off in tests, which drive the sweep themselves. */
  tickler?: boolean;
}

export interface RunningServer {
  server: Server<undefined>;
  hub: EventHub;
  url: string;
  stop(): Promise<void>;
}

function cookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

function callerOf(db: Database, request: Request): Caller | undefined {
  const auth = request.headers.get('authorization');
  if (auth !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    return match === null ? undefined : callerForToken(db, match[1]!.trim());
  }
  const session = cookie(request, SESSION_COOKIE);
  return session === undefined ? undefined : callerForSession(db, session);
}

function unauthorized(): Response {
  return errorResponse('not signed in: send "Authorization: Bearer <token>", or log in from a browser', EXIT_USAGE, 401);
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

async function login(db: Database, request: Request, now: () => string): Promise<Response> {
  let input: {account?: unknown; pin?: unknown};
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return errorResponse('the request body must be a JSON object', EXIT_USAGE, 400);
  }
  const account = typeof input.account === 'string' ? findAccount(db, input.account) : undefined;
  if (account === undefined) return errorResponse('no such account', EXIT_NOT_FOUND, 404);
  const pin = typeof input.pin === 'string' ? input.pin : undefined;
  if (!checkPin(db, account.id, pin)) return errorResponse('wrong PIN', EXIT_USAGE, 403);

  const session = createSession(db, account.id, now());
  return json({ok: true, account: account.name}, 200, {'set-cookie': sessionCookie(session, 60 * 60 * 24 * 365)});
}

function accountsJson(db: Database) {
  return listAccounts(db).map(account => ({name: account.name, has_pin: account.hasPin}));
}

/**
 * Server-sent events for one account.
 *
 * A browser that reconnects sends `Last-Event-ID`, and gets everything it missed from
 * the events table before the live feed resumes, so a laptop waking from sleep does not
 * show a stale list.
 */
function eventStream(db: Database, hub: EventHub, caller: Caller, request: Request): Response {
  const encoder = new TextEncoder();
  const lastSeen = Number(request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('since') ?? NaN);
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const deliver = (seq: number, data: unknown) => send(`id: ${seq}\nevent: change\ndata: ${JSON.stringify(data)}\n\n`);

      send(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({seq: latestEventSeq(db, caller.account.id)})}\n\n`);
      if (Number.isInteger(lastSeen)) {
        for (const event of eventsSince(db, caller.account.id, lastSeen)) deliver(event.seq, eventToJson(event));
      }

      const unsubscribe = hub.subscribe(caller.account.id, event => deliver(event.seq, eventToJson(event)));
      const keepalive = setInterval(() => send(': keepalive\n\n'), KEEPALIVE_MS);
      cleanup = () => {
        unsubscribe();
        clearInterval(keepalive);
      };
      request.signal.addEventListener('abort', () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

export function startServer(options: ServeOptions): RunningServer {
  const {db} = options;
  const now = options.now ?? nowIso;
  const hub = new EventHub();

  const server = Bun.serve({
    port: options.port ?? 7777,
    hostname: options.hostname ?? '127.0.0.1',
    development: options.development ?? false,
    routes: {
      '/': homepage,
      '/api/accounts': {
        GET: () => json({ok: true, accounts: accountsJson(db)}),
      },
      '/api/session': {
        GET: request => {
          const caller = callerOf(db, request);
          if (caller === undefined) return unauthorized();
          return json({ok: true, account: caller.account.name, actor: caller.actor, accounts: accountsJson(db)});
        },
        POST: request => login(db, request, now),
        DELETE: request => {
          const session = cookie(request, SESSION_COOKIE);
          if (session !== undefined) endSession(db, session);
          return json({ok: true}, 200, {'set-cookie': sessionCookie('', 0)});
        },
      },
      '/api/events': request => {
        const caller = callerOf(db, request);
        if (caller === undefined) return unauthorized();
        // An event stream is idle between changes by design; do not time it out.
        server.timeout(request, 0);
        return eventStream(db, hub, caller, request);
      },
      '/api/*': async request => {
        const caller = callerOf(db, request);
        if (caller === undefined) return unauthorized();
        const url = new URL(request.url);
        const response = await handleApi({db, hub, caller, now}, request, url);
        return response ?? errorResponse(`no such endpoint: ${request.method} ${url.pathname}`, EXIT_NOT_FOUND, 404);
      },
    },
    fetch() {
      return new Response('Not found', {status: 404});
    },
  });

  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.tickler !== false) {
    const sweep = () => {
      for (const account of listAccounts(db)) {
        try {
          sweepTickler(new Store(db, account, {hub, now}), now());
        } catch {
          // Busy or otherwise: the next sweep will do it.
        }
      }
    };
    sweep();
    timer = setInterval(sweep, TICKLER_INTERVAL_MS);
  }

  return {
    server,
    hub,
    url: server.url.toString().replace(/\/$/, ''),
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      await server.stop(true);
    },
  };
}
