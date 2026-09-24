/**
 * An input that offers completions for the word being typed: tags after `#`, projects
 * after `+`, lists after `>`, dates after `due:`.
 *
 * What to offer is decided by a `suggest` function the caller passes, so the capture box,
 * the tag editor and the clarify walk each say what makes sense for them, and this only
 * handles the menu. Tab takes the highlighted suggestion; Enter does too while the menu is
 * open, and submits otherwise; Escape closes the menu before it closes anything else.
 */
import {useEffect, useMemo, useState, type RefObject} from 'react';
import {CAPTURE_LISTS, completing, DATE_WORDS} from '../core/capture.ts';
import {resolveDate} from '../core/filter.ts';
import {shortDate} from '../core/format.ts';
import {api, type ProjectJson} from './api.ts';

export interface Suggestion {
  /** What is inserted in place of the partial word. */
  insert: string;
  label: string;
  hint?: string;
}

export interface Suggestions {
  start: number;
  items: Suggestion[];
}

export type Suggest = (value: string) => Suggestions | undefined;

export interface Vocabulary {
  tags: Array<{tag: string; count: number}>;
  projects: ProjectJson[];
}

/** The account's tags and projects, re-read when `revision` changes. */
export function useVocabulary(revision: number): Vocabulary {
  const [vocabulary, setVocabulary] = useState<Vocabulary>({tags: [], projects: []});
  useEffect(() => {
    Promise.all([api.allTags(), api.projects()]).then(
      ([tags, projects]) => setVocabulary({tags, projects: projects.filter(project => project.state !== 'done')}),
      () => undefined,
    );
  }, [revision]);
  return vocabulary;
}

const MAX = 8;

function tagItems(
  vocabulary: Vocabulary,
  partial: string,
  marker: string,
  taken: readonly string[],
  shown = marker,
): Suggestion[] {
  const lower = partial.toLowerCase();
  return vocabulary.tags
    .filter(use => use.tag.startsWith(lower) && use.tag !== lower && !taken.includes(use.tag))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, MAX)
    .map(use => ({insert: `${marker}${use.tag}`, label: `${shown}${use.tag}`, hint: `${use.count}`}));
}

/** Completions for the capture box. */
export function captureSuggest(vocabulary: Vocabulary, nowIso: string): Suggest {
  return value => {
    const at = completing(value);
    if (at === undefined) return undefined;
    const lower = at.partial.toLowerCase();
    let items: Suggestion[] = [];

    switch (at.kind) {
      case 'tag':
        // The `#` is already typed; only the word after it is replaced.
        items = tagItems(vocabulary, at.partial, '', [], '#');
        break;
      case 'project':
        items = vocabulary.projects
          .filter(project => project.stem.startsWith(lower) || project.title.toLowerCase().includes(lower))
          .slice(0, MAX)
          .map(project => ({insert: project.stem, label: `+${project.stem}`, hint: project.title}));
        break;
      case 'list':
        items = CAPTURE_LISTS.filter(list => list.startsWith(lower) && list !== lower).map(list => ({
          insert: list === 'waiting' ? 'waiting' : list,
          label: `>${list}`,
          ...(list === 'waiting' ? {hint: 'add :name for who'} : {}),
        }));
        break;
      case 'date':
        items = DATE_WORDS.filter(word => word.startsWith(lower) && word !== lower).map(word => {
          const date = resolveDate(word, nowIso);
          return {insert: word, label: word, ...(date === undefined ? {} : {hint: shortDate(date)})};
        });
        break;
    }
    return items.length === 0 ? undefined : {start: at.start, items};
  };
}

/** Completions for a line of bare tags, as in the tag editor or the clarify walk: `home ca`, `-cal`. */
export function tagSuggest(vocabulary: Vocabulary): Suggest {
  return value => {
    const match = /(^|\s)([-#]?)([^\s#-][^\s]*)$/.exec(value);
    if (match === null) return undefined;
    const marker = match[2]!;
    const partial = match[3]!;
    const typed = value
      .split(/\s+/)
      .map(word => word.replace(/^[-#]/, '').toLowerCase())
      .slice(0, -1);
    const items = tagItems(vocabulary, partial, marker === '-' ? '-' : '', typed);
    return items.length === 0 ? undefined : {start: value.length - partial.length - marker.length, items};
  };
}

/** Whether a key event came from an input whose suggestion menu is open, which gets Escape first. */
export function menuOpen(event: KeyboardEvent): boolean {
  return event.target instanceof HTMLElement && event.target.getAttribute('aria-expanded') === 'true';
}

export function CompletingInput({
  value,
  onChange,
  onSubmit,
  suggest,
  inputRef,
  placeholder,
  ariaLabel,
  autoFocus,
  disabled,
  onFocusChange,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  suggest: Suggest;
  inputRef?: RefObject<HTMLInputElement | null>;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onFocusChange?: (focused: boolean) => void;
}) {
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const [focused, setFocused] = useState(false);

  const offered = useMemo(() => (focused && dismissed !== value ? suggest(value) : undefined), [focused, dismissed, value, suggest]);
  useEffect(() => setHighlight(0), [offered?.start, offered?.items.length]);

  const accept = (item: Suggestion) => {
    if (offered === undefined) return;
    onChange(`${value.slice(0, offered.start)}${item.insert} `);
  };

  return (
    <div className="completing">
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={offered !== undefined}
        onFocus={() => {
          setFocused(true);
          onFocusChange?.(true);
        }}
        onBlur={() => {
          setFocused(false);
          onFocusChange?.(false);
        }}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          const items = offered?.items ?? [];
          if (items.length > 0) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setHighlight(current => (current + step + items.length) % items.length);
              return;
            }
            if (event.key === 'Tab' || event.key === 'Enter') {
              event.preventDefault();
              accept(items[highlight] ?? items[0]!);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(value);
              return;
            }
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {offered !== undefined && (
        <ul className="suggestions" role="listbox">
          {offered.items.map((item, index) => (
            <li
              key={item.label}
              role="option"
              aria-selected={index === highlight}
              className={index === highlight ? 'active' : ''}
              // Before the input loses focus, so the click lands.
              onMouseDown={event => {
                event.preventDefault();
                accept(item);
              }}
            >
              <span>{item.label}</span>
              {item.hint !== undefined && <span className="muted small">{item.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
