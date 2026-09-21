import {
  createPrompt,
  isEnterKey,
  useEffect,
  useKeypress,
  useRef,
  useState,
} from '@inquirer/core';
import { styleText } from 'node:util';
import { BackNavigation, type PromptContext } from './interactive.js';
import {
  type ReviewTarget,
  type PreparedTarget,
  wrapReviewText,
} from './review.js';

type Progress = (scope: number, message: string) => void;
type Retry = (scope: number, id: string, error: Error) => Promise<boolean>;
type Result = { prepared: PreparedTarget[] } | { error: unknown };
type Config = {
  selections: ReviewTarget[];
  run: (
    progress: Progress,
    retry: Retry,
    signal: AbortSignal,
  ) => Promise<PreparedTarget[]>;
};

// A single live screen owns all network activity, including retry decisions.
const progressScreen = createPrompt<Result, Config>((config, done) => {
  const [statuses, setStatuses] = useState(
    config.selections.map(() => 'Waiting'),
  );
  const [failure, setFailure] = useState<{
    scope: number;
    id: string;
    error: Error;
  }>();
  const [active, setActive] = useState(0);
  const [visible, setVisible] = useState(false);
  const controller = useRef(new AbortController());
  const pending = useRef<((retry: boolean) => void) | undefined>(undefined);
  useEffect(() => {
    let mounted = true;
    // Cached and local kits go straight to review without flashing a screen.
    const timer = setTimeout(() => setVisible(true), 150);
    const signal = controller.current.signal;
    const progress: Progress = (scope, message) => {
      if (mounted)
        setStatuses((previous) =>
          previous.map((value, index) => (index === scope ? message : value)),
        );
    };
    const retry: Retry = (scope, id, error) =>
      new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => {
          pending.current = undefined;
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        pending.current = (value) => {
          signal.removeEventListener('abort', abort);
          pending.current = undefined;
          setFailure(undefined);
          resolve(value);
        };
        setActive(0);
        setFailure({ scope, id, error });
      });
    void config.run(progress, retry, signal).then(
      (prepared) => {
        if (mounted) done({ prepared });
      },
      (error: unknown) => {
        if (mounted) done({ error });
      },
    );
    return () => {
      mounted = false;
      clearTimeout(timer);
      controller.current.abort(new BackNavigation());
    };
  }, []);
  useKeypress((key) => {
    if (key.name === 'escape') {
      controller.current.abort(new BackNavigation());
      done({ error: new BackNavigation() });
    } else if (failure) {
      if (key.name === 'up' || key.name === 'down')
        setActive(active === 0 ? 1 : 0);
      else if (isEnterKey(key)) {
        if (active === 0) pending.current?.(true);
        else {
          controller.current.abort(new BackNavigation());
          done({ error: new BackNavigation() });
        }
      }
    }
  });
  const width = Math.max(20, (process.stdout.columns || 80) - 4);
  if (!visible && !failure) return '';
  return [
    ...config.selections.map(
      ({ target }, index) =>
        `  ${styleText(target.global ? 'magenta' : 'cyan', target.label)} · ${wrapReviewText(statuses[index]!, width - target.label.length - 3)[0]}`,
    ),
    ...(failure
      ? [
          ...wrapReviewText(
            `${config.selections[failure.scope]!.target.label} · ${failure.id}: ${failure.error.message}`,
            width,
          ).map((line) => `  ${line}`),
          `  ${active === 0 ? '›' : ' '} [ Retry download ]`,
          `  ${active === 1 ? '›' : ' '} [ Back to kits ]`,
        ]
      : []),
    '  Esc back · Ctrl+C cancel',
  ].join('\n');
});

export async function prepareScreen(
  config: Config,
  context?: PromptContext,
): Promise<PreparedTarget[]> {
  const result = await progressScreen(config, {
    ...context,
    clearPromptOnDone: true,
  });
  if ('error' in result) throw result.error;
  return result.prepared;
}
