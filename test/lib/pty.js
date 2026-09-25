"use strict";

const { spawnSync } = require("child_process");

// 开一个 pty 把命令放进去：自己的 stdin 原样写进终端，终端吐的原样打到 stdout。
// Node 这边写一次，终端那头就是一块——粘贴、输入法上屏就是这么来的
// cli-pty 和 perm-gate 都用：「终端前有没有人」是看 stdin 是不是终端，管道冒充不了
const BRIDGE = `
import os, pty, sys, select, signal, struct, fcntl, termios
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
signal.signal(signal.SIGTERM, lambda *a: (os.kill(pid, 9), os._exit(1)))
src = [fd, 0]
while True:
    r, _, _ = select.select(src, [], [])
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        os.write(1, d)
    if 0 in r:
        d = os.read(0, 65536)
        if d: os.write(fd, d)
        else: src = [fd]
_, st = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1)
`;

function havePty() {
  if (process.platform === "win32") return false;
  const r = spawnSync("python3", ["-c", "import pty, termios, fcntl"], { stdio: "ignore", timeout: 10000 });
  return r.status === 0;
}

module.exports = { BRIDGE, havePty };
