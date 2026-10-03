import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ArtifactKind,
  ExecutionMode,
  JobState,
  SessionState,
  assertSandboxConfiguration,
  assertExecutionJobRequest,
  createEvent,
} from '../core/provider-contract.js';

export class LocalSandboxProvider {
  name = 'local';

  constructor(options = {}) {
    this.rootDir = options.rootDir ?? tmpdir();
    this.sessions = new Map();
    this.abortControllers = new Map();
    this.sequence = 0;
  }

  async createSession(request = {}) {
    assertSandboxConfiguration(request.sandbox);
    const id = request.id ?? `ses_${randomUUID()}`;
    const workspacePath = await mkdtemp(path.join(this.rootDir, 'partners-session-'));
    const session = {
      id,
      state: SessionState.Ready,
      executionMode: ExecutionMode.WorkspaceSession,
      provider: this.name,
      workspacePath,
      resources: request.resources ?? {},
      persistence: request.persistence ?? { kind: 'stopped' },
      ...(request.sandbox ? { sandbox: request.sandbox } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(id, session);
    return { ...session };
  }

  async getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await rm(session.workspacePath, { recursive: true, force: true });
    session.state = SessionState.Deleted;
    session.updatedAt = new Date().toISOString();
    this.sessions.delete(sessionId);
    return { ...session };
  }

  async runJob(request, onEvent = () => {}) {
    assertExecutionJobRequest(request);

    const jobId = request.id ?? `job_${randomUUID()}`;
    const controller = new AbortController();
    this.abortControllers.set(jobId, controller);

    let session = null;
    let workspacePath;
    let ephemeralWorkspace = false;
    const events = [];
    const emit = (type, payload = {}) => {
      const event = createEvent(type, { jobId, ...payload }, ++this.sequence);
      events.push(event);
      onEvent(event);
    };

    try {
      emit('job.state', { state: JobState.Preparing });

      if (request.executionMode === ExecutionMode.WorkspaceSession) {
        session = this.sessions.get(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }
        session.state = SessionState.Busy;
        session.updatedAt = new Date().toISOString();
        workspacePath = session.workspacePath;
      } else {
        workspacePath = await mkdtemp(path.join(this.rootDir, 'partners-job-'));
        ephemeralWorkspace = true;
      }

      await this.#writeInputs(workspacePath, request.inputs);
      await this.#cloneRepository(workspacePath, request, emit, controller.signal);

      emit('job.state', { state: JobState.Running });
      const run = await this.#runCommand({
        jobId,
        command: request.command ?? codeToCommand(request.code),
        workspacePath,
        timeoutSeconds: request.timeoutSeconds,
        signal: controller.signal,
        emit,
      });

      const artifacts = await this.#collectArtifacts({
        jobId,
        workspacePath,
        stdout: run.stdout,
        stderr: run.stderr,
        policy: request.artifactPolicy,
      });

      const state = run.timedOut
        ? JobState.TimedOut
        : run.cancelled
          ? JobState.Cancelled
          : run.exitCode === 0
            ? JobState.Succeeded
            : JobState.Failed;

      for (const artifact of artifacts) {
        emit('artifact.created', { artifact });
      }

      const result = {
        id: jobId,
        state,
        executionMode: request.executionMode,
        sessionId: request.sessionId ?? null,
        provider: this.name,
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
        artifacts,
        events,
        completedAt: new Date().toISOString(),
      };

      emit('job.final', {
        state,
        exitCode: run.exitCode,
        artifactCount: artifacts.length,
      });

      return result;
    } finally {
      this.abortControllers.delete(jobId);
      if (session && session.state !== SessionState.Deleted) {
        session.state = SessionState.Ready;
        session.updatedAt = new Date().toISOString();
      }
      if (ephemeralWorkspace) {
        await rm(workspacePath, { recursive: true, force: true });
      }
    }
  }

  async cancel(jobId, reason = 'cancelled') {
    const controller = this.abortControllers.get(jobId);
    if (!controller) {
      return;
    }
    controller.abort(new Error(reason));
  }

  async #writeInputs(workspacePath, inputs = {}) {
    for (const file of inputs.files ?? []) {
      const target = safeJoin(workspacePath, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      const content = file.contentBase64
        ? Buffer.from(file.contentBase64, 'base64')
        : Buffer.from(file.content ?? '');
      await writeFile(target, content);
    }
  }

  async #cloneRepository(workspacePath, request, emit, signal) {
    if (!request.repository?.url) {
      return;
    }

    const destination = request.repository.destination ?? 'repo';
    const argv = ['git', 'clone', request.repository.url, destination];
    if (request.repository.branch) {
      argv.splice(2, 0, '--branch', request.repository.branch);
    }

    await this.#runCommand({
      jobId: `clone_${randomUUID()}`,
      command: { argv, cwd: '.' },
      workspacePath,
      timeoutSeconds: request.repository.timeoutSeconds ?? 300,
      signal,
      emit,
    });
  }

  async #runCommand({ command, workspacePath, timeoutSeconds, signal, emit }) {
    const cwd = command.cwd ? safeJoin(workspacePath, command.cwd) : workspacePath;
    const childEnv = { ...process.env, ...(command.env ?? {}) };
    const child = spawn(command.argv[0], command.argv.slice(1), {
      cwd,
      env: childEnv,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutSeconds * 1000);

    signal.addEventListener('abort', () => {
      cancelled = true;
      child.kill('SIGTERM');
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      emit('log.stdout', { chunk });
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      emit('log.stderr', { chunk });
    });

    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', (error) => {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
          resolve(1);
          return;
        }
        reject(error);
      });
      child.once('close', (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timeout));

    return { exitCode, stdout, stderr, timedOut, cancelled };
  }

  async #collectArtifacts({ jobId, workspacePath, stdout, stderr, policy = {} }) {
    const artifactDir = await mkdtemp(path.join(this.rootDir, 'partners-artifacts-'));
    const artifacts = [];

    if (stdout) {
      artifacts.push(await writeArtifact(artifactDir, jobId, ArtifactKind.Stdout, 'stdout.txt', stdout));
    }
    if (stderr) {
      artifacts.push(await writeArtifact(artifactDir, jobId, ArtifactKind.Stderr, 'stderr.txt', stderr));
    }

    for (const item of policy.collect ?? []) {
      if (!item.startsWith('workspace:')) {
        continue;
      }

      const relative = item.slice('workspace:'.length);
      const source = safeJoin(workspacePath, relative);
      const sourceStat = await stat(source);
      const name = path.basename(source);
      const target = path.join(artifactDir, `${randomUUID()}-${name}`);

      if (sourceStat.isDirectory()) {
        await cp(source, target, { recursive: true });
        artifacts.push({
          id: `art_${randomUUID()}`,
          jobId,
          kind: ArtifactKind.DirectoryArchive,
          name,
          localPath: target,
          sizeBytes: 0,
          createdAt: new Date().toISOString(),
        });
      } else {
        await cp(source, target);
        artifacts.push({
          id: `art_${randomUUID()}`,
          jobId,
          kind: ArtifactKind.File,
          name,
          localPath: target,
          sizeBytes: sourceStat.size,
          createdAt: new Date().toISOString(),
        });
      }
    }

    return artifacts;
  }
}

