import { spawn } from 'node:child_process';
export async function startLiveGateway({ root, tenant, token, scopes = '*', extraEnv = {} }) {
  const env = { PATH: process.env.PATH, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_PROVIDER: 'cubesandbox',
    GATEWAY_MCP_ENABLED: '1', GATEWAY_STORE: 'postgres', POSTGRES_URL: process.env.MCP_TEST_POSTGRES_URL,
    CUBESANDBOX_ENDPOINT: process.env.CUBESANDBOX_ENDPOINT, CUBESANDBOX_PROXY_ENDPOINT: process.env.CUBESANDBOX_PROXY_ENDPOINT,
    GATEWAY_SERVICE_TOKEN: token, GATEWAY_TENANT_IDS: tenant, GATEWAY_PROJECT_IDS: 'partners', GATEWAY_SERVICE_SCOPES: scopes,
    GATEWAY_SERVICE_TOKEN_REF: tenant, GATEWAY_WORK_ROOT: root, GATEWAY_ARTIFACT_ROOT: root + '/artifacts', ...extraEnv };
  for (const key of ['CUBESANDBOX_API_KEY','CUBESANDBOX_TEMPLATE_ID','S3_ENDPOINT','S3_BUCKET','S3_REGION','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY']) if (process.env[key]) env[key] = process.env[key];
  if (env.S3_ENDPOINT) { env.GATEWAY_ARTIFACT_STORE = 's3'; env.S3_PREFIX = 'v015-validation/' + tenant; }
  const child = spawn(process.execPath, ['scripts/gateway-service.mjs'], { cwd: process.cwd(), env, stdio: ['ignore','pipe','pipe'] });
  let errors = ''; child.stderr.on('data', data => errors += data);
  const port = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Gateway startup deadline')); }, 15000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Gateway startup failed')); });
    child.stdout.on('data', data => { output += data; for (const line of output.split('\n')) try { const row = JSON.parse(line); if (row.message === 'gateway started') { clearTimeout(timer); resolve(row.port); } } catch {} });
  });
  return { child, url: `http://127.0.0.1:${port}`, errors: () => errors,
    async stop() { if (child.exitCode == null && child.signalCode == null) { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); } } };
}
export function requireLiveEnvironment() {
  for (const key of ['CUBESANDBOX_ENDPOINT','CUBESANDBOX_PROXY_ENDPOINT','MCP_TEST_POSTGRES_URL']) if (!process.env[key]) throw new Error(`${key} is required; use an isolated database`);
}
