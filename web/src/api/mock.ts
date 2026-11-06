import type { Api, ChatStreamEvent } from './contract.js';
import { ApiError } from './client.js';
import type {
  ApiKey,
  ApproveResponse,
  Booking,
  ChatMessage,
  CreateApiKeyResult,
  CreateProposalInput,
  Fact,
  ProposalDetail,
  TaskState,
  User,
} from './types.js';

function isoNow(): string {
  return new Date().toISOString();
}

function inMs(ms: number): string {
  return new Date(new Date().getTime() + ms).toISOString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Skipped under Vitest so tests don't wait on the demo pause. */
const DEMO_TURN_MS = import.meta.env.MODE === 'test' ? 0 : 800;

function pauseForDemo(): Promise<void> {
  if (DEMO_TURN_MS <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, DEMO_TURN_MS);
  });
}

let user: User | null = null;
let messageSeq = 0;
let proposalSeq = 1;
let apiKeySeq = 2;
let taskState: TaskState = { state: 'GATHERING' };

const messages: ChatMessage[] = [];
const proposals: ProposalDetail[] = [];
const facts: Fact[] = [];
const bookings: Booking[] = [];
const apiKeys: ApiKey[] = [];

type EventListener = (e: ChatStreamEvent) => void;
const streamListeners = new Set<EventListener>();

function emit(event: ChatStreamEvent): void {
  for (const listener of streamListeners) {
    listener(event);
  }
}

function mockHash(
  p: Pick<ProposalDetail, 'action' | 'provider_id' | 'slot' | 'price' | 'booking_id'>,
): string {
  return `mock_hash_${p.action}_${p.provider_id}_${p.slot.start}_${p.slot.end}_${p.price}_${p.booking_id ?? 'none'}`;
}

function buildProposal(
  partial: Omit<ProposalDetail, 'hash' | 'created_at' | 'updated_at' | 'user_id' | 'status'> &
    Partial<
      Pick<ProposalDetail, 'user_id' | 'status' | 'created_at' | 'updated_at' | 'hash'>
    >,
): ProposalDetail {
  const user_id = partial.user_id ?? user?.id ?? 'user-demo';
  const now = isoNow();
  const computedHash = mockHash({
    action: partial.action,
    provider_id: partial.provider_id,
    slot: partial.slot,
    price: partial.price,
    booking_id: partial.booking_id,
  });
  return {
    id: partial.id,
    user_id,
    action: partial.action,
    provider_id: partial.provider_id,
    provider_name: partial.provider_name,
    service: partial.service,
    slot: partial.slot,
    price: partial.price,
    currency: partial.currency,
    booking_id: partial.booking_id,
    hold_id: partial.hold_id,
    hold_expires_at: partial.hold_expires_at,
    status: partial.status ?? 'pending',
    created_at: partial.created_at ?? now,
    updated_at: partial.updated_at ?? now,
    expired: partial.expired,
    hash: partial.hash ?? computedHash,
  };
}

function supersedePending(): void {
  const now = isoNow();
  for (const p of proposals) {
    if (p.status === 'pending') {
      p.status = 'superseded';
      p.updated_at = now;
    }
  }
}

function nextProposalId(): string {
  proposalSeq += 1;
  return `prop-${proposalSeq}`;
}

function nextMessageId(): string {
  messageSeq += 1;
  return `m${messageSeq}`;
}

interface Offer {
  provider_id: string;
  provider_name: string;
  service: string;
  price: number;
}

function offerFor(text: string): Offer {
  const t = text.toLowerCase();
  if (t.includes('electric')) {
    return {
      provider_id: 'prov-spark',
      provider_name: 'Spark Electric',
      service: 'Switch replacement',
      price: 900,
    };
  }
  return {
    provider_id: 'prov-piperight',
    provider_name: 'PipeRight Co.',
    service: 'Plumber visit',
    price: 2100,
  };
}

function wantsBooking(text: string): boolean {
  return /\b(book|plumber|plumbing|electrician|electric|clean|repair|ac|hvac)\b/i.test(text);
}

function pushProposal(row: ProposalDetail): ProposalDetail {
  supersedePending();
  proposals.push(row);
  return row;
}