function codeToCommand(code) {
  if (!code) {
    throw new TypeError('Missing command or code');
  }

  if (code.language === 'python') {
    return { argv: ['python3', '-c', code.source] };
  }
  if (code.language === 'javascript') {
    return { argv: [process.execPath, '-e', code.source] };
  }
  if (code.language === 'shell') {
    return { argv: ['bash', '-lc', code.source] };
  }

  throw new TypeError(`Unsupported code language: ${code.language}`);
}

async function writeArtifact(artifactDir, jobId, kind, name, content) {
  const localPath = path.join(artifactDir, `${randomUUID()}-${name}`);
  await writeFile(localPath, content);
  const bytes = Buffer.byteLength(content);
  return {
    id: `art_${randomUUID()}`,
    jobId,
    kind,
    name,
    localPath,
    sizeBytes: bytes,
    createdAt: new Date().toISOString(),
  };
}

function safeJoin(root, relativePath = '.') {
  const workspaceRelativePath = normalizeWorkspacePath(relativePath);
  const target = path.resolve(root, workspaceRelativePath);
  const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return target;
}

function normalizeWorkspacePath(input) {
  if (!input || input === '/' || input === '/workspace') {
    return '.';
  }
  if (input.startsWith('/workspace/')) {
    return input.slice('/workspace/'.length);
  }
  if (input.startsWith('/')) {
    return input.slice(1);
  }
  return input;
}
