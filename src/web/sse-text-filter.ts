export type SseEvent = Record<string, unknown>;

export function createSseTextFilter(write: (event: SseEvent) => void): {
  emit: (event: SseEvent) => void;
} {
  return {
    emit(event) {
      if (event.type === 'text' || event.type === 'text_delta') return;
      write(event);
    },
  };
}
