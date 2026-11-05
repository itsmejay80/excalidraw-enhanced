# Canvas workspace

A self-hosted library of named Excalidraw drawings. Each canvas has a permanent
`/c/<id>` URL, its own saved scene, images, snapshots, and live browser updates.
Create, rename, search, import, archive, and restore drawings. Browser edits
save automatically; leaving the editor flushes pending changes. A shared
light/dark switch works in both the library and the compact canvas header.

## Run locally

Requires Node.js 22 or newer, npm, and a built copy of the durable canvas engine:

```bash
git clone https://github.com/yctimlin/mcp_excalidraw.git "$HOME/.local/share/excalidraw-mcp/source"
cd "$HOME/.local/share/excalidraw-mcp/source"
git checkout 66b768b
npm ci
npm run build
```

From this repository's `canvas-workspace` directory:

```bash
npm ci
npm run build
INCLUDE_ORIGINAL=0 npm start
```

Open `http://127.0.0.1:9124`. The published engine npm package 2.1.2 does not
contain the durable-state implementation; use the pinned source build above.
The editor and utilities under `frontend/vendor/` are adapted from that revision
under the accompanying MIT license. The engine source needs no modifications.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `PORT` | `9124`, bound to loopback |
| `PUBLIC_URL` | `http://127.0.0.1:<PORT>`; set to the URL clients use when proxying |
| `XDG_DATA_HOME` | `~/.local/share`; base for default storage paths |
| `CANVAS_WORKSPACE_DATA` | `$XDG_DATA_HOME/excalidraw-workspace` |
| `CANVAS_ENGINE_SOURCE` | `$XDG_DATA_HOME/excalidraw-mcp/source` |
| `INCLUDE_ORIGINAL` | Set `0` for a fresh installation; otherwise includes a legacy canvas |
| `ORIGINAL_CANVAS_URL` | `http://127.0.0.1:9123`, if integrating an existing engine |
| `LEGACY_EDITOR_DIST` | `$XDG_DATA_HOME/excalidraw`, assets for migrating an older browser installation |

The gateway starts isolated engine workers as canvases are opened. At most
eight workers can be resident simultaneously; inactive workers are evicted
without deleting saved data. Open tabs and in-flight requests are not evicted.
Any number of canvas records can be saved.

## Private deployment

The server does not implement authentication. Keep it on loopback or behind a
private authenticated network/proxy. A public source repository does not make
a running canvas server public.

For an existing Linux systemd installation with the original canvas service and
Tailscale installed, `scripts/deploy-local.sh` creates a versioned release,
backs up previous state/configuration, and points Tailscale Serve ports
9445 and 9446 to the workspace. It reads `XDG_DATA_HOME` and `XDG_CONFIG_HOME`
and requires your private URL explicitly:

```bash
PUBLIC_URL=https://your-machine.your-tailnet.ts.net:9445 bash scripts/deploy-local.sh
```

The script uses Serve without enabling Funnel. For a fresh deployment, use
the local run instructions and your own process manager/proxy configuration.

## MCP clients

Connect a locally running MCP client to your workspace's `/mcp` endpoint:

```bash
codex mcp add excalidraw --url http://127.0.0.1:9124/mcp
```

For Claude Code:

```bash
claude mcp add --transport http --scope user excalidraw http://127.0.0.1:9124/mcp
```

For another machine, replace the loopback URL with your private deployment URL.
Start a new client session. Use `create_canvas` or `list_canvases` to obtain a
canvas ID and browser URL. Drawing tools require `canvasId`; clients cannot
accidentally change a global selected canvas. `rename_canvas` and `get_canvas`
are also available. Legacy `/api/*` clients continue editing the original
canvas when it is enabled.

A private network URL is not reachable by cloud connectors. Those require a
separate authenticated endpoint or tunnel.

## Data and recovery

- `canvases.json` holds versioned names, timestamps, and archive state, written
  atomically with fsync. Invalid existing catalogs stop startup.
- Each UUID directory contains the engine's durable checkpoint, immutable image
  blobs, snapshots, and worker logs. Canvas names never become filesystem paths.
- PNG previews are regenerable. Archiving only changes library visibility.
- The legacy editor's service worker is retired without clearing localStorage
  or IndexedDB. Its previous browser drawing can be imported with its images;
  the source browser data is retained.

Back up workspace data and any original engine data. Stop the services while
copying them for a consistent backup. Keep backups outside this repo.
To roll back a scripted deployment, repoint the app's `current` symlink to a
previous release and restart `excalidraw-workspace.service`.

## Verification

```bash
npm test
```

Tests use temporary data and loopback servers. They verify MCP discovery,
canvas/scene/image/snapshot isolation, restart recovery, cross-origin rejection,
and browser create/edit/navigation/import flows. Browser tests use
`/usr/bin/chromium` or `CHROMIUM_PATH` and cover desktop/mobile layouts,
light/dark theme persistence, system-theme changes, and the compact header.
They do not mutate production drawings.
