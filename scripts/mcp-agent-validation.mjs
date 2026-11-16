import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PostgresGatewayStore } from '../src/gateway/postgres-gateway-store.js';
import { startLiveGateway, requireLiveEnvironment } from './lib/live-gateway.mjs';
requireLiveEnvironment();
const root = await mkdtemp(path.join(tmpdir(),'partners-mcp-agent-'));
const run = randomUUID(), tenant = 'agent-live:' + run, token = randomUUID();
const evidence = { run, startedAt: new Date().toISOString(), client: 'codex-cli 0.169.0 / standard Streamable HTTP MCP', rounds: [], artifactBackend: process.env.S3_ENDPOINT ? 's3' : 'local' };
const store = new PostgresGatewayStore({ connectionString: process.env.MCP_TEST_POSTGRES_URL });
let gateway, verifier, threadId;
const allEvents = [];
async function runAgent(round, prompt) {
  const common = ['--approve-for-me','-c','approval_policy="on-request"','-c','mcp_servers.computer-use.enabled=false','-c','mcp_servers.node_repl.enabled=false','-c',`mcp_servers.partners.url="${gateway.url}/mcp"`,
    '-c','mcp_servers.partners.bearer_token_env_var="PARTNERS_ACCEPTANCE_TOKEN"'];
  const output = path.join(root,`round-${round}.md`);
  const args = round === 1 ? ['exec',...common,'--trust','--skip-git-repo-check','-C',root,'--json','-o',output,prompt]
    : ['exec',...common,'resume',threadId,'--skip-git-repo-check','--json','-o',output,prompt];
  const child = spawn('codex', args, { env: { ...process.env, PARTNERS_ACCEPTANCE_TOKEN: token }, stdio: ['ignore','pipe','pipe'] });
  let stdout = '', stderr = '', pending = '';
  child.stdout.on('data', data => {
    stdout += data; pending += data;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) try {
      const event = JSON.parse(line); allEvents.push(event);
      if (event.type === 'thread.started') threadId = event.thread_id;
      if (event.item?.type === 'mcp_tool_call' && event.type === 'item.completed') console.log(JSON.stringify({ round, tool: event.item.tool, status: event.item.status }));
    } catch {}
  });
  child.stderr.on('data', data => stderr += data);
  const timer = setTimeout(() => child.kill('SIGTERM'), 12 * 60 * 1000);
  const code = await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',resolve); }); clearTimeout(timer);
  await writeFile(path.join(root,`round-${round}.jsonl`), stdout, { mode: 0o600 });
  await writeFile(path.join(root,`round-${round}.stderr.log`), stderr, { mode: 0o600 });
  assert.equal(code,0,`Agent round ${round} failed; see ${root}`);
  const answer = await readFile(output,'utf8');
  evidence.rounds.push({ round, completedAt: new Date().toISOString(), answer });
  console.log(JSON.stringify({ round, status: 'completed', threadId }));
}
async function tool(name,args) {
  const r = await verifier.callTool({name,arguments:args});
  if (r.isError && name !== 'job_get') throw new Error(JSON.stringify(r.structuredContent));
  return r.structuredContent;
}
try {
  gateway = await startLiveGateway({root,tenant,token});
  const rule = `This is an explicitly authorized real MCP acceptance run against a CubeSandbox v0.8.0 VM. Use ONLY the partners MCP tools for filesystem and execution. Do not use host shell, web, local files, other servers or subagents. Do not delete the remote session until requested. Use one session throughout all three rounds. Tenant ${tenant}, project partners. Poll job_get until terminal and artifactRefs are present; SESSION_BUSY is retryable after previous job cleanup. Always report the exact sessionId/jobIds, exit codes, and artifact downloadPath values. Keep command outputs bounded. All remote files live under /workspace/slug-demo. This template has Python3 but NO git and no reliable package network: do not install packages or invoke git. Use a plain source fixture, preserve initial files in baseline/, and generate a real unified diff with Python stdlib difflib. MCP cwd must be relative, e.g. slug-demo or ., never /workspace.\n`;
  await runAgent(1,rule+`Round 1: Create one session. Build a tiny Python repository slug-demo with slugify.py exposing slugify(text), initially return text.lower().replace(' ', '-'). Add unittest baseline cases 'Hello World'→'hello-world' and '你好 世界'→'你好-世界'; run these passing baseline tests and copy the initial source/test files into baseline/ inside the VM. Then add a test requiring trim and collapse of repeated whitespace, including tabs, run tests and observe the expected failure. Diagnose it, but stop before fixing. Use file_ops at least once to inspect or edit an actual file, and bash_exec to run real tests. Return the diagnosis, failing output and IDs.`);
  assert.ok(threadId);
  const initialSessions = await store.listSessions({tenantId:tenant,limit:100});
  assert.equal(initialSessions.length,1,'Agent round 1 did not create a workspace; inspect MCP startup diagnostics');
  assert.notEqual(initialSessions[0].state,'deleted','Agent lost its workspace before round 2');
  await runAgent(2,rule+`Round 2: Continue the SAME remote session from round 1. Implement the whitespace fix based on that observed failure, add empty/whitespace-only and mixed whitespace tests, and run the complete unittest suite. Return the passing result and a unified diff from the preserved initial files using difflib. Do not create another session.`);
  await runAgent(3,rule+`Round 3: Continue the SAME remote session. Add a requirement that fullwidth 'Ｈｅｌｌｏ　Ｗｏｒｌｄ' normalizes to 'hello-world' (NFKC), while Chinese text is retained. First add the regression and run it to expose the failure, then implement the smallest fix and rerun all tests. Write final.diff and final-tests.log inside slug-demo, and print their content using bash_exec so the job's stdout artifact contains the diff, tests and log. Return final test results, full diff, and artifact downloadPath. Leave the session available for the harness to verify and clean.`);
  const sessions = await store.listSessions({tenantId:tenant,limit:100}); assert.equal(sessions.length,1); evidence.sessionId=sessions[0].id; evidence.remoteId=sessions[0].providerSessionId;
  const jobs=await store.listJobs({tenantId:tenant,limit:1000}); evidence.jobs=jobs.map(j=>({id:j.id,state:j.state,exitCode:j.exitCode}));
  assert.ok(jobs.some(j=>j.exitCode!==0&&j.exitCode!=null),'Agent must observe a real failed test');
  const calls=allEvents.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call');
  evidence.toolCalls=calls.map(e=>({server:e.item.server,tool:e.item.tool,status:e.item.status}));
  assert.ok(calls.some(e=>e.item.tool==='file_ops')); assert.ok(calls.filter(e=>e.item.tool==='bash_exec').length>=3);
  verifier=new Client({name:'partners-agent-verifier',version:'1'});
  await verifier.connect(new StreamableHTTPClientTransport(new URL(gateway.url+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  const final=await tool('bash_exec',{sessionId:evidence.sessionId,command:'cd slug-demo && python3 -m unittest -v && cat final.diff && cat final-tests.log',requestId:'verify-'+run});
  let result;
  for(let i=0;i<300;i++){result=await tool('job_get',{jobId:final.jobId,maxOutputBytes:65536});if(['succeeded','failed'].includes(result.state)&&result.artifactRefs?.length)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(result.state,'succeeded'); assert.match(result.stdout,/--- .*slugify\.py/); evidence.verifierJob=final.jobId;
  await writeFile(path.join(root,'final-verification.log'),result.stdout+'\n'+result.stderr);
  evidence.artifacts=[];
  for(const artifact of result.artifactRefs){const response=await fetch(gateway.url+artifact.downloadPath,{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,200);const content=await response.text();await writeFile(path.join(root,artifact.kind+'.log'),content);evidence.artifacts.push({id:artifact.artifactId??artifact.id,kind:artifact.kind,downloadPath:artifact.downloadPath,status:response.status});}
  evidence.timings = [];
  for (const job of jobs) {
    const events = await store.listJobEvents(job.id);
    const first = events.find(e => ['log.stdout','log.stderr'].includes(e.type));
    evidence.timings.push({jobId:job.id,firstOutputMs:first ? Date.parse(first.at)-Date.parse(job.createdAt) : null,totalMs:Date.parse(job.completedAt)-Date.parse(job.createdAt),state:job.state});
  }
  evidence.sessionCreation = (await store.listAuditRecords({tenantId:tenant,limit:1000})).filter(a=>a.action==='mcp.tool'&&a.metadata?.tool==='session_create').map(a=>({durationMs:a.metadata.durationMs,outcome:a.outcome}));
  evidence.status='passed';
}catch(error){evidence.status='failed';evidence.error=error.message;process.exitCode=1;}
finally{
  // Only sessions owned by this unique acceptance tenant can be cleaned.
  for(const s of await store.listSessions({tenantId:tenant,limit:100})){
    if(s.providerSessionId){const response=await fetch(process.env.CUBESANDBOX_ENDPOINT+'/sandboxes/'+s.providerSessionId,{method:'DELETE'});evidence.cleanupStatus=response.status;}
  }
  await verifier?.close().catch(()=>{});await gateway?.stop();await store.close();
  evidence.completedAt=new Date().toISOString();await writeFile(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({status:evidence.status,error:evidence.error,evidencePath:path.join(root,'evidence.json')}));
}
