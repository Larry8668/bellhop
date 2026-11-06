import type {
  ApiKey,
  Booking,
  ChatMessage,
  CreateApiKeyResult,
  Fact,
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
  approve(proposalId: string): Promise<void>;
  decline(proposalId: string): Promise<void>;
  listFacts(): Promise<Fact[]>;
  updateFact(id: string, value: string): Promise<void>;
  forgetFact(id: string): Promise<void>;
  confirmFact(id: string): Promise<void>;
  listBookings(): Promise<Booking[]>;
  listApiKeys(): Promise<ApiKey[]>;
  createApiKey(name: string): Promise<CreateApiKeyResult>;
}
