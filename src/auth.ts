#!/usr/bin/env node
/**
 * One-time OAuth Authorization Code flow.
 *
 * Starts a throwaway HTTP server on the redirect URI, opens the Spotify consent
 * page, captures the `code`, exchanges it for tokens and writes the token cache
 * the MCP server reads. Run once (and again only if scopes change or the token
 * is revoked): `npm run auth`.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  SCOPES,
  SpotifyClient,
  loadConfig,
  tokenFilePath,
  writeTokenCache,
} from "./spotify.js";

function openBrowser(url: string): void {
  // Set SPOTIFY_NO_BROWSER=1 to just print the URL (headless / remote shells).
  if (process.env.SPOTIFY_NO_BROWSER) return;
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" })
      .on("error", () => {})
      .unref();
  } catch {
    // Non-fatal: the URL is printed for manual use.
  }
}

async function main() {
  const config = loadConfig();
  const redirect = new URL(config.redirectUri);
  const port = Number(redirect.port || 80);
  const state = randomBytes(16).toString("hex");

  const authorizeUrl = new URL("https://accounts.spotify.com/authorize");
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    scope: SCOPES.join(" "),
    redirect_uri: config.redirectUri,
    state,
    show_dialog: "true",
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const received = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      const done = (status: number, body: string, err?: Error) => {
        res.writeHead(status, { "Content-Type": "text/html" }).end(`<html><body>${body}</body></html>`);
        server.close();
        err ? reject(err) : resolve(received!);
      };

      if (error) return done(400, `Authorization failed: ${error}`, new Error(`Spotify returned: ${error}`));
      if (returnedState !== state)
        return done(400, "State mismatch — aborting.", new Error("OAuth state mismatch — possible CSRF; retry."));
      if (!received) return done(400, "No code returned.", new Error("No authorization code in callback."));

      done(200, "<h2>Spotify authorization complete.</h2><p>You can close this tab.</p>");
    });

    server.on("error", reject);
    server.listen(port, redirect.hostname, () => {
      console.log(`Listening for the Spotify callback on ${config.redirectUri}`);
      console.log(`\nIf your browser does not open, visit:\n${authorizeUrl}\n`);
      openBrowser(authorizeUrl.toString());
    });
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !payload.refresh_token) {
    throw new Error(
      `Token exchange failed (${res.status}): ${payload.error_description ?? payload.error ?? "no refresh token returned"}`
    );
  }

  await writeTokenCache({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
    scope: payload.scope,
    obtained_at: new Date().toISOString(),
  });

  const me = await new SpotifyClient(config).currentUser();
  console.log(`\nAuthorized as ${me.display_name ?? me.id} (${me.id}).`);
  console.log(`Token cache written to ${tokenFilePath()}`);
  console.log(`Scopes: ${payload.scope ?? SCOPES.join(" ")}`);
}

main().catch((err) => {
  console.error(`\nAuth failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
