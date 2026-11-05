#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
public_url="${PUBLIC_URL:?Set PUBLIC_URL to your private Tailscale Serve URL}"
app_dir="$data_home/excalidraw-workspace-app"
backup_dir="$data_home/excalidraw-backups/$(date +%Y%m%d-%H%M%S)"
release_dir="$app_dir/releases/$(date +%Y%m%d-%H%M%S)"
node_path="$(command -v node)"

test -f "$project_dir/dist/index.html"
test -f "$data_home/excalidraw-mcp/source/dist/server.js"
mkdir -p "$backup_dir" "$release_dir"
chmod 700 "$backup_dir"
if test -f "$config_home/systemd/user/excalidraw.service"; then
  cp "$config_home/systemd/user/excalidraw.service" "$backup_dir/"
fi
if test -f "$config_home/systemd/user/excalidraw-canvas.service"; then
  cp "$config_home/systemd/user/excalidraw-canvas.service" "$backup_dir/"
fi
tailscale serve status --json > "$backup_dir/tailscale-serve.json"
# Checkpoints are atomically published and image blobs are immutable. Read the
# checkpoint first, then retain every blob it can reference in this backup.
mkdir -p "$backup_dir/original-data"
if test -f "$data_home/excalidraw-mcp/data/canvas-state-v1.json"; then
  cp -a "$data_home/excalidraw-mcp/data/canvas-state-v1.json" "$backup_dir/original-data/"
fi
if test -d "$data_home/excalidraw-mcp/data/blobs"; then
  cp -a "$data_home/excalidraw-mcp/data/blobs" "$backup_dir/original-data/"
fi
if test -d "$data_home/excalidraw-workspace"; then
  cp -a "$data_home/excalidraw-workspace" "$backup_dir/workspace-data"
fi

cp "$project_dir/package.json" "$project_dir/package-lock.json" "$app_dir/"
npm ci --prefix "$app_dir" --omit=dev --ignore-scripts
cp -a "$project_dir/server" "$project_dir/dist" "$release_dir/"
ln -sfn "$release_dir" "$app_dir/current"

mkdir -p "$config_home/systemd/user"
cat > "$config_home/systemd/user/excalidraw-workspace.service" <<EOF
[Unit]
Description=Saved Excalidraw canvases and MCP workspace
After=network.target excalidraw-canvas.service
Wants=excalidraw-canvas.service

[Service]
Type=simple
WorkingDirectory=$app_dir
ExecStart=$node_path $app_dir/current/server/index.mjs
Environment=NODE_ENV=production
Environment=PORT=9124
Environment=PUBLIC_URL=$public_url
Environment=CANVAS_WORKSPACE_DATA=$data_home/excalidraw-workspace
Environment=CANVAS_ENGINE_SOURCE=$data_home/excalidraw-mcp/source
Environment=ORIGINAL_CANVAS_URL=http://127.0.0.1:9123
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable excalidraw-workspace.service
systemctl --user restart excalidraw-workspace.service
for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:9124/workspace-health > /dev/null; then
    tailscale serve --bg --https=9445 http://127.0.0.1:9124
    tailscale serve --bg --https=9446 http://127.0.0.1:9124
    printf 'Workspace deployed. Backup: %s\n' "$backup_dir"
    exit 0
  fi
  sleep 0.2
done
printf 'Workspace did not become healthy; existing Tailscale routes were retained.\n' >&2
exit 1
