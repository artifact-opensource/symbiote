/**
 * Symbiote — WhatsApp Channel Adapter
 * 
 * Baileys (multi-device) integration. Media, reactions, read receipts,
 * groups, mentions, ephemeral messages, voice notes.
 * 
 * Session persistence via filesystem auth state.
 */

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type WAMessage,
  type MessageUpsertType,
  type BaileysEventMap,
  type proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const __wa_dirname = path.dirname(fileURLToPath(import.meta.url));
import { BaseAdapter } from '../adapter.js';
import { formatForChannel } from '../formatter.js';
import { logInbound, logOutbound, logReaction } from '../message-logger.js';
import type {
  ChannelCapabilities,
  ChannelConfig,
  ChannelSource,
  InboundPayload,
  MediaPayload,
  OutboundMessage,
  SendResult,
} from '../types.js';

// ─── WhatsApp Capabilities ─────────────────────────────────────────────────

const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  media: true,
  reactions: true,
  messageEdit: false,
  messageDelete: true,
  threads: false,
  embeds: false,
  components: false,
  voiceNotes: true,
  readReceipts: true,
  typingIndicator: true,
  ephemeral: true,
  polls: true,
  formatting: 'whatsapp',
  maxMessageLength: 4096,
  maxMediaSize: 16 * 1024 * 1024, // 16MB
  rateLimits: {
    messagesPerSecond: 1,
    messagesPerMinute: 30,
    burstSize: 3,
  },
};

// ─── Config ────────────────────────────────────────────────────────────────

export interface WhatsAppAdapterConfig extends ChannelConfig {
  /** Directory for auth state persistence */
  authDir: string;
  /** Phone number for this account (for identification) */
  phoneNumber?: string;
  /** Auto-read incoming messages */
  autoRead?: boolean;
  /** Mark presence as available */
  markOnline?: boolean;
  /** QR code callback (for linking) */
  onQR?: (qr: string) => void;
}

// ─── Adapter ───────────────────────────────────────────────────────────────

export class WhatsAppAdapter extends BaseAdapter {
  readonly id: string;
  readonly channelType = 'whatsapp';
  readonly capabilities = WHATSAPP_CAPABILITIES;

  private socket?: WASocket;
  private authDir = '';
  private autoRead = false;
  private markOnline = true;
  private onQR?: (qr: string) => void;
  private selfJid = '';
  private qrAttempts = 0;

  constructor(id = 'whatsapp-main') {
    super();
    this.id = id;
    this.maxReconnectAttempts = 15; // WhatsApp is flaky, give it more tries
  }

  // ── Platform Lifecycle ─────────────────────────────────────────────────

  protected async platformConnect(config: ChannelConfig): Promise<void> {
    const waConfig = config as WhatsAppAdapterConfig;
    this.authDir = waConfig.authDir;
    this.autoRead = waConfig.autoRead ?? false;
    this.markOnline = waConfig.markOnline ?? true;
    this.onQR = waConfig.onQR;

    // Ensure auth dir exists
    fs.mkdirSync(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
      },
      printQRInTerminal: false, // Deprecated in Baileys — we render QR ourselves
      markOnlineOnConnect: this.markOnline,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    // Persist credentials
    this.socket.ev.on('creds.update', saveCreds);

    // Connection updates
    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Track QR attempts for max retry
        this.qrAttempts++;
        
        // Render QR code in terminal
        console.log(`\n  \x1b[38;2;255;193;37m📱 WhatsApp QR Code — scan with WhatsApp to link (attempt ${this.qrAttempts}):\x1b[0m\n`);
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const qrt = require('qrcode-terminal');
          qrt.generate(qr, { small: true });
        } catch {
          console.log(`  QR Data: ${qr}\n`);
        }
        
