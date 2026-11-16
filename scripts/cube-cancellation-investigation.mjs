import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CubeSandboxClient } from '../src/providers/cubesandbox-client.js';
if (!process.env.CUBESANDBOX_ENDPOINT || !process.env.CUBESANDBOX_PROXY_ENDPOINT) throw new Error('Real Cube endpoints required');
const root = await mkdtemp(path.join(tmpdir(), 'partners-cancel-investigation-'));
const evidence = { run: randomUUID(), startedAt: new Date().toISOString(), timebox: 'up to half an effective workday; stop once a decisive counterexample exists', cases: [] };
const client = new CubeSandboxClient(); let sandbox;
const pause = ms => new Promise(r => setTimeout(r, ms));
const frame = value => { const data = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(5); head.writeUInt32BE(data.length, 1); return Buffer.concat([head, data]); };
async function rpc(method, value, { streaming = false, deadline } = {}) {
  return fetch(`${client.proxyEndpoint}/sandbox/${sandbox.id}/49983/process.Process/${method}`, { method: 'POST',
    headers: { Authorization: 'Basic cm9vdDo=', 'Content-Type': streaming ? 'application/connect+json' : 'application/json', 'Connect-Protocol-Version': '1', ...(deadline ? { 'Connect-Timeout-Ms': String(deadline) } : {}) },
    body: streaming ? frame(value) : JSON.stringify(value), signal: AbortSignal.timeout(15000) });
}
async function start(argv, deadline) {
  const response = await rpc('Start', { process: { cmd: argv[0], args: argv.slice(1), cwd: '/workspace', envs: {} } }, { streaming: true, deadline });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); let buffered = Buffer.alloc(0), pid; const events = [];
  let started; const ready = new Promise(r => started = r);
  const completed = (async () => {
    try { while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffered = Buffer.concat([buffered, Buffer.from(value)]);
      while (buffered.length >= 5 && buffered.length >= 5 + buffered.readUInt32BE(1)) {
        const length = buffered.readUInt32BE(1), message = JSON.parse(buffered.subarray(5,5+length).toString()); buffered = buffered.subarray(5+length);
        events.push(message);
        if (message.event?.start?.pid != null) { pid = message.event.start.pid; started(pid); }
      }
    } } catch (error) { events.push({ transportError: error.name }); }
  })();
  await Promise.race([ready, pause(5000).then(() => { if (!pid) throw new Error('No process start PID'); })]);
  return { pid, events, completed, disconnect: () => reader.cancel().catch(() => {}) };
}
async function exec(argv) { return client.exec(sandbox.id, { argv, cwd: '/workspace', timeoutSeconds: 10 }); }
async function status(label) {
  const code = `import json,os,time\np='/workspace/${label}'\nr={}\nfor n in ['parent','child','grandchild']:\n try:\n  pid=int(open(p+'-'+n+'.pid').read()); alive=os.path.exists('/proc/'+str(pid)); r[n]={'pid':pid,'alive':alive,'heartbeat':os.stat(p+'-'+n+'.beat').st_mtime_ns}\n except Exception as e:r[n]={'error':type(e).__name__}\nprint(json.dumps(r))`;
  return JSON.parse((await exec(['python3','-c',code])).stdout);
}
function tree(label) {
  const prefix = '/workspace/' + label;
  const leaf = `import os,signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(prefix+'-grandchild.pid')},'w').write(str(os.getpid()))\nwhile True:\n open(${JSON.stringify(prefix+'-grandchild.beat')},'w').write(str(time.time_ns()));time.sleep(.1)`;
  const child = `import os,signal,time,subprocess\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(prefix+'-child.pid')},'w').write(str(os.getpid()))\nsubprocess.Popen(['python3','-c',${JSON.stringify(leaf)}],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nwhile True:\n open(${JSON.stringify(prefix+'-child.beat')},'w').write(str(time.time_ns()));time.sleep(.1)`;
  return `import os,signal,time,subprocess\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(prefix+'-parent.pid')},'w').write(str(os.getpid()))\nsubprocess.Popen(['python3','-c',${JSON.stringify(child)}],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nwhile True:\n open(${JSON.stringify(prefix+'-parent.beat')},'w').write(str(time.time_ns()));time.sleep(.1)`;
}
try {
  sandbox = await client.createSandbox(); evidence.sandboxId = sandbox.id;
  const process = await start(['python3','-c',tree('signal')]); await pause(600);
  const before = await status('signal');
  const term = await rpc('SendSignal', { process: { pid: process.pid }, signal: 'SIGNAL_SIGTERM' }); await term.body?.cancel();
  await pause(400); const afterTerm = await status('signal');
  const kill = await rpc('SendSignal', { process: { pid: process.pid }, signal: 'SIGNAL_SIGKILL' }); await kill.body?.cancel();
  await pause(500); const afterKill = await status('signal');
  const repeated = await rpc('SendSignal', { process: { pid: process.pid }, signal: 'SIGNAL_SIGKILL' }); await repeated.body?.cancel();
  await pause(300); const later = await status('signal');
  evidence.cases.push({ name: 'term-resistant-detached-descendants', pid: process.pid, termStatus: term.status, killStatus: kill.status, repeatedKillStatus: repeated.status, before, afterTerm, afterKill, later });
  assert.ok(afterTerm.parent.heartbeat > before.parent.heartbeat);
  const survivors = ['child','grandchild'].filter(n => later[n].heartbeat > afterKill[n].heartbeat);
  evidence.survivingDescendants = survivors;
  await process.disconnect();
  const detached = await start(['python3','-c',tree('disconnect')]); await pause(400); await detached.disconnect();
  const disconnectedBefore = await status('disconnect'); await pause(400); const disconnectedAfter = await status('disconnect');
  evidence.cases.push({ name: 'transport-disconnect', before: disconnectedBefore, after: disconnectedAfter, processContinues: disconnectedAfter.parent.heartbeat > disconnectedBefore.parent.heartbeat });
  const deadline = await start(['python3','-c',tree('deadline')], 1000); await pause(1500); await deadline.disconnect();
  const deadlineBefore = await status('deadline'); await pause(400); const deadlineAfter = await status('deadline');
  evidence.cases.push({ name: 'connect-deadline', before: deadlineBefore, after: deadlineAfter, processContinues: deadlineAfter.parent.heartbeat > deadlineBefore.parent.heartbeat, events: deadline.events.filter(e => e.error || e.transportError) });
  const writeRead = await exec(['python3','-c',"from pathlib import Path;p=Path('/workspace/reuse.txt');p.write_text('取消后仍可读写');print(p.read_text())"]);
  assert.equal(writeRead.exitCode, 0); assert.match(writeRead.stdout, /取消后仍可读写/);
  evidence.workspaceReusable = true;
  evidence.conclusion = survivors.length ? 'NO-GO: killing the selected envd process does not stop detached descendants; retain sandbox destruction' : 'INCONCLUSIVE: no detached survivor observed; more process-tree evidence required';
  evidence.status = 'completed';
} catch (error) { evidence.status = 'failed'; evidence.error = error.message; process.exitCode = 1; }
finally {
  if (sandbox) { await client.deleteSandbox(sandbox.id); await assert.rejects(client.getSandbox(sandbox.id)); evidence.cleanup = 'sandbox deletion confirmed'; }
  evidence.completedAt = new Date().toISOString(); await writeFile(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({ status: evidence.status, conclusion: evidence.conclusion, error: evidence.error, evidencePath: path.join(root,'evidence.json') }));
}
