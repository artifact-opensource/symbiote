/**
 * Symbiote — Discord Channel Adapter
 * 
 * Full discord.js integration. Guilds, DMs, threads, embeds,
 * reactions, components, typing indicators.
 * 
 * Platform-native. No lowest-common-denominator flattening.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message as DiscordMessage,
  type TextChannel,
  type DMChannel,
  type ThreadChannel,
  type NewsChannel,
  type GuildTextBasedChannel,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  type Interaction,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js';
import { BaseAdapter, TokenBucketLimiter } from '../adapter.js';
import { formatForChannel } from '../formatter.js';
import type {
  ChannelCapabilities,
  ChannelConfig,
  ChannelSource,
  InboundPayload,
  MediaPayload,
  OutboundMessage,
  SendResult,
  MessageComponent,
} from '../types.js';

// ─── Discord Capabilities ──────────────────────────────────────────────────

const DISCORD_CAPABILITIES: ChannelCapabilities = {
  media: true,
  reactions: true,
  messageEdit: true,
  messageDelete: true,
  threads: true,
  embeds: true,
  components: true,
  voiceNotes: false,
  readReceipts: false,
  typingIndicator: true,
  ephemeral: true,
  polls: false,
  formatting: 'markdown',
  maxMessageLength: 2000,
  maxMediaSize: 25 * 1024 * 1024, // 25MB (Nitro: 100MB)
  rateLimits: {
    messagesPerSecond: 5,
    burstSize: 5,
  },
};

// ─── Config ────────────────────────────────────────────────────────────────

export interface DiscordAdapterConfig extends ChannelConfig {
  token: string;
  /** Bot's application/user ID (for mention detection) */
  botId?: string;
  /** Sibling bot IDs — these bots are NOT filtered out (enables multi-bot coordination) */
  siblingBotIds?: string[];
}

// ─── Adapter ───────────────────────────────────────────────────────────────

/**
 * Slash command handler callback — receives the Discord interaction and
 * returns a response string (or empty string for silent ack).
 */
export type DiscordCommandHandler = (interaction: ChatInputCommandInteraction) => Promise<string>;

export class DiscordAdapter extends BaseAdapter {
  readonly id: string;
  readonly channelType = 'discord';
  readonly capabilities = DISCORD_CAPABILITIES;

  private client?: Client;
  private token = '';
  private botId = '';
  private siblingBotIds: Set<string> = new Set();
  private lastConfig: DiscordAdapterConfig | null = null;
  /** Registered slash command handlers (command name → handler) */
  private commandHandlers = new Map<string, DiscordCommandHandler>();

  constructor(id = 'discord-main') {
    super();
    this.id = id;
  }

  /** Register a slash command handler */
  registerCommand(name: string, handler: DiscordCommandHandler): void {
    this.commandHandlers.set(name, handler);
  }

  // ── Platform Lifecycle ─────────────────────────────────────────────────

