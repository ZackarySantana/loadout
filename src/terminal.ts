import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

const prepared = new WeakMap<
  NodeJS.ReadableStream,
  { cancel: boolean; lastEscape?: number }
>();

// Review has a back stack: consecutive Escapes navigate rather than cancel.
export function suspendEscapeCancellation(
  input: NodeJS.ReadableStream,
): () => void {
  prepareInput(input);
  const state = prepared.get(input)!;
  const cancel = state.cancel;
  state.cancel = false;
  state.lastEscape = undefined;
  return () => {
    state.cancel = cancel;
    state.lastEscape = undefined;
  };
}

export function prepareInput(input: NodeJS.ReadableStream): void {
  if (prepared.has(input)) return;
  // Inquirer doesn't expose escapeCodeTimeout. Node retains the input's key
  // decoder after an interface closes, so seed it before Inquirer opens one.
  const output = new Writable({ write: (_chunk, _encoding, done) => done() });
  const decoder = createInterface({
    input,
    output,
    terminal: true,
    escapeCodeTimeout: 50,
  });
  decoder.close();
  output.end();
  const state = { cancel: true, lastEscape: undefined as number | undefined };
  input.on('keypress', (_text, key: { name?: string; sequence?: string }) => {
    if (key.name !== 'escape' || !state.cancel) {
      state.lastEscape = undefined;
      return;
    }
    const now = performance.now();
    if (
      key.sequence === '\u001b\u001b' ||
      (state.lastEscape !== undefined && now - state.lastEscape <= 500)
    ) {
      state.lastEscape = undefined;
      // Use the same cancellation path as Ctrl+C, including later prompts.
      input.emit('keypress', '\u0003', {
        name: 'c',
        sequence: '\u0003',
        ctrl: true,
        meta: false,
        shift: false,
      });
    } else state.lastEscape = now;
  });
  prepared.set(input, state);
}
