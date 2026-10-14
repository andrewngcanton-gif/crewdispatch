// claude-inbox-receiver.ts — a standalone native-inbox RECEIVER process used by
// the Claude boundary tests. It stands in for the Claude host ON THE WIRE ONLY:
// it accepts connections at a real Windows named pipe / Unix socket, records
// every received frame group (the newline-delimited JSON the transport sends)
// to a JSONL file, and then either closes the connection (default) or holds it
// open (--hold) so the sender's bounded timeout can be exercised.
//
// This process does NOT prove that a real Claude conversation observed a
// message; it proves the production transport reached a separate OS process
// with the exact expected frames.
//
// Usage: node claude-inbox-receiver.js <socket-path> <out-file> [--hold]
// Prints READY once listening.
import fs from "node:fs";
import net from "node:net";

const socketPath = process.argv[2] ?? "";
const outFile = process.argv[3] ?? "";
const hold = process.argv.includes("--hold");

if (!socketPath || !outFile) {
  process.stderr.write("usage: claude-inbox-receiver.js <socket-path> <out-file> [--hold]\n");
  process.exit(2);
}

let groups = 0;
// With allowHalfOpen the hold mode can keep the connection open after the
// sender's half-close (the default would auto-close it, making hold == accept).
const server = net.createServer({ allowHalfOpen: hold }, (socket) => {
  let buf = "";
  socket.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
  });
  socket.on("error", () => undefined);
  socket.on("end", () => {
    groups += 1;
    fs.appendFileSync(outFile, `${JSON.stringify({ group: groups, frames: buf })}\n`, "utf8");
    if (!hold) socket.end();
  });
});

server.on("error", (e: Error) => {
  process.stderr.write(`receiver error: ${String((e as Error)?.message || e)}\n`);
  process.exit(1);
});

server.listen(socketPath, () => {
  process.stdout.write("READY\n");
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
