/**
 * Collecting what a run reported, for tests that used to pass a `logger`.
 *
 * Not a test file — a helper the others import. Two views over the same events:
 * the events themselves, for asserting on what a run *knows*, and the lines a
 * text reporter would write, for the handful of messages whose exact wording is
 * worth pinning.
 */

import { isFailure, render, renderFailure } from '../src/core/reporters.js';
import type { EpgEvent, Reporter } from '../src/core/events.js';
import type { FailureEvent } from '../src/core/reporters.js';

export interface Collected {
  /** Every event, in order, as a reporter was handed it. */
  readonly events: EpgEvent[];
  /** Pass this as `reporter`. */
  readonly reporter: Reporter;
  /** The lines a `textReporter` would have written, failures included. */
  readonly messages: string[];
  /** Just the failures, which are what `GrabSummary.failed` used to hold. */
  readonly failures: FailureEvent[];
  /** Every event of one type, narrowed. */
  of<T extends EpgEvent['type']>(type: T): Extract<EpgEvent, { type: T }>[];
}

export function collect(): Collected {
  const events: EpgEvent[] = [];

  return {
    events,
    reporter: (event) => events.push(event),
    get messages(): string[] {
      return events.flatMap((event) => {
        const line = isFailure(event) ? renderFailure(event) : render(event);

        return line === undefined ? [] : [line];
      });
    },
    get failures(): FailureEvent[] {
      return events.filter(isFailure);
    },
    of<T extends EpgEvent['type']>(type: T): Extract<EpgEvent, { type: T }>[] {
      return events.filter((event): event is Extract<EpgEvent, { type: T }> => event.type === type);
    },
  };
}
