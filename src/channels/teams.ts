import express from 'express';
import {
  ActivityHandler,
  BotFrameworkAdapter,
  TurnContext,
  Activity,
} from 'botbuilder';
import { Server } from 'http';

import { ASSISTANT_NAME, TRIGGER_PATTERN, TEAMS_PORT, TEAMS_TENANT_ID } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, QuestionOption, RegisteredGroup } from '../types.js';

export interface TeamsChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  appId: string;
  appSecret: string;
}

/**
 * Converts a Teams conversation reference into a stable JID.
 * Format: teams:<tenantId>:<channelId>
 */
function toTeamsJid(activity: Partial<Activity>): string {
  const tenantId = activity.conversation?.tenantId || 'unknown';
  const channelId = activity.conversation?.id || 'unknown';
  return `teams:${tenantId}:${channelId}`;
}

export class TeamsChannel implements Channel {
  name = 'teams';

  private adapter: BotFrameworkAdapter;
  private opts: TeamsChannelOpts;
  private app: express.Application;
  private server: Server | null = null;
  // Store conversation references for sending proactive messages
  private conversationRefs: Map<string, Partial<Activity>> = new Map();

  constructor(opts: TeamsChannelOpts) {
    this.opts = opts;
    this.adapter = new BotFrameworkAdapter({
      appId: opts.appId,
      appPassword: opts.appSecret,
      ...(TEAMS_TENANT_ID ? { channelAuthTenant: TEAMS_TENANT_ID } : {}),
    });

    this.adapter.onTurnError = async (context, error) => {
      logger.error({ err: error.message }, 'Teams bot turn error');
      await context.sendActivity('Sorry, something went wrong.');
    };

    this.app = express();
    this.app.use(express.json());
  }

  async connect(): Promise<void> {
    const handler = new ActivityHandler();

    handler.onMessage(async (context, next) => {
      const activity = context.activity;
      const jid = toTeamsJid(activity);

      // Store conversation reference for proactive messaging
      this.conversationRefs.set(jid, TurnContext.getConversationReference(activity));

      const senderName =
        activity.from?.name || activity.from?.id || 'Unknown';
      const senderId = activity.from?.id || '';
      const timestamp = activity.timestamp
        ? new Date(activity.timestamp).toISOString()
        : new Date().toISOString();
      const channelName =
        (activity.channelData as any)?.channel?.name ||
        activity.conversation?.name ||
        jid;

      // Strip HTML tags and bot mention from message text
      let content = activity.text || '';
      // Remove <at>BotName</at> mentions
      content = content.replace(/<at>[^<]*<\/at>/g, '').trim();
      // If message still doesn't start with trigger, prepend it
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      this.opts.onChatMetadata(jid, timestamp, channelName);

      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        logger.info({ jid, channelName, sender: senderName }, 'Message from unregistered Teams channel — register this JID');
        // Reply with the JID so it can be registered
        await context.sendActivity(`⚙️ Unregistered channel. JID: \`${jid}\``);
        await next();
        return;
      }

      this.opts.onMessage(jid, {
        id: activity.id || Date.now().toString(),
        chat_jid: jid,
        sender: senderId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ jid, channelName, sender: senderName }, 'Teams message stored');
      await next();
    });

    // Set up the HTTP endpoint for incoming Teams messages
    this.app.post('/api/messages', (req, res) => {
      this.adapter.processActivity(req, res, async (context) => {
        await handler.run(context);
      });
    });

    // Health check endpoint
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', channel: 'teams' });
    });

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(TEAMS_PORT, () => {
        logger.info({ port: TEAMS_PORT }, 'Teams bot HTTP server listening');
        console.log(`\n  Teams bot: listening on port ${TEAMS_PORT}`);
        console.log(`  Messaging endpoint: https://YOUR_TUNNEL_URL/api/messages\n`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const ref = this.conversationRefs.get(jid);
    if (!ref) {
      logger.warn({ jid }, 'No conversation reference found for Teams JID — cannot send message');
      return;
    }

    try {
      await this.adapter.continueConversation(ref, async (context) => {
        // Convert basic markdown-style formatting to Teams-compatible HTML
        const html = text
          .replace(/\*([^*]+)\*/g, '<b>$1</b>')   // *bold*
          .replace(/_([^_]+)_/g, '<i>$1</i>')      // _italic_
          .replace(/`([^`]+)`/g, '<code>$1</code>') // `code`
          .replace(/\n/g, '<br>');                   // newlines

        await context.sendActivity({ type: 'message', text: html, textFormat: 'xml' });
      });
      logger.info({ jid }, 'Teams message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Teams message');
    }
  }

  async sendQuestion(jid: string, question: string, options: QuestionOption[]): Promise<void> {
    const ref = this.conversationRefs.get(jid);
    if (!ref) {
      logger.warn({ jid }, 'No conversation reference for Teams sendQuestion');
      return;
    }

    try {
      await this.adapter.continueConversation(ref, async (context) => {
        // Use Adaptive Card with Action.Submit buttons
        const card = {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: question,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium',
            },
          ],
          actions: options.map((opt) => ({
            type: 'Action.Submit',
            title: opt.label,
            data: { value: opt.value, label: opt.label },
          })),
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        };

        await context.sendActivity({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: card,
            },
          ],
        });
      });
      logger.info({ jid, question: question.slice(0, 50) }, 'Teams question sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Teams question');
    }
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('teams:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info('Teams bot HTTP server stopped');
    }
  }

  async setTyping(jid: string, _isTyping: boolean): Promise<void> {
    const ref = this.conversationRefs.get(jid);
    if (!ref) return;
    try {
      await this.adapter.continueConversation(ref, async (context) => {
        await context.sendActivity({ type: 'typing' });
      });
    } catch {
      // Ignore typing indicator failures
    }
  }
}
