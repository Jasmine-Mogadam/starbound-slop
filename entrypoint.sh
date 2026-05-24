#!/bin/bash
set -euo pipefail

STARBOUND_DIR=${STARBOUND_DIR:-/opt/starbound}

mkdir -p "$STARBOUND_DIR/storage"
exec "$STARBOUND_DIR/linux64/starbound_server"
