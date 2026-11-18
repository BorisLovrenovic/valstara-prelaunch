import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

// The questions `price-index override` asks (E11.6-08). One answer is one
// line of input, typed by the founder or piped in by a script. Lines are
// buffered as they arrive, so a script that sends every answer at once
// loses none. The end of the input before the last question is a refusal,
// never a guess.

export interface Prompt {
  /** Asks `question` and returns the next line, or null at the end of the input. */
  ask(question: string): Promise<string | null>;
  /** Releases the input, so nothing keeps the process alive. */
  close(): void;
}

/** A prompt reading lines from `input` and writing each question to `write`. */
export function linePrompt(
  input: Readable,
  write: (text: string) => void,
): Prompt {
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  });
  const iterator = lines[Symbol.asyncIterator]();
  let ended = false;
  return {
    async ask(question) {
      write(question);
      if (ended) {
        return null;
      }
      const next = await iterator.next();
      if (next.done === true) {
        ended = true;
        return null;
      }
      return next.value;
    },
    close() {
      lines.close();
      input.pause();
    },
  };
}
