# starbound-slop

Dockerized Starbound dedicated server, deployable to [fly.io](https://fly.io).

> **Platform note:** The Starbound dedicated server binary is Linux/Windows only. You need a Linux or Windows machine with Starbound installed to build and deploy this.

## Setup

### 1. Point to your Starbound install

```sh
cp config.example.json config.json
```

Edit `config.json` with the paths to your local Starbound install:

```json
{
  "starboundPath": "C:/Program Files (x86)/Steam/steamapps/common/Starbound",
  "workshopPath": "C:/Program Files (x86)/Steam/steamapps/workshop/content/211820"
}
```

`workshopPath` is optional — omit it if you have no workshop mods. All mods in that folder will be included automatically.

### 2. Deploy

```sh
npm run deploy
```

This copies the server files into `.build/`, builds the Docker image with them baked in, and deploys to fly.io. Game saves persist in a fly.io volume across deploys.

### Local run

```sh
npm start
```

Same as deploy but runs locally via Docker. Requires Docker Desktop.

## How it works

`npm run deploy` (and `npm start`) runs `scripts/prepare.js` first, which copies `linux64/`, `assets/`, and any mods from your local install into `.build/server/`. The Dockerfile then bakes those files directly into the image — no Steam login or runtime downloads needed.

Save data lives in `/opt/starbound/storage/`, which is mounted to a persistent fly.io volume so it survives redeploys.
