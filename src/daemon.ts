#!/usr/bin/env node
import WebSocket from "ws";
import * as net from "net";
import * as fs from "fs";
import * as crypto from "crypto";
import type {
  ExtensionMessage,
  ExtensionError,
  ServerMessage,
  ServerMessageRequest,
} from "./common";
import {
  DaemonRequest,
  DaemonResponse,
  WS_DEFAULT_PORT,
  lineParser,
  socketPath,
} from "./protocol";

const EXTENSION_CONNECT_WAIT_MS = 5000;

interface Pending {
  resource?: string;
  resolve: (value: ExtensionMessage) => void;
  reject: (reason: string) => void;
  timer: NodeJS.Timeout;
}

// Owns the single extension WebSocket and multiplexes requests from any number of shims.
// Correlation ids are generated here, so concurrent sessions can never collide.
export class ExtensionBridge {
  private ws: WebSocket | null = null;
  private wsServers: WebSocket.Server[] = [];
  private pending = new Map<string, Pending>();
  private connectWaiters = new Set<() => void>();

  constructor(private readonly secret: string, private readonly port: number) {}

  async listen() {
    // Loopback only, on both families, so Firefox connects however it resolves "localhost".
    const hosts = process.env.CONTAINERIZED ? ["0.0.0.0"] : ["127.0.0.1", "::1"];
    for (const host of hosts) {
      const server = new WebSocket.Server({ host, port: this.port });
      // Wait for bind so EADDRINUSE surfaces (the port acts as the daemon singleton lock).
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      console.error(`WebSocket server listening on ${host}:${this.port}`);
      server.on("error", (e) => console.error(`WebSocket error on ${host}:`, e));
      server.on("connection", (conn) => this.onConnection(conn));
      this.wsServers.push(server);
    }
  }

  close() {
    this.wsServers.forEach((s) => s.close());
    this.wsServers = [];
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // The extension retries every ~2s, so right after the daemon autostarts (or the
  // extension reloads) the first request must wait for it instead of failing.
  private waitForExtension(maxMs: number): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.connectWaiters.delete(waiter);
        resolve(false);
      }, maxMs);
      this.connectWaiters.add(waiter);
    });
  }

  async request(message: ServerMessage, timeoutMs: number): Promise<ExtensionMessage> {
    if (!(await this.waitForExtension(EXTENSION_CONNECT_WAIT_MS))) {
      throw "Browser extension is not connected to the daemon";
    }
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject("Browser extension disconnected");
        return;
      }
      const correlationId = crypto.randomUUID();
      const req: ServerMessageRequest = { ...message, correlationId };
      const payload = JSON.stringify(req);
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject("Timed out waiting for response");
      }, timeoutMs);
      this.pending.set(correlationId, { resolve, reject, timer });
      this.ws.send(
        JSON.stringify({ payload: req, signature: this.sign(payload) })
      );
    });
  }

  private onConnection(conn: WebSocket) {
    // Latest extension connection wins (e.g. after an extension reload).
    this.ws = conn;
    console.error("Extension connected");
    for (const w of [...this.connectWaiters]) {
      this.connectWaiters.delete(w);
      w();
    }
    conn.on("close", () => {
      if (this.ws === conn) {
        this.ws = null;
        console.error("Extension disconnected");
        this.failAll("Browser extension disconnected");
      }
    });
    conn.on("message", (raw) => {
      let decoded: any;
      try {
        decoded = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (isErrorMessage(decoded)) {
        this.settle(decoded.correlationId)?.reject(decoded.errorMessage);
        return;
      }
      if (this.sign(JSON.stringify(decoded.payload)) !== decoded.signature) {
        console.error("Invalid message signature");
        return;
      }
      const msg: ExtensionMessage = decoded.payload;
      this.settle(msg.correlationId)?.resolve(msg);
    });
  }

  private settle(correlationId: string) {
    const p = this.pending.get(correlationId);
    if (!p) return undefined; // late or unknown response; upstream would crash here
    clearTimeout(p.timer);
    this.pending.delete(correlationId);
    return p;
  }

  private failAll(reason: string) {
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(reason);
  }

  private sign(payload: string) {
    return crypto.createHmac("sha256", this.secret).update(payload).digest("hex");
  }
}

function isErrorMessage(m: any): m is ExtensionError {
  return m.errorMessage !== undefined && m.correlationId !== undefined;
}

// Serves shims on the unix socket. If a stale socket file exists, removes it; if a live
// daemon answers on it, exits quietly.
export async function listenForShims(
  bridge: ExtensionBridge,
  sockPath: string
): Promise<net.Server> {
  const server = net.createServer((sock) => {
    const send = (r: DaemonResponse) => {
      if (!sock.destroyed) sock.write(JSON.stringify(r) + "\n");
    };
    sock.on("error", () => {});
    sock.on(
      "data",
      lineParser((req: DaemonRequest) => {
        bridge.request(req.message, req.timeoutMs).then(
          (result) => send({ id: req.id, ok: true, result }),
          (error) => send({ id: req.id, ok: false, error: String(error) })
        );
      })
    );
  });

  const tryListen = () =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

  try {
    await tryListen();
  } catch (e: any) {
    if (e.code !== "EADDRINUSE") throw e;
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.connect(sockPath);
      probe.once("connect", () => (probe.destroy(), resolve(true)));
      probe.once("error", () => resolve(false));
    });
    if (alive) throw new Error("Another daemon is already serving " + sockPath);
    fs.rmSync(sockPath, { force: true });
    await tryListen();
  }
  fs.chmodSync(sockPath, 0o600);
  console.error("Listening for MCP shims on", sockPath);
  return server;
}

async function main() {
  const secret = process.env.EXTENSION_SECRET;
  if (!secret) {
    throw new Error("EXTENSION_SECRET env var missing. See the extension's options page.");
  }
  const port = process.env.EXTENSION_PORT
    ? parseInt(process.env.EXTENSION_PORT, 10)
    : WS_DEFAULT_PORT;

  const bridge = new ExtensionBridge(secret, port);
  await bridge.listen();
  const sockPath = socketPath();
  const server = await listenForShims(bridge, sockPath);
  fs.writeFileSync(sockPath + ".pid", String(process.pid));

  const shutdown = () => {
    server.close();
    bridge.close();
    fs.rmSync(sockPath, { force: true });
    fs.rmSync(sockPath + ".pid", { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Daemon failed to start:", err.message ?? err);
    process.exit(1);
  });
}
