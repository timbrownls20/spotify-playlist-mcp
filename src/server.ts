#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MAX_HISTORY_LIMIT,
  SpotifyClient,
  SpotifyError,
  TIME_RANGES,
  TIME_RANGE_LABELS,
  clampLimit,
  formatAddedDate,
  formatArtists,
  formatPlayedAt,
  loadConfig,
  missingScopes,
  normalizeTimeRange,
  normalizeTrackUri,
  readTokenCache,
  reauthorizeMessage,
} from "./spotify.js";

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

// Fail fast with a readable message rather than surfacing it on every tool call.
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[spotify-playlist-mcp] ${(err as Error).message}`);
  process.exit(1);
}

const spotify = new SpotifyClient(config);
const server = new McpServer({ name: "spotify-playlist", version: "1.0.0" });

const playlistIdArg = z
  .string()
  .optional()
  .describe(
    "Playlist to target: its name (e.g. 'Electronic'), a bare id, spotify:playlist:ID, or an " +
      "open.spotify.com/playlist/... URL. Names are matched against your library and must be " +
      "unambiguous. Defaults to the SPOTIFY_DEFAULT_PLAYLIST env var when omitted."
  );

/** Shows which playlist a name actually resolved to, so a write is never silent. */
function describeTarget(target: { id: string; name?: string }): string {
  return target.name ? `${target.name} (${target.id})` : target.id;
}

const timeRangeArg = z
  .enum(TIME_RANGES)
  .optional()
  .describe(
    "Listening window: short_term (~4 weeks), medium_term (~6 months, default) or " +
      "long_term (several years)."
  );

/** Spotify publishes no play counts, so every history tool repeats this. */
const NO_COUNTS_NOTE =
  "Spotify exposes no per-track play counts — this is a ranking by play frequency, not a tally.";

server.registerTool(
  "pull_playlist",
  {
    title: "Pull playlist",
    description:
      "Fetch the entire tracklist of a Spotify playlist (all pages) as a numbered list of " +
      "artist - title with track URI and date added.",
    inputSchema: { playlist_id: playlistIdArg },
  },
  async ({ playlist_id }) => {
    try {
      const { id } = await spotify.resolvePlaylist(playlist_id);
      const meta = await spotify.playlistMeta(id);
      const { tracks, skipped } = await spotify.allTracks(id);

      const lines = tracks.map(
        (t, i) =>
          `${i + 1}. ${formatArtists(t.artists)} - ${t.name}  [${t.uri}]  added ${formatAddedDate(
            t.addedAt
          )}`
      );

      const header =
        `Playlist: ${meta.name} (${meta.id}) — ${tracks.length} tracks listed, ` +
        `API total ${meta.total}` +
        (skipped ? ` (${skipped} local/unavailable item(s) skipped)` : "");

      return text([header, "", ...(lines.length ? lines : ["(playlist is empty)"])].join("\n"));
    } catch (err) {
      return failure(err);
    }
  }
);

server.registerTool(
  "search_tracks",
  {
    title: "Search tracks",
    description: "Search Spotify for tracks and return their spotify:track: URIs.",
    inputSchema: {
      query: z.string().describe("Search terms, e.g. 'artist name track title'."),
      limit: z.number().int().optional().describe("Number of results, 1-20 (default 5)."),
    },
  },
  async ({ query, limit }) => {
    try {
      const q = query.trim();
      if (!q) return text("Empty query — nothing to search for.");

      const clamped = Math.min(20, Math.max(1, Math.trunc(limit ?? 5)));
      const results = await spotify.searchTracks(q, clamped);
      if (!results.length) return text(`No tracks found for "${q}".`);

      const lines = results.map(
        (t) => `${formatArtists(t.artists)} - ${t.name} | ${t.album} | ${t.uri}`
      );
      return text([`${results.length} result(s) for "${q}":`, "", ...lines].join("\n"));
    } catch (err) {
      return failure(err);
    }
  }
);

server.registerTool(
  "add_tracks",
  {
    title: "Add tracks",
    description:
      "Add one or more tracks to a playlist. Accepts spotify:track: URIs (track URLs and bare " +
      "ids are also accepted). Batched in chunks of 100.",
    inputSchema: {
      uris: z.array(z.string()).describe("Track URIs to add."),
      playlist_id: playlistIdArg,
    },
  },
  async ({ uris, playlist_id }) => {
    try {
      const cleaned = uris.map((u) => (u ?? "").trim()).filter(Boolean).map(normalizeTrackUri);
      if (!cleaned.length) return text("No track URIs supplied — nothing added.");

      const target = await spotify.resolvePlaylist(playlist_id, { forWrite: true });
      const added = await spotify.addTracks(target.id, cleaned);
      const batches = Math.ceil(added / 100);
      return text(
        `Added ${added} track(s) to ${describeTarget(target)}` +
          (batches > 1 ? ` in ${batches} batches of up to 100.` : ".")
      );
    } catch (err) {
      return failure(err);
    }
  }
);

server.registerTool(
  "list_playlists",
  {
    title: "List playlists",
    description:
      "Every playlist in the user's library, with id, track count and whether they own it " +
      "(only owned playlists can be modified). Use this to find a playlist id or name.",
    inputSchema: {
      owned_only: z
        .boolean()
        .optional()
        .describe("Only playlists the user owns and can modify (default false)."),
      query: z.string().optional().describe("Case-insensitive substring filter on the name."),
    },
  },
  async ({ owned_only, query }) => {
    try {
      const all = await spotify.allPlaylists();
      const needle = (query ?? "").trim().toLowerCase();
      const shown = all
        .filter((p) => (owned_only ? p.owned : true))
        .filter((p) => (needle ? p.name.toLowerCase().includes(needle) : true));

      if (!shown.length) {
        return text(
          `No playlists match` +
            (needle ? ` "${query}"` : "") +
            (owned_only ? " among those you own." : ".") +
            ` Library holds ${all.length}.`
        );
      }

      const lines = shown.map(
        (p) =>
          `${p.owned ? "*" : " "} ${p.name}  [${p.id}]  ${p.total} tracks  owner: ${p.owner}`
      );
      const owned = all.filter((p) => p.owned).length;
      const header =
        `${shown.length} of ${all.length} playlist(s)` +
        (needle || owned_only ? " matching your filter" : "") +
        `. ${owned} owned (marked *) and modifiable; the rest are followed and read-only.`;

      return text([header, "", ...lines].join("\n"));
    } catch (err) {
      return failure(err);
    }
  }
);

server.registerTool(
  "remove_tracks",
  {
    title: "Remove tracks",
    description:
      "Remove tracks from a playlist. Accepts spotify:track: URIs (track URLs and bare ids too). " +
      "Removes EVERY occurrence of each URI, so a duplicated track disappears entirely. " +
      "Batched in chunks of 100.",
    inputSchema: {
      uris: z.array(z.string()).describe("Track URIs to remove."),
      playlist_id: playlistIdArg,
    },
  },
  async ({ uris, playlist_id }) => {
    try {
      const cleaned = uris.map((u) => (u ?? "").trim()).filter(Boolean).map(normalizeTrackUri);
      if (!cleaned.length) return text("No track URIs supplied — nothing removed.");

      const target = await spotify.resolvePlaylist(playlist_id, { forWrite: true });
      const removed = await spotify.removeTracks(target.id, cleaned);
      const batches = Math.ceil(removed / 100);
      return text(
        `Removed ${removed} track URI(s) from ${describeTarget(target)}` +
          (batches > 1 ? ` in ${batches} batches of up to 100.` : ".") +
          " All occurrences of each URI were removed."
      );
    } catch (err) {
      return failure(err);
    }
  }
);

server.registerTool(
  "playlist_stats",
  {
    title: "Playlist stats",
    description: "Playlist name, total track count and the top 15 primary artists by track count.",
    inputSchema: { playlist_id: playlistIdArg },
  },
  async ({ playlist_id }) => {
    try {
      const { id } = await spotify.resolvePlaylist(playlist_id);
      const meta = await spotify.playlistMeta(id);
      const { tracks, skipped } = await spotify.allTracks(id);

      const tally = new Map<string, number>();
      for (const t of tracks) {
        const primary = t.artists[0] ?? "(unknown artist)";
        tally.set(primary, (tally.get(primary) ?? 0) + 1);
      }

      const top = [...tally.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 15)
        .map(([artist, count], i) => `${i + 1}. ${artist} — ${count}`);

      const lines = [
        `Playlist: ${meta.name} (${meta.id})`,
        `Owner: ${meta.owner}`,
        `Tracks: ${tracks.length}` +
          (skipped ? ` (${skipped} local/unavailable item(s) skipped)` : ""),
        `Distinct primary artists: ${tally.size}`,
        "",
        top.length ? "Top primary artists:" : "No tracks to tally.",
        ...top,
      ];
      return text(lines.join("\n"));
    } catch (err) {
      return failure(err);
    }
  }
);

server.registerTool(
  "top_tracks",
  {
    title: "Top tracks",
    description:
      "The user's most-played tracks over a listening window, in rank order. " +
      "Spotify provides no exact play counts — rank is the only signal.",
    inputSchema: {
      time_range: timeRangeArg,
      limit: z.number().int().optional().describe("Number of tracks, 1-50 (default 20)."),
    },
  },
  async ({ time_range, limit }) => {
    try {
      const range = normalizeTimeRange(time_range);
      const count = clampLimit(limit, 20, MAX_HISTORY_LIMIT);
      const tracks = await spotify.topTracks(range, count);
      if (!tracks.length) return text(`No top tracks for ${TIME_RANGE_LABELS[range]}.`);

      const lines = tracks.map(
        (t, i) => `${i + 1}. ${formatArtists(t.artists)} - ${t.name}  [${t.uri}]`
      );
      const header =
        `Top ${tracks.length} tracks — ${TIME_RANGE_LABELS[range]} (${range}).\n${NO_COUNTS_NOTE}`;

      return text([header, "", ...lines].join("\n"));
    } catch (err) {
      return failure(err);
    }
  }
);

server.registerTool(
  "top_artists",
  {
    title: "Top artists",
    description:
      "The user's most-played artists over a listening window, in rank order, with genres.",
    inputSchema: {
      time_range: timeRangeArg,
      limit: z.number().int().optional().describe("Number of artists, 1-50 (default 20)."),
    },
  },
  async ({ time_range, limit }) => {
    try {
      const range = normalizeTimeRange(time_range);
      const count = clampLimit(limit, 20, MAX_HISTORY_LIMIT);
      const artists = await spotify.topArtists(range, count);
      if (!artists.length) return text(`No top artists for ${TIME_RANGE_LABELS[range]}.`);

      const lines = artists.map(
        (a, i) => `${i + 1}. ${a.name}` + (a.genres.length ? `  [${a.genres.join(", ")}]` : "")
      );
      const header =
        `Top ${artists.length} artists — ${TIME_RANGE_LABELS[range]} (${range}).\n${NO_COUNTS_NOTE}`;

      return text([header, "", ...lines].join("\n"));
    } catch (err) {
      return failure(err);
    }
  }
);

server.registerTool(
  "recently_played",
  {
    title: "Recently played",
    description:
      "The most recent plays with timestamps, newest first. This is a rolling window of the " +
      "last 50 plays only — it is not a full listening history.",
    inputSchema: {
      limit: z.number().int().optional().describe("Number of plays, 1-50 (default 50)."),
    },
  },
  async ({ limit }) => {
    try {
      const count = clampLimit(limit, MAX_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
      const entries = await spotify.recentlyPlayed(count);
      if (!entries.length) return text("No recent plays returned by Spotify.");

      const lines = entries.map(
        (e) =>
          `${formatPlayedAt(e.playedAt)} — ${formatArtists(e.track.artists)} - ${e.track.name}  [${
            e.track.uri
          }]`
      );
      const header =
        `${entries.length} most recent play(s), newest first (times in UTC).\n` +
        `Spotify only retains the last ${MAX_HISTORY_LIMIT} plays, so this window is not a full history.`;

      return text([header, "", ...lines].join("\n"));
    } catch (err) {
      return failure(err);
    }
  }
);

server.registerTool(
  "playlist_rotation",
  {
    title: "Playlist rotation",
    description:
      "Cross-reference a playlist against listening data, grouping its tracks into HOT " +
      "(in your top tracks), recent (played lately) and cold (neither).",
    inputSchema: { playlist_id: playlistIdArg, time_range: timeRangeArg },
  },
  async ({ playlist_id, time_range }) => {
    try {
      const { id } = await spotify.resolvePlaylist(playlist_id);
      const range = normalizeTimeRange(time_range);

      const meta = await spotify.playlistMeta(id);
      const { tracks, skipped } = await spotify.allTracks(id);
      const top = await spotify.topTracks(range, MAX_HISTORY_LIMIT);
      const recent = await spotify.recentlyPlayed(MAX_HISTORY_LIMIT);

      const topRank = new Map(top.map((t, i) => [t.uri, i + 1]));

      // Within the 50-play window a repeat is a real (if tiny) count, so keep it.
      const plays = new Map<string, { count: number; latest: string | null }>();
      for (const entry of recent) {
        const seen = plays.get(entry.track.uri);
        if (seen) seen.count += 1;
        else plays.set(entry.track.uri, { count: 1, latest: entry.playedAt });
      }

      const ranked: Array<{ rank: number; line: string }> = [];
      const recentOnly: string[] = [];
      const cold: string[] = [];

      for (const t of tracks) {
        const label = `${formatArtists(t.artists)} - ${t.name}`;
        const rank = topRank.get(t.uri);
        const play = plays.get(t.uri);
        const playNote = play
          ? `, played ${play.count}× since ${formatPlayedAt(play.latest)}`
          : "";

        if (rank) ranked.push({ rank, line: `#${rank} — ${label}${playNote}` });
        else if (play)
          recentOnly.push(`${formatPlayedAt(play.latest)} — ${label} (${play.count}× in window)`);
        else cold.push(label);
      }

      // Numeric rank order, so #2 precedes #10.
      const hot = ranked.sort((a, b) => a.rank - b.rank).map((r) => r.line);
      const section = (title: string, rows: string[], empty: string) =>
        [`${title} (${rows.length})`, ...(rows.length ? rows.map((r) => `  ${r}`) : [`  ${empty}`])];

      const lines = [
        `Playlist: ${meta.name} (${meta.id}) — ${tracks.length} tracks` +
          (skipped ? ` (${skipped} local/unavailable item(s) skipped)` : ""),
        `Compared against your top tracks for ${TIME_RANGE_LABELS[range]} (${range}) and your last ${recent.length} plays.`,
        "",
        ...section("HOT — in your top tracks", hot, "none"),
        "",
        ...section("RECENT — played lately but not top-ranked", recentOnly, "none"),
        "",
        ...section("COLD — in neither list", cold, "none"),
        "",
        `Coverage caveat: top tracks and recent plays cover at most ${MAX_HISTORY_LIMIT} items each, ` +
          `so "cold" means "absent from those two lists", not "never played".`,
      ];

      return text(lines.join("\n"));
    } catch (err) {
      return failure(err);
    }
  }
);

/**
 * A token minted before the history scopes were added still authenticates, but
 * 403s on /me/top and /me/player. Say so plainly at startup.
 */
async function checkScopes() {
  const cache = await readTokenCache().catch(() => null);
  const missing = missingScopes(cache);
  if (!missing.length) return;

  console.error(`[spotify-playlist-mcp] ${reauthorizeMessage(missing)}`);
  process.exit(1);
}

async function main() {
  await checkScopes();
  await server.connect(new StdioServerTransport());
  console.error("[spotify-playlist-mcp] ready on stdio (10 tools)");
}

main().catch((err) => {
  const message = err instanceof SpotifyError ? err.message : String(err);
  console.error(`[spotify-playlist-mcp] fatal: ${message}`);
  process.exit(1);
});
