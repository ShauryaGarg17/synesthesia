"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  useMemo,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { useMutation, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useUserId, useUserName } from "@/app/lib/useUserId";
import YouTube from "react-youtube";
import ReactionOverlay from "@/components/ReactionOverlay";
import NowPlayingProgress from "@/components/NowPlayingProgress";
import AudioVisualizer from "@/components/AudioVisualizer";
import ShareRoom from "@/components/ShareRoom";

type RoomPageProps = {
  params: { code: string };
};

type YouTubeResult = {
  id: string;
  title: string;
  channel: string;
  thumbnailUrl?: string;
};

function createProviderId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function RoomPage({ params }: RoomPageProps) {
  const code = params.code.toUpperCase();
  const router = useRouter();
  const userId = useUserId();
  const [userName, setUserName] = useUserName();
  const room = useQuery(api.rooms.getRoomByCode, { code });
  const songs = useQuery(
    api.songs.listQueue,
    room ? { roomId: room._id } : "skip",
  );
  const votes = useQuery(
    api.votes.listVotesForUser,
    room && userId ? { roomId: room._id, userId } : "skip",
  );
  const recentlyPlayed = useQuery(
    api.playedSongs.listRecentlyPlayed,
    room ? { roomId: room._id } : "skip",
  );

  const addSong = useMutation(api.songs.addSong);
  const readdSong = useMutation(api.playedSongs.readdSong);
  const removeSong = useMutation(api.songs.removeSong);
  const adminSetScore = useMutation(api.songs.adminSetScore);
  const castVote = useMutation(api.votes.castVote);
  const adminAddVotes = useMutation(api.votes.adminAddVotes);
  const destroyRoom = useMutation(api.rooms.destroyRoom);
  const updateSettings = useMutation(api.rooms.updateSettings);
  const transferHost = useMutation(api.rooms.transferHost);

  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [searchResults, setSearchResults] = useState<YouTubeResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Vote animation tracking
  const [votedSongs, setVotedSongs] = useState<Set<string>>(new Set());

  // Track voting in progress to prevent double-clicks
  const [votingInProgress, setVotingInProgress] = useState<Set<string>>(
    new Set(),
  );

  // Track re-adding in progress to prevent double-clicks
  const [readdingInProgress, setReaddingInProgress] = useState<Set<string>>(
    new Set(),
  );

  // Recently played section expanded state
  const [recentlyPlayedExpanded, setRecentlyPlayedExpanded] = useState(false);

  // Admin-specific state
  const [scoreInputs, setScoreInputs] = useState<Record<string, string>>({});
  const [voteInputs, setVoteInputs] = useState<Record<string, string>>({});
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [settingsMaxSongs, setSettingsMaxSongs] = useState<string>("");

  // Volume control (host only)
  const [volume, setVolume] = useState(100);
  const [isMuted, setIsMuted] = useState(false);
  const prevVolumeRef = useRef(100);

  // YouTube player ref for progress bar & playback control
  const [ytPlayer, setYtPlayer] = useState<{
    getCurrentTime: () => number;
    getDuration: () => number;
    playVideo: () => void;
    pauseVideo: () => void;
    getPlayerState: () => number;
    setVolume: (v: number) => void;
    getVolume: () => number;
    seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  } | null>(null);

  // Track playback progress for the visualizer seek bar
  const [seekProgress, setSeekProgress] = useState(0);
  const seekRafRef = useRef<number>(0);

  useEffect(() => {
    if (!ytPlayer) return;
    const tick = () => {
      try {
        const cur = ytPlayer.getCurrentTime?.() ?? 0;
        const dur = ytPlayer.getDuration?.() ?? 0;
        setSeekProgress(dur > 0 ? cur / dur : 0);
      } catch {
        /* player not ready */
      }
      seekRafRef.current = requestAnimationFrame(tick);
    };
    seekRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(seekRafRef.current);
  }, [ytPlayer]);

  // Ref to prevent duplicate advance calls when tab is backgrounded
  const advancingRef = useRef(false);

  // Sync pause state from server to local YouTube player
  useEffect(() => {
    if (!ytPlayer) return;
    const paused = room?.isPaused ?? false;
    try {
      if (paused) {
        ytPlayer.pauseVideo();
      } else {
        ytPlayer.playVideo();
      }
    } catch {
      /* player not ready */
    }
  }, [ytPlayer, room?.isPaused]);

  // Drag & drop state for queue reorder (host only)
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const reorderSong = useMutation(api.songs.reorderSong);

  // Username prompt state
  const [nameInput, setNameInput] = useState("");

  const voteMap = useMemo(() => {
    const map = new Map<string, number>();
    votes?.forEach((vote) => {
      map.set(vote.songId, vote.value);
    });
    return map;
  }, [votes]);

  // Use currentSongId from the room to determine the current song
  const isHost = userId && room && userId === room.hostUserId;
  const currentSong = songs?.find((s) => s._id === room?.currentSongId);
  const queueSongs = useMemo(() => {
    if (!songs) return [];
    return songs.filter((s) => s._id !== room?.currentSongId);
  }, [songs, room?.currentSongId]);
  const advanceSong = useMutation(api.rooms.advanceSong);
  const togglePause = useMutation(api.rooms.togglePause);

  // Stable handler for when a song finishes — works even in background tabs
  // Only the host should advance; other clients get the update via subscription.
  const handleSongEnd = useCallback(() => {
    if (!isHost) return;
    if (advancingRef.current) return;
    advancingRef.current = true;
    setYtPlayer(null);
    if (room) {
      advanceSong({ roomId: room._id }).finally(() => {
        advancingRef.current = false;
      });
    } else {
      advancingRef.current = false;
    }
  }, [room, isHost, advanceSong]);

  // Reset advancing flag when the current song changes (new song loaded)
  useEffect(() => {
    advancingRef.current = false;
  }, [room?.currentSongId]);

  // Background-tab safety: poll player state & listen for visibilitychange
  useEffect(() => {
    if (!ytPlayer || !isHost) return;

    // setInterval still fires in background tabs (~1s minimum)
    const interval = setInterval(() => {
      try {
        const state = ytPlayer.getPlayerState();
        if (state === 0) handleSongEnd(); // 0 = ended
      } catch {
        /* player not ready */
      }
    }, 2000);

    // When the tab becomes visible, immediately check if the song ended
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        try {
          const state = ytPlayer.getPlayerState();
          if (state === 0) handleSongEnd();
        } catch {
          /* ignore */
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ytPlayer, isHost, handleSongEnd]);

  const isAdmin = !!(room && userId && userId === room.hostUserId);

  // Count how many songs the current user has added
  const userSongCount = useMemo(() => {
    if (!songs || !userId) return 0;
    return songs.filter((s) => s.addedBy === userId).length;
  }, [songs, userId]);

  const maxSongsPerUser = room?.settings.maxSongsPerUser ?? 0;
  const atSongLimit =
    !isAdmin && maxSongsPerUser > 0 && userSongCount >= maxSongsPerUser;

  // Get unique contributors for transfer host dropdown
  const contributors = useMemo(() => {
    if (!songs || !userId) return [];
    const map = new Map<string, string>();
    songs.forEach((s) => {
      if (s.addedBy !== userId) {
        map.set(s.addedBy, s.addedByName ?? "Unknown");
      }
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [songs, userId]);

  // ── Presence ──────────────────────────────────────────────────────────
  const userCount = useQuery(
    api.presence.list,
    room ? { roomId: room._id } : "skip",
  );
  const heartbeat = useMutation(api.presence.heartbeat);
  const leaveRoom = useMutation(api.presence.leave);

  useEffect(() => {
    if (!room || !userId) return;

    // Initial heartbeat
    heartbeat({ roomId: room._id, userId, userName: userName ?? undefined });

    const interval = setInterval(() => {
      heartbeat({ roomId: room._id, userId, userName: userName ?? undefined });
    }, 5000);

    return () => clearInterval(interval);
  }, [room, userId, userName, heartbeat]);

  const handleLeaveRoom = async () => {
    if (!room || !userId) return;
    try {
      await leaveRoom({ roomId: room._id, userId });
      router.push("/");
    } catch (err) {
      console.error("Failed to leave room", err);
    }
  };

  // ── Username prompt ───────────────────────────────────────────────────
  if (userId && !userName) {
    return (
      <main className="relative min-h-screen flex items-center justify-center px-4">
        <div className="pointer-events-none fixed inset-0 overflow-hidden">
          <div className="absolute top-1/4 left-1/3 w-[600px] h-[600px] rounded-full bg-primary/[0.06] blur-[140px]" />
          <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-accent/[0.04] blur-[100px]" />
        </div>
        <div className="relative z-10 w-full max-w-md">
          <div className="glass rounded-3xl p-8 sm:p-10">
            <div className="w-12 h-12 rounded-2xl bg-primary flex items-center justify-center mb-6">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="text-white"
              >
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold mb-1.5">Join the session</h2>
            <p className="text-white/35 text-sm mb-8">
              Choose a name so others know who{"'"}s in the mix.
            </p>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                const name = nameInput.trim();
                if (name) setUserName(name);
              }}
            >
              <input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Your name"
                autoFocus
                className="w-full h-12 rounded-2xl bg-white/[0.04] border border-white/[0.08] px-4 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-colors"
              />
              <button
                type="submit"
                disabled={!nameInput.trim()}
                className="w-full h-12 rounded-2xl bg-primary hover:bg-primary/85 disabled:bg-white/[0.04] disabled:text-white/20 text-white font-semibold transition-all duration-200"
              >
                Continue
              </button>
            </form>
          </div>
        </div>
      </main>
    );
  }

  const displayName = userName ?? "Anonymous";

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) {
      setSearchError("Enter a search term.");
      return;
    }

    setSearchError(null);
    setIsSearching(true);
    try {
      const response = await fetch(
        `/api/youtube/search?q=${encodeURIComponent(query)}`,
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Search failed.");
      }
      setSearchResults(data.results ?? []);
    } catch (err) {
      setSearchError(
        err instanceof Error ? err.message : "Unable to search YouTube.",
      );
    } finally {
      setIsSearching(false);
    }
  };

  const handleAddFromSearch = async (track: YouTubeResult) => {
    if (!room || !userId) {
      setSearchError("Room or user not ready yet.");
      return;
    }
    if (!allowGuestAdd && !isAdmin) {
      setSearchError("Guests cannot add songs in this room.");
      return;
    }

    setSearchError(null);
    try {
      await addSong({
        roomId: room._id,
        provider: "youtube",
        providerId: track.id,
        title: track.title,
        artist: track.channel,
        albumArtUrl: track.thumbnailUrl,
        addedBy: userId,
        addedByName: displayName,
      });
    } catch (err) {
      setSearchError(
        err instanceof Error ? err.message : "Unable to add track.",
      );
    }
  };

  const handleVote = async (songId: Id<"songs">, nextValue: number) => {
    if (!room || !userId) {
      setError("Room or user not ready yet.");
      return;
    }

    // Prevent double-clicks while vote is processing
    if (votingInProgress.has(songId)) return;

    setVotingInProgress((prev) => new Set(prev).add(songId));
    setError(null);
    // Trigger burst animation
    setVotedSongs((prev) => new Set(prev).add(songId));
    setTimeout(() => {
      setVotedSongs((prev) => {
        const next = new Set(prev);
        next.delete(songId);
        return next;
      });
    }, 500);
    try {
      await castVote({
        roomId: room._id,
        songId,
        userId,
        value: nextValue,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to cast vote.");
    } finally {
      setVotingInProgress((prev) => {
        const next = new Set(prev);
        next.delete(songId);
        return next;
      });
    }
  };

  const handleReaddSong = async (playedSongId: Id<"playedSongs">) => {
    if (!room || !userId) {
      setError("Room or user not ready yet.");
      return;
    }

    // Prevent double-clicks
    if (readdingInProgress.has(playedSongId)) return;

    setReaddingInProgress((prev) => new Set(prev).add(playedSongId));
    setError(null);

    try {
      await readdSong({
        roomId: room._id,
        playedSongId,
        userId,
        userName: userName ?? undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to re-add song.");
    } finally {
      setReaddingInProgress((prev) => {
        const next = new Set(prev);
        next.delete(playedSongId);
        return next;
      });
    }
  };

  const handleRemoveSong = async (songId: Id<"songs">) => {
    if (!userId) return;
    try {
      await removeSong({ songId, userId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove song.");
    }
  };

  const handleAdminSetScore = async (songId: Id<"songs">) => {
    if (!userId) return;
    const val = parseInt(scoreInputs[songId] ?? "", 10);
    if (isNaN(val)) return;
    try {
      await adminSetScore({ songId, userId, score: val });
      setScoreInputs((prev) => ({ ...prev, [songId]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to set score.");
    }
  };

  const handleAdminAddVotes = async (songId: Id<"songs">) => {
    if (!userId) return;
    const val = parseInt(voteInputs[songId] ?? "", 10);
    if (isNaN(val)) return;
    try {
      await adminAddVotes({ songId, userId, delta: val });
      setVoteInputs((prev) => ({ ...prev, [songId]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add votes.");
    }
  };

  const handleDestroyRoom = async () => {
    if (!room || !userId) return;
    try {
      await destroyRoom({ roomId: room._id, userId });
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to destroy room.");
    }
  };

  const handleTransferHost = async () => {
    if (!room || !userId || !transferTarget) return;
    try {
      await transferHost({
        roomId: room._id,
        userId,
        newHostUserId: transferTarget,
      });
      setTransferTarget("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to transfer host.");
    }
  };

  const handleUpdateMaxSongs = async () => {
    if (!room || !userId) return;
    const val = parseInt(settingsMaxSongs, 10);
    if (isNaN(val) || val < 0) return;
    try {
      await updateSettings({
        roomId: room._id,
        userId,
        settings: { maxSongsPerUser: val },
      });
      setSettingsMaxSongs("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to update settings.",
      );
    }
  };

  // ── Loading / Not found states ────────────────────────────────────────

  if (room === undefined) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-3 text-white/30">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          <span className="text-sm">Loading room…</span>
        </div>
      </main>
    );
  }

  if (room === null) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="glass rounded-3xl p-10 max-w-md text-center">
          <div className="text-5xl mb-4 opacity-30">🔇</div>
          <h2 className="text-xl font-bold mb-2">Room not found</h2>
          <p className="text-white/35 text-sm mb-8">
            Double-check the room code and try again.
          </p>
          <Link
            href="/"
            className="inline-flex h-10 items-center px-6 rounded-2xl bg-white/[0.06] hover:bg-white/[0.1] text-sm font-medium transition-colors"
          >
            ← Back home
          </Link>
        </div>
      </main>
    );
  }

  const allowGuestAdd = room.settings.allowGuestAdd;
  const canAdd = isAdmin || (allowGuestAdd && !atSongLimit);

  return (
    <main className="relative min-h-screen pb-20 lg:pb-6">
      {/* Ambient background orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -left-40 w-[700px] h-[700px] rounded-full bg-primary/[0.08] blur-[160px]" />
        <div className="absolute top-1/2 -right-32 w-[500px] h-[500px] rounded-full bg-accent/[0.07] blur-[120px]" />
        <div className="absolute -bottom-20 left-1/3 w-[600px] h-[600px] rounded-full bg-secondary/[0.06] blur-[140px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* ── Header ────────────────────────────────────────────────── */}
        <header className="glass rounded-2xl sm:rounded-3xl px-5 py-4 sm:px-6 sm:py-5 mb-6 sm:mb-8 border-l-4 !border-l-primary">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-1.5">
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                  {room.name}
                </h1>
                {isAdmin && (
                  <span className="px-2.5 py-0.5 text-[11px] font-bold bg-primary/20 text-primary border border-primary/30 uppercase tracking-widest rounded-lg">
                    Host
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/35">
                <span className="font-mono text-base sm:text-lg text-primary tracking-[0.2em] font-semibold">
                  {room.code}
                </span>
                <span className="w-1 h-1 rounded-full bg-white/15" />
                <span className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                  </span>
                  {userCount ?? 1} listening
                </span>
                <span className="w-1 h-1 rounded-full bg-white/15" />
                <span>{queueSongs.length} in queue</span>
              </div>
              <div className="mt-3">
                <ShareRoom roomCode={room.code} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!allowGuestAdd && (
                <span className="px-2.5 py-1 text-[10px] font-medium rounded-lg bg-red-500/10 text-red-400 border border-red-500/20">
                  Guest add off
                </span>
              )}
              {room.settings.allowDownvotes && (
                <span className="px-2.5 py-1 text-[10px] font-medium rounded-lg bg-primary/10 text-primary border border-primary/20">
                  Downvotes on
                </span>
              )}
              {maxSongsPerUser > 0 && (
                <span className="px-2.5 py-1 text-[10px] font-medium rounded-lg bg-white/[0.06] text-white/50 border border-white/[0.08]">
                  {maxSongsPerUser}/user
                </span>
              )}
              <button
                onClick={handleLeaveRoom}
                className="px-3.5 py-1.5 text-xs font-medium text-white/70 bg-white/[0.06] hover:bg-red-500/20 hover:text-red-400 border border-white/[0.08] hover:border-red-500/20 rounded-xl transition-all duration-200"
              >
                Leave
              </button>
            </div>
          </div>
        </header>

        {/* ── Main Content Grid ─────────────────────────────────────── */}
        <div className="grid gap-6 lg:gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          {/* ── Left: Now Playing ── */}
          <section className="space-y-5">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.25em] text-primary">
              Now Playing
            </h2>

            {currentSong ? (
              <div className="space-y-4">
                {/* Artwork with glow */}
                <div className="relative group">
                  <div className="absolute -inset-1 bg-primary/30 opacity-80 blur-md group-hover:opacity-100 transition-opacity duration-500" />
                  <div
                    key={currentSong._id}
                    className="relative overflow-hidden rounded-3xl border border-white/[0.06]"
                  >
                    <img
                      src={`https://img.youtube.com/vi/${currentSong.providerId}/hqdefault.jpg`}
                      alt={currentSong.title}
                      className="w-full aspect-video object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-5 sm:p-6">
                      <p className="text-xl sm:text-2xl font-bold text-white drop-shadow-lg leading-tight mb-1.5">
                        {currentSong.title}
                      </p>
                      <div className="flex items-center gap-2 text-sm text-white/45">
                        {currentSong.artist && (
                          <span>{currentSong.artist}</span>
                        )}
                        {currentSong.addedByName && (
                          <>
                            <span className="w-1 h-1 rounded-full bg-white/25" />
                            <span className="text-white/30">
                              Added by {currentSong.addedByName}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  {/* Reaction overlay sits above the clipped artwork div */}
                  <ReactionOverlay roomId={room._id} userId={userId} />
                </div>

                {/* Audio Visualizer — admin can click to seek */}
                <div className="glass rounded-2xl px-3 py-2">
                  <AudioVisualizer
                    isPlaying={!room?.isPaused}
                    progress={seekProgress}
                    canSeek={isAdmin}
                    onSeek={(fraction) => {
                      if (!ytPlayer) return;
                      const dur = ytPlayer.getDuration?.() ?? 0;
                      if (dur > 0) {
                        ytPlayer.seekTo(fraction * dur, true);
                      }
                    }}
                  />
                </div>

                {/* Hidden YouTube player */}
                <div
                  className="fixed -left-[9999px] top-0 opacity-0 pointer-events-none"
                  aria-hidden
                >
                  <YouTube
                    key={currentSong.providerId}
                    videoId={currentSong.providerId}
                    opts={{
                      width: "320",
                      height: "180",
                      playerVars: {
                        autoplay: 1,
                        rel: 0,
                        controls: 0,
                        disablekb: 1,
                        fs: 0,
                        modestbranding: 1,
                        origin:
                          typeof window !== "undefined"
                            ? window.location.origin
                            : "",
                      },
                    }}
                    onReady={(e: any) => {
                      const p = e.target;
                      p.setVolume(isHost ? 100 : 0);
                      if (room?.isPaused) {
                        p.pauseVideo();
                      } else {
                        p.playVideo();
                      }
                      setYtPlayer(p);
                    }}
                    onEnd={handleSongEnd}
                    onStateChange={(e: any) => {
                      // 0 = ended — backup for background tabs where onEnd may not fire
                      if (e.data === 0) handleSongEnd();
                    }}
                    onError={(e: any) =>
                      console.error("YouTube player error:", e.data)
                    }
                  />
                </div>

                {/* Playback Controls */}
                <div className="glass rounded-2xl px-4 py-3 border-l-4 !border-l-primary">
                  <div className="flex items-center gap-3">
                    {isHost && (
                      <button
                        type="button"
                        onClick={() => {
                          if (!room || !userId) return;
                          togglePause({ roomId: room._id, userId });
                        }}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary hover:bg-primary/85 text-white transition-all duration-200 hover:scale-105 active:scale-95 shadow-lg shadow-primary/20"
                        title={room?.isPaused ? "Play" : "Pause"}
                      >
                        {room?.isPaused ? (
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                          >
                            <polygon points="8,5 20,12 8,19" />
                          </svg>
                        ) : (
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                          >
                            <rect x="6" y="4" width="4" height="16" rx="1" />
                            <rect x="14" y="4" width="4" height="16" rx="1" />
                          </svg>
                        )}
                      </button>
                    )}
                    {!isHost && room?.isPaused && (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.05] text-white/25">
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                        >
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      </div>
                    )}
                    <div className="flex-1">
                      <NowPlayingProgress player={ytPlayer} />
                    </div>
                    {isHost && (
                      <button
                        type="button"
                        onClick={() => {
                          if (room) {
                            handleSongEnd();
                          }
                        }}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent hover:bg-accent/80 text-white transition-all duration-200"
                        title="Skip to next"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                        >
                          <polygon points="4,4 16,12 4,20" />
                          <rect x="17" y="4" width="3" height="16" rx="1" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {/* Volume control — host only, YT-style hover expand */}
                  {isHost && (
                    <div className="group/vol flex items-center gap-0 mt-2.5 pt-2.5 border-t border-white/[0.06]">
                      <button
                        type="button"
                        onClick={() => {
                          if (isMuted) {
                            setIsMuted(false);
                            const restored = prevVolumeRef.current || 100;
                            setVolume(restored);
                            ytPlayer?.setVolume(restored);
                          } else {
                            prevVolumeRef.current = volume;
                            setIsMuted(true);
                            setVolume(0);
                            ytPlayer?.setVolume(0);
                          }
                        }}
                        className="flex h-8 w-8 shrink-0 items-center justify-center text-white/50 hover:text-white transition-colors"
                        title={isMuted ? "Unmute" : "Mute"}
                      >
                        {isMuted || volume === 0 ? (
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <line x1="23" y1="9" x2="17" y2="15" />
                            <line x1="17" y1="9" x2="23" y2="15" />
                          </svg>
                        ) : volume < 50 ? (
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          </svg>
                        ) : (
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                          </svg>
                        )}
                      </button>
                      {/* Slider slides out on hover like YT */}
                      <div className="overflow-hidden w-0 opacity-0 group-hover/vol:w-28 group-hover/vol:opacity-100 transition-all duration-300 ease-out">
                        <div className="flex items-center gap-2 pl-1 pr-1">
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={isMuted ? 0 : volume}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              setVolume(v);
                              setIsMuted(v === 0);
                              if (v > 0) prevVolumeRef.current = v;
                              ytPlayer?.setVolume(v);
                            }}
                            className="w-full h-1 accent-primary cursor-pointer appearance-none bg-white/10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-primary/30"
                          />
                          <span className="text-[10px] font-mono text-white/30 w-6 text-right tabular-nums shrink-0">
                            {isMuted ? 0 : volume}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="glass rounded-3xl p-12 sm:p-16 text-center border-l-4 !border-l-white/20">
                <div className="text-5xl mb-4 opacity-20">♪</div>
                <p className="text-white/30 text-sm">
                  Add a song to get started
                </p>
              </div>
            )}
          </section>

          {/* ── Right: Queue + Add Song ─────────────────────────────── */}
          <section className="space-y-6">
            {/* Queue */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.25em] text-primary">
                  Up Next
                </h2>
                <span className="text-[11px] text-white/15 tabular-nums">
                  {queueSongs.length} tracks
                  {isAdmin ? " · Drag to reorder" : ""}
                </span>
              </div>

              <div className="space-y-1.5">
                {queueSongs.length === 0 ? (
                  <div className="glass rounded-2xl p-8 text-center">
                    <p className="text-white/25 text-sm">
                      No songs in queue. Add one below.
                    </p>
                  </div>
                ) : (
                  queueSongs.map((song, index) => {
                    const currentVote = voteMap.get(song._id) ?? 0;
                    const canRemove =
                      isAdmin || (userId && song.addedBy === userId);
                    return (
                      <div
                        key={song._id}
                        draggable={isAdmin}
                        onDragStart={() => {
                          if (isAdmin) setDragIdx(index);
                        }}
                        onDragOver={(e) => {
                          if (isAdmin) {
                            e.preventDefault();
                            setDragOverIdx(index);
                          }
                        }}
                        onDragLeave={() => setDragOverIdx(null)}
                        onDrop={async () => {
                          if (
                            !isAdmin ||
                            dragIdx === null ||
                            dragIdx === index ||
                            !userId
                          )
                            return;
                          try {
                            await reorderSong({
                              songId: queueSongs[dragIdx]._id,
                              userId,
                              newIndex: index,
                            });
                          } catch {
                            /* ignore */
                          }
                          setDragIdx(null);
                          setDragOverIdx(null);
                        }}
                        onDragEnd={() => {
                          setDragIdx(null);
                          setDragOverIdx(null);
                        }}
                        className={`group relative rounded-2xl px-3.5 py-3 sm:px-4 transition-all duration-200 ${
                          dragOverIdx === index
                            ? "glass !border-primary/15 !bg-primary/[0.03]"
                            : "glass glass-hover"
                        } ${isAdmin ? "cursor-grab active:cursor-grabbing" : ""} ${
                          dragIdx === index ? "opacity-40 scale-[0.98]" : ""
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {/* Track indicator */}
                          <div className="w-7 shrink-0 flex items-center justify-center">
                            <span className="text-xs text-accent/30 font-mono tabular-nums">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                          </div>

                          {/* Song info */}
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-sm truncate text-white/80">
                              {song.title}
                            </p>
                            <div className="flex items-center gap-1.5 text-[11px] text-white/25 mt-0.5">
                              {song.artist && (
                                <span className="truncate">{song.artist}</span>
                              )}
                              {song.addedByName && (
                                <>
                                  <span className="w-0.5 h-0.5 rounded-full bg-white/15 shrink-0" />
                                  <span className="truncate">
                                    {song.addedByName}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>

                          {/* Vote controls */}
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              onClick={() =>
                                handleVote(song._id, currentVote === 1 ? 0 : 1)
                              }
                              disabled={
                                !userId || votingInProgress.has(song._id)
                              }
                              className={`group/vote relative p-1.5 rounded-xl transition-all duration-200 ${
                                currentVote === 1
                                  ? "bg-primary text-white shadow-sm shadow-primary/30"
                                  : "text-white/20 hover:text-primary hover:bg-primary/20"
                              } disabled:opacity-30 disabled:cursor-not-allowed`}
                            >
                              {/* Ring burst on vote */}
                              {votedSongs.has(song._id) &&
                                currentVote === 1 && (
                                  <span className="absolute inset-0 rounded-xl border-2 border-primary/50 animate-vote-ring" />
                                )}
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                className={`transition-transform duration-200 group-hover/vote:scale-110 group-hover/vote:-translate-y-0.5 ${votedSongs.has(song._id) && currentVote === 1 ? "animate-vote-burst" : ""}`}
                              >
                                <path d="M12 4c.3 0 .6.1.8.4l5.5 7.5c.4.5.1 1.1-.5 1.1H14v6.5c0 .8-.7 1.5-1.5 1.5h-1c-.8 0-1.5-.7-1.5-1.5V13H6.2c-.6 0-.9-.6-.5-1.1l5.5-7.5c.2-.3.5-.4.8-.4z" />
                              </svg>
                            </button>

                            <span
                              className={`text-xs font-bold tabular-nums min-w-[2.5ch] text-center px-1.5 py-0.5 rounded-lg transition-all duration-200 ${
                                song.score > 0
                                  ? "text-white bg-primary"
                                  : song.score < 0
                                    ? "text-white bg-destructive"
                                    : "text-white/25 bg-white/[0.06]"
                              } ${votedSongs.has(song._id) ? "animate-score-pop" : ""}`}
                            >
                              {song.score > 0 ? `+${song.score}` : song.score}
                            </span>

                            {room.settings.allowDownvotes && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleVote(
                                    song._id,
                                    currentVote === -1 ? 0 : -1,
                                  )
                                }
                                disabled={
                                  !userId || votingInProgress.has(song._id)
                                }
                                className={`group/vote relative p-1.5 rounded-xl transition-all duration-200 ${
                                  currentVote === -1
                                    ? "bg-destructive text-black shadow-sm shadow-destructive/30"
                                    : "text-white/20 hover:text-destructive hover:bg-destructive/20"
                                } disabled:opacity-30 disabled:cursor-not-allowed`}
                              >
                                {votedSongs.has(song._id) &&
                                  currentVote === -1 && (
                                    <span className="absolute inset-0 rounded-xl border-2 border-destructive/50 animate-vote-ring" />
                                  )}
                                <svg
                                  width="16"
                                  height="16"
                                  viewBox="0 0 24 24"
                                  fill="currentColor"
                                  className={`transition-transform duration-200 group-hover/vote:scale-110 group-hover/vote:translate-y-0.5 ${votedSongs.has(song._id) && currentVote === -1 ? "animate-vote-burst" : ""}`}
                                >
                                  <path d="M12 20c-.3 0-.6-.1-.8-.4l-5.5-7.5c-.4-.5-.1-1.1.5-1.1H10V4.5c0-.8.7-1.5 1.5-1.5h1c.8 0 1.5.7 1.5 1.5V11h3.8c.6 0 .9.6.5 1.1l-5.5 7.5c-.2.3-.5.4-.8.4z" />
                                </svg>
                              </button>
                            )}

                            {canRemove && (
                              <button
                                type="button"
                                onClick={() => handleRemoveSong(song._id)}
                                className="p-1.5 rounded-lg text-transparent group-hover:text-white/15 hover:!text-red-400 hover:!bg-red-500/10 transition-all duration-200"
                              >
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Admin inline controls */}
                        {isAdmin && (
                          <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-white/[0.04]">
                            <input
                              className="w-16 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] px-2 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-primary/30"
                              placeholder="Score"
                              type="number"
                              value={scoreInputs[song._id] ?? ""}
                              onChange={(e) =>
                                setScoreInputs((prev) => ({
                                  ...prev,
                                  [song._id]: e.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              onClick={() => handleAdminSetScore(song._id)}
                              className="h-7 px-2.5 rounded-lg text-[11px] font-medium bg-accent text-black hover:brightness-110 transition-colors"
                            >
                              Set
                            </button>
                            <input
                              className="w-16 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] px-2 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-primary/30"
                              placeholder="+/−"
                              type="number"
                              value={voteInputs[song._id] ?? ""}
                              onChange={(e) =>
                                setVoteInputs((prev) => ({
                                  ...prev,
                                  [song._id]: e.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              onClick={() => handleAdminAddVotes(song._id)}
                              className="h-7 px-2.5 rounded-lg text-[11px] font-medium bg-secondary text-white hover:brightness-110 transition-colors"
                            >
                              Add
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Song limit indicator */}
            {maxSongsPerUser > 0 && !isAdmin && (
              <div
                className={`glass rounded-2xl px-4 py-3 text-sm ${atSongLimit ? "!border-destructive !bg-destructive/[0.12]" : ""}`}
              >
                <span className="text-white/40">
                  You{"'"}ve added{" "}
                  <span className="font-semibold text-white/60">
                    {userSongCount}/{maxSongsPerUser}
                  </span>{" "}
                  songs.
                  {atSongLimit
                    ? " Limit reached."
                    : ` ${maxSongsPerUser - userSongCount} remaining.`}
                </span>
              </div>
            )}

            {/* Add Song */}
            <div className="glass rounded-2xl sm:rounded-3xl p-5 sm:p-6 border-l-4 !border-l-primary">
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-sm font-semibold text-primary">
                  Add a song
                </h3>
                {/* Search toggle button */}
                <button
                  type="button"
                  onClick={() => setSearchExpanded((v) => !v)}
                  className={`flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-300 ${
                    searchExpanded
                      ? "bg-primary/20 text-primary border border-primary/30"
                      : "bg-white/[0.06] text-white/40 hover:text-primary hover:bg-primary/10 border border-white/[0.08] hover:border-primary/20"
                  }`}
                  title="Search"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </button>
              </div>

              {/* Expandable search area */}
              <div
                className={`overflow-hidden transition-all duration-300 ease-out ${
                  searchExpanded
                    ? "max-h-[500px] opacity-100 mb-4"
                    : "max-h-0 opacity-0"
                }`}
              >
                <form className="space-y-3" onSubmit={handleSearch}>
                  <div className="relative">
                    <svg
                      className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/20 pointer-events-none"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search YouTube…"
                      className="w-full h-11 rounded-xl bg-white/[0.04] border border-white/[0.06] pl-10 pr-4 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-primary/30 focus:ring-1 focus:ring-primary/10 transition-all"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isSearching}
                    className="w-full h-10 rounded-xl bg-primary hover:brightness-110 text-white text-sm font-bold uppercase tracking-wider disabled:opacity-40 transition-all duration-200 border border-primary"
                  >
                    {isSearching ? "Searching…" : "Search"}
                  </button>
                  {searchError && (
                    <p className="text-xs text-red-400/80">{searchError}</p>
                  )}
                </form>
              </div>

              {/* Search results */}
              {searchResults.length > 0 && (
                <div className="space-y-1 mb-6">
                  {searchResults.slice(0, 3).map((track) => (
                    <div
                      key={track.id}
                      className="group flex items-center gap-3 rounded-xl p-2.5 hover:bg-white/[0.04] border border-transparent hover:border-white/[0.06] transition-all duration-200"
                    >
                      <div className="h-11 w-16 overflow-hidden rounded-lg bg-white/[0.04] shrink-0 ring-1 ring-white/[0.06]">
                        {track.thumbnailUrl && (
                          <img
                            src={track.thumbnailUrl}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white/80 truncate">
                          {track.title}
                        </p>
                        <p className="text-[11px] text-white/25 truncate">
                          {track.channel}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleAddFromSearch(track)}
                        disabled={!canAdd || !userId}
                        className="shrink-0 h-8 px-3.5 rounded-lg text-xs font-bold bg-primary hover:brightness-110 text-white border border-primary disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
                      >
                        {atSongLimit ? "Limit" : "+ Add"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recently Played */}
            {recentlyPlayed && recentlyPlayed.length > 0 && (
              <div className="glass rounded-2xl sm:rounded-3xl p-5 sm:p-6 border-l-4 !border-l-accent mt-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-accent">
                    Recently Played
                  </h3>
                  <button
                    type="button"
                    onClick={() => setRecentlyPlayedExpanded((v) => !v)}
                    className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-300 ${
                      recentlyPlayedExpanded
                        ? "bg-accent/20 text-accent border border-accent/30"
                        : "bg-white/[0.06] text-white/40 hover:text-accent hover:bg-accent/10 border border-white/[0.08] hover:border-accent/20"
                    }`}
                    title={recentlyPlayedExpanded ? "Collapse" : "Expand"}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`transition-transform duration-300 ${recentlyPlayedExpanded ? "rotate-180" : ""}`}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                </div>

                <div
                  className={`overflow-hidden transition-all duration-300 ease-out ${
                    recentlyPlayedExpanded
                      ? "max-h-[400px] opacity-100"
                      : "max-h-0 opacity-0"
                  }`}
                >
                  <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
                    {recentlyPlayed.slice(0, 10).map((song) => (
                      <div
                        key={song._id}
                        className="group flex items-center gap-3 rounded-xl p-2.5 hover:bg-white/[0.04] border border-transparent hover:border-white/[0.06] transition-all duration-200"
                      >
                        <div className="h-10 w-14 overflow-hidden rounded-lg bg-white/[0.04] shrink-0 ring-1 ring-white/[0.06]">
                          {song.providerId && (
                            <img
                              src={`https://img.youtube.com/vi/${song.providerId}/default.jpg`}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-white/70 truncate">
                            {song.title}
                          </p>
                          <p className="text-[11px] text-white/25 truncate">
                            {song.artist || "Unknown artist"}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleReaddSong(song._id)}
                          disabled={
                            !canAdd ||
                            !userId ||
                            readdingInProgress.has(song._id)
                          }
                          className="shrink-0 h-7 px-3 rounded-lg text-[11px] font-bold bg-accent/80 hover:bg-accent text-black border border-accent/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
                        >
                          {readdingInProgress.has(song._id)
                            ? "..."
                            : atSongLimit
                              ? "Limit"
                              : "+ Re-add"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {!recentlyPlayedExpanded && (
                  <p className="text-[11px] text-white/25">
                    {recentlyPlayed.length} song
                    {recentlyPlayed.length !== 1 ? "s" : ""} played
                  </p>
                )}
              </div>
            )}
          </section>
        </div>

        {/* ── Admin Panel ────────────────────────────────────────────── */}
        {isAdmin && (
          <section className="mt-8 glass rounded-2xl sm:rounded-3xl p-5 sm:p-6 !border-primary/30">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-primary mb-5">
              <span className="w-5 h-5 rounded-md bg-primary flex items-center justify-center text-[10px] text-white">
                ★
              </span>
              Host Controls
            </h3>
            <div className="grid gap-6 sm:grid-cols-3">
              {/* Settings */}
              <div className="space-y-3">
                <p className="text-xs font-medium text-primary uppercase tracking-wider">
                  Settings
                </p>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="text-[11px] text-white/25 mb-1 block">
                      Max songs/user
                    </label>
                    <input
                      className="w-full h-8 rounded-lg bg-white/[0.04] border border-white/[0.06] px-2.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-primary/30"
                      type="number"
                      min={0}
                      placeholder={String(maxSongsPerUser)}
                      value={settingsMaxSongs}
                      onChange={(e) => setSettingsMaxSongs(e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleUpdateMaxSongs}
                    className="h-8 px-3 rounded-lg text-[11px] font-medium bg-accent text-black hover:brightness-110 transition-colors"
                  >
                    Update
                  </button>
                </div>
              </div>

              {/* Transfer Host */}
              <div className="space-y-3">
                <p className="text-xs font-medium text-primary uppercase tracking-wider">
                  Transfer Host
                </p>
                {contributors.length === 0 ? (
                  <p className="text-[11px] text-white/20">
                    No other contributors yet.
                  </p>
                ) : (
                  <div className="flex items-end gap-2">
                    <select
                      className="flex-1 h-8 rounded-lg bg-white/[0.04] border border-white/[0.06] px-2 text-xs text-white focus:outline-none focus:border-primary/30 [&>option]:bg-card"
                      value={transferTarget}
                      onChange={(e) => setTransferTarget(e.target.value)}
                    >
                      <option value="">Select user</option>
                      {contributors.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleTransferHost}
                      disabled={!transferTarget}
                      className="h-8 px-3 rounded-lg text-[11px] font-medium bg-accent text-black hover:brightness-110 disabled:opacity-30 transition-colors"
                    >
                      Transfer
                    </button>
                  </div>
                )}
              </div>

              {/* Danger Zone */}
              <div className="space-y-3">
                <p className="text-xs font-medium text-destructive uppercase tracking-wider">
                  Danger
                </p>
                {confirmDestroy ? (
                  <div className="space-y-2">
                    <p className="text-xs text-white/40">
                      Are you sure? This deletes everything.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleDestroyRoom}
                        className="h-8 px-3 rounded-lg text-[11px] font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
                      >
                        Destroy
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDestroy(false)}
                        className="h-8 px-3 rounded-lg text-[11px] font-medium bg-card hover:bg-white/10 text-white/60 border border-white/10 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDestroy(true)}
                    className="h-8 px-3 rounded-lg text-[11px] font-medium bg-red-600/80 hover:bg-red-600 text-white border border-red-600 transition-all"
                  >
                    Destroy Room
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Error toast */}
        {error && (
          <div className="fixed bottom-20 lg:bottom-6 right-6 z-50 glass rounded-2xl px-4 py-3 !border-red-500/20 !bg-red-500/[0.06] max-w-sm">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}
      </div>

      {/* ── Mobile sticky now-playing bar ─────────────────────────── */}
      {currentSong && (
        <div className="fixed bottom-0 inset-x-0 z-50 lg:hidden glass !border-t-2 !border-t-primary !rounded-none px-4 py-2.5 safe-bottom">
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              <div className="absolute -inset-0.5 rounded-lg bg-primary/20 blur-sm" />
              <img
                src={`https://img.youtube.com/vi/${currentSong.providerId}/default.jpg`}
                alt=""
                className="relative h-10 w-10 rounded-lg object-cover"
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate text-white/90">
                {currentSong.title}
              </p>
              {currentSong.artist && (
                <p className="text-[11px] text-white/30 truncate">
                  {currentSong.artist}
                </p>
              )}
            </div>
            {isHost && (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    if (!room || !userId) return;
                    togglePause({ roomId: room._id, userId });
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white hover:brightness-110 transition-colors"
                >
                  {room?.isPaused ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <polygon points="8,5 20,12 8,19" />
                    </svg>
                  ) : (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (room) {
                      handleSongEnd();
                    }
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white hover:brightness-110 transition-colors"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <polygon points="4,4 16,12 4,20" />
                    <rect x="17" y="4" width="3" height="16" rx="1" />
                  </svg>
                </button>
              </div>
            )}
          </div>
          <div className="mt-1.5">
            <NowPlayingProgress player={ytPlayer} />
          </div>
        </div>
      )}
    </main>
  );
}
