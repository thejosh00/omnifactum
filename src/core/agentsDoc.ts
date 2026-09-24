/**
 * The contract an agent reads, printed by `omni agents` and served at `/api/agents`.
 *
 * This document is the agent interface, so if it drifts from what the code does, agents
 * will do the wrong thing confidently. It is generated from a pure function precisely so
 * its content can be asserted in a unit test, and `tests/e2e/contract.test.ts` executes
 * the commands below to prove they still work.
 *
 * Keep every example here runnable. If you change a command, change it here in the same
 * commit.
 */
import {AGENT_TAG, TAG_PATTERN} from './tags.ts';
import {LIST_STATES, taskStateList} from './types.ts';

/** `\`omni inbox\` / \`next\` / …`, built from the states rather than typed out. */
function listShorthands(): string {
  const [first, ...rest] = LIST_STATES;
  return [`\`omni ${first}\``, ...rest.map(state => `\`${state}\``)].join(' / ');
}

export function agentsDocument(): string {
  return `# Working with this task system

This is a GTD task system. **Use the \`omni\` command to read and change tasks.** Pass
\`--json\` and you never have to parse anything but JSON.

The tasks live in a database behind a server, \`omni serve\`, which is also where a
person using the web app is working. \`omni\` sends your command to that server, so you
and they can change the same tasks at the same time without either of you losing work.

## Before you start

\`omni\` needs to know where the server is and who you are:

\`\`\`bash
export OMNI_URL=http://127.0.0.1:7777     # or wherever the server runs
export OMNI_TOKEN=omni_...                # a token issued for you
\`\`\`

A person issues your token with \`omni account token <account> agent:your-name\`. The token
decides which account's lists you see (for example \`work\` or \`home\`) and records you
as \`agent:your-name\` in every log line you write. If you have no token, ask for one;
do not borrow a person's.

## Finding work you may do

Tasks you are invited to pick up are tagged \`${AGENT_TAG}\`:

\`\`\`bash
omni next --tag ${AGENT_TAG} --json
\`\`\`

\`\`\`json
[
  {
    "id": "1nab5wap5x2q",
    "title": "Fix printer driver",
    "state": "next",
    "tags": ["home", "${AGENT_TAG}"],
    "created": "2026-09-12T10:04:00Z",
    "body": "Driver crashes after the OS update.",
    "log": [],
    "stem": "fix-printer-driver",
    "version": 1
  }
]
\`\`\`

Only take work from \`next\`. Do not take from \`inbox\` (it has not been thought about
yet), \`someday\` (deliberately not now), \`waiting\` (someone else owns it), or
\`review\` (already finished and waiting on a person). \`omni next\` already hides tasks
that are deferred to a future date.

A task that comes back to \`next\` after you submitted it was rejected. Read the newest
log entry to find out why before starting again.

## Reporting what you did

**You do not mark tasks done. You hand them back for review.**

\`\`\`bash
omni submit 1nab5 \\
  --note "Installed vendor PPD 4.2, test page prints clean." --json
\`\`\`

\`\`\`json
{
  "ok": true,
  "task": {
    "id": "1nab5wap5x2q",
    "state": "review",
    "log": [
      {"at": "2026-09-12T11:03:00Z", "actor": "agent:your-name", "text": "Installed vendor PPD 4.2, test page prints clean."}
    ]
  }
}
\`\`\`

The task moves to \`review\`, where a person looks at what you did and decides whether it
is finished. They accept it, or send it back to \`next\` with a note saying what was
wrong. **\`omni done\` is refused for agents** — that is the point of the queue, not an
obstacle to route around.

\`--note\` is required, and it is the only thing your reviewer has to go on. Say what you
actually did and what you changed, not that you did it. If something is uncertain or you
had to guess, say that too; it is much cheaper for them to read it than to discover it.

If you could not finish at all, do not submit. Say so instead:

\`\`\`bash
omni mv 1nab5 waiting --note "blocked: needs the vendor login" --json
omni tag 1nab5 +needs-review --json
\`\`\`

Part-way through something long, record it without moving anything:

\`\`\`bash
omni note 1nab5 "Reproduced on 24.04; bisecting the driver versions now." --json
\`\`\`

That appends one line to the log and changes nothing else. Use it rather than moving a
task somewhere it does not belong just to leave a trace.

## Referring to a task

Anywhere a command takes a task, you can give its \`id\`, any unambiguous prefix of that
id, or its \`stem\`. These are the same task:

\`\`\`bash
omni show 1nab5wap5x2q
omni show 1nab5
omni show fix-printer-driver
\`\`\`

## The commands

| Command | Does |
| --- | --- |
| \`omni list [query] --json\` | tasks matching a query; defaults to \`next\` |
| ${listShorthands()} | one list |
| \`omni show <task> --json\` | one task in full, including its log |
| \`omni add "Title" -t tag -s state --json\` | capture a task |
| \`omni submit <task> --note "..." --json\` | hand finished work back for review |
| \`omni review --json\` | what is waiting to be checked |
| \`omni mv <task> <state> --json\` | move between ${taskStateList()} |
| \`omni note <task> "..." --json\` | record what happened, changing nothing |
| \`omni tag <task> +add -remove --json\` | change tags |
| \`omni tags --json\` | every tag in use, with counts |
| \`omni due --json\` | deadlines, soonest first |
| \`omni project list --json\` | projects, with a \`stalled\` flag |

Every command takes \`--json\`.

Queries are the same everywhere: \`home errand\` means both tags, \`home,errand\` means
either, \`-someday\` excludes, \`/printer\` searches the text, and there are fields like
\`project:kitchen\`, \`due:today\` and \`is:overdue\`.

## Exit codes and errors

| Code | Means |
| --- | --- |
| 0 | it worked |
| 1 | it failed |
| 2 | the command was wrong, or the token was missing or refused |
| 3 | no such task, or the reference was ambiguous |
| 4 | the server was unreachable or busy; retry |

With \`--json\`, a failure is JSON on **stdout** and stderr is empty, so one parse covers
every outcome:

\`\`\`json
{"ok": false, "error": "no task matches \\"nope\\"", "code": 3}
\`\`\`

Always check \`ok\`. A task you were about to complete may have been finished by someone
else a moment earlier, and that is reported rather than silently repeated.

## Working alongside a person

Someone may have the web app open on the same list while you run. That is supported,
and you do not need to coordinate: the server applies each command to the task as it is
at that moment, not to the copy you read a moment ago.

**Do not batch up a change and write it later.** Give the command the change you want,
and let it apply. \`omni tag 1nab5 +done-by-agent\` adds your tag to whatever tags exist
at that moment; setting a whole tag list from something you read earlier would discard
whatever a person added in between.

**Do not write to the database directly.** Go through \`omni\` or the HTTP API below.

Exit code 4 means the server could not be reached or stayed busy. Wait a moment and run
the command again.

## Creating a task

\`\`\`bash
omni add "Call the bank about the overdraft" -t calls --json
omni add "Order tiles" -p renovate-the-kitchen --next --json
\`\`\`

Tags must match \`${TAG_PATTERN.source}\` — lowercase, no spaces, use \`-\` to join words.
They are free-form: there is no list to register with.

A date without a time (\`--due 2026-10-15\`) means that day on the server's local calendar:
it is due until local midnight, and a \`defer\` date arrives at local midnight. Log
timestamps are UTC.

## Projects

A project is an outcome that needs more than one action, with an \`outcome\` saying what
done looks like.

\`\`\`bash
omni project list --json
\`\`\`

A project with \`"stalled": true\` is active but has nothing in \`next\` or \`waiting\` to
move it forward. If you finish the last action on a project, that is worth mentioning to
a person. Do not invent the next step yourself.

Link a task to a project with \`-p <stem>\` when adding it.

## What not to do

**Do not accept your own work.** \`omni submit\` is how you finish; \`omni done\` is for
the person reviewing it.

**Do not delete tasks.** There is no trash and no version history here, so a deletion is
permanent. \`omni rm\` requires \`--yes\` for that reason. If something looks wrong, move
it to \`someday\` or tag it for a person instead.

**Do not put a \`defer\` date on a task in \`next\`.** Deferred tasks live in \`someday\`
and move to \`next\` on their date. That is what lets \`next\` be trusted literally.

## Without the CLI: the HTTP API

Anything that can make HTTP requests can do the same things. Send your token as
\`Authorization: Bearer <token>\`; bodies and responses are JSON, in the same envelopes
as above.

| Request | Does |
| --- | --- |
| \`GET /api/tasks?state=next&q=agent\` | list, with the same query language |
| \`GET /api/tasks/<task>\` | one task |
| \`POST /api/tasks\` \`{"title", "state", "tags"}\` | capture |
| \`POST /api/tasks/<task>/submit\` \`{"note"}\` | hand back for review |
| \`POST /api/tasks/<task>/note\` \`{"note"}\` | record progress |
| \`POST /api/tasks/<task>/move\` \`{"to", "note"}\` | move |
| \`POST /api/tasks/<task>/tags\` \`{"add", "remove"}\` | change tags |
| \`PATCH /api/tasks/<task>\` with \`If-Match: <version>\` | replace title, body or dates |
| \`GET /api/projects\` | projects |
| \`GET /api/agents\` | this document |

A \`PATCH\` replaces what is there, so it carries the task's \`version\` from when you read
it. If someone changed the task since, you get \`409\` and the task as it is now: re-read
it and decide again rather than retrying blindly.

Run \`omni agents\` to print this document again.
`;
}
