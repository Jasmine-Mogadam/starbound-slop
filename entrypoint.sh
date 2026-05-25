#!/bin/bash
set -uo pipefail

STARBOUND_DIR=${STARBOUND_DIR:-/opt/starbound}
GAME_DIR="$STARBOUND_DIR/storage/game"
ARCHIVE="$STARBOUND_DIR/storage/game.tar.gz"
SERVER_DIR="$GAME_DIR/linux"
SERVER_BIN="$SERVER_DIR/starbound_server"

log() {
  local msg="[$(date '+%H:%M:%S')] $*"
  echo "$msg"
}

python3 /usr/local/bin/status_server.py &

fix_perms() {
  # DepotDownloader doesn't preserve the +x bit, so binaries arrive non-executable.
  [ -d "$SERVER_DIR" ] || return 0
  chmod +x "$SERVER_DIR"/starbound_server "$SERVER_DIR"/starbound \
           "$SERVER_DIR"/asset_packer "$SERVER_DIR"/asset_unpacker \
           "$SERVER_DIR"/dump_versioned_json "$SERVER_DIR"/make_versioned_json \
           "$SERVER_DIR"/planet_mapgen "$SERVER_DIR"/run-server.sh \
           "$SERVER_DIR"/run-client.sh 2>/dev/null || true
}

if [ ! -f "$SERVER_BIN" ] || { [ -f "$ARCHIVE" ] && [ "$ARCHIVE" -nt "$SERVER_BIN" ]; }; then
  shopt -s nullglob
  parts=("$STARBOUND_DIR/storage/game.tar.gz.part."*)
  shopt -u nullglob

  if [ ${#parts[@]} -gt 0 ]; then
    log "Extracting ${#parts[@]} upload chunks..."
    rm -rf "$GAME_DIR" && mkdir -p "$GAME_DIR"
    cat "${parts[@]}" | tar xzf - -C "$GAME_DIR" && rm -f "${parts[@]}"
    log "Extraction complete."
  elif [ -f "$ARCHIVE" ]; then
    log "Extracting game archive..."
    rm -rf "$GAME_DIR" && mkdir -p "$GAME_DIR"
    tar xzf "$ARCHIVE" -C "$GAME_DIR"
    rm -f "$ARCHIVE"
    log "Extraction complete."
  else
    log "Waiting for game archive at $ARCHIVE..."
    while [ ! -f "$ARCHIVE" ] && [ ${#parts[@]} -eq 0 ]; do
      sleep 5
      shopt -s nullglob
      parts=("$STARBOUND_DIR/storage/game.tar.gz.part."*)
      shopt -u nullglob
    done
    exec "$0"
  fi
fi

fix_perms

# Starbound writes its runtime config to ../storage/starbound_server.config on first launch.
# Apply our overrides every start so they survive even if the file gets regenerated.
patch_config() {
  local cfg="$GAME_DIR/storage/starbound_server.config"
  [ -f "$cfg" ] || return 0
  python3 - "$cfg" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    cfg = json.load(f)
overrides = {
    "safeScripts": False,
    "allowAssetsMismatch": True,
}
changed = False
for k, v in overrides.items():
    if cfg.get(k) != v:
        cfg[k] = v
        changed = True
if changed:
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"Patched config: {overrides}")
PY
}

patch_config

log "Starting starbound_server..."
touch /tmp/starbound_started
cd "$SERVER_DIR"
exec ./starbound_server
