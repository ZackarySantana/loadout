export class DownloadCancelledError extends Error {
  constructor() {
    super('Cancelled. No kit selections or agent outputs saved.');
    this.name = 'DownloadCancelledError';
  }
}

export async function retryDownload<T>(
  attempt: () => Promise<T>,
  retry?: (error: Error) => Promise<boolean>,
  onRetry?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    for (let tries = 0; tries < 2; tries++) {
      try {
        signal?.throwIfAborted();
        return await attempt();
      } catch (failure) {
        signal?.throwIfAborted();
        const error =
          failure instanceof Error ? failure : new Error(String(failure));
        if (tries === 0) {
          onRetry?.();
          continue;
        }
        if (!retry) throw error;
        if (!(await retry(error))) throw new DownloadCancelledError();
      }
    }
  }
}
