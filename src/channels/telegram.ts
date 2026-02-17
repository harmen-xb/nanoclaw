import { Bot, InlineKeyboard } from "grammy";

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from "../config.js";
import { logger } from "../logger.js";
import { Channel, OnInboundMessage, OnChatMetadata, QuestionOption, RegisteredGroup } from "../types.js";

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = "telegram";

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command("chatid", (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === "private"
          ? ctx.from?.first_name || "Private"
          : (ctx.chat as any).title || "Unknown";

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: "Markdown" },
      );
    });

    // Command to check bot status
    this.bot.command("ping", (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on("message:text", async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith("/")) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        "Unknown";
      const sender = ctx.from?.id.toString() || "";
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === "private"
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @clai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Clai\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === "mention") {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          "Message from unregistered Telegram chat",
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        "Telegram message stored",
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : "";

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || "",
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on("message:photo", (ctx) => storeNonText(ctx, "[Photo]"));
    this.bot.on("message:video", (ctx) => storeNonText(ctx, "[Video]"));

    // Handle voice messages — transcribe using Telegram's native API
    this.bot.on("message:voice", async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : "";

      this.opts.onChatMetadata(chatJid, timestamp);

      try {
        // Use Telegram Bot API to request transcription
        const chatId = ctx.chat.id;
        const messageId = ctx.message.message_id;

        // Call Telegram's transcribeAudio endpoint
        const transcribeRes = await fetch(
          `https://api.telegram.org/bot${this.botToken}/transcribeAudio`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
          }
        );
        const transcribeData = await transcribeRes.json() as any;

        let transcription: string | null = null;

        if (transcribeData.ok && transcribeData.result?.text) {
          transcription = transcribeData.result.text;
          logger.info({ chatJid, senderName }, "Voice message transcribed via Telegram API");
        } else {
          // Transcription not immediately available — poll for up to 10s
          logger.info({ chatJid }, "Transcription pending, polling...");
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const pollRes = await fetch(
              `https://api.telegram.org/bot${this.botToken}/transcribeAudio`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
              }
            );
            const pollData = await pollRes.json() as any;
            if (pollData.ok && pollData.result?.text) {
              transcription = pollData.result.text;
              logger.info({ chatJid, senderName, attempts: i + 2 }, "Voice message transcribed after polling");
              break;
            }
          }
        }

        const content = transcription
          ? `[Voice message]: ${transcription}${caption}`
          : `[Voice message - transcription unavailable]${caption}`;

        this.opts.onMessage(chatJid, {
          id: messageId.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || "",
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      } catch (err) {
        logger.error({ chatJid, err }, "Failed to process voice message");
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || "",
          sender_name: senderName,
          content: `[Voice message - processing failed]${caption}`,
          timestamp,
          is_from_me: false,
        });
      }
    });

    this.bot.on("message:audio", (ctx) => storeNonText(ctx, "[Audio]"));
    this.bot.on("message:document", (ctx) => {
      const name = ctx.message.document?.file_name || "file";
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on("message:sticker", (ctx) => {
      const emoji = ctx.message.sticker?.emoji || "";
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on("message:location", (ctx) => storeNonText(ctx, "[Location]"));
    this.bot.on("message:contact", (ctx) => storeNonText(ctx, "[Contact]"));

    // Handle inline keyboard button taps (callback queries)
    this.bot.on("callback_query:data", async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        await ctx.answerCallbackQuery();
        return;
      }

      const data = ctx.callbackQuery.data;
      // Callback data format: "q:<questionId>:<value>:<label>"
      if (!data.startsWith("q:")) {
        await ctx.answerCallbackQuery();
        return;
      }

      const parts = data.split(":");
      // parts: ["q", questionId, value, ...label parts]
      const label = parts.slice(3).join(":");

      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
      const timestamp = new Date().toISOString();

      // Acknowledge the button tap immediately
      await ctx.answerCallbackQuery({ text: `✓ ${label}` });

      // Edit the original message to show the selection
      try {
        const originalText = ctx.callbackQuery.message?.text || "";
        await ctx.editMessageText(`${originalText}\n\n_You answered: *${label}*_`, {
          parse_mode: "Markdown",
        });
      } catch {
        // Ignore edit failures (message too old, etc.)
      }

      // Deliver the answer as an inbound message
      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: `cbq-${ctx.callbackQuery.id}`,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || "",
        sender_name: senderName,
        content: label,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, senderName, label }, "Inline keyboard answer received");
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, "Telegram bot error");
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            "Telegram bot connected",
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendQuestion(jid: string, question: string, options: QuestionOption[]): Promise<void> {
    if (!this.bot) {
      logger.warn("Telegram bot not initialized");
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, "");
      const questionId = Date.now().toString(36);

      // Build inline keyboard — up to 2 buttons per row
      const keyboard = new InlineKeyboard();
      options.forEach((opt, i) => {
        // Callback data: "q:<questionId>:<value>:<label>"
        const callbackData = `q:${questionId}:${opt.value}:${opt.label}`.slice(0, 64);
        keyboard.text(opt.label, callbackData);
        // New row every 2 buttons, or after the last one
        if ((i + 1) % 2 === 0 && i < options.length - 1) {
          keyboard.row();
        }
      });

      await this.bot.api.sendMessage(numericId, question, {
        reply_markup: keyboard,
      });
      logger.info({ jid, question: question.slice(0, 50) }, "Telegram question sent");
    } catch (err) {
      logger.error({ jid, err }, "Failed to send Telegram question");
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn("Telegram bot not initialized");
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, "");

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, "Telegram message sent");
    } catch (err) {
      logger.error({ jid, err }, "Failed to send Telegram message");
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith("tg:");
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info("Telegram bot stopped");
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, "");
      await this.bot.api.sendChatAction(numericId, "typing");
    } catch (err) {
      logger.debug({ jid, err }, "Failed to send Telegram typing indicator");
    }
  }
}
