import test from "node:test";
import assert from "node:assert/strict";
import { browserCommand } from "../../dashboard/launcher";

test("Dashboard browser commands are platform-specific", () => {
  const url = "http://127.0.0.1:30080/ui";
  const win = browserCommand("win32", url, { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
  assert.equal(win.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(win.args, ["/d", "/s", "/c", "start", "", url]);

  const mac = browserCommand("darwin", url, {});
  assert.deepEqual(mac, { file: "/usr/bin/open", args: ["-g", url] });

  const linux = browserCommand("linux", url, {});
  assert.deepEqual(linux, { file: "xdg-open", args: [url] });
});