function seedProposal(): ProposalDetail {
  return buildProposal({
    id: 'prop-seed',
    action: 'book',
    provider_id: 'prov-quickfix',
    provider_name: 'QuickFix Plumbing',
    service: 'Leak repair',
    slot: { start: inMs(36 * HOUR), end: inMs(38 * HOUR) },
    price: 1800,
    currency: 'INR',
    booking_id: null,
    hold_id: 'hold-seed',
    hold_expires_at: inMs(10 * MINUTE),
    expired: false,
  });
}

function resetFixtures(): void {
  user = {
    id: 'user-demo',
    email: 'demo@bellhop.local',
    name: 'Demo User',
  };
  messageSeq = 2;
  proposalSeq = 1;
  apiKeySeq = 2;
  messages.length = 0;
  messages.push(
    {
      id: 'm1',
      role: 'user',
      text: 'Need a plumber tomorrow morning.',
      createdAt: new Date(Date.UTC(2026, 0, 10, 9, 0, 0)).toISOString(),
    },
    {
      id: 'm2',
      role: 'assistant',
      text: 'I can compare plumbers in your area once you confirm the address.',
      createdAt: new Date(Date.UTC(2026, 0, 10, 9, 0, 5)).toISOString(),
    },
  );
  proposals.length = 0;
  proposals.push(seedProposal());
  facts.length = 0;
  facts.push(
    {
      id: 'f1',
      key: 'service_area',
      value: 'Indiranagar, Bengaluru',
      kind: 'explicit',
      status: 'active',
    },
    {
      id: 'f2',
      key: 'preferred_morning',
      value: 'After 9am',
      kind: 'explicit',
      status: 'active',
    },
    {
      id: 'f3',
      key: 'budget_ceiling',
      value: '2500 INR',
      kind: 'inferred',
      status: 'unconfirmed',
    },
    {
      id: 'f4',
      key: 'last_plumber',
      value: 'CityCare Services',
      kind: 'inferred',
      status: 'active',
    },
    {
      id: 'f5',
      key: 'pets',
      value: 'One friendly dog',
      kind: 'explicit',
      status: 'active',
    },
  );
  bookings.length = 0;
  bookings.push(
    {
      id: 'b1',
      providerName: 'Spark Electric',
      service: 'Switch replacement',
      slot: { start: inMs(3 * 24 * HOUR), end: inMs(3 * 24 * HOUR + HOUR) },
      price: 900,
      currency: 'INR',
      status: 'confirmed',
      when: 'upcoming',
    },
    {
      id: 'b0',
      providerName: 'CoolAir HVAC',
      service: 'AC service',
      slot: { start: inMs(-30 * 24 * HOUR), end: inMs(-30 * 24 * HOUR + HOUR) },
      price: 1200,
      currency: 'INR',
      status: 'confirmed',
      when: 'past',
    },
  );
  apiKeys.length = 0;
  apiKeys.push({
    id: 'k1',
    name: 'Dev MCP',
    prefix: 'bh_dev_',
    createdAt: new Date(Date.UTC(2025, 8, 1, 8, 0, 0)).toISOString(),
  });
  taskState = {
    state: 'COMPARING',
    service: 'Plumber',
    area: 'Indiranagar',
    window_from: inMs(36 * HOUR),
    window_to: inMs(38 * HOUR),
    budget: 2500,
  };
}

resetFixtures();

function copyMessages(): ChatMessage[] {
  return messages.map((m) => ({ ...m }));
}

