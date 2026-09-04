// Symbiote — Builtin tool: proactive messaging & social actions
// Send messages, media, reactions, typing indicators, presence updates.
// This is what makes AVA a social being, not just a responder.

import type { ToolDefinition } from '../types.js';
import type { ChannelRegistry } from '../../channels/registry.js';
import type { OutboundMessage, MediaPayload } from '../../channels/types.js';

/** Factory — needs registry reference from daemon */
export function createMessageTool(registry: ChannelRegistry): ToolDefinition {
  return {
    name: 'message',
    description: [
      'Send a message to a chat on any connected channel (WhatsApp, Discord).',
      'Can send text, media (images/audio/docs), and reactions.',
      'Use this to proactively reach out, send files, or react to messages.',
      'For reactions, set action="react" with emoji and messageId.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel type: "whatsapp" or "discord"',
          enum: ['whatsapp', 'discord'],
        },
        chatId: {
          type: 'string',
          description: 'Chat/channel ID. WhatsApp: JID or LID. Discord: channel ID.',
        },
        content: {
          type: 'string',
          description: 'Text message content. Required unless sending a reaction.',
        },
        action: {
          type: 'string',
          description: 'Action type: "send" (default) or "react"',
          enum: ['send', 'react'],
        },
        replyToId: {
          type: 'string',
          description: 'Message ID to reply to (optional)',
        },
        media: {
          type: 'object',
          description: 'Media attachment. Properties: type ("image"|"audio"|"video"|"document"|"voice"|"sticker"), path (local file path or URL), caption (optional)',
          properties: {
            type: { type: 'string' },
            path: { type: 'string' },
            caption: { type: 'string' },
            filename: { type: 'string' },
          },
        },
        emoji: {
          type: 'string',
          description: 'Emoji for reactions (when action="react")',
        },
        messageId: {
          type: 'string',
          description: 'Target message ID for reactions (when action="react")',
        },
      },
      required: ['channel', 'chatId'],
    },
    async execute(input) {
      const channel = input.channel as string;
      const chatId = input.chatId as string;
      const action = (input.action as string) ?? 'send';
      const content = input.content as string | undefined;
      const replyToId = input.replyToId as string | undefined;
      const emoji = input.emoji as string | undefined;
      const messageId = input.messageId as string | undefined;

      // Find the adapter for this channel type
      const adapters = registry.list();
      const target = adapters.find(a => a.channelType === channel && a.status === 'running');
      if (!target) {
        return JSON.stringify({ error: `No running adapter for channel "${channel}". Available: ${adapters.map(a => `${a.channelType}(${a.status})`).join(', ')}` });
      }

      const adapter = registry.get(target.id);
      if (!adapter) return JSON.stringify({ error: 'Adapter not found' });

      // ── Reaction ──
      if (action === 'react') {
        if (!emoji) return JSON.stringify({ error: 'emoji is required for reactions' });
        if (!messageId) return JSON.stringify({ error: 'messageId is required for reactions' });

        if (typeof (adapter as any).react === 'function') {
          try {
            await (adapter as any).react(chatId, messageId, emoji);
            return JSON.stringify({ success: true, action: 'react', emoji, messageId });
          } catch (err) {
            return JSON.stringify({ error: `Reaction failed: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        return JSON.stringify({ error: `Adapter "${channel}" does not support reactions` });
      }

      // ── Send message ──
      if (!content && !input.media) {
        return JSON.stringify({ error: 'Either content or media is required for sending' });
      }

      const outbound: OutboundMessage = {
        content: content ?? '',
        replyToId,
      };

      // Attach media if provided
      if (input.media) {
        const m = input.media as Record<string, unknown>;
        const mediaPayload: MediaPayload = {
          type: (m.type as MediaPayload['type']) ?? 'document',
          caption: m.caption as string | undefined,
          filename: m.filename as string | undefined,
        };

        const mediaPath = m.path as string;
        if (mediaPath?.startsWith('http://') || mediaPath?.startsWith('https://')) {
          mediaPayload.url = mediaPath;
        } else if (mediaPath) {
          mediaPayload.path = mediaPath;
        }

        outbound.media = [mediaPayload];
      }

      try {
        const result = await registry.sendToChannel(channel, chatId, outbound);
        // Check if the adapter actually succeeded (don't blindly return success)
        if (result && (result as any).success === false) {
          return JSON.stringify({
            success: false,
            action: 'send',
            channel,
            chatId,
            error: (result as any).error || 'Send failed (no error details)',
          });
        }
        return JSON.stringify({
          success: true,
          action: 'send',
          channel,
          chatId,
          messageId: (result as any)?.messageId,
          ...(outbound.media ? { mediaAttached: true } : {}),
        });
      } catch (err) {
        return JSON.stringify({ error: `Send failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  };
}

/** Typing indicator tool */
export function createTypingTool(registry: ChannelRegistry): ToolDefinition {
  return {
    name: 'typing',
    description: 'Send a typing indicator to a chat. Shows "typing..." to the recipient. WhatsApp supports composing/recording/paused. Discord shows typing for ~10 seconds.',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel type: "whatsapp" or "discord"',
          enum: ['whatsapp', 'discord'],
        },
        chatId: {
          type: 'string',
          description: 'Chat/channel ID',
        },
        duration: {
          type: 'number',
          description: 'Duration in milliseconds (default 3000). WhatsApp only.',
        },
      },
      required: ['channel', 'chatId'],
    },
    async execute(input) {
      const channel = input.channel as string;
      const chatId = input.chatId as string;
      const duration = (input.duration as number) ?? 3000;

      const adapters = registry.list();
      const target = adapters.find(a => a.channelType === channel && a.status === 'running');
      if (!target) {
        return JSON.stringify({ error: `No running adapter for "${channel}"` });
      }

      const adapter = registry.get(target.id);
      if (!adapter || typeof (adapter as any).typing !== 'function') {
        return JSON.stringify({ error: `Adapter "${channel}" does not support typing indicators` });
      }

      try {
        await (adapter as any).typing(chatId, duration);
        return JSON.stringify({ success: true, action: 'typing', channel, chatId, duration });
      } catch (err) {
        return JSON.stringify({ error: `Typing failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  };
}

/** Presence update tool (WhatsApp) */
export function createPresenceTool(registry: ChannelRegistry): ToolDefinition {
  return {
    name: 'presence',
    description: 'Update presence status on WhatsApp. States: "available" (online), "unavailable" (offline), "composing" (typing), "recording" (recording voice), "paused" (stopped typing). Discord presence is managed by the bot framework.',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel type (currently only "whatsapp" supports presence)',
          enum: ['whatsapp'],
        },
        chatId: {
          type: 'string',
          description: 'Chat ID to update presence for',
        },
        state: {
          type: 'string',
          description: 'Presence state: "available", "unavailable", "composing", "recording", "paused"',
          enum: ['available', 'unavailable', 'composing', 'recording', 'paused'],
        },
      },
      required: ['channel', 'chatId', 'state'],
    },
    async execute(input) {
      const channel = input.channel as string;
      const chatId = input.chatId as string;
      const state = input.state as string;

      const adapters = registry.list();
      const target = adapters.find(a => a.channelType === channel && a.status === 'running');
      if (!target) {
        return JSON.stringify({ error: `No running adapter for "${channel}"` });
      }

      const adapter = registry.get(target.id);
      if (!adapter) return JSON.stringify({ error: 'Adapter not found' });

      // Access the socket directly for presence updates
      const socket = (adapter as any).getSocket?.() ?? (adapter as any).socket;
      if (!socket) {
        return JSON.stringify({ error: 'WhatsApp socket not available' });
      }

      try {
        await socket.presenceSubscribe(chatId);
        await socket.sendPresenceUpdate(state, chatId);
        return JSON.stringify({ success: true, action: 'presence', channel, chatId, state });
      } catch (err) {
        return JSON.stringify({ error: `Presence update failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  };
}

/** Delete message tool */
export function createDeleteMessageTool(registry: ChannelRegistry): ToolDefinition {
  return {
    name: 'delete_message',
    description: 'Delete a message from a chat. WhatsApp: deletes for everyone. Discord: deletes bot\'s own messages.',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel type: "whatsapp" or "discord"',
          enum: ['whatsapp', 'discord'],
        },
        chatId: {
          type: 'string',
          description: 'Chat/channel ID',
        },
        messageId: {
          type: 'string',
          description: 'ID of the message to delete',
        },
      },
      required: ['channel', 'chatId', 'messageId'],
    },
    async execute(input) {
      const channel = input.channel as string;
      const chatId = input.chatId as string;
      const messageId = input.messageId as string;

      const adapters = registry.list();
      const target = adapters.find(a => a.channelType === channel && a.status === 'running');
      if (!target) {
        return JSON.stringify({ error: `No running adapter for "${channel}"` });
      }

      const adapter = registry.get(target.id);
      if (!adapter || typeof (adapter as any).deleteMessage !== 'function') {
        return JSON.stringify({ error: `Adapter "${channel}" does not support message deletion` });
      }

      try {
        await (adapter as any).deleteMessage(chatId, messageId);
        return JSON.stringify({ success: true, action: 'delete', channel, chatId, messageId });
      } catch (err) {
        return JSON.stringify({ error: `Delete failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  };
}

/** Mark messages as read tool */
export function createMarkReadTool(registry: ChannelRegistry): ToolDefinition {
  return {
    name: 'mark_read',
    description: 'Mark a message as read (sends read receipt / blue ticks on WhatsApp).',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel type: "whatsapp" or "discord"',
          enum: ['whatsapp', 'discord'],
        },
        chatId: {
          type: 'string',
          description: 'Chat/channel ID',
        },
        messageId: {
          type: 'string',
          description: 'ID of the message to mark as read',
        },
      },
      required: ['channel', 'chatId', 'messageId'],
    },
    async execute(input) {
      const channel = input.channel as string;
      const chatId = input.chatId as string;
      const messageId = input.messageId as string;

      const adapters = registry.list();
      const target = adapters.find(a => a.channelType === channel && a.status === 'running');
      if (!target) {
        return JSON.stringify({ error: `No running adapter for "${channel}"` });
      }

      const adapter = registry.get(target.id);
      if (!adapter || typeof (adapter as any).markRead !== 'function') {
        return JSON.stringify({ error: `Adapter "${channel}" does not support read receipts` });
      }

      try {
        await (adapter as any).markRead(chatId, messageId);
        return JSON.stringify({ success: true, action: 'mark_read', channel, chatId, messageId });
      } catch (err) {
        return JSON.stringify({ error: `Mark read failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  };
}
