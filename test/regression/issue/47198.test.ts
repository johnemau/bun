import { expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux } from "harness";

// JavaScriptCore reads the resident set size from /proc/self/statm after every
// collection. Bun 1.4.3 read it through one descriptor opened at startup. The
// WebKit merge in 1.4.4 switched the Linux build to a reader that opens, reads
// and closes the file on every call. The fixed build holds the descriptor
// again, so a process shows exactly one statm descriptor before user code runs
// and the same one after many collections.
test.skipIf(!isLinux)("JavaScriptCore keeps one /proc/self/statm descriptor across collections", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
      const fs = require("fs");
      const target = "/proc/" + process.pid + "/statm";
      const statmFds = () =>
        fs.readdirSync("/proc/self/fd").filter(fd => {
          try {
            return fs.readlinkSync("/proc/self/fd/" + fd) === target;
          } catch {
            return false;
          }
        });
      const before = statmFds();
      let keep = [];
      for (let i = 0; i < 30; i++) {
        keep.push(new Array(20000).fill(0).map((_, j) => ({ j, s: "x" + j })));
        if (keep.length > 5) keep.shift();
        Bun.gc(true);
      }
      const after = statmFds();
      console.log(JSON.stringify({ before, after }));
      `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stderr).toBe("");
  const { before, after } = JSON.parse(stdout);
  expect(before).toHaveLength(1);
  expect(after).toEqual(before);
  expect(exitCode).toBe(0);
});
