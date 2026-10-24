/**
 * Tool Progress Bubble — live "what am I doing" message for chat channels.
 *
 * Tool starts are accumulated into one editable message. The message collapses
 * to a one-line count when the turn finishes.
 *
 * Enabled via symbiote.json -> toolProgress = true.
 */

export const TOOL_EMOJI: Readonly<Record<string, string>> = {
    read: '📖',
    write: '✍️',
    edit: '✏️',
    exec: '⚡',
    image: '🖼️',
    image_gen: '🎨',
    process_start: '🚀',
    process_poll: '📊',
    process_kill: '🛑',
    process_list: '📋',
    tts: '🔊',
    stt: '🎙️',
    web_fetch: '🌐',
    memory_search: '🧠',
    comb_recall: '🔮',
    comb_stage: '💾',
    memory_offload: '📦',
    memory_recall: '🧭',
    memory_ingest: '🧬',
    memory_stats: '📈',
    google_workspace: '📅',
    azure_cloud: '☁️',
    oci_cloud: '🏗️',
    n8n_cloud: '🔗',
    kaggle_cloud: '🧪',
    kaggle_kernel_push: '🧫',
    web_browse: '🌍',
    web_click: '🖱️',
    web_type: '⌨️',
    web_screenshot: '📸',
    web_extract: '🧾',
    web_scroll: '📜',
    web_wait: '⏳',
    web_session: '🗂️',
    web_tab_open: '🆕',
    web_tab_switch: '🔀',
    web_tab_close: '🚪',
    web_tabs: '🪟',
    web_download: '⬇️',
    web_upload: '⬆️',
    cua_screenshot: '👁️',
    cua_click: '👆',
    cua_move: '🫳',
    cua_type: '🔤',
    cua_press: '🎛️',
    cua_scroll: '↕️',
    computer_use: '🤖',
    persona_digest: '🧙',
    fs: '🗃️',
    hardware: '🔧',
    todo: '✅',
    cron_manage: '⏰',
    threads_manage: '🧵',
    message: '💬',
    typing: '📝',
    presence: '🟢',
    delete_message: '🗑️',
    mark_read: '👀',
    spawn: '🪺',
    subagent_status: '🔍',
    workspace_tasks: '🗒️',
    workspace_manage: '🏢',
};

const EDIT_THROTTLE_MS = 1000;
const TEXT_BUDGET = 1900;
const PREVIEW_CAP = 60;
type ProgressOutcome = 'done' | 'interrupted' | 'failed';

export interface ProgressDeps {
    enabled: boolean;
    /** Send a new message; must resolve to the platform SendResult (messageId optional). */
    send: (adapterId: string, chatId: string, content: string) => Promise<{ success?: boolean; messageId?: string; error?: string } | null>;
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
    private lastRenderedText: string | null = null;
    private flushPromise: Promise<boolean> | null = null;
    private flushPending = false;
    private forcePending = false;
    private outcome: ProgressOutcome = 'done';

    constructor(
        private deps: ProgressDeps,
        private adapterId: string,
        private chatId: string,
    ) { }

    /** Called on every onToolStart with the tool's input args. */
    async toolLine(name: string, args?: Record<string, unknown>): Promise<void> {
        if (this.closed || !this.deps.enabled) return;
        try {
            const prev = previewOf(name, args);
            const emoji = TOOL_EMOJI[name] ?? '🧰';
            this.totalCount++;
            this.lines.push(prev ? `${emoji} **${name}** \`${prev}\`` : `${emoji} **${name}**`);
            if (this.lines.length > 40) this.lines.splice(0, this.lines.length - 40);
            await this.flush(false);
        }
        catch (error) {
            console.error(`[progress] Could not record ${name} activity for ${this.adapterId}/${this.chatId}:`, error);
        }
    }

    async todoLine(progressText: string): Promise<void> {
        if (this.closed || !this.deps.enabled) return;
        const escaped = redactSensitiveValues(progressText)
            .replaceAll('\\', '\\\\')
            .replaceAll('"', '\\"')
            .replace(/\s+/g, ' ')
            .trim();
        if (!escaped) return;
        const maxTextLength = TEXT_BUDGET - '⚙️ **Working…**\n✅ todo [completed]: ""'.length;
        const text = escaped.length > maxTextLength ? `${escaped.slice(0, maxTextLength - 3)}...` : escaped;
        this.lines.push(`✅ todo [completed]: "${text}"`);
        if (this.lines.length > 40) this.lines.splice(0, this.lines.length - 40);
        await this.flush(false);
    }

    /** Force a final edit (turn finished), collapsing the bubble to one line. */
    async finalize(outcome: ProgressOutcome = 'done'): Promise<void> {
        if (this.closed) return;
        // Never posted a message and no tool lines — don't create a stray
        // "Working…" bubble for tool-less turns.
        if (this.messageId === null && this.totalCount === 0) { this.closed = true; return; }
        this.closed = true;
        this.outcome = outcome;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.flushPromise) await this.flushPromise;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        try {
            if (!await this.flush(true) && this.totalCount > 0) {
                console.error(`[progress] Final activity summary was not delivered for ${this.adapterId}/${this.chatId}.`);
            }
        } catch (error) {
            console.error(`[progress] Could not finalize activity for ${this.adapterId}/${this.chatId}:`, error);
        }
    }

    private render(): string {
        if (this.closed) {
            const prefix = this.outcome === 'done' ? '✅ **Done' : this.outcome === 'interrupted' ? '⏸️ **Interrupted' : '⚠️ **Failed';
            return `${prefix} — ${this.totalCount} tool call${this.totalCount === 1 ? '' : 's'}**`;
        }
        const header = '⚙️ **Working…**';
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
        if (this.messageId !== null && this.messageId !== '' && text === this.lastRenderedText) {
            return true;
        }
        try {
            if (this.messageId === null) {
                const r = await this.deps.send(this.adapterId, this.chatId, text);
                if (!r || r.success === false) {
                    throw new Error(r?.error ?? 'Channel send returned no successful delivery result.');
                }
                // '' sentinel = sent but not editable (no messageId back)
                this.messageId = r && r.messageId ? r.messageId : '';
                this.lastRenderedText = text;
                if (this.deps.edit === null) this.closed = false;
            }
            else if (this.messageId !== '' && this.deps.edit) {
                const edited = await this.deps.edit(this.adapterId, this.chatId, this.messageId, text);
                if (edited === null || edited === false) {
                    throw new Error('Channel did not confirm the progress-message edit.');
                }
                this.lastRenderedText = text;
            }
            this.lastEdit = Date.now();
            return this.messageId !== '';
        }
        catch (error) {
            console.error(`[progress] Delivery failed for ${this.adapterId}/${this.chatId}:`, error);
            return false;
        }
    }
}
