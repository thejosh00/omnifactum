/**
 * Turning `process.argv` into a command.
 *
 * Hand-rolled rather than pulled from a library, because it is sixty lines, it is pure
 * so every rule below is a cheap unit test, and a dependency here would have to earn
 * its place against exactly that.
 */

export interface FlagSpec {
  /** Flags that take no value, e.g. `--all`. */
  boolean?: readonly string[];
  /** Short forms, e.g. `{t: 'tag'}`. */
  alias?: Readonly<Record<string, string>>;
}

export interface ParsedArgs {
  positional: string[];
  /** Repeated flags accumulate, so `-t a -t b` gives two values. */
  flags: Map<string, string[]>;
  booleans: Set<string>;
  /** A flag that expected a value and did not get one, and similar. */
  errors: string[];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: readonly string[], spec: FlagSpec = {}): ParsedArgs {
  const booleanFlags = new Set(spec.boolean ?? []);
  const aliases = spec.alias ?? {};

  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  const errors: string[] = [];

  const resolve = (name: string): string => aliases[name] ?? name;

  const take = (name: string, value: string): void => {
    const existing = flags.get(name);
    if (existing === undefined) flags.set(name, [value]);
    else existing.push(value);
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    index += 1;

    // Everything after a bare `--` is positional, which is how a value that looks
    // like a flag gets through.
    if (token === '--') {
      positional.push(...argv.slice(index));
      break;
    }

    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }

    const isLong = token.startsWith('--');
    const body = isLong ? token.slice(2) : token.slice(1);
    const equals = body.indexOf('=');

    if (equals !== -1) {
      const name = resolve(body.slice(0, equals));
      const value = body.slice(equals + 1);
      if (booleanFlags.has(name)) {
        errors.push(`--${name} does not take a value`);
      } else {
        take(name, value);
      }
      continue;
    }

    const name = resolve(body);
    if (booleanFlags.has(name)) {
      booleans.add(name);
      continue;
    }

    const next = argv[index];
    if (next === undefined || (next.startsWith('-') && next !== '-' && next.length > 1)) {
      errors.push(`${isLong ? '--' : '-'}${body} needs a value`);
      continue;
    }
    take(name, next);
    index += 1;
  }

  return {positional, flags, booleans, errors};
}

/** The single value of a flag, or undefined. A repeated flag keeps its last value. */
export function flagValue(args: ParsedArgs, name: string): string | undefined {
  const values = args.flags.get(name);
  return values === undefined ? undefined : values[values.length - 1];
}

/**
 * Every value of a repeatable flag, with comma-separated entries split out, so that
 * `-t home,errand` and `-t home -t errand` mean the same thing.
 */
export function flagList(args: ParsedArgs, name: string): string[] {
  const values = args.flags.get(name) ?? [];
  return values
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.booleans.has(name);
}
