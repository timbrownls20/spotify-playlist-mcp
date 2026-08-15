import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** OAuth scopes needed to read and modify playlists, and to read listening history. */
export const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-top-read",
  "user-read-recently-played",
];

/** Time windows Spotify offers for top items, with the labels we show users. */
export const TIME_RANGES = ["short_term", "medium_term", "long_term"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  short_term: "approximately the last 4 weeks",
  medium_term: "approximately the last 6 months",
  long_term: "several years of listening",
};

/** Spotify caps recently-played and top-item pages at 50. */
export const MAX_HISTORY_LIMIT = 50;

const API_BASE = "https://api.spotify.com/v1";
const ACCOUNTS_BASE = "https://accounts.spotify.com";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8888/callback";

/** Refresh a little early so a token can't expire mid-request. */
const EXPIRY_SKEW_MS = 60_000;

/** Longest 429 wait we'll sit through before giving up and reporting it. */
const MAX_RETRY_AFTER_S = 60;

export interface TokenCache {
  access_token?: string;
  refresh_token: string;
  /** Epoch ms at which access_token stops being valid. */
  expires_at?: number;
  scope?: string;
  obtained_at?: string;
}

export class SpotifyError extends Error {}

/** Project root — one level up from the compiled dist/ this file runs from. */
const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, "..");

/**
 * Load `.env` from the project root, if present. Real environment variables
 * always win, so an MCP client that passes `env` in its config keeps control.
 */
function loadDotEnv(): void {
  let contents: string;
  try {
    contents = readFileSync(join(projectRoot, ".env"), "utf8");
  } catch {
    return; // No .env — env vars come from the environment.
  }

  for (const line of contents.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim(); // Strip trailing comments.
    }
    if (value) process.env[key] = value;
  }
}

loadDotEnv();

export function tokenFilePath(): string {
  return process.env.SPOTIFY_TOKEN_FILE
    ? resolve(process.env.SPOTIFY_TOKEN_FILE)
    : join(projectRoot, ".spotify-token.json");
}

export interface AppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function loadConfig(): AppConfig {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  const missing = [
    !clientId && "SPOTIFY_CLIENT_ID",
    !clientSecret && "SPOTIFY_CLIENT_SECRET",
  ].filter(Boolean);

