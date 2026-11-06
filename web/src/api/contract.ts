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
  TraceEvent,
  User,
} from './types.js';

export type ChatStreamEvent = TraceEvent;

export interface Api {
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, name: string): Promise<void>;
  signOut(): Promise<void>;
  me(): Promise<User | null>;
  listMessages(): Promise<ChatMessage[]>;
  sendMessage(text: string): Promise<ChatMessage>;
  streamEvents(onEvent: (e: ChatStreamEvent) => void): () => void;
  listProposals(): Promise<ProposalDetail[]>;
  createProposal(input: CreateProposalInput): Promise<ProposalDetail>;
  approve(proposalId: string, hash: string): Promise<ApproveResponse>;
  decline(proposalId: string): Promise<void>;
  getTask(): Promise<TaskState | null>;
  listFacts(): Promise<Fact[]>;
  updateFact(id: string, value: string): Promise<void>;
  forgetFact(id: string): Promise<void>;
  confirmFact(id: string): Promise<void>;
  listBookings(): Promise<Booking[]>;
  /** Dev only: provider cancels the booking; the server then proposes a replacement. */
  simulateProviderCancel(bookingId: string): Promise<void>;
  listApiKeys(): Promise<ApiKey[]>;
  createApiKey(name: string): Promise<CreateApiKeyResult>;
}
