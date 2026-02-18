import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

// Maximum number of played songs to retain per room
const MAX_PLAYED_SONGS_PER_ROOM = 100;

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function isCodeAvailable(ctx: MutationCtx, code: string) {
  const existing = await ctx.db
    .query("rooms")
    .withIndex("by_code", (q) => q.eq("code", code))
    .unique();

  return !existing;
}

/** Throws if the calling user is not the room host. */
async function requireAdmin(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  userId: string,
) {
  const room = await ctx.db.get(roomId);
  if (!room) {
    throw new Error("Room not found.");
  }
  if (room.hostUserId !== userId) {
    throw new Error("Only the room host can perform this action.");
  }
  return room;
}

export const createRoom = mutation({
  args: {
    name: v.string(),
    hostUserId: v.string(),
    code: v.optional(v.string()),
    maxSongsPerUser: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let code = (args.code ?? generateRoomCode()).toUpperCase();

    if (args.code) {
      const available = await isCodeAvailable(ctx, code);
      if (!available) {
        throw new Error("Room code already in use.");
      }
    } else {
      let attempts = 0;
      while (!(await isCodeAvailable(ctx, code))) {
        attempts += 1;
        if (attempts > 5) {
          throw new Error("Unable to generate a unique room code.");
        }
        code = generateRoomCode();
      }
    }

    const roomId = await ctx.db.insert("rooms", {
      code,
      name: args.name,
      hostUserId: args.hostUserId,
      createdAt: now,
      updatedAt: now,
      isActive: true,
      settings: {
        allowGuestAdd: true,
        allowDownvotes: true,
        maxQueueLength: 100,
        maxSongsPerUser: args.maxSongsPerUser ?? 5,
      },
    });

    return { roomId, code };
  },
});

export const getRoomByCode = query({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .unique();
  },
});

// ── Admin-only mutations ────────────────────────────────────────────────

export const updateSettings = mutation({
  args: {
    roomId: v.id("rooms"),
    userId: v.string(),
    settings: v.object({
      allowGuestAdd: v.optional(v.boolean()),
      allowDownvotes: v.optional(v.boolean()),
      maxQueueLength: v.optional(v.number()),
      maxSongsPerUser: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const room = await requireAdmin(ctx, args.roomId, args.userId);

    const merged = { ...room.settings, ...args.settings };
    await ctx.db.patch(args.roomId, {
      settings: merged,
      updatedAt: Date.now(),
    });
  },
});

export const transferHost = mutation({
  args: {
    roomId: v.id("rooms"),
    userId: v.string(),
    newHostUserId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.roomId, args.userId);

    if (args.userId === args.newHostUserId) {
      throw new Error("You are already the host.");
    }

    await ctx.db.patch(args.roomId, {
      hostUserId: args.newHostUserId,
      updatedAt: Date.now(),
    });
  },
});

export const destroyRoom = mutation({
  args: {
    roomId: v.id("rooms"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.roomId, args.userId);

    // Delete all votes in the room
    const votes = await ctx.db
      .query("votes")
      .withIndex("by_room_user", (q) => q.eq("roomId", args.roomId))
      .collect();
    for (const vote of votes) {
      await ctx.db.delete(vote._id);
    }

    // Delete all songs in the room
    const songs = await ctx.db
      .query("songs")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    for (const song of songs) {
      await ctx.db.delete(song._id);
    }

    // Delete the room itself
    await ctx.db.delete(args.roomId);
  },
});

export const togglePause = mutation({
  args: {
    roomId: v.id("rooms"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const room = await requireAdmin(ctx, args.roomId, args.userId);
    await ctx.db.patch(args.roomId, {
      isPaused: !room.isPaused,
      updatedAt: Date.now(),
    });
  },
});

export const advanceSong = mutation({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    // Remove the song that just finished playing
    if (room.currentSongId) {
      const finishedSong = await ctx.db.get(room.currentSongId);
      if (finishedSong) {
        // Save to played songs history before deleting
        await ctx.db.insert("playedSongs", {
          roomId: finishedSong.roomId,
          provider: finishedSong.provider,
          providerId: finishedSong.providerId,
          title: finishedSong.title,
          artist: finishedSong.artist,
          albumArtUrl: finishedSong.albumArtUrl,
          addedBy: finishedSong.addedBy,
          addedByName: finishedSong.addedByName,
          playedAt: Date.now(),
        });

        // Cleanup: remove old played songs beyond the retention limit
        const playedSongs = await ctx.db
          .query("playedSongs")
          .withIndex("by_room_played", (q) => q.eq("roomId", args.roomId))
          .order("desc")
          .collect();
        if (playedSongs.length > MAX_PLAYED_SONGS_PER_ROOM) {
          const toDelete = playedSongs.slice(MAX_PLAYED_SONGS_PER_ROOM);
          for (const old of toDelete) {
            await ctx.db.delete(old._id);
          }
        }

        // Delete votes for the finished song
        const votes = await ctx.db
          .query("votes")
          .withIndex("by_song_user", (q) => q.eq("songId", finishedSong._id))
          .collect();
        for (const vote of votes) {
          await ctx.db.delete(vote._id);
        }
        await ctx.db.delete(finishedSong._id);
      }
    }

    // Get remaining songs, sorted by score (highest first)
    const songs = await ctx.db
      .query("songs")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    // Filter to YouTube songs only (custom songs can't be played)
    const playable = songs
      .filter((s) => s.provider === "youtube")
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.lastScoreUpdatedAt - b.lastScoreUpdatedAt;
      });

    const nextSong = playable[0] ?? null;

    await ctx.db.patch(args.roomId, {
      currentSongId: nextSong ? nextSong._id : undefined,
      isPaused: false,
    });
  },
});