  if (missing.length) {
    throw new SpotifyError(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Create a Spotify developer app and set them in your MCP client config — see README.md.`
    );
  }

  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: (process.env.SPOTIFY_REDIRECT_URI || DEFAULT_REDIRECT_URI).trim(),
  };
}

export async function readTokenCache(): Promise<TokenCache | null> {
  try {
    return JSON.parse(await readFile(tokenFilePath(), "utf8")) as TokenCache;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SpotifyError(`Could not read token cache ${tokenFilePath()}: ${(err as Error).message}`);
  }
}

export async function writeTokenCache(cache: TokenCache): Promise<void> {
  await writeFile(tokenFilePath(), JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Scopes in SCOPES that the cached token was not granted. A token minted before
 * a scope was added keeps working for the old endpoints but 403s on the new
 * ones, so we check up front rather than surfacing a cryptic API error.
 */
export function missingScopes(cache: TokenCache | null): string[] {
  if (!cache) return [];
  const granted = new Set((cache.scope ?? "").split(/\s+/).filter(Boolean));
  return SCOPES.filter((scope) => !granted.has(scope));
}

export function reauthorizeMessage(missing: string[]): string {
  return (
    `Stored Spotify token is missing required scope(s): ${missing.join(", ")}. ` +
    `Delete the token cache and re-authorize:\n` +
    `  rm ${tokenFilePath()}\n` +
    `  pnpm run auth`
  );
}

export type PlaylistRef = { kind: "id"; id: string } | { kind: "name"; name: string };

/**
 * Classifies a playlist reference. Ids, `spotify:playlist:ID` URIs and
 * open.spotify.com URLs resolve straight to an id; anything else is taken as a
 * playlist *name* to be looked up against the user's library.
 *
 * Spotify ids are always 22 base62 characters, which is what lets a bare word
 * like "Electronic" be read as a name rather than a malformed id.
 */
export function parsePlaylistRef(input: string | undefined | null): PlaylistRef {
  const raw = (input ?? "").trim();
  const fallback = (process.env.SPOTIFY_DEFAULT_PLAYLIST ?? "").trim();
  const value = raw || fallback;

  if (!value) {
    throw new SpotifyError(
      "No playlist specified. Pass playlist_id (a name, bare id, spotify:playlist:ID, or an " +
        "open.spotify.com/playlist/... URL), or set SPOTIFY_DEFAULT_PLAYLIST in the server env."
    );
  }

  const uriMatch = value.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uriMatch) return { kind: "id", id: uriMatch[1] };

  if (/^https?:\/\//i.test(value)) {
    const urlMatch = value.match(/playlist[/:]([A-Za-z0-9]+)/);
    if (urlMatch) return { kind: "id", id: urlMatch[1] };
    throw new SpotifyError(`Could not find a playlist id in URL: ${value}`);
  }

  if (/^[A-Za-z0-9]{22}$/.test(value)) return { kind: "id", id: value };

  return { kind: "name", name: value };
}

/** Accepts a bare track id, a track URL, or a `spotify:track:ID` URI. Returns the URI. */
export function normalizeTrackUri(input: string): string {
  const value = input.trim();
  if (/^spotify:track:[A-Za-z0-9]+$/.test(value)) return value;

  const urlMatch = value.match(/^https?:\/\/[^\s]*track[/:]([A-Za-z0-9]+)/);
  if (urlMatch) return `spotify:track:${urlMatch[1]}`;

  if (/^[A-Za-z0-9]{22}$/.test(value)) return `spotify:track:${value}`;

  throw new SpotifyError(
    `Not a track URI: ${value}. Expected spotify:track:ID, a track URL, or a bare track id.`
  );
}

/** Validates a caller-supplied time range, defaulting to the ~6 month window. */
export function normalizeTimeRange(input: string | undefined | null): TimeRange {
  const value = (input ?? "").trim() || "medium_term";
  if ((TIME_RANGES as readonly string[]).includes(value)) return value as TimeRange;

  throw new SpotifyError(
    `Unrecognised time_range: ${value}. Expected one of ${TIME_RANGES.join(", ")}.`
  );
}

export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, Math.trunc(limit ?? fallback)));
}

export interface PlaylistTrack {
  name: string;
  artists: string[];
  album: string;
  uri: string;
  addedAt: string | null;
}

export interface TopArtist {
  name: string;
  genres: string[];
  uri: string;
}

export interface PlayEntry {
  playedAt: string | null;
  track: PlaylistTrack;
}

/** Shared shape for the track objects returned by playlists, search and history. */
function toTrack(raw: any, addedAt: string | null = null): PlaylistTrack {
  return {
    name: raw?.name || "(unknown title)",
    artists: (raw?.artists ?? []).map((a: any) => a.name).filter(Boolean),
    album: raw?.album?.name ?? "",
    uri: raw?.uri ?? "",
    addedAt,
  };
}

export interface PlaylistMeta {
  id: string;
  name: string;
  owner: string;
  total: number;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  owner: string;
  total: number;
  /** Only playlists you own can be modified; the rest are merely followed. */
  owned: boolean;
}

export interface ResolvedPlaylist {
  id: string;
  /** Present only when the reference was resolved from a name. */
  name?: string;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export class SpotifyClient {
  private config: AppConfig;
  private cache: TokenCache | null = null;

  constructor(config: AppConfig = loadConfig()) {
    this.config = config;
  }

  private basicAuthHeader(): string {
    const raw = `${this.config.clientId}:${this.config.clientSecret}`;
    return `Basic ${Buffer.from(raw).toString("base64")}`;
  }

  private async loadCache(): Promise<TokenCache> {
    if (this.cache) return this.cache;
    const cache = await readTokenCache();
    if (!cache?.refresh_token) {
      throw new SpotifyError(
        `No Spotify refresh token found at ${tokenFilePath()}. Run \`pnpm run auth\` once to authorize this app.`
      );
    }

