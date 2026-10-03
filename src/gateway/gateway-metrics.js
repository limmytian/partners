export function createGatewayMetrics({
  clock = () => Date.now(),
  storeStats = () => null,
} = {}) {
  const startedAt = clock();
  const requests = {
    total: 0,
    byStatus: new Map(),
    byRoute: new Map(),
    totalDurationMs: 0,
  };
  const jobsStarted = new Map();
  const jobsTerminal = new Map();
  const jobsRunning = new Map();
  const providerDuration = new Map();
  const artifactFailures = new Map();

  return {
    recordRequest({ method, path, statusCode, durationMs }) {
      requests.total += 1;
      requests.totalDurationMs += boundedNumber(durationMs);
      increment(requests.byStatus, labelsKey({ status_class: `${Math.floor(statusCode / 100)}xx` }));
      increment(requests.byRoute, labelsKey({ route: `${method} ${path}` }));
    },

    recordJobStarted({ executionMode, provider }) {
      const labels = jobLabels({ executionMode, provider });
      increment(jobsStarted, labelsKey(labels));
      increment(jobsRunning, labelsKey(labels));
    },

    recordJobFinished({ executionMode, provider, state, durationMs }) {
      const labels = jobLabels({ executionMode, provider });
      decrement(jobsRunning, labelsKey(labels));
      increment(jobsTerminal, labelsKey({ ...labels, state: boundedState(state) }));
      const durationKey = labelsKey({ ...labels, state: boundedState(state) });
      const current = providerDuration.get(durationKey) ?? { count: 0, sum: 0 };
      providerDuration.set(durationKey, {
        count: current.count + 1,
        sum: current.sum + boundedNumber(durationMs),
      });
    },

    recordArtifactFailure({ backend, operation }) {
      increment(artifactFailures, labelsKey({
        backend: boundedLabel(backend ?? 'unknown'),
        operation: boundedOperation(operation),
      }));
    },

    prometheus() {
      const lines = [
        '# TYPE partners_gateway_uptime_seconds gauge',
        `partners_gateway_uptime_seconds ${Math.max(0, Math.floor((clock() - startedAt) / 1000))}`,
        '# TYPE partners_gateway_http_requests_total counter',
        `partners_gateway_http_requests_total ${requests.total}`,
        '# TYPE partners_gateway_http_request_duration_ms_total counter',
        `partners_gateway_http_request_duration_ms_total ${requests.totalDurationMs}`,
      ];

      appendMap(lines, requests.byStatus, 'partners_gateway_http_requests_by_status_total', 'counter');
      appendMap(lines, requests.byRoute, 'partners_gateway_http_requests_by_route_total', 'counter');
      appendMap(lines, jobsStarted, 'partners_gateway_jobs_started_total', 'counter');
      appendMap(lines, jobsTerminal, 'partners_gateway_jobs_terminal_total', 'counter');
      appendMap(lines, jobsRunning, 'partners_gateway_jobs_running', 'gauge');
      appendDuration(lines, providerDuration);
      appendPostgresPool(lines, storeStats());
      appendMap(lines, artifactFailures, 'partners_gateway_artifact_failures_total', 'counter');

      return `${lines.join('\n')}\n`;
    },
  };
}

export function instrumentArtifactStore(artifactStore, metrics, { backend } = {}) {
  if (!artifactStore || !metrics) {
    return artifactStore;
  }
  const backendName = boundedLabel(backend ?? artifactStore.backend ?? artifactStore.constructor?.name ?? 'unknown');
  const operations = new Map([
    ['writeArtifact', 'write'],
    ['readArtifact', 'read'],
    ['deleteArtifact', 'delete'],
  ]);

  return new Proxy(artifactStore, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!operations.has(property) || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args) => {
        try {
          return await value.apply(target, args);
        } catch (error) {
          metrics.recordArtifactFailure({
            backend: backendName,
            operation: operations.get(property),
          });
          throw error;
        }
      };
    },
  });
}

function appendMap(lines, map, metricName, type) {
  lines.push(`# TYPE ${metricName} ${type}`);
  if (map.size === 0) {
    return;
  }
  for (const [key, value] of [...map.entries()].sort()) {
    lines.push(`${metricName}${formatLabels(parseLabelsKey(key))} ${value}`);
  }
}

function appendDuration(lines, map) {
  lines.push('# TYPE partners_gateway_provider_runtime_duration_ms summary');
  if (map.size === 0) {
    return;
  }
  for (const [key, value] of [...map.entries()].sort()) {
    const labels = formatLabels(parseLabelsKey(key));
    lines.push(`partners_gateway_provider_runtime_duration_ms_count${labels} ${value.count}`);
    lines.push(`partners_gateway_provider_runtime_duration_ms_sum${labels} ${value.sum}`);
  }
}

function appendPostgresPool(lines, stats) {
  lines.push('# TYPE partners_gateway_postgres_pool_total gauge');
  lines.push('# TYPE partners_gateway_postgres_pool_idle gauge');
  lines.push('# TYPE partners_gateway_postgres_pool_waiting gauge');
  if (!stats) {
    return;
  }
  lines.push(`partners_gateway_postgres_pool_total ${boundedNumber(stats.totalCount)}`);
  lines.push(`partners_gateway_postgres_pool_idle ${boundedNumber(stats.idleCount)}`);
  lines.push(`partners_gateway_postgres_pool_waiting ${boundedNumber(stats.waitingCount)}`);
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map, key) {
  map.set(key, Math.max(0, (map.get(key) ?? 0) - 1));
}

function jobLabels({ executionMode, provider }) {
  return {
    execution_mode: boundedLabel(executionMode ?? 'unknown'),
    provider: boundedLabel(provider ?? 'unknown'),
  };
}

function boundedState(state) {
  const allowed = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
  return allowed.has(state) ? state : 'unknown';
}

function boundedOperation(operation) {
  const allowed = new Set(['write', 'read', 'delete']);
  return allowed.has(operation) ? operation : 'unknown';
}

function boundedLabel(value) {
  return String(value ?? 'unknown')
    .toLowerCase()
    .replaceAll(/[^a-z0-9_:-]/g, '_')
    .slice(0, 80) || 'unknown';
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function labelsKey(labels) {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${boundedLabel(value)}`)
    .join(',');
}

function parseLabelsKey(key) {
  if (!key) {
    return {};
  }
  return Object.fromEntries(key.split(',').map((entry) => {
    const index = entry.indexOf('=');
    return [entry.slice(0, index), entry.slice(index + 1)];
  }));
}

function formatLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return '';
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeMetricLabel(value)}"`).join(',')}}`;
}

function escapeMetricLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
