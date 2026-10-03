import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ExecutionMode, LocalSandboxProvider } from '../src/index.js';

test('runs an ephemeral interpreter job and copies artifacts out before cleanup', async () => {
  const provider = new LocalSandboxProvider();
  const events = [];
  const input = Buffer.from('hello').toString('base64');

  const result = await provider.runJob({
    executionMode: ExecutionMode.EphemeralInterpreter,
    inputs: {
      files: [{ path: 'input.txt', contentBase64: input }],
    },
    command: {
      argv: [
        process.execPath,
        '-e',
        "const fs=require('fs'); console.log(fs.readFileSync('input.txt','utf8')); fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/result.txt','ok');",
      ],
      cwd: '/workspace',
    },
    timeoutSeconds: 5,
    artifactPolicy: {
      collect: ['workspace:/workspace/out/result.txt'],
    },
  }, (event) => events.push(event));

  assert.equal(result.state, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);
  assert.ok(events.some((event) => event.type === 'log.stdout'));
  assert.ok(events.some((event) => event.type === 'job.final'));

  const artifact = result.artifacts.find((item) => item.name === 'result.txt');
  assert.ok(artifact);
  assert.equal(await readFile(artifact.localPath, 'utf8'), 'ok');
});

test('runs multiple jobs in a persistent workspace session', async () => {
  const provider = new LocalSandboxProvider();
  const session = await provider.createSession();

  await provider.runJob({
    executionMode: ExecutionMode.WorkspaceSession,
    sessionId: session.id,
    command: {
      argv: [process.execPath, '-e', "require('fs').writeFileSync('persist.txt','yes')"],
    },
    timeoutSeconds: 5,
  });

  const result = await provider.runJob({
    executionMode: ExecutionMode.WorkspaceSession,
    sessionId: session.id,
    command: {
      argv: [process.execPath, '-e', "console.log(require('fs').readFileSync('persist.txt','utf8'))"],
    },
    timeoutSeconds: 5,
  });

  assert.equal(result.state, 'succeeded');
  assert.match(result.stdout, /yes/);

  await provider.deleteSession(session.id);
  assert.equal(await provider.getSession(session.id), null);
});

test('keeps default local behavior while accepting the shared sandbox contract', async () => {
  const provider = new LocalSandboxProvider();
  const sandbox = {
    profile: 'local-tools',
    image: `registry.example/partners/local@sha256:${'a'.repeat(64)}`,
    init: { argv: ['/workspace/bootstrap.sh'], timeoutSeconds: 5 },
  };
  const session = await provider.createSession({ sandbox });
  assert.equal((await provider.getSession(session.id)).sandbox.profile, 'local-tools');

  const result = await provider.runJob({
    executionMode: ExecutionMode.EphemeralInterpreter,
    sandbox,
    command: { argv: [process.execPath, '-e', 'console.log("local")'] },
    timeoutSeconds: 5,
  });
  assert.equal(result.state, 'succeeded');
  await provider.deleteSession(session.id);
});
