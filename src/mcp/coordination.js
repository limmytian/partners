import { createHash, randomUUID } from 'node:crypto';

export const MCP_COORDINATION_SCHEMA = `CREATE TABLE IF NOT EXISTS gateway_mcp_operations (
  key text PRIMARY KEY, owner text NOT NULL, request_hash text NOT NULL,
  record jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);`;
export class McpMemoryCoordinator {
  constructor() { this.records = new Map(); }
  async migrate() {}
  async claim(key, requestHash, record) {
    if (this.records.has(key)) return { acquired: false, record: structuredClone(this.records.get(key)) };
    const value = { ...record, owner: randomUUID(), requestHash };
    this.records.set(key, value);
    return { acquired: true, record: structuredClone(value) };
  }
  async get(key) { return structuredClone(this.records.get(key) ?? null); }
  async update(key, owner, record) {
    const current = this.records.get(key);
    if (current?.owner !== owner) throw new Error('Operation ownership lost');
    this.records.set(key, { ...record, owner, requestHash: current.requestHash });
  }
  async release(key, owner) {
    if (this.records.get(key)?.owner === owner) this.records.delete(key);
  }
}
export class McpPostgresCoordinator {
  constructor(store) { this.store = store; }
  async query(sql, values = []) {
    const result = await this.store.runner.execute({ connectionString: this.store.connectionString,
      statements: [{ name: 'mcpCoordination', sql, values }] });
    return result.results[0];
  }
  async migrate() { await this.query("BEGIN; SELECT pg_advisory_xact_lock(hashtext('partners_mcp_schema'));\n" + MCP_COORDINATION_SCHEMA + '\nCOMMIT;'); }
  async claim(key, requestHash, record) {
    const owner = randomUUID();
    const value = { ...record, owner, requestHash };
    const result = await this.query(`INSERT INTO gateway_mcp_operations(key,owner,request_hash,record)
      VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(key) DO NOTHING RETURNING record`,
    [key, owner, requestHash, JSON.stringify(value)]);
    return result.rows.length ? { acquired: true, record: result.rows[0].record }
      : { acquired: false, record: await this.get(key) };
  }
  async get(key) { return (await this.query('SELECT record FROM gateway_mcp_operations WHERE key=$1', [key])).rows[0]?.record ?? null; }
  async update(key, owner, record) {
    const result = await this.query(`UPDATE gateway_mcp_operations SET record=$3::jsonb
      WHERE key=$1 AND owner=$2 RETURNING key`, [key, owner, JSON.stringify(record)]);
    if (!result.rows.length) throw new Error('Operation ownership lost');
  }
  async release(key, owner) { await this.query('DELETE FROM gateway_mcp_operations WHERE key=$1 AND owner=$2', [key, owner]); }
}
export function gatewayCoordinator(store) {
  if (!store.mcpCoordinator) store.mcpCoordinator = store.runner
    ? new McpPostgresCoordinator(store) : new McpMemoryCoordinator();
  return store.mcpCoordinator;
}
export function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function mcpError(code, retryable = false, details = {}) {
  return Object.assign(new Error(code), { code, retryable, details });
}
