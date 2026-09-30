# browser-control-daemon

One daemon owns the Browser Control extension's WebSocket port (8089). Every Claude Code
session runs a thin stdio MCP shim that talks to the daemon over a private unix socket,
and starts the daemon in the background if it isn't running. Sessions are no longer
limited by the number of ports the extension is configured for.

```
claude session 1 ─ shim ─┐
claude session 2 ─ shim ─┼─ unix socket (0600) ─ daemon ─ ws://127.0.0.1:8089 ─ extension
claude session N ─ shim ─┘
```

## Setup
```
npm run build
claude mcp add browser-control -e EXTENSION_SECRET=<secret from extension options> -- node $PWD/dist/server.js
```
Extension: configure the single port 8089 (remove the extra ports / pool wrapper).

## Notes
- `EXTENSION_SECRET` / `EXTENSION_PORT` are read by the daemon at spawn time. To change them: `npm run stop`; the next tool call respawns it.
- Logs: `~/.local/state/browser-control-daemon/daemon.log`.
- Daemon requests use its own UUID correlation ids, so concurrent sessions can't collide.
- Tools are a copy of upstream `mcp-server/server.ts`; only the `BrowserAPI` import differs.
- Tests: `npm test` (needs unix-socket creation, so not inside the Claude Code sandbox).
- Stop the old per-session upstream server / port pool first: the daemon exits if 8089 is taken.

## Attribution
`src/server.ts` and `src/common/` are derived from
[eyalzh/browser-control-mcp](https://github.com/eyalzh/browser-control-mcp) (MIT, see `LICENSE`).
Use it with that project's Firefox extension.
