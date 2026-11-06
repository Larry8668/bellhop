import type { Api, ChatStreamEvent } from './contract.js';
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

let user: User | null = {
  id: 'user-demo',
  email: 'demo@bellhop.local',
  name: 'Demo User',
};

let messageSeq = 3;
const messages: ChatMessage[] = [
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
];

let proposalSeq = 1;

function nextProposalId(): string {
  proposalSeq += 1;
  return `prop-${proposalSeq}`;
}

function mockHash(p: Pick<ProposalDetail, 'action' | 'provider_id' | 'slot' | 'price' | 'booking_id'>): string {
  return `mock_hash_${p.action}_${p.provider_id}_${p.slot.start}_${p.slot.end}_${p.price}_${p.booking_id ?? 'none'}`;
}

function buildProposal(
  partial: Omit<ProposalDetail, 'hash' | 'created_at' | 'updated_at' | 'user_id' | 'status'> &
    Partial<
      Pick<
        ProposalDetail,
        'user_id' | 'status' | 'created_at' | 'updated_at' | 'hash'
      >
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
  const row: ProposalDetail = {
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
  return row;
}

const proposals: ProposalDetail[] = [
  buildProposal({
    id: 'prop-seed',
    action: 'book',
    provider_id: 'prov-quickfix',
    provider_name: 'QuickFix Plumbing',
    service: 'Leak repair',
    slot: {
      start: new Date(Date.UTC(2026, 0, 12, 10, 0, 0)).toISOString(),
      end: new Date(Date.UTC(2026, 0, 12, 12, 0, 0)).toISOString(),
    },
    price: 1800,
    currency: 'INR',
    booking_id: null,
    hold_id: 'hold-seed',
    hold_expires_at: new Date(Date.UTC(2026, 0, 11, 23, 59, 59)).toISOString(),
    expired: false,
  }),
];

const facts: Fact[] = [
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
];

const bookings: Booking[] = [
  {
    id: 'b1',
    providerName: 'Spark Electric',
    service: 'Switch replacement',
    slot: {
      start: new Date(Date.UTC(2026, 0, 15, 14, 0, 0)).toISOString(),
      end: new Date(Date.UTC(2026, 0, 15, 15, 0, 0)).toISOString(),
    },
    price: 900,
    currency: 'INR',
    status: 'confirmed',
    when: 'upcoming',
  },
  {
    id: 'b0',
    providerName: 'CoolAir HVAC',
    service: 'AC service',
    slot: {
      start: new Date(Date.UTC(2025, 10, 2, 11, 0, 0)).toISOString(),
      end: new Date(Date.UTC(2025, 10, 2, 12, 0, 0)).toISOString(),
    },
    price: 1200,
    currency: 'INR',
    status: 'confirmed',
    when: 'past',
  },
];

let apiKeySeq = 1;
const apiKeys: ApiKey[] = [
  {
    id: 'k1',
    name: 'Dev MCP',
    prefix: 'bh_dev_',
    createdAt: new Date(Date.UTC(2025, 8, 1, 8, 0, 0)).toISOString(),
  },
];

const plaintextByKeyId = new Map<string, string>();

type EventListener = (e: ChatStreamEvent) => void;
const streamListeners = new Set<EventListener>();

let traceSeq = 0;

function emit(event: ChatStreamEvent): void {
  for (const listener of streamListeners) {
    listener(event);
  }
}

function pushTrace(): void {
  traceSeq += 1;
  emit({
    ts: isoNow(),
    type: 'trace',
    summary: `Mock trace tick #${traceSeq}`,
    detail: { source: 'mock' },
  });
}

let traceTimer: ReturnType<typeof setInterval> | null = null;

function ensureTraceLoop(): void {
  if (traceTimer !== null) return;
  traceTimer = setInterval(() => {
    pushTrace();
  }, 4000);
}

function stopTraceLoop(): void {
  if (traceTimer === null) return;
  clearInterval(traceTimer);
  traceTimer = null;
}

function firstPendingProposal(): ProposalDetail | undefined {
  return proposals.find((p) => p.status === 'pending' && !p.expired);
}

function emitProposalState(): void {
  const pending = firstPendingProposal();
  if (pending) {
    emit({
      ts: isoNow(),
      type: 'proposal_pending',
      summary: `Pending ${pending.action} for ${pending.provider_name}`,
      detail: pending,
    });
  } else {
    emit({
      ts: isoNow(),
      type: 'proposal_cleared',
      summary: 'No pending proposal',
    });
  }
}

export const mockApi: Api = {
  signIn: async (email: string, password: string): Promise<void> => {
    if (!email || !password) {
      throw new Error('Email and password are required');
    }
    user = {
      id: 'user-mock',
      email,
      name: email.split('@')[0] ?? 'User',
    };
  },

  signUp: async (email: string, password: string, name: string): Promise<void> => {
    if (!email || !password || !name) {
      throw new Error('Email, password, and name are required');
    }
    user = { id: 'user-new', email, name };
  },

  signOut: async (): Promise<void> => {
    user = null;
  },

  me: async (): Promise<User | null> => {
    return user;
  },

  listMessages: async (): Promise<ChatMessage[]> => {
    return [...messages];
  },

  sendMessage: async (text: string): Promise<ChatMessage> => {
    const trimmed = text.trim();
    const userMsg: ChatMessage = {
      id: `m${++messageSeq}`,
      role: 'user',
      text: trimmed,
      createdAt: isoNow(),
    };
    messages.push(userMsg);

    const assistant: ChatMessage = {
      id: `m${++messageSeq}`,
      role: 'assistant',
      text: 'Got it — I will line up options and ask before booking anything.',
      createdAt: isoNow(),
    };
    messages.push(assistant);

    if (trimmed.toLowerCase().includes('book')) {
      const slotStart = new Date(Date.UTC(2026, 0, 13, 9, 30, 0)).toISOString();
      const slotEnd = new Date(Date.UTC(2026, 0, 13, 11, 30, 0)).toISOString();
      const holdExpires = new Date(Date.UTC(2026, 0, 13, 12, 0, 0)).toISOString();
      const id = nextProposalId();
      proposals.push(
        buildProposal({
          id,
          action: 'book',
          provider_id: 'prov-piperight',
          provider_name: 'PipeRight Co.',
          service: 'Plumber visit',
          slot: { start: slotStart, end: slotEnd },
          price: 2100,
          currency: 'INR',
          booking_id: null,
          hold_id: `hold-${id}`,
          hold_expires_at: holdExpires,
          expired: false,
        }),
      );
      emitProposalState();
    }

    return assistant;
  },

  streamEvents: (onEvent: (e: ChatStreamEvent) => void): (() => void) => {
    streamListeners.add(onEvent);
    ensureTraceLoop();
    emitProposalState();
    pushTrace();
    return () => {
      streamListeners.delete(onEvent);
      if (streamListeners.size === 0) {
        stopTraceLoop();
      }
    };
  },

  listProposals: async (): Promise<ProposalDetail[]> => [...proposals],

  createProposal: async (input: CreateProposalInput): Promise<ProposalDetail> => {
    const id = nextProposalId();
    const holdExpires = new Date(Date.UTC(2026, 0, 20, 12, 0, 0)).toISOString();
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
      proposals.push(row);
      emitProposalState();
      return row;
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
      proposals.push(row);
      emitProposalState();
      return row;
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
    proposals.push(row);
    emitProposalState();
    return row;
  },

  approve: async (proposalId: string, hash: string): Promise<ApproveResponse> => {
    const idx = proposals.findIndex((p) => p.id === proposalId);
    if (idx < 0) {
      throw new Error('No matching pending proposal');
    }
    const current = proposals[idx]!;
    if (current.status !== 'pending') {
      throw new Error('Proposal is not pending');
    }
    if (current.hash !== hash) {
      throw new Error('Hash mismatch');
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
        slot: {
          start: new Date(Date.UTC(2026, 0, 14, 10, 0, 0)).toISOString(),
          end: new Date(Date.UTC(2026, 0, 14, 12, 0, 0)).toISOString(),
        },
        price: current.price + 100,
        currency: current.currency,
        booking_id: null,
        hold_id: `hold-${replacementId}`,
        hold_expires_at: new Date(Date.UTC(2026, 0, 20, 12, 0, 0)).toISOString(),
        expired: false,
      });
      proposals.push(replacement);
      emitProposalState();
      emit({
        ts: isoNow(),
        type: 'proposal_resolved',
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
      emitProposalState();
      return {
        outcome: {
          kind: 'slot_gone',
          alternatives: [
            {
              start: new Date(Date.UTC(2026, 0, 16, 9, 0, 0)).toISOString(),
              end: new Date(Date.UTC(2026, 0, 16, 11, 0, 0)).toISOString(),
            },
          ],
        },
        message: 'That slot was taken. Here are alternatives.',
      };
    }

    if (hash === 'hash-unconfirmed') {
      proposals.splice(idx, 1);
      emitProposalState();
      return {
        outcome: { kind: 'unconfirmed', hold_id: current.hold_id },
        message: 'Booking status unclear — we are still verifying.',
      };
    }

    proposals.splice(idx, 1);
    emit({
      ts: isoNow(),
      type: 'proposal_resolved',
      summary: 'Approved',
      detail: { proposalId },
    });
    emitProposalState();
    return {
      outcome: { kind: 'booked', booking_id: `bk-${proposalId}` },
      message: 'Booked (mock).',
    };
  },

  decline: async (proposalId: string): Promise<void> => {
    const idx = proposals.findIndex((p) => p.id === proposalId);
    if (idx < 0) {
      throw new Error('No matching pending proposal');
    }
    proposals.splice(idx, 1);
    emit({
      ts: isoNow(),
      type: 'proposal_resolved',
      summary: 'Declined',
      detail: { proposalId },
    });
    emitProposalState();
  },

  getTask: async (): Promise<TaskState | null> => {
    return {
      state: 'COMPARING',
      service: 'Plumber',
      area: 'Indiranagar',
      window_from: new Date(Date.UTC(2026, 0, 12, 8, 0, 0)).toISOString(),
      window_to: new Date(Date.UTC(2026, 0, 12, 12, 0, 0)).toISOString(),
      budget: 2500,
    };
  },

  listFacts: async (): Promise<Fact[]> => [...facts],

  updateFact: async (id: string, value: string): Promise<void> => {
    const fact = facts.find((f) => f.id === id);
    if (!fact) throw new Error('Fact not found');
    fact.value = value;
  },

  forgetFact: async (id: string): Promise<void> => {
    const fact = facts.find((f) => f.id === id);
    if (!fact) throw new Error('Fact not found');
    fact.status = 'forgotten';
  },

  confirmFact: async (id: string): Promise<void> => {
    const fact = facts.find((f) => f.id === id);
    if (!fact) throw new Error('Fact not found');
    fact.status = 'active';
  },

  listBookings: async (): Promise<Booking[]> => [...bookings],

  listApiKeys: async (): Promise<ApiKey[]> => [...apiKeys],

  createApiKey: async (name: string): Promise<CreateApiKeyResult> => {
    const id = `k${apiKeySeq++}`;
    const plaintext = `bh_mock_${id}_secret`;
    const rec: CreateApiKeyResult = {
      id,
      name,
      prefix: plaintext.slice(0, 8),
      createdAt: isoNow(),
      plaintextKey: plaintext,
    };
    const { plaintextKey, ...rest } = rec;
    plaintextByKeyId.set(id, plaintextKey);
    apiKeys.push(rest);
    return rec;
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

export function __resetMockApiForTests(): void {
  streamListeners.clear();
  stopTraceLoop();
  user = {
    id: 'user-demo',
    email: 'demo@bellhop.local',
    name: 'Demo User',
  };
  messageSeq = 3;
  proposalSeq = 1;
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
  proposals.push(
    buildProposal({
      id: 'prop-seed',
      action: 'book',
      provider_id: 'prov-quickfix',
      provider_name: 'QuickFix Plumbing',
      service: 'Leak repair',
      slot: {
        start: new Date(Date.UTC(2026, 0, 12, 10, 0, 0)).toISOString(),
        end: new Date(Date.UTC(2026, 0, 12, 12, 0, 0)).toISOString(),
      },
      price: 1800,
      currency: 'INR',
      booking_id: null,
      hold_id: 'hold-seed',
      hold_expires_at: new Date(Date.UTC(2026, 0, 11, 23, 59, 59)).toISOString(),
      expired: false,
    }),
  );
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
      slot: {
        start: new Date(Date.UTC(2026, 0, 15, 14, 0, 0)).toISOString(),
        end: new Date(Date.UTC(2026, 0, 15, 15, 0, 0)).toISOString(),
      },
      price: 900,
      currency: 'INR',
      status: 'confirmed',
      when: 'upcoming',
    },
    {
      id: 'b0',
      providerName: 'CoolAir HVAC',
      service: 'AC service',
      slot: {
        start: new Date(Date.UTC(2025, 10, 2, 11, 0, 0)).toISOString(),
        end: new Date(Date.UTC(2025, 10, 2, 12, 0, 0)).toISOString(),
      },
      price: 1200,
      currency: 'INR',
      status: 'confirmed',
      when: 'past',
    },
  );
  apiKeySeq = 2;
  apiKeys.length = 0;
  apiKeys.push({
    id: 'k1',
    name: 'Dev MCP',
    prefix: 'bh_dev_',
    createdAt: new Date(Date.UTC(2025, 8, 1, 8, 0, 0)).toISOString(),
  });
  plaintextByKeyId.clear();
  traceSeq = 0;
}
