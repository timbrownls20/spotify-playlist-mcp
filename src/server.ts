#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  SpotifyClient,
  SpotifyError,
  formatAddedDate,
  formatArtists,
  loadConfig,
  normalizePlaylistId,
  normalizeTrackUri,
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
    "Playlist to target: bare id, spotify:playlist:ID, or an open.spotify.com/playlist/... URL. " +
      "Defaults to the SPOTIFY_DEFAULT_PLAYLIST env var when omitted."
  );

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
      const id = normalizePlaylistId(playlist_id);
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
      const id = normalizePlaylistId(playlist_id);
      const cleaned = uris.map((u) => (u ?? "").trim()).filter(Boolean).map(normalizeTrackUri);
      if (!cleaned.length) return text("No track URIs supplied — nothing added.");

      const added = await spotify.addTracks(id, cleaned);
      const batches = Math.ceil(added / 100);
      return text(
        `Added ${added} track(s) to playlist ${id}` +
          (batches > 1 ? ` in ${batches} batches of up to 100.` : ".")
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
      const id = normalizePlaylistId(playlist_id);
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

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("[spotify-playlist-mcp] ready on stdio (4 tools)");
}

main().catch((err) => {
  const message = err instanceof SpotifyError ? err.message : String(err);
  console.error(`[spotify-playlist-mcp] fatal: ${message}`);
  process.exit(1);
});
