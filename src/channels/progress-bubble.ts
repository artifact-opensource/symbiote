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
    terminal: '💻', bash: '💻', shell: '💻', exec: '⚙️',
    read_file: '📄', read: '📄', write_file: '✏️', write: '✏️',
    edit_file: '✏️', patch: '🩹', apply_patch: '🩹',
    search_files: '🔎', grep: '🔎', glob: '🔎', find: '🔎',
    web_search: '🌐', web: '🌐', fetch: '🌐', http: '🌐',
    browser: '🌍', memory_search: '🧠', memory: '🧠',
    message: '💬', send_message: '💬', list: '📋', ls: '📋',
};

const EDIT_THROTTLE_MS = 1500;
const TEXT_BUDGET = 3800;
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
    const one = String(v).split('\n')[0].trim();
    if (!one) return '';
    return one.length > PREVIEW_CAP ? one.slice(0, PREVIEW_CAP - 3) + '...' : one;
}

export class ToolProgressBubble {
    private lines: string[] = [];
    private messageId: string | null = null;
    private lastEdit = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private totalCount = 0;
    private done = false;

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
            this.lines.push(prev ? `${emoji} **${name}** \`${prev}\`` : `${emoji} **${name}**`);
            if (this.lines.length > 40) this.lines.splice(0, this.lines.length - 40);
            await this.flush(false);
        }
        catch { /* never break an agent turn over cosmetics */ }
    }

    /** Force a final edit (turn finished). */
    async finalize(): Promise<void> {
        if (this.closed) return;
        // Never posted a message and no tool lines — don't create a stray
        // "Working…" bubble for tool-less turns.
        if (this.messageId === null && this.lines.length === 0) { this.closed = true; return; }
        this.closed = true;
        this.done = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        try { await this.flush(true); } catch { /* ignore */ }
    }

    private render(): string {
        const header = this.done
            ? `✅ **Done — ${this.totalCount} tool call${this.totalCount === 1 ? '' : 's'}**`
            : '⚙️ **Working…**';
        let ls = this.lines.slice();
        while (ls.length > 1 && ((header + '\n').length + ls.join('\n').length) > TEXT_BUDGET) {
            ls.shift();
        }
        return header + '\n' + ls.join('\n');
    }

    private async flush(force: boolean): Promise<void> {
        if (this.deps.edit === null && this.messageId !== null) return; // no edit path available
        const now = Date.now();
        if (!force && this.messageId !== null) {
            const wait = EDIT_THROTTLE_MS - (now - this.lastEdit);
            if (wait > 0) {
                if (!this.timer) {
                    this.timer = setTimeout(() => { this.timer = null; void this.flush(true).catch(() => { }); }, wait);
                }
                return;
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
                await this.deps.edit(this.adapterId, this.chatId, this.messageId, text);
            }
            this.lastEdit = Date.now();
        }
        catch { /* ignore */ }
    }
}