export const mockApi: Api = {
  signIn: async (email: string, password: string): Promise<void> => {
    if (!email || !password) {
      throw new ApiError(400, 'invalid', 'Email and password are required');
    }
    user = {
      id: 'user-mock',
      email,
      name: email.split('@')[0] ?? 'User',
    };
  },

  signUp: async (email: string, password: string, name: string): Promise<void> => {
    if (!email || !password || !name) {
      throw new ApiError(400, 'invalid', 'Email, password, and name are required');
    }
    user = { id: 'user-new', email, name };
  },

  signOut: async (): Promise<void> => {
    user = null;
  },

  me: async (): Promise<User | null> => user,

  listMessages: async (): Promise<ChatMessage[]> => copyMessages(),

  sendMessage: async (text: string): Promise<ChatMessage> => {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new ApiError(400, 'empty', 'Message is empty');
    }
    if (trimmed.toLowerCase().includes('unavailable')) {
      throw new ApiError(
        503,
        'model_unavailable',
        'The model is unavailable right now.',
      );
    }

    const createdAt = isoNow();
    messages.push({
      id: nextMessageId(),
      role: 'user',
      text: trimmed,
      createdAt,
    });

    emit({
      ts: isoNow(),
      type: 'state_transition',
      summary: `${String(taskState.state)} → SEARCHING`,
      detail: { from: taskState.state, to: 'SEARCHING' },
    });
    taskState = { ...taskState, state: 'SEARCHING' };
    emit({
      ts: isoNow(),
      type: 'model_call',
      summary: 'Model drafting a reply',
      detail: { est_tokens: trimmed.length },
    });

    await pauseForDemo();

    if (!wantsBooking(trimmed)) {
      const assistant: ChatMessage = {
        id: nextMessageId(),
        role: 'assistant',
        text: 'Tell me the service and when you need it. I will not book anything until you confirm.',
        createdAt: isoNow(),
      };
      messages.push(assistant);
      taskState = { ...taskState, state: 'GATHERING' };
      emit({
        ts: isoNow(),
        type: 'turn_end',
        summary: 'Turn finished',
      });
      return { ...assistant };
    }

    const offer = offerFor(trimmed);
    const slot = { start: inMs(26 * HOUR), end: inMs(28 * HOUR) };
    emit({
      ts: isoNow(),
      type: 'tool_call',
      summary: 'search_providers',
      detail: { service: offer.service, area: 'Indiranagar' },
    });
    emit({
      ts: isoNow(),
      type: 'tool_call',
      summary: 'propose_booking',
      detail: { provider_id: offer.provider_id, price: offer.price },
    });

    const id = nextProposalId();
    const row = buildProposal({
      id,
      action: 'book',
      provider_id: offer.provider_id,
      provider_name: offer.provider_name,
      service: offer.service,
      slot,
      price: offer.price,
      currency: 'INR',
      booking_id: null,
      hold_id: `hold-${id}`,
      hold_expires_at: inMs(10 * MINUTE),
      expired: false,
    });
    pushProposal(row);
    taskState = {
      state: 'PROPOSED',
      service: offer.service,
      area: 'Indiranagar',
      window_from: slot.start,
      window_to: slot.end,
      budget: 2500,
    };

    const assistant: ChatMessage = {
      id: nextMessageId(),
      role: 'assistant',
      text: `I held ${offer.provider_name} for ${offer.service} — ${offer.price} INR. Confirm the approval card to book.`,
      createdAt: isoNow(),
      proposalId: id,
    };
    messages.push(assistant);

    emit({
      ts: isoNow(),
      type: 'approval',
      summary: 'Proposal waiting for confirmation',
      detail: { proposalId: id },
    });
    emit({
      ts: isoNow(),
      type: 'state_transition',
      summary: 'SEARCHING → PROPOSED',
      detail: { from: 'SEARCHING', to: 'PROPOSED' },
    });
    emit({
      ts: isoNow(),
      type: 'turn_end',
      summary: 'Turn finished',
    });
    return { ...assistant };
  },

  streamEvents: (onEvent: (e: ChatStreamEvent) => void): (() => void) => {
    streamListeners.add(onEvent);
    return () => {
      streamListeners.delete(onEvent);
    };
  },

  listProposals: async (): Promise<ProposalDetail[]> => proposals.map((p) => ({ ...p, slot: { ...p.slot } })),

  createProposal: async (input: CreateProposalInput): Promise<ProposalDetail> => {
    const id = nextProposalId();
    const holdExpires = inMs(10 * MINUTE);
    if (input.action === 'book') {
      const row = buildProposal({
        id,
        action: 'book',
        provider_id: input.provider_id,
        // No `provider_name` on the request (plan §7 gate fix item 5); the
        // mock stands in a placeholder the same way the real server would
        // derive one server-side instead of trusting client-supplied text.
        provider_name: `Provider ${input.provider_id}`,
        service: input.service,
        slot: input.slot,
        price: 1999,
        currency: 'INR',
        booking_id: null,
        hold_id: `hold-${id}`,
        hold_expires_at: holdExpires,
        expired: false,
      });
      return pushProposal(row);
    }
    if (input.action === 'cancel') {
      const row = buildProposal({
        id,
        action: 'cancel',
        provider_id: 'na',
        provider_name: '—',
        service: 'Cancel booking',
        slot: { start: isoNow(), end: isoNow() },
        price: 0,
        currency: 'INR',
        booking_id: input.booking_id,
        hold_id: null,
        hold_expires_at: holdExpires,
        expired: false,
      });
      return pushProposal(row);
    }
    const row = buildProposal({
      id,
      action: 'reschedule',
      provider_id: 'na',
      provider_name: '—',
      service: 'Reschedule',
      slot: input.slot,
      price: 0,
      currency: 'INR',
      booking_id: input.booking_id,
      hold_id: null,
      hold_expires_at: holdExpires,
      expired: false,
    });
    return pushProposal(row);
  },

  approve: async (proposalId: string, hash: string): Promise<ApproveResponse> => {
    const idx = proposals.findIndex((p) => p.id === proposalId);
    const current = idx >= 0 ? proposals[idx] : undefined;
    if (!current) {
      throw new ApiError(404, 'not_found', 'No matching pending proposal');
    }
    if (current.status !== 'pending') {
      throw new ApiError(409, 'not_pending', 'Proposal is not pending');
    }
    if (current.hash !== hash) {
      throw new ApiError(409, 'hash_mismatch', 'Hash mismatch');
    }

    // Dev toggles for outcome shapes (used by page tests via hash fixtures).
    if (hash === 'hash-needs-reapproval') {
      proposals.splice(idx, 1);
      const replacementId = nextProposalId();
      const replacement = buildProposal({
        id: replacementId,
        action: 'book',
        provider_id: current.provider_id,
        provider_name: current.provider_name,
        service: current.service,
        slot: { start: inMs(48 * HOUR), end: inMs(50 * HOUR) },
        price: current.price + 100,
        currency: current.currency,
        booking_id: null,
        hold_id: `hold-${replacementId}`,
        hold_expires_at: inMs(10 * MINUTE),
        expired: false,
      });
      proposals.push(replacement);
      emit({
        ts: isoNow(),
        type: 'approval',
        summary: 'Needs re-approval',
        detail: { proposalId, outcome: 'needs_reapproval' },
      });
      return {
        outcome: { kind: 'needs_reapproval', proposal_id: replacement.id },
        message: 'Terms changed — please review the updated proposal.',
      };
    }

    if (hash === 'hash-slot-gone') {
      proposals.splice(idx, 1);
      return {
        outcome: {
          kind: 'slot_gone',
          alternatives: [{ start: inMs(72 * HOUR), end: inMs(74 * HOUR) }],
        },
        message: 'That slot was taken. Here are alternatives.',
      };
    }

    if (hash === 'hash-unconfirmed') {
      proposals.splice(idx, 1);
      return {
        outcome: { kind: 'unconfirmed', hold_id: current.hold_id },
        message: 'Booking status unclear — we are still verifying.',
      };
    }

    proposals.splice(idx, 1);
    const bookingId = `bk-${proposalId}`;
    bookings.unshift({
      id: bookingId,
      providerName: current.provider_name,
      service: current.service,
      slot: current.slot,
      price: current.price,
      currency: 'INR',
      status: 'confirmed',
      when: 'upcoming',
    });
    taskState = { ...taskState, state: 'DONE' };
    emit({
      ts: isoNow(),
      type: 'approval',
      summary: 'Approval consumed',
      detail: { proposalId },
    });
    emit({
      ts: isoNow(),
      type: 'intent',
      summary: 'Booking verified with the provider',
      detail: { bookingId },
    });
    return {
      outcome: { kind: 'booked', booking_id: bookingId },
      message: 'Booked and verified with the provider.',
    };
  },

  decline: async (proposalId: string): Promise<void> => {
    const idx = proposals.findIndex((p) => p.id === proposalId);
    const current = idx >= 0 ? proposals[idx] : undefined;
    if (!current) {
      throw new ApiError(404, 'not_found', 'No matching pending proposal');
    }
    proposals.splice(idx, 1);
    taskState = { ...taskState, state: 'GATHERING' };
    emit({
      ts: isoNow(),
      type: 'approval',
      summary: 'Declined',
      detail: { proposalId },
    });
  },

  getTask: async (): Promise<TaskState | null> => ({ ...taskState }),

  listFacts: async (): Promise<Fact[]> => facts.map((f) => ({ ...f })),

  updateFact: async (id: string, value: string): Promise<void> => {
    const fact = facts.find((f) => f.id === id);
    if (!fact) throw new ApiError(404, 'not_found', 'Fact not found');
    fact.value = value;
  },

  forgetFact: async (id: string): Promise<void> => {
    const fact = facts.find((f) => f.id === id);
    if (!fact) throw new ApiError(404, 'not_found', 'Fact not found');
    fact.status = 'forgotten';
  },

  confirmFact: async (id: string): Promise<void> => {
    const fact = facts.find((f) => f.id === id);
    if (!fact) throw new ApiError(404, 'not_found', 'Fact not found');
    fact.status = 'active';
  },

  listBookings: async (): Promise<Booking[]> =>
    bookings.map((b) => ({ ...b, slot: { ...b.slot } })),

  simulateProviderCancel: async (bookingId: string): Promise<void> => {
    const booking = bookings.find((b) => b.id === bookingId);
    if (!booking) throw new ApiError(404, 'not_found', 'Booking not found');
    if (booking.status !== 'confirmed') {
      throw new ApiError(409, 'not_confirmed', 'Only a confirmed booking can be cancelled by the provider');
    }
    booking.status = 'cancelled';

    const id = nextProposalId();
    const slot = { start: inMs(30 * HOUR), end: inMs(32 * HOUR) };
    const row = buildProposal({
      id,
      action: 'book',
      provider_id: 'prov-replacement',
      provider_name: 'Replacement Co.',
      service: booking.service,
      slot,
      price: booking.price,
      currency: 'INR',
      booking_id: null,
      hold_id: `hold-${id}`,
      hold_expires_at: inMs(10 * MINUTE),
      expired: false,
    });
    pushProposal(row);
    taskState = {
      state: 'PROPOSED',
      service: booking.service,
      area: 'Indiranagar',
      window_from: slot.start,
      window_to: slot.end,
      budget: typeof taskState.budget === 'number' ? taskState.budget : 2500,
    };
    messages.push({
      id: nextMessageId(),
      role: 'assistant',
      text: 'The provider cancelled your booking. I held a replacement — please confirm the approval card.',
      createdAt: isoNow(),
      proposalId: id,
    });
    emit({
      ts: isoNow(),
      type: 'proactive',
      summary: 'Provider cancelled a booking; replacement proposed',
      detail: { bookingId, proposalId: id },
    });
    emit({
      ts: isoNow(),
      type: 'state_transition',
      summary: 'DONE → PROPOSED',
      detail: { from: 'DONE', to: 'PROPOSED' },
    });
  },

  listApiKeys: async (): Promise<ApiKey[]> => apiKeys.map((k) => ({ ...k })),

  createApiKey: async (name: string): Promise<CreateApiKeyResult> => {
    const id = `k${apiKeySeq}`;
    apiKeySeq += 1;
    const plaintext = `bh_mock_${id}_secret`;
    const createdAt = isoNow();
    apiKeys.push({
      id,
      name,
      prefix: plaintext.slice(0, 8),
      createdAt,
    });
    return {
      id,
      name,
      prefix: plaintext.slice(0, 8),
      createdAt,
      plaintextKey: plaintext,
    };
  },
};

/** Test helper: control whether `me()` sees a signed-in user before mounting `SessionProvider`. */
export function __setMockUserForTests(next: User | null): void {
  user = next;
}

/** Test-only: replace the in-memory proposals list (Vitest). */
export function __setProposalsForTests(next: ProposalDetail[]): void {
  proposals.length = 0;
  proposals.push(...next);
}

/** Test-only: replace the in-memory facts list (Vitest). */
export function __setFactsForTests(next: Fact[]): void {
  facts.length = 0;
  facts.push(...next);
}

export function __resetMockApiForTests(): void {
  streamListeners.clear();
  resetFixtures();
}
