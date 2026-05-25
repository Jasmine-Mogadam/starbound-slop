#!/bin/bash
set -uo pipefail

STARBOUND_DIR=${STARBOUND_DIR:-/opt/starbound}
STORAGE_DIR="$STARBOUND_DIR/storage"
GAME_DIR="$STORAGE_DIR/game"
BUNDLE="$STORAGE_DIR/bundle.tar.gz"
BUNDLE_GLOB="$STORAGE_DIR/bundle.tar.gz.part."
SERVER_DIR="$GAME_DIR/linux"
SERVER_BIN="$SERVER_DIR/starbound_server"
MODS_DIR="$GAME_DIR/mods"
SWAPFILE="$STORAGE_DIR/swapfile"
SWAP_SIZE_GB="${SWAP_SIZE_GB:-2}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Backstop the known Starbound mem leak — swap on the persistent volume survives reboots.
setup_swap() {
  if swapon --show=NAME --noheadings 2>/dev/null | grep -qFx "$SWAPFILE"; then
    return 0
  fi
  if [ ! -f "$SWAPFILE" ]; then
    log "Creating ${SWAP_SIZE_GB}G swap file at $SWAPFILE..."
    if ! fallocate -l "${SWAP_SIZE_GB}G" "$SWAPFILE" 2>/dev/null; then
      dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAP_SIZE_GB * 1024)) status=none
    fi
    chmod 0600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null
  fi
  if swapon "$SWAPFILE" 2>/dev/null; then
    log "Swap enabled ($(swapon --show=SIZE,USED --noheadings | tail -1))."
  else
    log "Could not enable swap (kernel may not support it); continuing without."
  fi
}

setup_swap

python3 /usr/local/bin/status_server.py &

# Clean up any artifacts from older flows so they don't confuse us.
rm -rf "$STORAGE_DIR/bad-mods" "$STORAGE_DIR/reassemble.sh" 2>/dev/null
rm -f "$STORAGE_DIR"/mods.tar "$STORAGE_DIR"/mods.tar.part.* \
      "$STORAGE_DIR"/game.tar.gz "$STORAGE_DIR"/game.tar.gz.part.* 2>/dev/null

# Assemble bundle from chunks if an upload is in progress.
shopt -s nullglob
parts=("$BUNDLE_GLOB"*)
shopt -u nullglob
if [ ${#parts[@]} -gt 0 ]; then
  log "Assembling bundle from ${#parts[@]} chunks..."
  cat "${parts[@]}" > "$BUNDLE" && rm -f "${parts[@]}"
fi

# Extract a freshly-uploaded bundle — wipes game/ to guarantee a clean state.
if [ -f "$BUNDLE" ]; then
  log "Extracting bundle ($(du -h "$BUNDLE" | cut -f1))..."
  rm -rf "$GAME_DIR" && mkdir -p "$GAME_DIR"
  tar --warning=no-unknown-keyword -xzf "$BUNDLE" -C "$GAME_DIR"
  rm -f "$BUNDLE"
  log "Extraction complete."
fi

# Wait for a bundle if nothing's on disk yet.
if [ ! -e "$SERVER_BIN" ]; then
  log "No server files yet. Waiting for bundle upload at $BUNDLE..."
  while [ ! -f "$BUNDLE" ]; do
    sleep 5
    shopt -s nullglob
    parts=("$BUNDLE_GLOB"*)
    shopt -u nullglob
    [ ${#parts[@]} -gt 0 ] && break
  done
  exec "$0"
fi

# Belt-and-suspenders: nuke macOS AppleDouble sidecars that crash Starbound on load.
# (Should never be present if the bundle was built with COPYFILE_DISABLE=1, but cheap to check.)
[ -d "$MODS_DIR" ] && find "$MODS_DIR" -maxdepth 1 -name '._*' -delete 2>/dev/null

# DepotDownloader on macOS doesn't preserve the +x bit on Linux binaries.
chmod +x "$SERVER_DIR"/starbound_server "$SERVER_DIR"/starbound \
         "$SERVER_DIR"/asset_packer "$SERVER_DIR"/asset_unpacker \
         "$SERVER_DIR"/dump_versioned_json "$SERVER_DIR"/make_versioned_json \
         "$SERVER_DIR"/planet_mapgen "$SERVER_DIR"/run-server.sh \
         "$SERVER_DIR"/run-client.sh 2>/dev/null || true

# Apply Starbound config overrides every boot so they survive regen.
cfg="$GAME_DIR/storage/starbound_server.config"
if [ -f "$cfg" ]; then
  python3 - "$cfg" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    cfg = json.load(f)
overrides = {"safeScripts": False, "allowAssetsMismatch": True}
if any(cfg.get(k) != v for k, v in overrides.items()):
    cfg.update(overrides)
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"Patched config: {overrides}", flush=True)
PY
fi

if [ "${SAFE_MODE:-0}" = "1" ]; then
  log "SAFE_MODE=1, sleeping instead of launching starbound. SSH in to debug."
  exec sleep infinity
fi

log "Starting starbound_server..."
touch /tmp/starbound_started
cd "$SERVER_DIR"
exec ./starbound_server
