# spotify-playlist-mcp

A local [MCP](https://modelcontextprotocol.io) server that lets an MCP client (Claude
Desktop, Claude Code, Cowork) fully manage a Spotify playlist — including the two things
the official Spotify connector can't do: **read an existing playlist's full contents** and
**add tracks to it**.

Runs over stdio on your machine. Credentials and tokens never leave it.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `pull_playlist` | `playlist_id?` | The **entire** tracklist (all pages) as `artist(s) - title  [spotify:track:URI]  added YYYY-MM-DD` |
| `search_tracks` | `query`, `limit?` (1–20, default 5) | `artist(s) - title \| album \| spotify:track:URI` per match |
| `add_tracks` | `uris[]`, `playlist_id?` | Count added (batched in chunks of 100) |
| `playlist_stats` | `playlist_id?` | Name, owner, track count, top 15 primary artists |

`playlist_id` accepts a bare id, `spotify:playlist:ID`, or an
`open.spotify.com/playlist/ID?...` URL. When omitted it falls back to the
`SPOTIFY_DEFAULT_PLAYLIST` env var; with neither set you get a clear validation error.
No playlist is hardcoded — the server works against any playlist the authorized user can
read or modify. Local files, unavailable tracks and podcast episodes are skipped and
reported as a count.

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
playlist-modify-private playlist-modify-public`.

On a headless/remote shell set `SPOTIFY_NO_BROWSER=1` and open the printed URL yourself.

The MCP server itself never prompts — it refreshes the access token from the stored
refresh token. Re-run `pnpm auth` only if you revoke access or the scopes change.

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
  whole.
- **Token handling:** the access token is refreshed when expired and, on a `401`, refreshed
  and the request retried once.
- **Rate limits:** a `429` is retried once after the `Retry-After` delay (waits longer than
  60s are reported rather than slept through).
- **`403`/`404`** surface a readable message pointing at ownership/scope or a bad id.

## Layout

```
src/server.ts   McpServer + stdio transport, the 4 tools
src/spotify.ts  Web API client, token cache/refresh, id normalisation, pagination
src/auth.ts     one-time OAuth CLI (pnpm auth)
```

Nothing is sent anywhere except api.spotify.com. `.spotify-token.json`, `.env` and `dist/`
are git-ignored — `.env.example` is the committed template.
