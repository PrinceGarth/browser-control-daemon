import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { ServerMessage } from "./common";

// Wire protocol between MCP shims and the daemon: newline-delimited JSON over a unix socket.
export interface DaemonRequest {
  id: number;
  message: ServerMessage;
  timeoutMs: number;
}

export type DaemonResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export const WS_DEFAULT_PORT = 8089;

function stateDir(): string {
  const base =
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  const dir = path.join(base, "browser-control-daemon");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function socketPath(): string {
  if (process.env.BROWSER_CONTROL_DAEMON_SOCKET) {
    return process.env.BROWSER_CONTROL_DAEMON_SOCKET;
  }
  // Unix socket paths are limited to ~104 bytes, so prefer the short runtime dir.
  const runtime = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  return path.join(runtime, `browser-control-daemon-${os.userInfo().uid}.sock`);
}

export function logPath(): string {
  return process.env.BROWSER_CONTROL_DAEMON_LOG ?? path.join(stateDir(), "daemon.log");
}

// Splits a stream into complete newline-delimited JSON values.
export function lineParser(onValue: (value: any) => void) {
  let buf = "";
  return (chunk: Buffer | string) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onValue(JSON.parse(line));
      } catch (e) {
        console.error("Dropping malformed line:", e);
      }
    }
  };
}
