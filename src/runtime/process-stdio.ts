import type { Writable } from 'node:stream';

export function guardOutputStream(
  name: string,
  stream: Writable,
  onUnexpectedError: (name: string, error: NodeJS.ErrnoException) => void,
): void {
  let unavailable = false;
  let reported = false;
  stream.on('error', error => {
    const streamError = error as NodeJS.ErrnoException;
    if (streamError.code === 'EPIPE') {
      if (unavailable) return;
      unavailable = true;
      stream.write = ((...args: Parameters<Writable['write']>) => {
        const callback = args.find((argument): argument is (error?: Error | null) => void =>
          typeof argument === 'function',
        );
        if (callback) queueMicrotask(() => callback());
        return false;
      }) as Writable['write'];
      return;
    }
    if (reported) return;
    reported = true;
    onUnexpectedError(name, streamError);
  });
}

export function guardProcessOutputStreams(onUnexpectedError: (name: string, error: NodeJS.ErrnoException) => void): void {
  guardOutputStream('stdout', process.stdout, onUnexpectedError);
  guardOutputStream('stderr', process.stderr, onUnexpectedError);
}
