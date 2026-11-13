import type { Classification } from '../../../packages/domain/src/index.js';

export interface TurnClassificationInput {
  text?: unknown;
  terminalStatus?: string | null;
  waiting?: boolean;
  classifierUnavailable?: boolean;
}
export interface TurnClassification {
  classification: Classification;
  terminalStatus: string | null;
  alertParent: boolean;
  confidence: 'high' | 'low';
  reason: string;
  classifierVersion: 'deterministic-v1';
}

/** Advisory interpretation only: this module has no state, authority, connector or persistence access. */
export function classifyTurn(input: TurnClassificationInput): TurnClassification {
  const suppliedStatus = input.terminalStatus;
  const terminalStatus = typeof suppliedStatus === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(suppliedStatus) ? suppliedStatus : suppliedStatus == null ? null : 'unknown';
  const result = (classification: Classification, confidence: 'high' | 'low', reason: string): TurnClassification => ({
    classification, terminalStatus, alertParent: classification !== 'progress_update' && classification !== 'completion_claim', confidence, reason, classifierVersion: 'deterministic-v1',
  });
  if (input.classifierUnavailable) return result('ambiguous', 'low', 'classifier_unavailable');
  // Preserve native failure/cancellation independently from the language classification.
  if (terminalStatus && ['failed', 'interrupted', 'cancelled', 'canceled'].includes(terminalStatus.toLowerCase())) return result('blocker', 'high', 'native_terminal_failure');
  if (typeof input.text !== 'string') return result('ambiguous', 'low', 'no_reliable_content');
  const text = input.text.slice(0, 30_000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!text || /^(?:```[\s\S]*```|\{[\s\S]*\}|\[[\s\S]*\])$/.test(text)) return result('ambiguous', 'low', 'no_reliable_prose');
  const prose = text.replace(/\b(?:not|never)\s+(?:blocked|done|completed|finished|implemented)\b/gi, '');
  if (/\b(?:blocked|cannot proceed|can['’]t proceed|unable to continue|missing (?:required|access|artifact|credential)|need (?:your )?(?:help|input))\b/i.test(prose)) return result('blocker', 'high', 'explicit_blocker');
  if (/\b(?:I (?:recommend|propose)|my proposal|proposal\s*:|decision required|please approve|approval required|should we|(?:may|can) I proceed|choose between)\b/i.test(prose)) return result('decision_proposal', 'high', 'explicit_decision_request');
  if (prose.includes('?') || /\b(?:please (?:choose|clarify|confirm)|need your (?:answer|choice)|awaiting (?:your )?(?:answer|response|input))\b/i.test(prose)) return result('awaiting_input', 'high', 'explicit_question');
  if (/\b(?:unsure|uncertain|unclear|perhaps|maybe|might be|not sure|ambiguous)\b/i.test(prose)) return result('ambiguous', 'low', 'uncertain_language');
  if (input.waiting) return result('ambiguous', 'low', 'waiting_without_clear_request');
  if (/\b(?:done|completed|finished|implemented)\b/i.test(prose)) return result('completion_claim', 'high', 'completion_claim_only');
  if (/\b(?:working|progress|investigating|investigated|checked|reviewed|tested|tests passed|running|continuing|mapped|updated|next|not done|not completed|not finished|not implemented)\b/i.test(text)) return result('progress_update', 'high', 'progress_evidence');
  return result('ambiguous', 'low', 'unrecognized_content');
}
