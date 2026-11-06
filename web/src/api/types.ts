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
}

export type ProposalAction = 'book' | 'cancel' | 'reschedule';

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
  status: BookingStatus;
  when: BookingWhen;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

export interface CreateApiKeyResult extends ApiKey {
  plaintextKey: string;
}
