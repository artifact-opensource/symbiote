/**
 * Tool Progress Bubble — live "what am I doing" message for chat channels.
 *
 * Mirrors Hermes' tool-progress rendering: each tool call becomes a line
 * (emoji + tool name + primary argument preview) accumulated into ONE
 * editable Discord message that is updated in place as work progresses.
 * Edits are throttled (>=1.5s apart); when the text outgrows the platform
 * limit the oldest lines roll off.
 *
 * Enabled via symbiote.json -> communication.discord.toolProgress = true.
 */

const EMOJI: Record<string, string> = {
    terminal: '💻', bash: '💻', shell: '💻', exec: '⚡',
    read_file: '📖', read: '📖', write_file: '✏️', write: '✏️',
    edit_file: '✏️', patch: '🩹', apply_patch: '🩹',
    search_files: '🔎', grep: '🔎', glob: '🔎', find: '🔎',
    web_search: '🌐', web: '🌐', fetch: '🌐', http: '🌐',
    browser: '🌍', memory_search: '🧠', memory: '🧠',
    message: '💬', send_message: '💬', list: '📋', ls: '📋',
};

const EDIT_THROTTLE_MS = 1500;
const TEXT_BUDGET = 1900;
const PREVIEW_CAP = 60;

export interface ProgressDeps {
    enabled: boolean;
    /** Send a new message; must resolve to the platform SendResult (messageId optional). */
    send: (adapterId: string, chatId: string, content: string) => Promise<{ messageId?: string } | null>;
    /** Edit an existing message. Null when the adapter lacks edit support. */
    edit: ((adapterId: string, chatId: string, messageId: string, content: string) => Promise<unknown>) | null;
}

function previewOf(name: string, args: Record<string, unknown> | undefined): string {
    args = args || {};
    const s = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
    let v: unknown;
    if (args.command !== undefined || name === 'terminal' || name === 'bash' || name === 'shell') {
        v = s(args.command ?? '');
    }
    else if (args.path !== undefined || args.file_path !== undefined || args.filepath !== undefined) {
        v = s(args.path ?? args.file_path ?? args.filepath);
    }
    else if (args.query !== undefined) v = s(args.query);
    else if (args.url !== undefined) v = s(args.url);
    else if (args.pattern !== undefined) v = s(args.pattern);
    else if (args.skill !== undefined) v = s(args.skill);
    else {
        const k = Object.keys(args)[0];
        if (k === undefined) return '';
        v = s(args[k]);
    }
    const one = redactSensitiveValues(String(v).split('\n')[0].trim());
    if (!one) return '';
    return one.length > PREVIEW_CAP ? one.slice(0, PREVIEW_CAP - 3) + '...' : one;
}

