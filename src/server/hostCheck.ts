/**
 * Who may talk to `omni serve`, decided before any route runs.
 *
 * A web page the user visits can point its own name at 127.0.0.1 (DNS rebinding) and
 * then talk to this server as if it were same-origin; a device on the network can reach
 * it directly when it listens on 0.0.0.0. So a request is answered only when its `Host`
 * is this machine's loopback name with our port, or a name the user listed with
 * `omni serve --allowed-hosts` (or `OMNI_ALLOWED_HOSTS`). A write (anything but GET/HEAD) carrying an `Origin` must
 * also come from one of those hosts. Mirrors otto's `check_request`.
 *
 * Copied from legenda's R2 change; only the how-to-allow hint differs.
 */

const SAFE_NAME = /^[a-z0-9.\-[\]:]+$/i;

/** The comma-separated `--allowed-hosts` value as a clean list of lower-case names. */
export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(name => name !== '');
}

/** An error message for a bad `--allowed-hosts` value, or undefined. */
export function allowedHostsProblem(value: string): string | undefined {
  const bad = parseAllowedHosts(value).filter(name => !SAFE_NAME.test(name));
  return bad.length > 0 ? `has names that are not host names: ${bad.join(', ')}` : undefined;
}

/** Every `Host` value this server answers to. A listed name may carry its own port. */
export function acceptedHosts(port: number, allowed: readonly string[]): string[] {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  for (const name of allowed) {
    hosts.push(`${name}:${port}`);
    if (/:\d+$/.test(name) && !name.endsWith(']')) hosts.push(name);
  }
  return hosts;
}

const nameOf = (host: string) => host.replace(/:\d+$/, '');

function refusal(seen: string, what: string, allowed: readonly string[]): string {
  const name = nameOf(seen);
  const command = SAFE_NAME.test(name) && name !== ''
    ? `omni serve --allowed-hosts ${[...allowed.filter(n => n !== name), name].join(',')}`
    : 'omni serve --allowed-hosts <name>[,<name>…]';
  return (
    `refused ${what} "${seen}": this server only answers to localhost, 127.0.0.1 and [::1] ` +
    `and the names in allowed_hosts. To allow it, restart the server with: ${command}   (or set OMNI_ALLOWED_HOSTS)`
  );
}

/** Why this request is refused, or undefined to let it through. */
export function checkRequest(request: Request, port: number, allowed: readonly string[]): string | undefined {
  const accepted = acceptedHosts(port, allowed);
  const host = (request.headers.get('host') ?? '').trim().toLowerCase();
  if (!accepted.includes(host)) return refusal(host, 'a request for host', allowed);
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const origin = request.headers.get('origin');
  if (origin === null) return undefined;
  const from = origin.trim().toLowerCase();
  if (!accepted.some(h => from === `http://${h}`)) {
    return refusal(from.replace(/^https?:\/\//, ''), 'a cross-origin write from', allowed);
  }
  return undefined;
}
