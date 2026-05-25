# starbound-slop

Dockerized Starbound dedicated server with workshop mods. Runs locally with a
[playit.gg](https://playit.gg) tunnel so friends can connect over the public
internet without you opening any router ports.

## Architecture note (Apple Silicon)

Starbound is x86_64 only. The Dockerfile pins `--platform linux/amd64` so Docker
Desktop on M1/M2/M3/M4 Macs emulates Intel automatically via Rosetta/QEMU.

## Prerequisites

- Docker Desktop running
- Starbound installed locally with the Linux dedicated-server files staged in
  `starbound-server-files/` (Steam workshop mods go in
  `starbound-server-files/mods/`). The Fly deploy script
  (`scripts/deploy.js`) can populate this directory for you via SteamCMD if
  you don't already have it; see the Fly section at the bottom.
- A free [playit.gg](https://playit.gg) account

## Local setup with playit.gg

### 1. Configure env

```sh
cp .env.example .env
```

Leave `PLAYIT_SECRET` blank for now.

### 2. Build the image

```sh
npm run local:build
```

### 3. Claim the playit agent (one-time)

```sh
npm run local:claim
```

This runs the playit agent interactively. It prints a URL like
`https://playit.gg/claim/xxxxxxxx`. Open it, sign in / sign up, and link the
agent to your account.

Once linked, playit.gg will show you a **secret key** for this agent. Copy it
into `.env`:

```
PLAYIT_SECRET=your-secret-here
```

Stop the claim process with `Ctrl+C` once you've copied the secret.

### 4. Create the tunnel on playit.gg

On [playit.gg → Tunnels → Add Tunnel](https://playit.gg/account/tunnels):

- **Tunnel type:** TCP
- **Local port:** `21025`
- **Local address:** `starbound` (the docker compose service name — the playit
  container resolves this via the shared compose network)

playit will give you a public address like `starbound.joinmc.link:12345`. That's
what your friends connect to.

### 5. Start everything

```sh
npm run local:up
```

Tail the server logs:

```sh
npm run local:logs
```

You can also connect locally at `localhost:21025` to test before sharing the
public address.

### Common commands

```sh
npm run local:up           # start starbound + playit (detached)
npm run local:down         # stop everything
npm run local:logs         # tail starbound logs
npm run local:logs:playit  # tail playit agent logs
npm start                  # run the server natively on macOS (no Docker)
```

### Optional: set a server password

Edit `starbound-server-files/storage/universe_server.config` (created after the
first run) and set:

```json
"serverPassword" : "yourpassword"
```

Then `npm run local:down && npm run local:up` to apply.

## fly.io deployment (legacy)

The original Fly setup is still wired up if you ever want it back. See
`scripts/deploy.js`, `Dockerfile`, and `fly.toml`. Commands:

```sh
npm run setup    # one-time: create the fly app + volume
npm run deploy   # build, push, upload bundle, restart
npm run status   # flyctl status
npm run logs:fly # tail fly logs
npm run ssh      # flyctl ssh console
npm run destroy  # tear it all down
```

Friends connect to `starbound-server.fly.dev:21025` (or the dedicated IPv4).

## How it works

The Dockerfile builds a thin Ubuntu image with Starbound's runtime
dependencies. The entrypoint expects the game files to be present at
`/opt/starbound/storage/game/` — locally we bind-mount
`./starbound-server-files` directly into that path, so there's no upload step
and mod changes take effect on next restart.

The playit agent runs as a sidecar container, dials out to playit's edge
servers, and forwards incoming public traffic to `starbound:21025` over the
compose network. No inbound ports on your home router.
