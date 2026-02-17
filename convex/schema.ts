import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  rooms: defineTable({
    code: v.string(),
    name: v.string(),
    hostUserId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    isActive: v.boolean(),
    settings: v.object({
      allowGuestAdd: v.boolean(),
      allowDownvotes: v.boolean(),
      maxQueueLength: v.number(),
      maxSongsPerUser: v.optional(v.number()),
    }),
    currentSongId: v.optional(v.id("songs")),
    isPaused: v.optional(v.boolean()),
  }).index("by_code", ["code"]),

  songs: defineTable({
    roomId: v.id("rooms"),
    provider: v.union(v.literal("youtube"), v.literal("custom")),
    providerId: v.string(),
    title: v.string(),
    artist: v.optional(v.string()),
    albumArtUrl: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    addedBy: v.string(),
    addedByName: v.optional(v.string()),
    addedAt: v.number(),
    score: v.number(),
    lastScoreUpdatedAt: v.number(),
  })
    .index("by_room", ["roomId"])
    .index("by_room_provider", ["roomId", "provider", "providerId"]),

  votes: defineTable({
    roomId: v.id("rooms"),
    songId: v.id("songs"),
    userId: v.string(),
    value: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_song_user", ["songId", "userId"])
    .index("by_room_user", ["roomId", "userId"]),

  reactions: defineTable({
    roomId: v.id("rooms"),
    userId: v.string(),
    emoji: v.string(),
    createdAt: v.number(),
  }).index("by_room_time", ["roomId", "createdAt"]),

  presence: defineTable({
    userId: v.string(),
    roomId: v.id("rooms"),
    updatedAt: v.number(),
    userName: v.optional(v.string()),
  })
    .index("by_room_updated", ["roomId", "updatedAt"])
    .index("by_user_room", ["userId", "roomId"]),

  playedSongs: defineTable({
    roomId: v.id("rooms"),
    provider: v.union(v.literal("youtube"), v.literal("custom")),
    providerId: v.string(),
    title: v.string(),
    artist: v.optional(v.string()),
    albumArtUrl: v.optional(v.string()),
    addedBy: v.string(),
    addedByName: v.optional(v.string()),
    playedAt: v.number(),
  }).index("by_room_played", ["roomId", "playedAt"]),
});