function redactSensitiveValues(value: string): string {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
        .replace(/\b(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\b(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1$2[REDACTED]')
        .replace(/\b(--?(?:token|api[-_]?key|password|passwd|secret)|(?:access|refresh)_token|client_secret)\b(\s*=\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1$2[REDACTED]');
}

export class ToolProgressBubble {
    private lines: string[] = [];
    private messageId: string | null = null;
    private lastEdit = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private totalCount = 0;
    private done = false;
    private streamedText = '';
    private currentTool = '';
    private flushPromise: Promise<boolean> | null = null;
    private flushPending = false;
    private forcePending = false;

    constructor(
        private deps: ProgressDeps,
        private adapterId: string,
        private chatId: string,
    ) { }

    /** Called on every onToolStart with the tool's input args. */
    async toolLine(name: string, args?: Record<string, unknown>): Promise<void> {
        if (this.closed || !this.deps.enabled) return;
        try {
            const emoji = EMOJI[name] || '⚙️';
            const prev = previewOf(name, args);
            this.totalCount++;
            this.currentTool = name;
            this.lines.push(prev ? `${emoji} **${name}** \`${prev}\`` : `${emoji} **${name}**`);
            if (this.lines.length > 40) this.lines.splice(0, this.lines.length - 40);
            await this.flush(false);
        }
        catch { /* never break an agent turn over cosmetics */ }
    }

    async toolDone(name: string): Promise<void> {
        if (this.closed || this.currentTool !== name) return;
        this.currentTool = '';
        try { await this.flush(false); } catch { /* cosmetic only */ }
    }

    /** Stream assistant text into the same editable channel message. */
    async streamText(delta: string): Promise<void> {
        if (this.closed || !delta || !this.deps.edit) return;
        this.streamedText += delta;
        try { await this.flush(false); } catch { /* never break an agent turn over cosmetics */ }
    }

    /** Force a final edit (turn finished). Returns true when finalText was delivered in-place. */
    async finalize(finalText?: string): Promise<boolean> {
        if (this.closed) return false;
        // Never posted a message and no tool lines — don't create a stray
        // "Working…" bubble for tool-less turns.
        if (this.messageId === null && this.lines.length === 0 && !this.streamedText) { this.closed = true; return false; }
        this.closed = true;
        this.done = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.flushPromise) await this.flushPromise;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        const canDeliverFinal = typeof finalText === 'string'
            && finalText.length <= TEXT_BUDGET
            && this.messageId !== null
            && this.messageId !== ''
            && this.deps.edit !== null;
        if (canDeliverFinal) this.streamedText = finalText;
        else if (typeof finalText === 'string' && finalText.length > TEXT_BUDGET) this.streamedText = '';
        try {
            const flushed = await this.flush(true);
            return canDeliverFinal && flushed;
        } catch { /* fall back to the regular channel send */ }
        return false;
    }

    private render(): string {
        if (this.streamedText) {
            let text = this.streamedText;
            if (text.length > TEXT_BUDGET) text = '…' + text.slice(-(TEXT_BUDGET - 1));
            const activity = !this.done && this.currentTool ? `\n\n⚙️ **Using ${this.currentTool}…**` : '';
            return text + activity;
        }
        const header = this.done
            ? `✅ **Done — ${this.totalCount} tool call${this.totalCount === 1 ? '' : 's'}**`
            : '⚙️ **Working…**';
        let ls = this.lines.slice();
        while (ls.length > 1 && ((header + '\n').length + ls.join('\n').length) > TEXT_BUDGET) {
            ls.shift();
        }
        return header + '\n' + ls.join('\n');
    }

    private flush(force: boolean): Promise<boolean> {
        if (this.flushPromise) {
            this.flushPending = true;
            this.forcePending ||= force;
            return this.flushPromise;
        }

        this.flushPromise = (async () => {
            let forceFlush = force;
            let result = false;
            do {
                this.flushPending = false;
                forceFlush ||= this.forcePending;
                this.forcePending = false;
                result = await this.flushOnce(forceFlush);
                forceFlush = false;
            } while (this.flushPending);
            return result;
        })().finally(() => {
            this.flushPromise = null;
        });
        return this.flushPromise;
    }

    private async flushOnce(force: boolean): Promise<boolean> {
        if (this.deps.edit === null && this.messageId !== null) return false; // no edit path available
        const now = Date.now();
        if (!force && this.messageId !== null) {
            const wait = EDIT_THROTTLE_MS - (now - this.lastEdit);
            if (wait > 0) {
                if (!this.timer) {
                    this.timer = setTimeout(() => { this.timer = null; void this.flush(true).catch(() => { }); }, wait);
                }
                return false;
            }
        }
        const text = this.render();
        try {
            if (this.messageId === null) {
                const r = await this.deps.send(this.adapterId, this.chatId, text);
                // '' sentinel = sent but not editable (no messageId back)
                this.messageId = r && r.messageId ? r.messageId : '';
                if (this.deps.edit === null) this.closed = false;
            }
            else if (this.messageId !== '' && this.deps.edit) {
                const edited = await this.deps.edit(this.adapterId, this.chatId, this.messageId, text);
                if (edited === null) return false;
            }
            this.lastEdit = Date.now();
            return this.messageId !== '';
        }
        catch { return false; }
    }
}
