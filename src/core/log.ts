/**
 * The trailing `## Log` section.
 *
 * This section must be the last thing in the file, and that is not an aesthetic
 * choice. It means an agent can record what it did with a single shell append — no
 * parsing, no rewriting, and no way to mangle the frontmatter. Because appends land
 * at the end of the file and `omni` only ever edits the frontmatter at the start,
 * the two writers touch different byte ranges and cannot corrupt each other.
 *
 * Parsing is deliberately forgiving. A line under the heading that is not a
 * recognisable entry is kept verbatim and handed back unchanged on write.
 */
import type {LogEntry} from './types.ts';

export const LOG_HEADING = '## Log';

/** Matches `## Log`, any heading level, any case, with optional trailing spaces. */
const HEADING_PATTERN = /^#{1,6}\s+log\s*$/i;

/**
 * `- <timestamp> **<actor>** — <text>`, with the actor and the dash both optional so
 * that a hand-written `- 2026-09-12T10:00:00Z did the thing` still parses.
 */
const ENTRY_PATTERN =
  /^[-*]\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z)\s*(?:\*\*(.+?)\*\*)?\s*(?:[—–-]\s*)?(.*)$/;

export interface BodyAndLog {
  /** Markdown before the `## Log` heading, trailing whitespace preserved. */
  body: string;
  log: LogEntry[];
  hasLogSection: boolean;
}

/**
 * Split a file body into its prose and its log. The *last* `## Log` heading wins,
 * because the section is defined as the final one in the file.
 */
export function splitBodyAndLog(body: string): BodyAndLog {
  const lines = body.split('\n');

  let headingAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADING_PATTERN.test(lines[i]!)) {
      headingAt = i;
      break;
    }
  }

  if (headingAt === -1) {
    return {body, log: [], hasLogSection: false};
  }

  return {
    body: lines.slice(0, headingAt).join('\n'),
    log: parseLogLines(lines.slice(headingAt + 1)),
    hasLogSection: true,
  };
}

function parseLogLines(lines: string[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const raw of lines) {
    if (raw.trim().length === 0) continue;
    const match = ENTRY_PATTERN.exec(raw);
    if (match === null) {
      entries.push({at: '', actor: '', text: raw.trim(), raw, parsed: false});
      continue;
    }
    entries.push({
      at: match[1]!,
      actor: (match[2] ?? '').trim(),
      text: (match[3] ?? '').trim(),
      raw,
      parsed: true,
    });
  }
  return entries;
}

export function formatLogEntry(at: string, actor: string, text: string): string {
  const collapsed = text.replace(/\s*\n\s*/g, ' ').trim();
  const who = actor.trim().length > 0 ? `**${actor.trim()}** ` : '';
  return `- ${at} ${who}— ${collapsed}`;
}

/**
 * Rejoin prose and log into a file body, with the log last and exactly one blank line
 * around the heading. An entry that did not parse is written back as its original line.
 */
export function joinBodyAndLog(body: string, log: LogEntry[]): string {
  const prose = body.replace(/\s+$/, '');
  if (log.length === 0) {
    return prose.length > 0 ? `${prose}\n` : '';
  }

  const rendered = log.map(entry =>
    entry.parsed ? formatLogEntry(entry.at, entry.actor, entry.text) : entry.raw,
  );

  const head = prose.length > 0 ? `${prose}\n\n` : '';
  return `${head}${LOG_HEADING}\n\n${rendered.join('\n')}\n`;
}

/** Append an entry, keeping the list oldest-first. */
export function appendLogEntry(log: LogEntry[], at: string, actor: string, text: string): LogEntry[] {
  const raw = formatLogEntry(at, actor, text);
  return [...log, {at, actor, text: text.trim(), raw, parsed: true}];
}

/** The most recent parsed entry, used to say who completed a task and what they said. */
export function latestEntry(log: LogEntry[]): LogEntry | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]!.parsed) return log[i];
  }
  return undefined;
}
