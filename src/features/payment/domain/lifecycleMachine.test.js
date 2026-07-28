/**
 * Unit tests for the controlled payment lifecycle state machine.
 *
 * These tests exercise the compiled allow-list, invalid-transition rejection,
 * terminal-state handling, timeline replay, and the constraint that the
 * settlement path (send_to_swift / acknowledge) is only reachable from the
 * satisfactory accepted → sent_to_swift → acknowledged progression.
 */

import { describe, it, expect } from 'vitest';
import {
  canTransition,
  transition,
  getTimeline,
  getAllowedActions,
  isTerminal,
  LIFECYCLE_STATES,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_REASON_CODES,
} from '@/features/payment/domain/lifecycleMachine';

describe('lifecycleMachine.canTransition', () => {
  it('allows a permitted transition from the allow-list', () => {
    const result = canTransition(LIFECYCLE_STATES.DRAFT, LIFECYCLE_ACTIONS.VALIDATE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.from).toBe(LIFECYCLE_STATES.DRAFT);
      expect(result.action).toBe(LIFECYCLE_ACTIONS.VALIDATE);
      expect(result.to).toBe(LIFECYCLE_STATES.VALIDATED);
    }
  });

  it('rejects a transition that is not present in the allow-list', () => {
    const result = canTransition(LIFECYCLE_STATES.DRAFT, LIFECYCLE_ACTIONS.ACCEPT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(LIFECYCLE_REASON_CODES.ILLEGAL_TRANSITION);
    }
  });

  it('rejects an unknown state with a sanitized reason code', () => {
    const result = canTransition('not-a-state', LIFECYCLE_ACTIONS.VALIDATE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(LIFECYCLE_REASON_CODES.UNKNOWN_STATE);
    }
  });

  it('rejects an unknown action with a sanitized reason code', () => {
    const result = canTransition(LIFECYCLE_STATES.DRAFT, 'not-an-action');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(LIFECYCLE_REASON_CODES.UNKNOWN_ACTION);
    }
  });

  it('rejects any transition out of a terminal state', () => {
    const result = canTransition(LIFECYCLE_STATES.ACKNOWLEDGED, LIFECYCLE_ACTIONS.RESET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(LIFECYCLE_REASON_CODES.TERMINAL_STATE);
    }
  });
});

describe('lifecycleMachine.transition', () => {
  it('applies a legal transition and produces a sanitized timeline event', () => {
    const result = transition(LIFECYCLE_STATES.VALIDATED, LIFECYCLE_ACTIONS.PROCESS, {
      actorId: 'demo-user-operator-01',
      safeReasonCode: 'lifecycle.transitioned',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromState).toBe(LIFECYCLE_STATES.VALIDATED);
      expect(result.toState).toBe(LIFECYCLE_STATES.PROCESSING);
      expect(result.action).toBe(LIFECYCLE_ACTIONS.PROCESS);
      expect(result.terminal).toBe(false);
      expect(result.event.fromState).toBe(LIFECYCLE_STATES.VALIDATED);
      expect(result.event.toState).toBe(LIFECYCLE_STATES.PROCESSING);
      expect(result.event.actorId).toBe('demo-user-operator-01');
      expect(typeof result.event.eventId).toBe('string');
      expect(typeof result.event.occurredAt).toBe('string');
    }
  });

  it('flags a transition into a terminal state as terminal', () => {
    const result = transition(LIFECYCLE_STATES.SENT_TO_SWIFT, LIFECYCLE_ACTIONS.ACKNOWLEDGE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toState).toBe(LIFECYCLE_STATES.ACKNOWLEDGED);
      expect(result.terminal).toBe(true);
    }
  });

  it('denies an illegal transition rather than applying it', () => {
    const result = transition(LIFECYCLE_STATES.DRAFT, LIFECYCLE_ACTIONS.SEND_TO_SWIFT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(LIFECYCLE_REASON_CODES.ILLEGAL_TRANSITION);
    }
  });

  it('sanitizes free-form metadata into safe primitives on the event', () => {
    const result = transition(LIFECYCLE_STATES.PROCESSING, LIFECYCLE_ACTIONS.ACCEPT, {
      metadata: { paymentId: 'demo-pay-0001', nested: { drop: true }, count: 3 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.metadata).toEqual({ paymentId: 'demo-pay-0001', count: 3 });
    }
  });
});

