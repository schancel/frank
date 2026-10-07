import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import type { MessageItem } from "@frank/cashweb/types/messages";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_MODERATOR } from "@frank/codec";
import { generateAvatarPng } from "../../bot-directory";

export class ChatRoomBot implements FrankBotDefinition {
  readonly id = "lobby";
  readonly label = "Lobby";
  readonly defaultIdentityPath =
    process.env.LOBBY_BOT_IDENTITY_JSON ?? "/tmp/lobby-bot-identity.json";

  getProfile(): BotProfile {
    return {
      name: "Lobby",
      bio: "Community group chat rooms. Send /join to enter #general, /rooms to list rooms, /help for commands.",
      avatarPng: generateAvatarPng("lobby", [30, 140, 220]),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_MODERATOR,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    console.log(`[lobby] Welcoming new user ${user.address}`);
    try {
      await ctx.sendMessage(user.address, [
        {
          type: "text",
          text: "👋 Welcome to Frank! I host community group chat rooms over direct messaging. Send /join to chat with everyone in #general, or /help to learn more!",
        },
      ]);
    } catch (err) {
      console.warn(`[lobby] Failed to welcome ${user.address}:`, err);
    }
  }

  private async getDisplayName(address: string, ctx: BotContext): Promise<string> {
    const nick = await ctx.state.get(`nick:${address.toLowerCase()}`);
    if (nick && nick.trim()) {
      return nick.trim();
    }
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  private async getKnownRooms(ctx: BotContext): Promise<string[]> {
    const raw = await ctx.state.get("rooms:list");
    if (!raw) return ["general"];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // fallback
    }
    return ["general"];
  }

  private async registerRoom(room: string, ctx: BotContext): Promise<void> {
    const rooms = await this.getKnownRooms(ctx);
    if (!rooms.includes(room)) {
      rooms.push(room);
      await ctx.state.put("rooms:list", JSON.stringify(rooms));
    }
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const textItems = msgCtx.items.filter((item: any) => item.type === "text") as Array<{
      type: "text";
      text: string;
    }>;
    const text = textItems.map((it) => it.text).join("\n").trim();
    const sender = msgCtx.peerAddress.toLowerCase();

    if (!text) {
      await msgCtx.reply([
        {
          type: "text",
          text: "👋 Welcome to Lobby! Send /join to enter #general, or /help for instructions.",
        },
      ]);
      return;
    }

    const lower = text.toLowerCase();

    // 1. /help
    if (lower === "/help" || lower === "help") {
      await msgCtx.reply([
        {
          type: "text",
          text: `💬 **Lobby Group Chat Commands**

• \`/join [room]\` - Join a chat room (default: #general)
• \`/leave\` - Leave your current chat room
• \`/rooms\` - View all active rooms and participant counts
• \`/who\` - See who is currently in your room
• \`/nick <name>\` - Set your display nickname
• Any other message will be relayed to everyone in your room!`,
        },
      ]);
      return;
    }

    // 2. /nick <name>
    if (lower.startsWith("/nick ") || lower.startsWith("nick ")) {
      const parts = text.split(/\s+/);
      const newNick = parts[1]?.trim();
      if (!newNick || newNick.length < 2 || newNick.length > 25 || !/^[a-zA-Z0-9_-]+$/.test(newNick)) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ Nickname must be 2-25 characters long and contain only letters, numbers, underscores, and dashes.",
          },
        ]);
        return;
      }

      await ctx.state.put(`nick:${sender}`, newNick);
      await msgCtx.reply([
        {
          type: "text",
          text: `✅ Your nickname has been updated to **${newNick}**!`,
        },
      ]);
      return;
    }

    // 3. /rooms
    if (lower === "/rooms" || lower === "rooms") {
      const rooms = await this.getKnownRooms(ctx);
      const roomLines: string[] = [];

      for (const room of rooms) {
        const subs = await ctx.subscriptions.listSubscribers(`room:${room}`);
        roomLines.push(`• **#${room}** (${subs.length} member${subs.length === 1 ? "" : "s"})`);
      }

      await msgCtx.reply([
        {
          type: "text",
          text: `🌐 **Active Rooms**\n\n${roomLines.join("\n")}\n\n_Send \`/join <room>\` to join any room!_`,
        },
      ]);
      return;
    }

    // 4. /who
    if (lower === "/who" || lower === "who") {
      const currentRoom = await ctx.state.get(`user_room:${sender}`);
      if (!currentRoom) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ You are not currently in any room. Send `/join` to enter #general!",
          },
        ]);
        return;
      }

      const subs = await ctx.subscriptions.listSubscribers(`room:${currentRoom}`);
      const memberNames: string[] = [];
      for (const sub of subs) {
        const name = await this.getDisplayName(sub, ctx);
        memberNames.push(sub === sender ? `• **${name}** (you)` : `• ${name}`);
      }

      await msgCtx.reply([
        {
          type: "text",
          text: `👥 **Members in #${currentRoom}** (${subs.length}):\n\n${memberNames.join("\n")}`,
        },
      ]);
      return;
    }

    // 5. /leave
    if (lower === "/leave" || lower === "leave") {
      const currentRoom = await ctx.state.get(`user_room:${sender}`);
      if (!currentRoom) {
        await msgCtx.reply([
          {
            type: "text",
            text: "You are not currently in any room.",
          },
        ]);
        return;
      }

      const nick = await this.getDisplayName(sender, ctx);
      await ctx.subscriptions.unsubscribe(sender, `room:${currentRoom}`);
      await ctx.state.del(`user_room:${sender}`);

      // Announce departure to other room members
      const remainingSubs = await ctx.subscriptions.listSubscribers(`room:${currentRoom}`);
      for (const sub of remainingSubs) {
        try {
          await ctx.sendMessage(sub, [
            {
              type: "text",
              text: `🚪 [**#${currentRoom}**] **${nick}** left the room.`,
            },
          ]);
        } catch {
          // ignore transient send error
        }
      }

      await msgCtx.reply([
        {
          type: "text",
          text: `👋 You left **#${currentRoom}**. Send \`/join\` anytime to jump back in!`,
        },
      ]);
      return;
    }

    // 6. /join [room]
    if (lower.startsWith("/join") || lower.startsWith("join")) {
      const parts = text.split(/\s+/);
      let targetRoom = parts[1]?.trim()?.toLowerCase() ?? "general";
      targetRoom = targetRoom.replace(/^#/, "");
      if (!/^[a-z0-9_-]{1,30}$/.test(targetRoom)) {
        await msgCtx.reply([
          {
            type: "text",
            text: "⚠️ Room name must be 1-30 characters of lowercase letters, numbers, hyphens, or underscores.",
          },
        ]);
        return;
      }

      const currentRoom = await ctx.state.get(`user_room:${sender}`);
      const nick = await this.getDisplayName(sender, ctx);

      // Leave old room if switching
      if (currentRoom && currentRoom !== targetRoom) {
        await ctx.subscriptions.unsubscribe(sender, `room:${currentRoom}`);
        const oldSubs = await ctx.subscriptions.listSubscribers(`room:${currentRoom}`);
        for (const sub of oldSubs) {
          try {
            await ctx.sendMessage(sub, [
              {
                type: "text",
                text: `🚪 [**#${currentRoom}**] **${nick}** left the room.`,
              },
            ]);
          } catch {
            // ignore
          }
        }
      }

      await ctx.subscriptions.subscribe(sender, `room:${targetRoom}`);
      await ctx.state.put(`user_room:${sender}`, targetRoom);
      await this.registerRoom(targetRoom, ctx);

      // Announce to other room members
      const newSubs = await ctx.subscriptions.listSubscribers(`room:${targetRoom}`);
      for (const sub of newSubs) {
        if (sub === sender) continue;
        try {
          await ctx.sendMessage(sub, [
            {
              type: "text",
              text: `👋 [**#${targetRoom}**] **${nick}** joined the room!`,
            },
          ]);
        } catch {
          // ignore
        }
      }

      await msgCtx.reply([
        {
          type: "text",
          text: `🎉 You joined **#${targetRoom}**! Any message you send here will be broadcast to everyone in the room.\n\nType \`/who\` to see members, \`/rooms\` for other rooms, or \`/leave\` to exit.`,
        },
      ]);
      return;
    }

    // 7. Regular message routing inside user's active room
    const currentRoom = await ctx.state.get(`user_room:${sender}`);
    if (!currentRoom) {
      await msgCtx.reply([
        {
          type: "text",
          text: `💬 You are not in a room yet! Send \`/join\` to join **#general**, or type \`/help\` for a list of commands.`,
        },
      ]);
      return;
    }

    const nick = await this.getDisplayName(sender, ctx);
    const roomSubs = await ctx.subscriptions.listSubscribers(`room:${currentRoom}`);

    const broadcastItem: MessageItem = {
      type: "text",
      text: `[**#${currentRoom}**] **${nick}**: ${text}`,
    };

    let delivered = 0;
    for (const member of roomSubs) {
      if (member === sender) continue;
      try {
        await ctx.sendMessage(member, [broadcastItem]);
        delivered++;
      } catch (err) {
        console.warn(`[lobby] Failed to deliver room message to ${member}:`, err);
      }
    }

    // Acknowledge single participant room if nobody else is present
    if (roomSubs.length <= 1) {
      await msgCtx.reply([
        {
          type: "text",
          text: `_You are currently the only person in #${currentRoom}. Invite someone to join with \`/join #${currentRoom}\`!_`,
        },
      ]);
    }
  }
}
