# spotify-playlist-mcp

A local [MCP](https://modelcontextprotocol.io) server that lets an MCP client (Claude
Desktop, Claude Code, Cowork) fully manage a Spotify playlist — including the two things
the official Spotify connector can't do: **read an existing playlist's full contents** and
**add tracks to it**.

Runs over stdio on your machine. Credentials and tokens never leave it.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_playlists` | `owned_only?`, `query?` | Every playlist in your library with id, track count and ownership |
| `pull_playlist` | `playlist_id?` | The **entire** tracklist (all pages) as `artist(s) - title  [spotify:track:URI]  added YYYY-MM-DD` |
| `search_tracks` | `query`, `limit?` (1–20, default 5) | `artist(s) - title \| album \| spotify:track:URI` per match |
| `add_tracks` | `uris[]`, `playlist_id?` | Count added (batched in chunks of 100) |
| `remove_tracks` | `uris[]`, `playlist_id?` | Count removed — **every** occurrence of each URI |
| `playlist_stats` | `playlist_id?` | Name, owner, track count, top 15 primary artists |
| `top_tracks` | `time_range?`, `limit?` (1–50, default 20) | Your most-played tracks, in rank order |
| `top_artists` | `time_range?`, `limit?` (1–50, default 20) | Your most-played artists, in rank order, with genres |
| `recently_played` | `limit?` (1–50, default 50) | Recent plays as `YYYY-MM-DD HH:MM — artist(s) - title` (UTC), newest first |
| `playlist_rotation` | `playlist_id?`, `time_range?` | Playlist tracks grouped **HOT** / **recent** / **cold** against your listening |

`time_range` is `short_term` (~4 weeks), `medium_term` (~6 months, the default) or
`long_term` (several years).

No playlist is hardcoded — every tool works against any playlist the authorized user can
read or modify. Local files, unavailable tracks and podcast episodes are skipped and
reported as a count.

### Naming a playlist

`playlist_id` accepts four forms:

| Form | Example |
| --- | --- |
| Name | `Electronic` |
| Bare id | `1VdAWOel0ZEN1GBrIbqxox` |
| URI | `spotify:playlist:1VdAWOel0ZEN1GBrIbqxox` |
| URL | `https://open.spotify.com/playlist/1VdAWOel0ZEN1GBrIbqxox?si=...` |

Omitted, it falls back to `SPOTIFY_DEFAULT_PLAYLIST`; with neither set you get a clear
validation error. Ids are recognised by shape — Spotify ids are always 22 base62
characters — so anything else is treated as a name and looked up in your library.

Name matching narrows through **exact → case-insensitive → substring**, and the first tier
with a hit wins. Two rules keep it safe:

- **Ambiguity is an error, never a guess.** A name matching several playlists returns the
  candidates and their ids so you can pick.
- **Writes are stricter than reads.** `add_tracks` and `remove_tracks` only consider
  playlists you own, and refuse substring matches outright — `"ADHD"` will read from
  *ADHD Wall Of Sound* but not write to it. Pass the full name or the id. Write results
  name the playlist they resolved to, so a write is never silent about its target.

## Listening history: no play counts

**Spotify's Web API does not expose per-track play counts to anyone**, including you for
your own account. There is no endpoint that answers "how many times have I played this
track". The history tools work within that limit:

- `top_tracks` / `top_artists` return a **ranking** by play frequency over a window. Rank
  is the only signal — there are no numbers behind it.
- `recently_played` returns a **rolling window of the last 50 plays** only. It is not a
  history and cannot be paged back further. Plays shorter than ~30 seconds never appear,
  and anything beyond 50 plays ago is gone.
- `playlist_rotation` combines the two, so its `cold` group means "absent from your top 50
  and your last 50 plays" — **not** "never played".

For true all-time counts the only source is a Spotify GDPR **Extended Streaming History**
export (Privacy Settings → request it; arrives in a few days as JSON). That is out of
scope for this server.

## Setup

### 1. Create a Spotify app

