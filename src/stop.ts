import * as fs from "fs";
import { socketPath } from "./protocol";

const pidFile = socketPath() + ".pid";
try {
  const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
  process.kill(pid, "SIGTERM");
  console.log(`Stopped daemon (pid ${pid})`);
} catch {
  console.log("Daemon not running");
}
