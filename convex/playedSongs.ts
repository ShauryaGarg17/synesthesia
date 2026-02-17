import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Get recently played songs for a room (last 20)
export const listRecentlyPlayed = query({
  args: {
    roomId: v.id("rooms"),
  },
  handler: async (ctx, args) => {
    const played = await ctx.db
      .query("playedSongs")
      .withIndex("by_room_played", (q) => q.eq("roomId", args.roomId))
      .order("desc")
      .take(20);
    return played;
  },
});

// Re-add a played song back to the queue
export const readdSong = mutation({
  args: {
    roomId: v.id("rooms"),
    playedSongId: v.id("playedSongs"),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    const playedSong = await ctx.db.get(args.playedSongId);
    if (!playedSong) {
      throw new Error("Played song not found.");
    }

    if (playedSong.roomId !== args.roomId) {
      throw new Error("Song does not belong to this room.");
    }

    const isAdmin = args.userId === room.hostUserId;

    // Check if guests can add songs
    if (!isAdmin && !room.settings.allowGuestAdd) {
      throw new Error("Guests cannot add songs in this room.");
    }

    // Check user's song limit (if set and not admin)
    const maxSongsPerUser = room.settings.maxSongsPerUser ?? 0;
    if (!isAdmin && maxSongsPerUser > 0) {
      const userSongs = await ctx.db
        .query("songs")
        .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
        .filter((q) => q.eq(q.field("addedBy"), args.userId))
        .collect();

      if (userSongs.length >= maxSongsPerUser) {
        throw new Error(
          `You can only add ${maxSongsPerUser} songs. Remove one first.`,
        );
      }
    }

    // Check if song is already in the queue
    const existing = await ctx.db
      .query("songs")
      .withIndex("by_room_provider", (q) =>
        q
          .eq("roomId", args.roomId)
          .eq("provider", playedSong.provider)
          .eq("providerId", playedSong.providerId),
      )
      .unique();

    if (existing) {
      throw new Error("This song is already in the queue.");
    }

    const now = Date.now();

    // Add the song back to the queue
    await ctx.db.insert("songs", {
      roomId: args.roomId,
      provider: playedSong.provider,
      providerId: playedSong.providerId,
      title: playedSong.title,
      artist: playedSong.artist,
      albumArtUrl: playedSong.albumArtUrl,
      addedBy: args.userId,
      addedByName: args.userName,
      addedAt: now,
      score: 0,
      lastScoreUpdatedAt: now,
    });

    return { success: true };
  },
});