describe('lifecycleMachine SWIFT-only-on-satisfactory paths', () => {
  it('permits send_to_swift only from the accepted state', () => {
    const fromAccepted = canTransition(
      LIFECYCLE_STATES.ACCEPTED,
      LIFECYCLE_ACTIONS.SEND_TO_SWIFT,
    );
    expect(fromAccepted.ok).toBe(true);
    if (fromAccepted.ok) {
      expect(fromAccepted.to).toBe(LIFECYCLE_STATES.SENT_TO_SWIFT);
    }
  });

  it('denies send_to_swift from processing and review states', () => {
    expect(
      canTransition(LIFECYCLE_STATES.PROCESSING, LIFECYCLE_ACTIONS.SEND_TO_SWIFT).ok,
    ).toBe(false);
    expect(
      canTransition(LIFECYCLE_STATES.PENDING_REVIEW, LIFECYCLE_ACTIONS.SEND_TO_SWIFT).ok,
    ).toBe(false);
    expect(
      canTransition(LIFECYCLE_STATES.REPAIR_REQUIRED, LIFECYCLE_ACTIONS.SEND_TO_SWIFT).ok,
    ).toBe(false);
  });

  it('reaches acknowledged only along the satisfactory settlement path', () => {
    const timeline = getTimeline(
      [
        { action: LIFECYCLE_ACTIONS.VALIDATE },
        { action: LIFECYCLE_ACTIONS.PROCESS },
        { action: LIFECYCLE_ACTIONS.ACCEPT },
        { action: LIFECYCLE_ACTIONS.SEND_TO_SWIFT },
        { action: LIFECYCLE_ACTIONS.ACKNOWLEDGE },
      ],
      { initialState: LIFECYCLE_STATES.DRAFT },
    );
    expect(timeline.ok).toBe(true);
    expect(timeline.finalState).toBe(LIFECYCLE_STATES.ACKNOWLEDGED);
    expect(timeline.events).toHaveLength(5);
    expect(timeline.denied).toHaveLength(0);
  });

  it('denies acknowledge unless the payment was sent to SWIFT first', () => {
    const result = canTransition(LIFECYCLE_STATES.ACCEPTED, LIFECYCLE_ACTIONS.ACKNOWLEDGE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(LIFECYCLE_REASON_CODES.ILLEGAL_TRANSITION);
    }
  });
});

describe('lifecycleMachine.getTimeline', () => {
  it('replays a legal transition sequence into an ordered timeline', () => {
    const result = getTimeline([
      { action: LIFECYCLE_ACTIONS.VALIDATE },
      { action: LIFECYCLE_ACTIONS.PROCESS },
      { action: LIFECYCLE_ACTIONS.REQUEST_APPROVAL },
    ]);
    expect(result.ok).toBe(true);
    expect(result.finalState).toBe(LIFECYCLE_STATES.PENDING_APPROVAL);
    expect(result.events).toHaveLength(3);
    expect(result.denied).toHaveLength(0);
  });

  it('skips illegal records and records them as denied without aborting', () => {
    const result = getTimeline([
      { action: LIFECYCLE_ACTIONS.VALIDATE },
      { action: LIFECYCLE_ACTIONS.SEND_TO_SWIFT },
      { action: LIFECYCLE_ACTIONS.PROCESS },
    ]);
    expect(result.ok).toBe(true);
    expect(result.finalState).toBe(LIFECYCLE_STATES.PROCESSING);
    expect(result.events).toHaveLength(2);
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0].action).toBe(LIFECYCLE_ACTIONS.SEND_TO_SWIFT);
    expect(result.denied[0].fromState).toBe(LIFECYCLE_STATES.VALIDATED);
  });

  it('records malformed records as denied with an invalid-input reason code', () => {
    const result = getTimeline([{ action: LIFECYCLE_ACTIONS.VALIDATE }, null]);
    expect(result.ok).toBe(true);
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0].safeReasonCode).toBe(LIFECYCLE_REASON_CODES.INVALID_INPUT);
  });

  it('returns an empty timeline for a non-array records argument', () => {
    const result = getTimeline('not-an-array');
    expect(result.ok).toBe(true);
    expect(result.finalState).toBe(LIFECYCLE_STATES.DRAFT);
    expect(result.events).toHaveLength(0);
    expect(result.denied).toHaveLength(0);
  });
});

describe('lifecycleMachine.getAllowedActions and isTerminal', () => {
  it('returns the permitted actions for a known state', () => {
    const actions = getAllowedActions(LIFECYCLE_STATES.PROCESSING);
    expect(actions).toContain(LIFECYCLE_ACTIONS.REJECT);
    expect(actions).toContain(LIFECYCLE_ACTIONS.ACCEPT);
    expect(actions).toContain(LIFECYCLE_ACTIONS.REQUEST_APPROVAL);
  });

  it('returns an empty action list for an unknown state', () => {
    expect(getAllowedActions('not-a-state')).toHaveLength(0);
  });

  it('identifies terminal states correctly', () => {
    expect(isTerminal(LIFECYCLE_STATES.REJECTED)).toBe(true);
    expect(isTerminal(LIFECYCLE_STATES.ACKNOWLEDGED)).toBe(true);
    expect(isTerminal(LIFECYCLE_STATES.DRAFT)).toBe(false);
    expect(isTerminal(LIFECYCLE_STATES.ACCEPTED)).toBe(false);
  });
});