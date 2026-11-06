/** Invalid memory input (empty key/value, or a context_log row that is not all active facts). */
export class MemoryInputError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'MemoryInputError';
  }
}
