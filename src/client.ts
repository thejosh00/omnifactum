/**
 * Talking to `omni serve` from the command line.
 *
 * Where the server is and who you are come from the environment, then from a file the
 * `account token --save` command writes, then from defaults:
 *
 *   OMNI_URL    default http://127.0.0.1:7777
 *   OMNI_TOKEN  default the contents of <data dir>/token
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export const DEFAULT_URL = 'http://127.0.0.1:7777';
export const TOKEN_FILE = 'token';

export interface ClientConfig {
  url: string;
  token: string | undefined;
}

export function clientConfig(env: Record<string, string | undefined>, dataDir: string): ClientConfig {
  const url = (env['OMNI_URL']?.trim() || DEFAULT_URL).replace(/\/+$/, '');
  let token = env['OMNI_TOKEN']?.trim();
  if (token === undefined || token.length === 0) {
    try {
      token = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim() || undefined;
    } catch {
      token = undefined;
    }
  }
  return {url, token};
}

export interface RemoteResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class Unreachable extends Error {}
export class Unauthorized extends Error {}

/** Run a command on the server. Throws `Unreachable` or `Unauthorized`, never exits. */
export async function runRemote(
  config: ClientConfig,
  argv: readonly string[],
  actor: string | undefined,
  fetcher: Fetch = fetch,
): Promise<RemoteResult> {
  const headers: Record<string, string> = {'content-type': 'application/json'};
  if (config.token !== undefined) headers['authorization'] = `Bearer ${config.token}`;

  let response: Response;
  try {
    response = await fetcher(`${config.url}/api/cli`, {
      method: 'POST',
      headers,
      body: JSON.stringify({argv, ...(actor === undefined ? {} : {actor})}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Unreachable(error instanceof Error ? error.message : String(error));
  }

  if (response.status === 401) throw new Unauthorized(await response.text());
  const body = (await response.json()) as Partial<RemoteResult> & {error?: string};
  if (typeof body.code !== 'number') {
    throw new Unreachable(body.error ?? `unexpected ${response.status} from the server`);
  }
  return {code: body.code, stdout: body.stdout ?? [], stderr: body.stderr ?? []};
}
