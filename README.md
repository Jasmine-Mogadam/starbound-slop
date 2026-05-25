# starbound-slop

Dockerized Starbound dedicated server, deployable to [fly.io](https://fly.io).

Uses SteamCMD inside the container to download the Linux server binaries at startup — no need to copy files off your Mac. Requires owning Starbound on Steam.

## Architecture note (Apple Silicon)

Starbound and SteamCMD are x86_64 only. The Dockerfile pins `--platform linux/amd64` so Docker Desktop on M1/M2/M3/M4 Macs automatically emulates an Intel environment via Rosetta/QEMU.

## Local setup

### 1. Set your Steam credentials

```sh
cp .env.example .env
```

Edit `.env` with your Steam username and password. If you have Steam Guard (2FA) enabled, add your current code too — it expires in ~30 seconds so do this right before running.

```
STEAM_USER=your_steam_username
STEAM_PASS=your_steam_password
STEAM_GUARD=123456
```

### 2. Build the image

```sh
npm run docker:build
```

This builds once. You only need to rebuild if the Dockerfile or entrypoint changes.

### 3. Run the server

```sh
npm run docker:run
```

On first run, SteamCMD downloads Starbound (~4 GB) into a named Docker volume (`starbound-data`). Subsequent starts validate and diff against what's cached — much faster.

**Shortcut:** `npm run docker` builds and runs in one step.

### Other commands

```sh
npm run logs   # tail container output
npm run stop   # stop and remove the local container
npm start      # run the server natively on macOS (no Docker, uses your local Starbound install)
```

Connect from your Starbound client at `localhost:21025`.

## fly.io deployment

### 1. Set secrets

```sh
flyctl secrets set STEAM_USER=your_username STEAM_PASS=your_password
```

If Steam Guard is active, set it immediately before deploying:

```sh
flyctl secrets set STEAM_GUARD=123456
```

### 2. Deploy

```sh
npm run deploy
```

The fly.io volume (`starbound_data`) persists the Starbound install and saves across deploys. First deploy downloads everything; subsequent deploys are fast.

After the first successful deploy, you can unset `STEAM_GUARD`:

```sh
flyctl secrets unset STEAM_GUARD
```

### Connecting to the server

Find your server address and port:

```sh
npm run status
```

Look for the **IP address** in the output (or use the dedicated IPv4 allocated during first deploy). The port is always **21025**.

In Starbound: **Multiplayer → Connect** and enter:
- **Address:** your fly.io IP or `starbound-server.fly.dev`
- **Port:** `21025`
- **Account / Password:** leave blank (see below)

### Optional: set a server password

By default the server has no password — anyone with the address can join. To add one:

```sh
npm run ssh
```

Then inside the machine:

```sh
nano /opt/starbound/storage/universe_server.config
```

Add or update:

```json
"serverPassword" : "yourpassword"
```

Save and redeploy (`npm run deploy`) or restart the machine (`flyctl machine restart`) to apply. Players enter this password in the Starbound connect dialog.

## How it works

The Dockerfile installs SteamCMD into the image at build time. At container startup, `entrypoint.sh` runs `steamcmd.sh +app_update 211820 validate` to download or update Starbound, then launches `linux64/starbound_server`. The named volume at `/opt/starbound` caches the install so the download only happens in full once.

Save data lives in `/opt/starbound/storage/` inside the same volume.
