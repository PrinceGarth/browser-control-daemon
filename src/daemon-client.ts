import * as net from "net";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import type {
  ExtensionMessage,
  BrowserTab,
  BrowserHistoryItem,
  ServerMessage,
  TabContentExtensionMessage,
  ScreenshotExtensionMessage,
} from "./common";
import { DaemonRequest, DaemonResponse, lineParser, logPath, socketPath } from "./protocol";

const EXTENSION_RESPONSE_TIMEOUT_MS = 1000;
// Capturing may foreground the tab, wait for it to paint, and transfer a large payload.
const SCREENSHOT_RESPONSE_TIMEOUT_MS = 10000;
const DAEMON_START_TIMEOUT_MS = 8000;
// Slack on top of the daemon's own timeout (plus its 5s extension-connect wait) so its error wins over ours.
const IPC_SLACK_MS = 7000;

interface InFlight {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

// Same method surface as upstream's BrowserAPI, but talks to the shared daemon.
export class BrowserAPI {
  private sock: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private nextId = 1;
  private inflight = new Map<number, InFlight>();

  async init() {
    await this.connect();
  }

  close() {
    this.sock?.destroy();
    this.sock = null;
  }

  async openTab(url: string): Promise<number | undefined> {
    return (await this.call({ cmd: "open-tab", url }, "opened-tab-id")).tabId;
  }

  async closeTabs(tabIds: number[]) {
    await this.call({ cmd: "close-tabs", tabIds }, "tabs-closed");
  }

  async getTabList(): Promise<BrowserTab[]> {
    return (await this.call({ cmd: "get-tab-list" }, "tabs")).tabs;
  }

  async getBrowserRecentHistory(searchQuery?: string): Promise<BrowserHistoryItem[]> {
    return (
      await this.call({ cmd: "get-browser-recent-history", searchQuery }, "history")
    ).historyItems;
  }

  async getTabContent(tabId: number, offset: number): Promise<TabContentExtensionMessage> {
    return this.call({ cmd: "get-tab-content", tabId, offset }, "tab-content");
  }

  async reorderTabs(tabOrder: number[]): Promise<number[]> {
    return (await this.call({ cmd: "reorder-tabs", tabOrder }, "tabs-reordered")).tabOrder;
  }

  async findHighlight(tabId: number, queryPhrase: string): Promise<number> {
    return (
      await this.call({ cmd: "find-highlight", tabId, queryPhrase }, "find-highlight-result")
    ).noOfResults;
  }

  async groupTabs(
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: string,
    groupTitle: string
  ): Promise<number> {
    return (
      await this.call(
        { cmd: "group-tabs", tabIds, isCollapsed, groupColor, groupTitle },
        "new-tab-group"
      )
    ).groupId;
  }

  async captureScreenshot(
    tabId: number,
    format: "jpeg" | "png",
    quality: number,
    scale: number
  ): Promise<ScreenshotExtensionMessage> {
    return this.call(
      { cmd: "capture-screenshot", tabId, format, quality, scale },
      "screenshot",
      SCREENSHOT_RESPONSE_TIMEOUT_MS
    );
  }

  private async call<T extends ExtensionMessage["resource"]>(
    message: ServerMessage,
    resource: T,
    timeoutMs: number = EXTENSION_RESPONSE_TIMEOUT_MS
  ): Promise<Extract<ExtensionMessage, { resource: T }>> {
    const sock = await this.connect();
    const id = this.nextId++;
    const result = await new Promise<ExtensionMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        reject(new Error("Timed out waiting for daemon"));
      }, timeoutMs + IPC_SLACK_MS);
      this.inflight.set(id, { resolve, reject, timer });
      const req: DaemonRequest = { id, message, timeoutMs };
      sock.write(JSON.stringify(req) + "\n");
    });
    if (result.resource !== resource) {
      throw new Error(`Resource mismatch: expected ${resource}, got ${result.resource}`);
    }
    return result as Extract<ExtensionMessage, { resource: T }>;
  }

  private connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    this.connecting ??= this.connectOrSpawn().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connectOrSpawn(): Promise<net.Socket> {
    let sock: net.Socket;
    try {
      sock = await tryConnect(socketPath());
    } catch {
      spawnDaemon();
      sock = await waitForDaemon();
    }
    sock.on("data", lineParser((res: DaemonResponse) => this.onResponse(res)));
    sock.on("error", () => {});
    sock.on("close", () => {
      if (this.sock === sock) this.sock = null;
      this.failAll(new Error("Lost connection to browser-control daemon"));
    });
    this.sock = sock;
    return sock;
  }

  private onResponse(res: DaemonResponse) {
    const entry = this.inflight.get(res.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.inflight.delete(res.id);
    if (res.ok) entry.resolve(res.result);
    else entry.reject(new Error(res.error));
  }

  private failAll(err: Error) {
    for (const [id, entry] of this.inflight) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.inflight.delete(id);
    }
  }
}

function tryConnect(p: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(p);
    s.once("connect", () => (s.removeAllListeners("error"), resolve(s)));
    s.once("error", reject);
  });
}

function spawnDaemon() {
  if (!process.env.EXTENSION_SECRET) {
    throw new Error(
      "Daemon is not running and EXTENSION_SECRET env var is missing. See the extension's options page."
    );
  }
  const log = fs.openSync(logPath(), "a");
  const child = spawn(process.execPath, [path.join(__dirname, "daemon.js")], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
}

async function waitForDaemon(): Promise<net.Socket> {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  for (;;) {
    try {
      return await tryConnect(socketPath());
    } catch (e) {
      if (Date.now() > deadline) {
        throw new Error(
          `Daemon did not start within ${DAEMON_START_TIMEOUT_MS}ms. See ${logPath()}`
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
