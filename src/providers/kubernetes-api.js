import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

/**
 * Small Kubernetes REST client used by KubernetesSandboxProvider.
 * It deliberately covers only the resources needed by the provider so the
 * gateway does not need a heavyweight Kubernetes client dependency.
 */
export class KubernetesApiClient {
  constructor({
    server,
    token = null,
    ca = null,
    requestImpl = request,
  } = {}) {
    if (!server) {
      throw new TypeError('KubernetesApiClient requires server');
    }
    this.server = server.replace(/\/$/, '');
    this.token = token;
    this.ca = ca;
    this.requestImpl = requestImpl;
  }

  static fromEnvironment() {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT ?? '443';
    const serviceAccountDir = '/var/run/secrets/kubernetes.io/serviceaccount';
    const tokenPath = `${serviceAccountDir}/token`;
    const caPath = `${serviceAccountDir}/ca.crt`;

    if (!host) {
      throw new Error('Kubernetes API is not configured: KUBERNETES_SERVICE_HOST is missing');
    }
    if (!existsSync(tokenPath)) {
      throw new Error(`Kubernetes service-account token is missing: ${tokenPath}`);
    }

    return new KubernetesApiClient({
      server: `https://${host}:${port}`,
      token: readFileSync(tokenPath, 'utf8').trim(),
      ca: existsSync(caPath) ? readFileSync(caPath) : null,
    });
  }

  async request(path, { method = 'GET', body = undefined, headers = {}, signal } = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const response = await this.requestImpl({
      url: `${this.server}${path}`,
      method,
      body: payload,
      ca: this.ca,
      token: this.token,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.byteLength) } : {}),
        ...headers,
      },
      signal,
    });

    const parsed = parseBody(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const reason = parsed?.message ?? parsed?.reason ?? response.body ?? `HTTP ${response.statusCode}`;
      throw Object.assign(new Error(`Kubernetes API ${method} ${path} failed: ${response.statusCode} ${reason}`), {
        statusCode: response.statusCode,
        response: parsed,
      });
    }
    return parsed;
  }

  createPod(namespace, pod) {
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`, {
      method: 'POST',
      body: pod,
    });
  }

  getPod(namespace, name) {
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`);
  }

  patchPod(namespace, name, patch) {
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: patch,
      headers: { 'content-type': 'application/merge-patch+json' },
    });
  }

  listPods(namespace, labelSelector = '') {
    const query = labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : '';
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods${query}`);
  }

  deletePod(namespace, name) {
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      body: { propagationPolicy: 'Background' },
    });
  }

  createService(namespace, service) {
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/services`, {
      method: 'POST',
      body: service,
    });
  }

  listServices(namespace, labelSelector = '') {
    const query = labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : '';
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/services${query}`);
  }

  createPersistentVolumeClaim(namespace, claim) {
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims`, {
      method: 'POST',
      body: claim,
    });
  }

  getPersistentVolumeClaim(namespace, name) {
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(name)}`);
  }

  patchPersistentVolumeClaim(namespace, name, patch) {
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: patch,
      headers: { 'content-type': 'application/merge-patch+json' },
    });
  }

  deletePersistentVolumeClaim(namespace, name) {
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      body: { propagationPolicy: 'Background' },
    });
  }

  deleteService(namespace, name) {
    return this.request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      body: { propagationPolicy: 'Background' },
    });
  }

  async getPodLogs(namespace, name, container = 'sandbox') {
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}/log?container=${encodeURIComponent(container)}`;
    const response = await this.requestImpl({
      url: `${this.server}${path}`,
      method: 'GET',
      ca: this.ca,
      token: this.token,
      headers: { accept: 'text/plain' },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Kubernetes pod logs failed: ${response.statusCode} ${response.body}`);
    }
    return response.body;
  }
}

function parseBody(body) {
  if (!body) {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function request({ url, method, body, ca, token, headers, signal }) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(target, {
      method,
      ca: target.protocol === 'https:' ? ca : undefined,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: chunks.join('') }));
    });
    req.once('error', reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy(signal.reason ?? new Error('Request aborted'));
      } else {
        signal.addEventListener('abort', () => req.destroy(signal.reason ?? new Error('Request aborted')), { once: true });
      }
    }
    if (body) {
      req.write(body);
    }
    req.end();
  });
}
