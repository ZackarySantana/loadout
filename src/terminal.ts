import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

const prepared = new WeakSet<NodeJS.ReadableStream>();

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
  let lastEscape: number | undefined;
  input.on('keypress', (_text, key: { name?: string; sequence?: string }) => {
    if (key.name !== 'escape') {
      lastEscape = undefined;
      return;
    }
    const now = performance.now();
    if (
      key.sequence === '\u001b\u001b' ||
      (lastEscape !== undefined && now - lastEscape <= 500)
    ) {
      lastEscape = undefined;
      // Use the same cancellation path as Ctrl+C, including later prompts.
      input.emit('keypress', '\u0003', {
        name: 'c',
        sequence: '\u0003',
        ctrl: true,
        meta: false,
        shift: false,
      });
    } else lastEscape = now;
  });
  prepared.add(input);
}