  protected async platformConnect(config: ChannelConfig): Promise<void> {
    const discordConfig = config as DiscordAdapterConfig;
    this.lastConfig = { ...discordConfig };
    this.token = discordConfig.token;

    // Sibling bots are peers — never filter them out
    if (discordConfig.siblingBotIds?.length) {
      this.siblingBotIds = new Set(discordConfig.siblingBotIds);
    } else {
      this.siblingBotIds = new Set();
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction,
      ],
    });

    // Wire events
    this.client.on(Events.MessageCreate, (msg) => this.handleMessage(msg));
    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      this.handleReaction(reaction as any, user as any, false);
    });
    this.client.on(Events.MessageReactionRemove, (reaction, user) => {
      this.handleReaction(reaction as any, user as any, true);
    });
    this.client.on(Events.MessageUpdate, (_old, newMsg) => {
      if (newMsg.partial) return;
      this.handleEdit(newMsg as DiscordMessage);
    });
    this.client.on(Events.MessageDelete, (msg) => {
      this.handleDelete(msg as DiscordMessage);
    });

    // Slash command interactions
    this.client.on(Events.InteractionCreate, (interaction) => {
      this.handleInteraction(interaction as Interaction).catch((err) => {
        console.error(`[${this.id}] Interaction error:`, err);
      });
    });

    // Health events
    this.client.on(Events.ClientReady, async () => {
      this.botId = this.client!.user?.id ?? '';
      console.log(`[${this.id}] Connected as ${this.client!.user?.tag} (${this.botId})`);
      await this.registerSlashCommands().catch((err) => {
        console.error(`[${this.id}] Slash command registration failed:`, err);
      });
    });
    this.client.on(Events.Error, (err) => {
      console.error(`[${this.id}] Error:`, err.message);
      this.health.transition('degraded');
    });
    this.client.on(Events.ShardDisconnect, () => {
      this.health.transition('disconnected', 'Shard disconnected');
    });
    this.client.on(Events.ShardReconnecting, () => {
      this.health.transition('reconnecting');
    });
    this.client.on(Events.ShardResume, () => {
      this.health.transition('connected');
    });

    try {
      await this.client.login(this.token);
    } catch (err) {
      this.client.destroy();
      this.client = undefined;
      throw err;
    }
  }

  protected async platformDisconnect(): Promise<void> {
    this.client?.destroy();
    this.client = undefined;
  }

  protected async platformReconnect(): Promise<void> {
    console.log(`[${this.id}] reconnecting Discord adapter — preserving upgraded config`);
    await new Promise(r => setTimeout(r, 3000));
    this.client?.destroy();
    this.client = undefined;

    const reconnectConfig = this.lastConfig ?? ({ token: this.token } as DiscordAdapterConfig);
    await this.platformConnect(reconnectConfig);
  }

  // ── Inbound Handlers ──────────────────────────────────────────────────

  private handleMessage(msg: DiscordMessage): void {
    // Ignore own messages
    if (msg.author.id === this.botId) return;
    // Ignore non-sibling bots (random bots in the server)
    // Sibling bots ARE allowed through — the router's @mention check handles loop prevention
    if (msg.author.bot && !this.siblingBotIds.has(msg.author.id)) return;

    // Temporary diagnostic log to confirm inbound Discord events reach the adapter.
    console.log(
      `[${this.id}] inbound message: guild=${msg.guildId ?? 'dm'} channel=${msg.channel.id} ` +
      `author=${msg.author.id} bot=${msg.author.bot} chatType=${this.resolveChatType(msg.channel)} ` +
      `contentLen=${msg.content?.length ?? 0} mentions=${msg.mentions.users.size}`,
    );

    const source = this.buildSource(msg);
    const payload = this.buildPayload(msg);

    console.log(
      `[${this.id}] routed payload: chatId=${source.chatId} sender=${source.senderId} ` +
      `chatType=${source.chatType} text=${payload.text ? 'yes' : 'no'} media=${payload.media?.length ?? 0}`,
    );

    this.emit(source, payload, msg.id);
  }

  private handleReaction(reaction: any, user: any, remove: boolean): void {
    if (user.id === this.botId) return;

    const chatId = reaction.message.channel?.id ?? '';
    const chatType = this.resolveChatType(reaction.message.channel);

    this.emit(
      {
        channelType: 'discord',
        adapterId: this.id,
        chatId,
        chatType,
        senderId: user.id,
        senderName: user.username,
      },
      {
        type: 'reaction',
        reaction: {
          emoji: reaction.emoji?.name ?? '❓',
          messageId: reaction.message.id,
          messageAuthorId: reaction.message.author?.id,
          remove,
        },
      },
      `reaction-${reaction.message.id}-${user.id}-${reaction.emoji?.name}`,
    );
  }

  private handleEdit(msg: DiscordMessage): void {
    if (msg.author.id === this.botId) return;

    const source = this.buildSource(msg);
    this.emit(
      source,
      {
        type: 'edit',
        edit: { messageId: msg.id, newText: msg.content },
        raw: msg,
      },
      `edit-${msg.id}-${Date.now()}`,
    );
  }

  private handleDelete(msg: DiscordMessage): void {
    const chatId = msg.channel?.id ?? '';
    const chatType = this.resolveChatType(msg.channel as any);

    this.emit(
      {
        channelType: 'discord',
        adapterId: this.id,
        chatId,
        chatType,
        senderId: msg.author?.id ?? 'unknown',
      },
      { type: 'delete', raw: { messageId: msg.id } },
      `delete-${msg.id}`,
    );
  }

  // ── Slash Command Handler ─────────────────────────────────────────────

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const commandName = interaction.commandName;
    const handler = this.commandHandlers.get(commandName);
    if (!handler) {
      await interaction.reply({ content: '❓ Unknown command.', ephemeral: true }).catch(() => {});
      return;
    }

    // Defer reply so we have time to process
    await interaction.deferReply().catch(() => {});

    try {
      const response = await handler(interaction);
      if (response) {
        await interaction.editReply({ content: response }).catch(() => {});
      }
      // If response is empty, the handler already replied or wants silence
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await interaction.editReply({ content: `⚠️ Error: ${errMsg}` }).catch(() => {});
    }
  }

  // ── Source/Payload Builders ────────────────────────────────────────────

  private buildSource(msg: DiscordMessage): ChannelSource {
    const chatType = this.resolveChatType(msg.channel);
    const mentions = msg.mentions.users.map(u => u.id);

    return {
      channelType: 'discord',
      adapterId: this.id,
      chatId: msg.channel.id,
      chatType,
      senderId: msg.author.id,
      senderName: msg.member?.displayName ?? msg.author.displayName ?? msg.author.username,
      replyToId: msg.reference?.messageId ?? undefined,
      threadId: msg.channel.isThread() ? msg.channel.id : undefined,
      mentions,
    };
  }

  private buildPayload(msg: DiscordMessage): InboundPayload {
    const media: MediaPayload[] = [];

    for (const att of msg.attachments.values()) {
      media.push({
        type: this.resolveMediaType(att.contentType ?? ''),
        url: att.url,
        mimeType: att.contentType ?? undefined,
        filename: att.name ?? undefined,
        sizeBytes: att.size,
        width: att.width ?? undefined,
        height: att.height ?? undefined,
      });
    }

    // Stickers
    for (const sticker of msg.stickers.values()) {
      media.push({
        type: 'sticker',
        url: sticker.url,
        filename: sticker.name,
      });
    }

    return {
      type: media.length > 0 && !msg.content ? 'media' : 'text',
      text: msg.content || undefined,
      media: media.length > 0 ? media : undefined,
      raw: msg,
    };
  }

  private resolveChatType(channel: any): 'dm' | 'group' | 'channel' | 'thread' {
    if (!channel) return 'channel';
    if (channel.type === ChannelType.DM) return 'dm';
    if (channel.isThread?.()) return 'thread';
    return 'channel'; // Guild text channels
  }

  private resolveMediaType(contentType: string): MediaPayload['type'] {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  // ── Outbound ───────────────────────────────────────────────────────────

  protected async platformSend(chatId: string, message: OutboundMessage): Promise<SendResult> {
    const channel = await this.resolveChannel(chatId);
    if (!channel) {
      return { success: false, error: `Channel ${chatId} not found` };
    }

    // Format content for Discord
    const content = message.content || '';
    const chunks = content ? formatForChannel(content, this.capabilities) : [''];

    let lastMessageId: string | undefined;

    for (let i = 0; i < chunks.length; i++) {
      const isFirst = i === 0;
      const isLast = i === chunks.length - 1;

      const sendOptions: any = {
        content: chunks[i] || undefined,
      };

      // Reply only on first chunk
      if (isFirst && message.replyToId) {
        sendOptions.reply = { messageId: message.replyToId };
      }

      // Media on last chunk
      if (isLast && message.media?.length) {
        sendOptions.files = message.media.map(m => ({
          attachment: m.url ?? m.path ?? '',
          name: m.filename,
        }));
      }

      // Components on last chunk
      if (isLast && message.components?.length) {
        sendOptions.components = this.buildComponents(message.components);
      }

      try {
        const sent = await channel.send(sendOptions);
        lastMessageId = sent.id;
      } catch (err) {
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

  private async resolveChannel(chatId: string): Promise<TextChannel | DMChannel | ThreadChannel | NewsChannel | null> {
    if (!this.client) return null;
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (!channel) return null;
      if ('send' in channel) return channel as any;
      return null;
    } catch {
      return null;
    }
  }

  private async registerSlashCommands(): Promise<void> {
    if (!this.client?.application?.id || !this.token) return;

    const commands = [
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('Switch the active model for this chat')
        .addStringOption(option => option.setName('model').setDescription('Model name or provider/model').setRequired(true))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('provider')
        .setDescription('Switch the active provider or provider/model for this chat')
        .addStringOption(option => option.setName('provider').setDescription('Provider name or provider/model').setRequired(true))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset this chat session and drop prior state')
        .toJSON(),
      new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Reload config and restart the active chat context')
        .toJSON(),
    ];

    const rest = new REST({ version: '10' }).setToken(this.token);
    await rest.put(Routes.applicationCommands(this.client.application.id), { body: commands });
  }

  private buildComponents(components: MessageComponent[]): any[] {
    const rows: any[] = [];
    let currentRow = new ActionRowBuilder<ButtonBuilder>();
    let buttonCount = 0;

    for (const comp of components) {
      if (comp.type === 'button') {
        const button = new ButtonBuilder()
          .setCustomId(comp.value ?? comp.label ?? 'btn')
          .setLabel(comp.label ?? 'Button')
          .setStyle(this.resolveButtonStyle(comp.style));

        currentRow.addComponents(button);
        buttonCount++;

        if (buttonCount >= 5) {
          rows.push(currentRow);
          currentRow = new ActionRowBuilder<ButtonBuilder>();
          buttonCount = 0;
        }
      }
    }

    if (buttonCount > 0) rows.push(currentRow);
    return rows;
  }

  private resolveButtonStyle(style?: string): ButtonStyle {
    switch (style) {
      case 'primary': return ButtonStyle.Primary;
      case 'danger': return ButtonStyle.Danger;
      case 'success': return ButtonStyle.Success;
      case 'link': return ButtonStyle.Link;
      default: return ButtonStyle.Secondary;
    }
  }

  // ── Platform Actions ───────────────────────────────────────────────────

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.resolveChannel(chatId);
    if (!channel) return;
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.react(emoji);
    } catch (err) {
      console.error(`[${this.id}] React failed:`, err);
    }
  }

  /**
   * Edit a message previously sent by this bot.
   * Canonical implementation (merged 2026-08-24 — was duplicated, TS2393).
   * Author-guarded + 2000-char truncated + SendResult.
   */
  async editMessage(chatId: string, messageId: string, newContent: string): Promise<SendResult> {
    try {
      if (!this.client) return { success: false, error: 'not connected' };
      const channel = await this.resolveChannel(chatId);
      if (!channel) return { success: false, error: `Channel ${chatId} not found` };
      const msg = await channel.messages.fetch(messageId);
      if (msg.author.id !== this.botId) {
        return { success: false, error: 'refusing to edit a non-bot message' };
      }
      await msg.edit(newContent.length > 2000 ? newContent.slice(0, 2000) : newContent);
      return { success: true, messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[${this.id}] Edit failed:`, error);
      return { success: false, error };
    }
  }

  /** Remove this bot's own reaction from a message (emoji-swap support). */
  async unreact(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client?.user) return;
    const channel = await this.resolveChannel(chatId);
    if (!channel) return;
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.reactions.cache.get(emoji)?.users.remove(this.client.user.id);
    } catch { /* cosmetic — ignore */ }
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    const channel = await this.resolveChannel(chatId);
    if (!channel) return;
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.delete();
    } catch (err) {
      console.error(`[${this.id}] Delete failed:`, err);
    }
  }

  async typing(chatId: string, _durationMs?: number): Promise<void> {
    const channel = await this.resolveChannel(chatId);
    if (!channel) return;
    try {
      await channel.sendTyping();
    } catch { /* ignore */ }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Get the bot's user ID */
  getBotId(): string {
    return this.botId;
  }

  /** Get the underlying discord.js client (for advanced usage) */
  getClient(): Client | undefined {
    return this.client;
  }
}
