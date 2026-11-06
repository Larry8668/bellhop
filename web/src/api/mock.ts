import type { Api, ChatStreamEvent } from './contract.js';
import type {
  ApiKey,
  Booking,
  ChatMessage,
  CreateApiKeyResult,
  Fact,
  Proposal,
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

let pendingProposal: Proposal | null = {
  id: 'prop-seed',
  action: 'book',
  providerName: 'QuickFix Plumbing',
  service: 'Leak repair',
  slot: {
    start: new Date(Date.UTC(2026, 0, 12, 10, 0, 0)).toISOString(),
    end: new Date(Date.UTC(2026, 0, 12, 12, 0, 0)).toISOString(),
  },
  price: 1800,
  currency: 'INR',
  expiresAt: new Date(Date.UTC(2026, 0, 11, 23, 59, 59)).toISOString(),
};

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

function emitProposalState(): void {
  if (pendingProposal) {
    emit({
      ts: isoNow(),
      type: 'proposal_pending',
      summary: `Pending ${pendingProposal.action} for ${pendingProposal.providerName}`,
      detail: pendingProposal,
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
      pendingProposal = {
        id: `prop-${messageSeq}`,
        action: 'book',
        providerName: 'PipeRight Co.',
        service: 'Plumber visit',
        slot: {
          start: new Date(Date.UTC(2026, 0, 13, 9, 30, 0)).toISOString(),
          end: new Date(Date.UTC(2026, 0, 13, 11, 30, 0)).toISOString(),
        },
        price: 2100,
        currency: 'INR',
        expiresAt: new Date(Date.UTC(2026, 0, 13, 12, 0, 0)).toISOString(),
      };
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

  approve: async (proposalId: string): Promise<void> => {
    if (!pendingProposal || pendingProposal.id !== proposalId) {
      throw new Error('No matching pending proposal');
    }
    pendingProposal = null;
    emit({
      ts: isoNow(),
      type: 'proposal_resolved',
      summary: 'Approved',
      detail: { proposalId },
    });
    emitProposalState();
  },

  decline: async (proposalId: string): Promise<void> => {
    if (!pendingProposal || pendingProposal.id !== proposalId) {
      throw new Error('No matching pending proposal');
    }
    pendingProposal = null;
    emit({
      ts: isoNow(),
      type: 'proposal_resolved',
      summary: 'Declined',
      detail: { proposalId },
    });
    emitProposalState();
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

export function __resetMockApiForTests(): void {
  streamListeners.clear();
  stopTraceLoop();
  user = {
    id: 'user-demo',
    email: 'demo@bellhop.local',
    name: 'Demo User',
  };
  messageSeq = 3;
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
  pendingProposal = {
    id: 'prop-seed',
    action: 'book',
    providerName: 'QuickFix Plumbing',
    service: 'Leak repair',
    slot: {
      start: new Date(Date.UTC(2026, 0, 12, 10, 0, 0)).toISOString(),
      end: new Date(Date.UTC(2026, 0, 12, 12, 0, 0)).toISOString(),
    },
    price: 1800,
    currency: 'INR',
    expiresAt: new Date(Date.UTC(2026, 0, 11, 23, 59, 59)).toISOString(),
  };
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
