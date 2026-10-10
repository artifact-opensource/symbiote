// Symbiote — Interactive prompt helpers shared by setup, configure and the installer.
// Answers are read from a line queue, so TTY use, piped input and CI runs all behave the same:
// when input ends, every remaining prompt falls back to its default.

import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { palette, ok, warn, heading, hint } from './brand.js';

export interface Option<T extends string = string> {
  id: T;
  label: string;
  note?: string;
}

export class Prompter {
  private rl: readline.Interface;
  private queue: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private ended = false;
  private muted = false;

  constructor() {
    // Echo goes through this sink so secrets can be hidden without touching raw mode.
    const sink = new Writable({
      write: (chunk, encoding, done) => {
        if (!this.muted) process.stdout.write(chunk, encoding as BufferEncoding);
        done();
      },
    });
    this.rl = readline.createInterface({ input: process.stdin, output: sink, terminal: process.stdin.isTTY === true });
    this.rl.on('line', line => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line); else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.ended = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  close(): void {
    this.rl.close();
  }

  section(title: string): void {
    console.log(`\n${heading(title)}`);
  }

  note(text: string): void {
    console.log(hint(text));
  }

  done(text: string): void {
    console.log(ok(text));
  }

  caution(text: string): void {
    console.log(warn(text));
  }

  private nextLine(): Promise<string | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  private async ask(label: string, suffix: string, secret = false): Promise<string> {
    process.stdout.write(`  ${palette.violet}›${palette.reset} ${label}${suffix} ${palette.dim}›${palette.reset} `);
    this.muted = secret;
    const line = await this.nextLine();
    this.muted = false;
    if (secret || line === null || process.stdin.isTTY !== true) process.stdout.write('\n');
    return (line ?? '').trim();
  }

  async text(label: string, fallback = ''): Promise<string> {
    const suffix = fallback ? ` ${palette.dim}(${fallback})${palette.reset}` : '';
    return (await this.ask(label, suffix)) || fallback;
  }

  async number(label: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): Promise<number> {
    for (;;) {
      const raw = await this.text(label, String(fallback));
      const value = Number(raw);
      if (Number.isFinite(value) && value >= min && value <= max) return value;
      if (this.ended && !this.queue.length) return fallback;
      this.caution(`Enter a number between ${min} and ${max}.`);
    }
  }

  async confirm(label: string, fallback: boolean): Promise<boolean> {
    const answer = (await this.ask(label, ` ${palette.dim}${fallback ? 'Y/n' : 'y/N'}${palette.reset}`)).toLowerCase();
    return answer ? answer.startsWith('y') : fallback;
  }

  async choose<T extends string>(label: string, options: Option<T>[], fallback: T): Promise<T> {
    options.forEach((option, i) => {
      const marker = option.id === fallback ? `${palette.green}●${palette.reset}` : `${palette.dark}○${palette.reset}`;
      const note = option.note ? ` ${palette.dim}${option.note}${palette.reset}` : '';
      console.log(`  ${marker} ${palette.dim}${String(i + 1).padStart(2)}${palette.reset}  ${option.label}${note}`);
    });
    for (;;) {
      const answer = await this.text(label, fallback);
      const picked = options[Number(answer) - 1] ?? options.find(o => o.id === answer.toLowerCase());
      if (picked) return picked.id;
      if (this.ended && !this.queue.length) return fallback;
      this.caution('Pick a number or id from the list.');
    }
  }

  /** Read a secret with echo suppressed. Enter keeps the existing value. */
  async secret(label: string, existing = ''): Promise<string> {
    const suffix = existing ? ` ${palette.dim}(Enter keeps current)${palette.reset}` : '';
    return (await this.ask(label, suffix, true)) || existing;
  }
}
