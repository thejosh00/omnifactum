/**
 * The small modal questions the app asks: a line of text, a list to move to, "are you
 * sure", and the keyboard help. All in-page, never `window.prompt`.
 */
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {TASK_STATES, type TaskState} from '../core/types.ts';
import {BINDINGS, keyLabel} from './keys.ts';

export function Modal({title, onClose, children}: {title: string; onClose: () => void; children: ReactNode}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export interface PromptRequest {
  title: string;
  label?: string;
  placeholder?: string;
  initial?: string;
  /** Refuse an empty answer, and say why. */
  required?: string;
  submit: string;
  onSubmit: (value: string) => void;
}

export function Prompt({request, onClose}: {request: PromptRequest; onClose: () => void}) {
  const [value, setValue] = useState(request.initial ?? '');
  const [error, setError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = () => {
    if (request.required !== undefined && value.trim().length === 0) {
      setError(request.required);
      return;
    }
    request.onSubmit(value.trim());
    onClose();
  };

  return (
    <Modal title={request.title} onClose={onClose}>
      <form
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        {request.label !== undefined && <label htmlFor="prompt-input">{request.label}</label>}
        <textarea
          id="prompt-input"
          ref={input}
          rows={3}
          value={value}
          placeholder={request.placeholder}
          onChange={event => {
            setValue(event.target.value);
            setError(undefined);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {error !== undefined && <p className="field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {request.submit}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function MoveMenu({
  from,
  onMove,
  onClose,
}: {
  from: TaskState;
  onMove: (to: TaskState) => void;
  onClose: () => void;
}) {
  const choices = TASK_STATES.filter(state => state !== from);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const index = Number(event.key) - 1;
      const state = TASK_STATES[index];
      if (state !== undefined && state !== from) {
        event.preventDefault();
        event.stopPropagation();
        onMove(state);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [from, onMove, onClose]);

  return (
    <Modal title="Move to…" onClose={onClose}>
      <div className="choices">
        {choices.map(state => (
          <button
            key={state}
            className="choice"
            onClick={() => {
              onMove(state);
              onClose();
            }}
          >
            <kbd>{TASK_STATES.indexOf(state) + 1}</kbd> {state}
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function Confirm({
  title,
  message,
  confirm,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => button.current?.focus(), []);
  return (
    <Modal title={title} onClose={onClose}>
      <p>{message}</p>
      <div className="modal-actions">
        <button className="quiet" onClick={onClose}>
          Cancel
        </button>
        <button
          ref={button}
          className="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirm}
        </button>
      </div>
    </Modal>
  );
}

export function Help({onClose}: {onClose: () => void}) {
  const groups = [...new Set(BINDINGS.map(binding => binding.group))];
  return (
    <Modal title="Keyboard" onClose={onClose}>
      <div className="help">
        {groups.map(group => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {BINDINGS.filter(binding => binding.group === group).map(binding => (
                <div key={binding.intent}>
                  <dt>
                    {binding.keys.map(key => (
                      <kbd key={key}>{keyLabel(key)}</kbd>
                    ))}
                  </dt>
                  <dd>{binding.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="hint">
        Filters: <code>home errand</code> both, <code>home,errand</code> either, <code>-someday</code> not,{' '}
        <code>/printer</code> text, <code>due:today</code>, <code>is:overdue</code>.
      </p>
    </Modal>
  );
}