    const missing = missingScopes(cache);
    if (missing.length) throw new SpotifyError(reauthorizeMessage(missing));

    this.cache = cache;
    return cache;
  }

  /** Returns a valid access token, refreshing via the stored refresh token when needed. */
  async accessToken(force = false): Promise<string> {
    const cache = await this.loadCache();
    const fresh =
      cache.access_token && cache.expires_at && cache.expires_at - EXPIRY_SKEW_MS > Date.now();
    if (fresh && !force) return cache.access_token!;
    return this.refreshAccessToken(cache);
  }

  private async refreshAccessToken(cache: TokenCache): Promise<string> {
    const res = await fetch(`${ACCOUNTS_BASE}/api/token`, {
      method: "POST",
      headers: {
        Authorization: this.basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cache.refresh_token,
      }),
    });

    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      throw new SpotifyError(
        `Token refresh failed (${res.status} ${payload.error ?? ""}${
          payload.error_description ? `: ${payload.error_description}` : ""
        }). The stored refresh token may have been revoked — re-run \`npm run auth\`.`
      );
    }

    const updated: TokenCache = {
      ...cache,
      access_token: payload.access_token,
      // Spotify only returns a new refresh token occasionally; keep the old one otherwise.
      refresh_token: payload.refresh_token ?? cache.refresh_token,
      expires_at: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
      scope: payload.scope ?? cache.scope,
    };
    this.cache = updated;
    await writeTokenCache(updated);
    return updated.access_token!;
  }

  /** Web API request with one retry on 401 (refresh) and one on 429 (Retry-After). */
  async request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.attempt<T>(path, opts, {
      forceRefresh: false,
      refreshed: false,
      rateLimited: false,
    });
  }

  private async attempt<T>(
    path: string,
    opts: RequestOptions,
    state: { forceRefresh: boolean; refreshed: boolean; rateLimited: boolean }
  ): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const token = await this.accessToken(state.forceRefresh);
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    if (res.status === 401 && !state.refreshed) {
      return this.attempt<T>(path, opts, { ...state, refreshed: true, forceRefresh: true });
    }

    if (res.status === 429 && !state.rateLimited) {
      const waitS = Number(res.headers.get("retry-after") ?? "1") || 1;
      if (waitS > MAX_RETRY_AFTER_S) {
        throw new SpotifyError(
          `Spotify rate limited this request and asked to wait ${waitS}s — try again later.`
        );
      }
      await new Promise((r) => setTimeout(r, waitS * 1000));
      return this.attempt<T>(path, opts, { ...state, rateLimited: true, forceRefresh: false });
    }

    if (!res.ok) throw await this.describeError(res, path);

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async describeError(res: Response, path: string): Promise<SpotifyError> {
    const detail = await res
      .json()
      .then((body: any) => body?.error?.message ?? body?.error_description ?? "")
      .catch(() => "");

    const hint =
      res.status === 403
        ? " (forbidden — the authorized user may not own or be able to modify this playlist, or the required scope is missing; re-run `npm run auth` if scopes changed)"
        : res.status === 404
          ? " (not found — check the playlist id)"
          : res.status === 429
            ? " (rate limited)"
            : "";

    return new SpotifyError(`Spotify API ${res.status} on ${path}${hint}${detail ? `: ${detail}` : ""}`);
  }

  async currentUser(): Promise<{ id: string; display_name?: string }> {
    return this.request("/me");
  }

  /** Memoised — the authorized account cannot change within a process. */
  private userIdPromise: Promise<string> | null = null;

  async userId(): Promise<string> {
    this.userIdPromise ??= this.currentUser().then((me) => me.id);
    return this.userIdPromise;
  }

  /** Every playlist in the user's library (owned and followed), following pagination. */
  async allPlaylists(): Promise<PlaylistSummary[]> {
    const me = await this.userId();
    const summaries: PlaylistSummary[] = [];
    let offset = 0;
    const limit = 50;

    for (;;) {
      const page = await this.request<any>("/me/playlists", { query: { limit, offset } });
      const items: any[] = page.items ?? [];

      for (const p of items) {
        if (!p?.id) continue;
        summaries.push({
          id: p.id,
          // Spotify permits an empty name, so `||` not `??`.
          name: p.name || "(untitled)",
          owner: p.owner?.display_name ?? p.owner?.id ?? "unknown",
          // Playlists renamed `tracks` to `items`; accept either for the count.
          total: p.items?.total ?? p.tracks?.total ?? 0,
          owned: p.owner?.id === me,
        });
      }

      offset += items.length;
      if (!page.next || items.length === 0) break;
    }

    return summaries;
  }

  /**
   * Turns a playlist reference into an id, looking names up in the library.
   *
   * Matching narrows through exact, then case-insensitive, then substring; the
   * first tier with any hit wins. Ambiguity is an error rather than a guess.
   * `forWrite` additionally refuses substring matches, since silently modifying
   * the wrong playlist is far worse than making the caller be explicit.
   */
  async resolvePlaylist(
    input: string | undefined | null,
    opts: { forWrite?: boolean } = {}
  ): Promise<ResolvedPlaylist> {
    const ref = parsePlaylistRef(input);
    if (ref.kind === "id") return { id: ref.id };

    const wanted = ref.name;
    const lower = wanted.toLowerCase();
    const all = await this.allPlaylists();
    const pool = opts.forWrite ? all.filter((p) => p.owned) : all;

    const exact = pool.filter((p) => p.name === wanted);
    const insensitive = pool.filter((p) => p.name.toLowerCase() === lower);
    const substring = pool.filter((p) => p.name.toLowerCase().includes(lower));

    const [matches, tier] = exact.length
      ? ([exact, "exact"] as const)
      : insensitive.length
        ? ([insensitive, "case-insensitive"] as const)
        : ([substring, "substring"] as const);

    if (!matches.length) {
      throw new SpotifyError(
        `No ${opts.forWrite ? "playlist you own" : "playlist"} named "${wanted}". ` +
          `Use list_playlists to see what's available, or pass an id.`
      );
    }

    if (matches.length > 1) {
      const shown = matches.slice(0, 8).map((p) => `  ${p.name} (${p.id})`);
      throw new SpotifyError(
        `"${wanted}" matches ${matches.length} playlists — pass an id to disambiguate:\n` +
          shown.join("\n") +
          (matches.length > shown.length ? `\n  ...and ${matches.length - shown.length} more` : "")
      );
    }

    const match = matches[0];
    if (opts.forWrite && tier === "substring") {
      throw new SpotifyError(
        `Refusing to modify "${match.name}" from the partial name "${wanted}" — a wrong match ` +
          `would write to the wrong playlist. Pass the full name or the id (${match.id}).`
      );
    }

    return { id: match.id, name: match.name };
  }

  async playlistMeta(playlistId: string): Promise<PlaylistMeta> {
    const data = await this.request<any>(`/playlists/${playlistId}`, {
      query: { fields: "id,name,owner(display_name,id),items(total)" },
    });
    return {
      id: data.id,
      name: data.name,
      owner: data.owner?.display_name ?? data.owner?.id ?? "unknown",
      total: data.items?.total ?? 0,
    };
  }

  /**
   * Every track in the playlist, following pagination.
   * Local files, unavailable items and non-track items (e.g. episodes) are skipped.
   */
  async allTracks(playlistId: string): Promise<{ tracks: PlaylistTrack[]; skipped: number }> {
    const tracks: PlaylistTrack[] = [];
    let skipped = 0;
    let offset = 0;
    const limit = 100;

    for (;;) {
      const page = await this.request<any>(`/playlists/${playlistId}/items`, {
        query: {
          limit,
          offset,
          fields:
            "items(added_at,is_local,item(name,uri,type,is_local,album(name),artists(name))),next,total",
        },
      });

      const items: any[] = page.items ?? [];
      for (const item of items) {
        const track = item?.item;
        if (!track || item.is_local || track.is_local || track.type !== "track" || !track.uri) {
          skipped++;
          continue;
        }
        tracks.push(toTrack(track, item.added_at ?? null));
      }

      offset += items.length;
      if (!page.next || items.length === 0) break;
    }

    return { tracks, skipped };
  }

  async searchTracks(query: string, limit: number): Promise<PlaylistTrack[]> {
    const data = await this.request<any>("/search", {
      query: { q: query, type: "track", limit },
    });
    return (data.tracks?.items ?? []).map((track: any) => toTrack(track));
  }

  /**
   * The user's most-played tracks for a window, in rank order.
   * Spotify exposes no play counts — position in this list is the only signal.
   */
  async topTracks(timeRange: TimeRange, limit: number): Promise<PlaylistTrack[]> {
    const data = await this.request<any>("/me/top/tracks", {
      query: { time_range: timeRange, limit },
    });
    return (data.items ?? []).map((track: any) => toTrack(track));
  }

  async topArtists(timeRange: TimeRange, limit: number): Promise<TopArtist[]> {
    const data = await this.request<any>("/me/top/artists", {
      query: { time_range: timeRange, limit },
    });
    return (data.items ?? []).map((artist: any) => ({
      name: artist?.name ?? "(unknown artist)",
      genres: artist?.genres ?? [],
      uri: artist?.uri ?? "",
    }));
  }

  /**
   * The last plays Spotify still holds, newest first. This is a rolling window
   * of at most 50 items — it is not a history and cannot be paged backwards far.
   */
  async recentlyPlayed(limit: number): Promise<PlayEntry[]> {
    const data = await this.request<any>("/me/player/recently-played", {
      query: { limit },
    });

    const entries: PlayEntry[] = [];
    for (const item of data.items ?? []) {
      // Playlists renamed `track` to `item`; accept either in case this follows.
      const raw = item?.track ?? item?.item;
      if (!raw?.uri) continue;
      entries.push({ playedAt: item.played_at ?? null, track: toTrack(raw) });
    }
    return entries;
  }

  /** Adds URIs in chunks of 100 (the API limit). Returns the number added. */
  async addTracks(playlistId: string, uris: string[]): Promise<number> {
    for (let i = 0; i < uris.length; i += 100) {
      await this.request(`/playlists/${playlistId}/items`, {
        method: "POST",
        body: { uris: uris.slice(i, i + 100) },
      });
    }
    return uris.length;
  }

  /**
   * Removes URIs in chunks of 100. Note Spotify deletes *every* occurrence of a
   * URI, so a track sitting in the playlist twice disappears entirely.
   */
  async removeTracks(playlistId: string, uris: string[]): Promise<number> {
    for (let i = 0; i < uris.length; i += 100) {
      await this.request(`/playlists/${playlistId}/items`, {
        method: "DELETE",
        // The body key follows the endpoint rename: `items`, not `tracks`.
        body: { items: uris.slice(i, i + 100).map((uri) => ({ uri })) },
      });
    }
    return uris.length;
  }
}

export function formatArtists(artists: string[]): string {
  return artists.length ? artists.join(", ") : "(unknown artist)";
}

export function formatAddedDate(addedAt: string | null): string {
  return addedAt ? addedAt.slice(0, 10) : "unknown";
}

/** `2026-08-15T09:25:57Z` -> `2026-08-15 09:25` (UTC, as Spotify reports it). */
export function formatPlayedAt(playedAt: string | null): string {
  return playedAt ? playedAt.slice(0, 16).replace("T", " ") : "unknown time";
}