        if (this.onQR) {
          this.onQR(qr);
        }
      }

      if (connection === 'open') {
        this.selfJid = this.socket?.user?.id ?? '';
        console.log(`[${this.id}] Connected as ${this.selfJid}`);
        this.health.transition('connected');

        // Auto-open web UI in browser after successful connection (Windows/Mac only — not headless servers)
        if (process.platform === 'win32' || process.platform === 'darwin') {
          try {
            const configPath = path.join(process.cwd(), 'symbiote.json');
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            const port = cfg.apiPort ?? 3006;
            const webUrl = `http://localhost:${port}`;
            const openCmd = process.platform === 'win32' ? 'start ""' : 'open';
            console.log(`\n  \x1b[38;2;0;230;118m✓\x1b[0m Opening web UI → \x1b[38;2;0;229;255m${webUrl}\x1b[0m\n`);
            exec(`${openCmd} "${webUrl}"`, () => {});
          } catch {
            // Non-fatal — web UI just won't auto-open
          }
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          // 440 = conflict (another socket took over). DON'T auto-reconnect from here
          // because BaseAdapter.reconnect will handle it properly with backoff.
          // The problem is: platformConnect registers this handler, and reconnect
          // calls platformReconnect which calls platformConnect again, creating
          // a NEW handler. If we also reconnect from HERE, we get two reconnect
          // attempts racing — causing infinite 440 loops.
          if (statusCode === 440) {
            console.log(`[${this.id}] Disconnected (440 conflict). Letting reconnect backoff handle it.`);
            this.health.transition('disconnected', `Status: ${statusCode}`);
            // Don't call reconnect here — the baseAdapter reconnect loop or
            // the registry's auto-reconnect will handle it with proper backoff
          } else {
            console.log(`[${this.id}] Disconnected (${statusCode}), reconnecting...`);
            this.health.transition('disconnected', `Status: ${statusCode}`);
            this.reconnect().catch(err => {
              console.error(`[${this.id}] Reconnect failed:`, err);
            });
          }
        } else {
          console.log(`[${this.id}] Logged out. Manual re-link required.`);
          this.health.transition('disconnected', 'Logged out');
        }
      }
    });

    // Incoming messages
    console.log(`[${this.id}] Registering messages.upsert listener`);
    this.socket.ev.on('messages.upsert', ({ messages, type }) => {
      console.log(`[${this.id}] messages.upsert fired: type=${type}, count=${messages.length}`);
      this.handleMessages(messages, type);
    });

    // Debug: log ALL events to see what Baileys is actually emitting
    const debugEvents = ['messages.update', 'messages.delete', 'message-receipt.update', 'messaging-history.set'] as const;
    for (const evName of debugEvents) {
      (this.socket.ev as any).on(evName, (data: any) => {
        const count = Array.isArray(data) ? data.length : (data?.messages?.length ?? '?');
        console.log(`[${this.id}] event: ${evName} (count=${count})`);
      });
    }

    // Reactions
    this.socket.ev.on('messages.reaction', (reactions) => {
      for (const { key, reaction } of reactions) {
        if (!reaction) continue;
        this.handleReaction(key, reaction);
      }
    });
  }

  protected async platformDisconnect(): Promise<void> {
    this.socket?.end(undefined);
    this.socket = undefined;
  }

  protected async platformReconnect(): Promise<void> {
    // Fully destroy old socket before creating new one
    if (this.socket) {
      try { this.socket.ev.removeAllListeners('connection.update'); } catch {}
      try { this.socket.ev.removeAllListeners('messages.upsert'); } catch {}
      try { this.socket.ev.removeAllListeners('messages.reaction'); } catch {}
      try { this.socket.ev.removeAllListeners('creds.update'); } catch {}
      this.socket.end(undefined);
      this.socket = undefined;
    }
    // Small delay to let WhatsApp server release the session
    await new Promise(r => setTimeout(r, 2000));
    await this.platformConnect({
      authDir: this.authDir,
      autoRead: this.autoRead,
      markOnline: this.markOnline,
      onQR: this.onQR,
    } as ChannelConfig);
  }

  // ── Inbound Handlers ──────────────────────────────────────────────────

  private handleMessages(messages: WAMessage[], type: MessageUpsertType): void {
    console.log(`[${this.id}] handleMessages: type=${type}, count=${messages.length}`);
    if (type !== 'notify') return; // Only process new messages

    for (const msg of messages) {
      console.log(`[${this.id}] msg: from=${msg.key.remoteJid}, fromMe=${msg.key.fromMe}, hasMsg=${!!msg.message}, participant=${msg.key.participant}`);
      if (!msg.message) continue;
      if (msg.key.fromMe) continue; // Ignore own messages

      const source = this.buildSource(msg);
      const payload = this.buildPayload(msg);

      if (payload) {
        // Auto-download media in background, then emit
        if (payload.media && payload.media.length > 0) {
          this.downloadAndEmit(msg, source, payload).catch(err => {
            console.error(`[${this.id}] Media download failed, emitting without local path:`, err);
            this.emit(source, payload, msg.key.id ?? undefined);
          });
        } else {
          this.emit(source, payload, msg.key.id ?? undefined);
        }

        // Auto-read
        if (this.autoRead && this.socket) {
          this.socket.readMessages([msg.key]).catch(() => {});
        }
      }
    }
  }

  /** Download media from message, attach local paths to payload, then emit */
  private async downloadAndEmit(msg: WAMessage, source: ChannelSource, payload: InboundPayload): Promise<void> {
    const mediaDir = path.join(os.tmpdir(), 'symbiote-media');
    try {
      const localPath = await this.downloadMedia(msg, mediaDir);
      if (localPath && payload.media) {
        payload.media[0].path = localPath;
        console.log(`[${this.id}] Media downloaded: ${localPath}`);
      }
    } catch (err) {
      console.warn(`[${this.id}] Media download failed:`, err);
    }
    this.emit(source, payload, msg.key.id ?? undefined);
  }

  private handleReaction(key: proto.IMessageKey, reaction: proto.IReaction): void {
    const chatId = key.remoteJid ?? '';
    const isGroup = chatId.endsWith('@g.us');

    this.emit(
      {
        channelType: 'whatsapp',
        adapterId: this.id,
        chatId,
        chatType: isGroup ? 'group' : 'dm',
        senderId: reaction.key?.participant ?? reaction.key?.remoteJid ?? 'unknown',
      },
      {
        type: 'reaction',
        reaction: {
          emoji: reaction.text ?? '',
          messageId: key.id ?? '',
          remove: !reaction.text, // Empty text = reaction removed
        },
      },
      `reaction-${key.id}-${reaction.text}`,
    );
  }

  // ── Source/Payload Builders ────────────────────────────────────────────

  private buildSource(msg: WAMessage): ChannelSource {
    const remoteJid = msg.key.remoteJid ?? '';
    const isGroup = remoteJid.endsWith('@g.us');
    const senderId = isGroup
      ? msg.key.participant ?? ''
      : remoteJid;

    // Extract mentions
    const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

    return {
      channelType: 'whatsapp',
      adapterId: this.id,
      chatId: remoteJid,
      chatType: isGroup ? 'group' : 'dm',
      senderId,
      senderName: msg.pushName ?? undefined,
      replyToId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
      mentions: mentionedJids.length > 0 ? mentionedJids : undefined,
    };
  }

  private buildPayload(msg: WAMessage): InboundPayload | null {
    const m = msg.message;
    if (!m) return null;

    // Text message
    const text = m.conversation
      ?? m.extendedTextMessage?.text
      ?? m.imageMessage?.caption
      ?? m.videoMessage?.caption
      ?? m.documentMessage?.caption
      ?? undefined;

    // Media
    const media: MediaPayload[] = [];

    if (m.imageMessage) {
      media.push({
        type: 'image',
        mimeType: m.imageMessage.mimetype ?? 'image/jpeg',
        sizeBytes: m.imageMessage.fileLength ? Number(m.imageMessage.fileLength) : undefined,
        width: m.imageMessage.width ?? undefined,
        height: m.imageMessage.height ?? undefined,
        caption: m.imageMessage.caption ?? undefined,
      });
    }

    if (m.videoMessage) {
      media.push({
        type: 'video',
        mimeType: m.videoMessage.mimetype ?? 'video/mp4',
        sizeBytes: m.videoMessage.fileLength ? Number(m.videoMessage.fileLength) : undefined,
        durationMs: m.videoMessage.seconds ? m.videoMessage.seconds * 1000 : undefined,
        caption: m.videoMessage.caption ?? undefined,
      });
    }

    if (m.audioMessage) {
      media.push({
        type: m.audioMessage.ptt ? 'voice' : 'audio',
        mimeType: m.audioMessage.mimetype ?? 'audio/ogg',
        sizeBytes: m.audioMessage.fileLength ? Number(m.audioMessage.fileLength) : undefined,
        durationMs: m.audioMessage.seconds ? m.audioMessage.seconds * 1000 : undefined,
      });
    }

    if (m.documentMessage) {
      media.push({
        type: 'document',
        mimeType: m.documentMessage.mimetype ?? 'application/octet-stream',
        filename: m.documentMessage.fileName ?? undefined,
        sizeBytes: m.documentMessage.fileLength ? Number(m.documentMessage.fileLength) : undefined,
      });
    }

    if (m.stickerMessage) {
      media.push({
        type: 'sticker',
        mimeType: m.stickerMessage.mimetype ?? 'image/webp',
      });
    }

    if (!text && media.length === 0) return null;

    return {
      type: media.length > 0 ? 'media' : 'text',
      text,
      media: media.length > 0 ? media : undefined,
      raw: msg,
    };
  }

  // ── Outbound ───────────────────────────────────────────────────────────

  protected async platformSend(chatId: string, message: OutboundMessage): Promise<SendResult> {
    if (!this.socket) {
      console.warn(`[${this.id}] Send failed: not connected`);
      return { success: false, error: 'Not connected' };
    }

    if (this.health.state !== 'connected') {
      console.warn(`[${this.id}] Send attempted while health=${this.health.state}, proceeding anyway`);
    }

    const chunks = message.content
      ? formatForChannel(message.content, this.capabilities)
      : [''];

    let lastMessageId: string | undefined;

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;

      try {
        // Send media on last chunk if present
        if (isLast && message.media?.length) {
          for (const media of message.media) {
            const sent = await this.sendMedia(chatId, media, chunks[i], undefined);
            lastMessageId = sent;
          }
        } else if (chunks[i]) {
          console.log(`[whatsapp-send] Sending text to ${chatId}: ${chunks[i].slice(0, 80)}...`);
          const sent = await this.socket.sendMessage(chatId, {
            text: chunks[i],
          });
          console.log(`[whatsapp-send] sendMessage returned:`, JSON.stringify(sent?.key));
          lastMessageId = sent?.key?.id ?? undefined;
        }
      } catch (err) {
        console.error(`[whatsapp-send] Error:`, err);
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      success: true,
      messageId: lastMessageId,
      deliveredAt: Date.now(),
    };
  }

  private async sendMedia(
    chatId: string,
    media: MediaPayload,
    caption?: string,
    quoted?: any,
  ): Promise<string | undefined> {
    if (!this.socket) return undefined;

    const source = media.url ?? media.path;
    if (!source) return undefined;

    const isUrl = source.startsWith('http');
    const mediaContent = isUrl ? { url: source } : fs.readFileSync(source);

    let msgContent: any;

    switch (media.type) {
      case 'image':
        msgContent = { image: mediaContent, caption, mimetype: media.mimeType };
        break;
      case 'video':
        msgContent = { video: mediaContent, caption, mimetype: media.mimeType };
        break;
      case 'audio':
      case 'voice':
        msgContent = { audio: mediaContent, mimetype: media.mimeType, ptt: media.type === 'voice' };
        break;
      case 'document':
        msgContent = { document: mediaContent, caption, mimetype: media.mimeType, fileName: media.filename };
        break;
      case 'sticker':
        msgContent = { sticker: mediaContent, mimetype: media.mimeType };
        break;
      default:
        msgContent = { document: mediaContent, caption, mimetype: media.mimeType };
    }

    const sent = await this.socket.sendMessage(chatId, msgContent, { quoted });
    return sent?.key?.id ?? undefined;
  }

  // ── Platform Actions ───────────────────────────────────────────────────

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.socket) return;
    try {
      await this.socket.sendMessage(chatId, {
        react: { text: emoji, key: { remoteJid: chatId, id: messageId } as any },
      });
    } catch (err) {
      console.error(`[${this.id}] React failed:`, err);
    }
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.socket) return;
    try {
      await this.socket.sendMessage(chatId, {
        delete: { remoteJid: chatId, id: messageId } as any,
      });
    } catch (err) {
      console.error(`[${this.id}] Delete failed:`, err);
    }
  }

  // ── Group Management ───────────────────────────────────────────────────

  async groupUpdateSubject(groupJid: string, subject: string): Promise<void> {
    if (!this.socket) return;
    try {
      await this.socket.groupUpdateSubject(groupJid, subject);
      console.log(`[${this.id}] Group subject updated: ${groupJid} → "${subject}"`);
    } catch (err) {
      console.error(`[${this.id}] Group subject update failed:`, err);
    }
  }

  async groupUpdateDescription(groupJid: string, description: string): Promise<void> {
    if (!this.socket) return;
    try {
      await this.socket.groupUpdateDescription(groupJid, description);
      console.log(`[${this.id}] Group description updated: ${groupJid}`);
    } catch (err) {
      console.error(`[${this.id}] Group description update failed:`, err);
    }
  }

  /**
   * Send typing (composing) indicator.
   * @param chatId - Chat to show typing in
   * @param durationMs - Controls behavior:
   *   - `> 0 && finite`: One-shot composing, auto-pauses after durationMs
   *   - `Infinity`: Sustained composing, no auto-pause (PresenceManager handles lifecycle)
   *   - `0`: Just send 'paused' — used by PresenceManager.stopTyping() to dismiss bubble
   */
  async typing(chatId: string, durationMs = 3000): Promise<void> {
    if (!this.socket) return;
    try {
      if (durationMs === 0) {
        // Explicit pause — dismiss composing bubble immediately
        await this.socket.sendPresenceUpdate('paused', chatId);
        return;
      }
      await this.socket.presenceSubscribe(chatId);
      await this.socket.sendPresenceUpdate('composing', chatId);
      // Only auto-pause for one-shot typing calls.
      // Sustained typing (PresenceManager) passes Infinity — pause is sent by stopTyping().
      if (durationMs > 0 && isFinite(durationMs)) {
        setTimeout(() => {
          this.socket?.sendPresenceUpdate('paused', chatId).catch(() => {});
        }, durationMs);
      }
    } catch { /* ignore */ }
  }

  /**
   * Explicitly pause typing indicator. Called when a turn ends.
   */
  async pauseTyping(chatId: string): Promise<void> {
    if (!this.socket) return;
    try {
      await this.socket.sendPresenceUpdate('paused', chatId);
    } catch { /* ignore */ }
  }

  async markRead(chatId: string, messageId: string): Promise<void> {
    if (!this.socket) return;
    try {
      await this.socket.readMessages([{
        remoteJid: chatId,
        id: messageId,
      } as any]);
    } catch { /* ignore */ }
  }

  // ── Media Download ─────────────────────────────────────────────────────

  /**
   * Download media from a WhatsApp message.
   * Returns the local file path.
   */
  async downloadMedia(msg: WAMessage, outputDir: string): Promise<string | null> {
    if (!this.socket) return null;

    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      if (!buffer) return null;

      fs.mkdirSync(outputDir, { recursive: true });
      const ext = this.guessExtension(msg);
      const filename = `${msg.key.id ?? Date.now()}${ext}`;
      const filepath = path.join(outputDir, filename);
      fs.writeFileSync(filepath, buffer as Buffer);
      return filepath;
    } catch (err) {
      console.error(`[${this.id}] Media download failed:`, err);
      return null;
    }
  }

  private guessExtension(msg: WAMessage): string {
    const m = msg.message;
    if (!m) return '';
    if (m.imageMessage) return '.jpg';
    if (m.videoMessage) return '.mp4';
    if (m.audioMessage) return m.audioMessage.ptt ? '.ogg' : '.mp3';
    if (m.documentMessage) {
      const name = m.documentMessage.fileName ?? '';
      const ext = path.extname(name);
      return ext || '.bin';
    }
    if (m.stickerMessage) return '.webp';
    return '';
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  getSelfJid(): string {
    return this.selfJid;
  }

  getSocket(): WASocket | undefined {
    return this.socket;
  }
}