At the [developer dashboard](https://developer.spotify.com/dashboard) create an app and
add **exactly** the redirect URI you intend to use — `http://127.0.0.1:8888/callback` is
the default. Note the client id and client secret.

### 2. Install and build

```bash
pnpm install
pnpm build
```

### 3. Authorize once

`pnpm auth` runs the OAuth Authorization Code flow: it starts a temporary HTTP server
on the redirect URI, opens the Spotify consent page, captures the code, exchanges it for
tokens and writes `.spotify-token.json` (git-ignored, mode 0600). It prints the authorized
account on success.

Copy `.env.example` to `.env` in the repo root (git-ignored) and fill in the credentials —
both `pnpm auth` and the server read it automatically:

```bash
cp .env.example .env
$EDITOR .env
pnpm auth
```

Real environment variables take precedence over `.env`, so the `env` block in an MCP
client config still wins.

Scopes requested: `playlist-read-private playlist-read-collaborative
playlist-modify-private playlist-modify-public user-top-read user-read-recently-played`.

On a headless/remote shell set `SPOTIFY_NO_BROWSER=1` and open the printed URL yourself.

The MCP server itself never prompts — it refreshes the access token from the stored
refresh token. Re-run `pnpm auth` only if you revoke access or the scopes change.

### Upgrading: the history tools need a re-authorization

The `user-top-read` and `user-read-recently-played` scopes were added alongside the
listening-history tools. A token cached before that still authenticates but is refused on
the new endpoints, so the server **refuses to start** and tells you what to do rather than
failing later with an opaque `403`:

```bash
rm .spotify-token.json
pnpm auth
```

Refreshing an existing token does not widen its scopes — the cache must be deleted and the
consent flow re-run. Restart your MCP client afterwards.

### 4. Point your client at it

`claude_desktop_config.json` (or any MCP client config):

```json
{
  "mcpServers": {
    "spotify-playlist": {
      "command": "node",
      "args": ["/abs/path/spotify-playlist-mcp/dist/server.js"],
      "env": {
        "SPOTIFY_CLIENT_ID": "...",
        "SPOTIFY_CLIENT_SECRET": "...",
        "SPOTIFY_REDIRECT_URI": "http://127.0.0.1:8888/callback",
        "SPOTIFY_DEFAULT_PLAYLIST": "<optional_default_playlist_id>"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add spotify-playlist -- node /abs/path/spotify-playlist-mcp/dist/server.js
```

(then set the same env vars in the generated config, or export them in your shell).

## Environment variables

Read from the process environment first, falling back to `.env` in the repo root.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | yes | Spotify app client id |
| `SPOTIFY_CLIENT_SECRET` | yes | Spotify app client secret |
| `SPOTIFY_REDIRECT_URI` | no | Defaults to `http://127.0.0.1:8888/callback`; must match the dashboard exactly |
| `SPOTIFY_DEFAULT_PLAYLIST` | no | Playlist used when a tool is called without `playlist_id` |
| `SPOTIFY_TOKEN_FILE` | no | Override the token cache path (default `.spotify-token.json` in the repo root) |
| `SPOTIFY_NO_BROWSER` | no | `pnpm auth` prints the URL instead of opening a browser |

## Behaviour notes

- **Pagination:** `pull_playlist` and `playlist_stats` walk the playlist 100 items at a
  time until Spotify stops returning a `next` page, so 100+ track playlists come back
  whole. `list_playlists` does the same in pages of 50. Note Spotify's `total` for the
  playlist *library* can overcount by one or more (it counts entries it then declines to
  return); the tools report what was actually retrieved.
- **Deletes remove every occurrence:** `remove_tracks` deletes all copies of a URI, which
  is Spotify's behaviour, not a choice this server makes. Removing one of two duplicates
  is not possible by URI alone.
- **Token handling:** the access token is refreshed when expired and, on a `401`, refreshed
  and the request retried once.
- **Rate limits:** a `429` is retried once after the `Retry-After` delay (waits longer than
  60s are reported rather than slept through).
- **`403`/`404`** surface a readable message pointing at ownership/scope or a bad id.
- **Scope drift:** the cached token's granted scopes are checked at startup and before every
  request; a token missing any required scope produces re-authorization instructions.

## Layout

```
src/server.ts   McpServer + stdio transport, the 10 tools
src/spotify.ts  Web API client, token cache/refresh, id normalisation, pagination
src/auth.ts     one-time OAuth CLI (pnpm auth)
```

Nothing is sent anywhere except api.spotify.com. `.spotify-token.json`, `.env` and `dist/`
are git-ignored — `.env.example` is the committed template.
