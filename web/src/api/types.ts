export type Role = 'user' | 'assistant' | 'system';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
  /** Set when this message points at a proposal card. */
  proposalId?: string | null;
}

export type ProposalAction = 'book' | 'cancel' | 'reschedule';

/** Legacy chat-oriented shape; prefer `ProposalDetail` for API-backed UI. */
export interface Proposal {
  id: string;
  action: ProposalAction;
  providerName: string;
  service: string;
  slot: { start: string; end: string };
  price: number;
  currency: 'INR';
  expiresAt: string;
}

/** Server row from proposals APIs (snake_case as returned). */
export interface ProposalDetail {
  id: string;
  user_id: string;
  action: ProposalAction;
  provider_id: string;
  provider_name: string;
  service: string;
  slot: { start: string; end: string };
  price: number;
  currency: string;
  booking_id: string | null;
  hold_id: string | null;
  hold_expires_at: string;
  hash: string;
  status: string;
  created_at: string;
  updated_at: string;
  expired: boolean;
}

export type ExecutionOutcomeKind =
  | 'booked'
  | 'cancelled'
  | 'rescheduled'
  | 'needs_reapproval'
  | 'slot_gone'
  | 'unconfirmed'
  | 'rejected'
  | 'failed';

export type ExecutionOutcome = {
  kind: ExecutionOutcomeKind;
} & Record<string, unknown>;

export type TaskState = {
  state: string;
  service?: unknown;
  area?: unknown;
  window_from?: unknown;
  window_to?: unknown;
  budget?: unknown;
} & Record<string, unknown>;

/** No `provider_name`: the server derives the display name rather than trusting client-supplied text (plan §7 gate fix item 5). */
export type CreateProposalInput =
  | {
      action: 'book';
      provider_id: string;
      service: string;
      slot: { start: string; end: string };
    }
  | { action: 'cancel'; booking_id: string }
  | {
      action: 'reschedule';
      booking_id: string;
      slot: { start: string; end: string };
    };

export interface ApproveResponse {
  outcome: ExecutionOutcome;
  message: string;
}

export interface TraceEvent {
  ts: string;
  type: string;
  summary: string;
  detail?: unknown;
}

export type ChatStreamEvent = TraceEvent;

export type FactKind = 'explicit' | 'inferred';

export type FactStatus = 'active' | 'unconfirmed' | 'forgotten';

export interface Fact {
  id: string;
  key: string;
  value: string;
  kind: FactKind;
  status: FactStatus;
}

export type BookingStatus = 'confirmed' | 'cancelled' | 'rescheduled';

export type BookingWhen = 'past' | 'upcoming';

export interface Booking {
  id: string;
  providerName: string;
  service: string;
  slot: { start: string; end: string };
  price: number;
  currency: 'INR';
  status: BookingStatus;
  when: BookingWhen;
}

export interface ApiKey {
  id: string;
  name: string;
  /** Shown instead of the full key once it is created; the server may omit either. */
  start?: string;
  prefix?: string;
  createdAt: string;
}

export interface CreateApiKeyResult extends ApiKey {
  plaintextKey: string;
}
