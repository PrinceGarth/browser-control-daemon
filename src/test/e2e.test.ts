import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import WebSocket from "ws";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bcd-"));
const SECRET = "test-secret";
const PORT = 18089;
process.env.EXTENSION_SECRET = SECRET;
process.env.EXTENSION_PORT = String(PORT);
process.env.BROWSER_CONTROL_DAEMON_SOCKET = path.join(dir, "d.sock");
process.env.BROWSER_CONTROL_DAEMON_LOG = path.join(dir, "d.log");

const sign = (p: string) => crypto.createHmac("sha256", SECRET).update(p).digest("hex");

test("many shims share one daemon and one extension connection", async () => {
  const { BrowserAPI } = await import("../daemon-client");
  const shims = Array.from({ length: 5 }, () => new BrowserAPI());
  try {
    // Race: all five try to autostart the daemon at once.
    await Promise.all(shims.map((s) => s.init()));

    // Fake extension: answers get-tab-list with a tab whose title echoes a delay-ordered id.
    const ext = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r) => ext.once("open", r));
    let connections = 0;
    ext.on("message", (raw) => {
      connections++;
      const { payload, signature } = JSON.parse(raw.toString());
      assert.equal(signature, sign(JSON.stringify(payload)));
      const reply = {
        resource: "tabs",
        correlationId: payload.correlationId,
        tabs: [{ id: 1, title: payload.correlationId, url: "x", active: false }],
      };
      // Reverse-ish ordering: random delay proves correlation, not arrival order.
      setTimeout(
        () => ext.send(JSON.stringify({ payload: reply, signature: sign(JSON.stringify(reply)) })),
        Math.random() * 50
      );
    });

    const results = await Promise.all(shims.flatMap((s) => [s.getTabList(), s.getTabList()]));
    assert.equal(results.length, 10);
    assert.equal(connections, 10);
    assert.equal(new Set(results.map((r) => r[0].title)).size, 10); // distinct correlation ids

    // Extension errors propagate to the right caller.
    ext.removeAllListeners("message");
    ext.on("message", (raw) => {
      const { payload } = JSON.parse(raw.toString());
      ext.send(JSON.stringify({ correlationId: payload.correlationId, errorMessage: "boom" }));
    });
    await assert.rejects(shims[0].getTabList(), /boom/);

    // Extension gone -> request waits for reconnect; one arriving ~1.5s later succeeds.
    ext.close();
    await new Promise((r) => setTimeout(r, 100));
    const late = shims[1].getTabList();
    await new Promise((r) => setTimeout(r, 1500));
    const ext2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r) => ext2.once("open", r));
    ext2.on("message", (raw) => {
      const { payload } = JSON.parse(raw.toString());
      const reply = { resource: "tabs", correlationId: payload.correlationId, tabs: [] };
      ext2.send(JSON.stringify({ payload: reply, signature: sign(JSON.stringify(reply)) }));
    });
    assert.deepEqual(await late, []);

    // Extension gone for good -> clear error after the wait.
    ext2.close();
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(shims[1].getTabList(), /not connected/);

    // Exactly one daemon process.
    const pid = parseInt(fs.readFileSync(process.env.BROWSER_CONTROL_DAEMON_SOCKET + ".pid", "utf8"));
    assert.ok(pid > 0);
    process.kill(pid, 0);
  } finally {
    shims.forEach((s) => s.close());
    try {
      process.kill(parseInt(fs.readFileSync(process.env.BROWSER_CONTROL_DAEMON_SOCKET + ".pid", "utf8")), "SIGTERM");
    } catch {}
  }
});
