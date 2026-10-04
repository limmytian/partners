import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * PtySession spawns an interactive pseudo-terminal session.
 * Primary: Uses python3 pty module with TIOCSWINSZ ioctl for true PTY allocation and window resizing.
 * Fallback: Spawns interactive shell (/bin/sh -i) with piped stdio if python3 is unavailable.
 */
export class PtySession extends EventEmitter {
  constructor({
    command = '/bin/sh',
    args = [],
    cwd = process.cwd(),
    env = {},
    cols = 80,
    rows = 24,
    usePty = true,
  } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.cols = Number.parseInt(cols, 10) || 80;
    this.rows = Number.parseInt(rows, 10) || 24;
    this.closed = false;
    this.isPty = false;

    this.#start(usePty);
  }

  #start(usePty) {
    if (usePty) {
      try {
        this.#startPythonPty();
        return;
      } catch (err) {
        // Fall back to piped spawn
      }
    }
    this.#startPipedSpawn();
  }

  #startPythonPty() {
    const pythonScript = `
import os, pty, sys, select, json, struct, termios, fcntl

cols = int(sys.argv[1])
rows = int(sys.argv[2])
cwd = sys.argv[3]
cmd = sys.argv[4]
cmd_args = sys.argv[5:]

try:
    os.chdir(cwd)
except Exception as e:
    sys.stderr.write(f"chdir error: {e}\\n")
    sys.stderr.flush()

master, slave = pty.openpty()
try:
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
except Exception:
    pass

pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    try:
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    except Exception:
        pass
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    exec_args = [cmd] + cmd_args
    os.execvp(cmd, exec_args)
else:
    os.close(slave)
    sys.stdout.buffer.write(b"__READY__\\n")
    sys.stdout.buffer.flush()
    in_buf = b""
    while True:
        r, _, _ = select.select([0, master], [], [])
        if master in r:
            try:
                data = os.read(master, 4096)
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            except OSError:
                break
        if 0 in r:
            try:
                chunk = os.read(0, 4096)
                if not chunk:
                    break
                in_buf += chunk
                while b"\\n" in in_buf:
                    line, in_buf = in_buf.split(b"\\n", 1)
                    if not line:
                        continue
                    try:
                        msg = json.loads(line.decode("utf-8"))
                        mtype = msg.get("type")
                        if mtype == "stdin":
                            data = msg.get("data", "")
                            if isinstance(data, str):
                                data = data.encode("utf-8")
                            os.write(master, data)
                        elif mtype == "resize":
                            r_rows = int(msg.get("rows", 24))
                            r_cols = int(msg.get("cols", 80))
                            try:
                                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r_rows, r_cols, 0, 0))
                            except Exception:
                                pass
                    except Exception:
                        # Direct raw input fallback
                        os.write(master, line + b"\\n")
            except OSError:
                break
    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else (status >> 8)
        sys.exit(code)
    except Exception:
        sys.exit(0)
`;

    const mergedEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      ...this.env,
    };

    const child = spawn('python3', [
      '-u',
      '-c',
      pythonScript,
      String(this.cols),
      String(this.rows),
      this.cwd,
      this.command,
      ...this.args,
    ], {
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    this.isPty = true;

    let ready = false;
    let leftover = '';

    child.stdout.on('data', (chunk) => {
      if (!ready) {
        const text = leftover + chunk.toString('utf8');
        const readyIdx = text.indexOf('__READY__\n');
        if (readyIdx !== -1) {
          ready = true;
          this.isReady = true;
          this.emit('ready');
          const remaining = text.slice(readyIdx + '__READY__\n'.length);
          if (remaining.length > 0) {
            this.emit('data', Buffer.from(remaining, 'utf8'));
          }
        } else {
          leftover = text;
        }
      } else {
        this.emit('data', chunk);
      }
    });

    child.stderr.on('data', (chunk) => {
      this.emit('stderr', chunk);
    });

    child.on('close', (code) => {
      this.closed = true;
      this.emit('close', code ?? 0);
    });

    child.on('error', (err) => {
      if (!ready) {
        // Fall back to piped spawn if python failed to launch
        this.#startPipedSpawn();
      } else {
        this.emit('error', err);
      }
    });
  }

  #startPipedSpawn() {
    this.isPty = false;
    const mergedEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      ...this.env,
    };

    const child = spawn(this.command, this.args.length > 0 ? this.args : ['-i'], {
      cwd: this.cwd,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;

    child.stdout.on('data', (chunk) => {
      this.emit('data', chunk);
    });

    child.stderr.on('data', (chunk) => {
      this.emit('data', chunk);
    });

    child.on('close', (code) => {
      this.closed = true;
      this.emit('close', code ?? 0);
    });

    child.on('error', (err) => {
      this.emit('error', err);
    });

    queueMicrotask(() => {
      this.isReady = true;
      this.emit('ready');
    });
  }

  write(data) {
    if (this.closed || !this.child?.stdin?.writable) return;
    if (this.isPty) {
      this.child.stdin.write(JSON.stringify({ type: 'stdin', data: String(data) }) + '\n');
    } else {
      this.child.stdin.write(data);
    }
  }

  resize(cols, rows) {
    this.cols = Number.parseInt(cols, 10) || this.cols;
    this.rows = Number.parseInt(rows, 10) || this.rows;
    if (this.closed || !this.child?.stdin?.writable) return;
    if (this.isPty) {
      this.child.stdin.write(JSON.stringify({ type: 'resize', cols: this.cols, rows: this.rows }) + '\n');
    }
  }

  kill(signal = 'SIGTERM') {
    if (this.closed || !this.child) return;
    this.child.kill(signal);
  }
}
