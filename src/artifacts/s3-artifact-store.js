import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export class S3ArtifactStore {
  constructor({
    endpoint,
    bucket,
    region = 'us-east-1',
    accessKeyId,
    secretAccessKey,
    prefix = 'gateway-artifacts',
    fetchImpl = fetch,
  } = {}) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new TypeError('S3ArtifactStore requires endpoint, bucket, accessKeyId, and secretAccessKey');
    }
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.bucket = bucket;
    this.region = region;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.prefix = trimSlashes(prefix);
    this.fetch = fetchImpl;
    this.records = new Map();
    this.backend = 's3';
  }

  async writeArtifact(input = {}) {
    const artifactId = input.id ?? `art_${randomUUID()}`;
    const jobId = input.jobId ?? 'unscoped';
    const name = sanitizeName(input.name ?? `${artifactId}.bin`);
    const content = readArtifactContent(input);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const key = this.#objectKey({ artifactId, jobId, name });
    const contentType = input.contentType ?? 'application/octet-stream';
    const retentionClass = input.retentionClass ?? 'review';

    const response = await this.#request('PUT', key, {
      body: content,
      headers: {
        'content-type': contentType,
        'content-length': String(content.byteLength),
        'x-amz-tagging': tagQuery({
          retentionClass,
          artifactId,
          jobId,
        }),
        'x-amz-meta-artifact-id': artifactId,
        'x-amz-meta-job-id': jobId,
        'x-amz-meta-sha256': sha256,
      },
    });
    if (!response.ok) {
      throw new Error(`S3 put failed for ${artifactId}: ${response.status} ${response.body}`);
    }

    const record = {
      id: artifactId,
      jobId,
      kind: input.kind ?? 'file',
      name,
      contentType,
      sizeBytes: content.byteLength,
      sha256,
      storageUri: `s3://${this.bucket}/${key}`,
      downloadHandle: `artifact://s3/${artifactId}`,
      retentionClass,
      metadata: {
        ...(input.metadata ?? {}),
        s3: {
          bucket: this.bucket,
          key,
          region: this.region,
          endpoint: this.endpoint,
        },
      },
      createdAt: input.createdAt ?? new Date().toISOString(),
    };

    this.records.set(artifactId, record);
    return { ...record };
  }

  async readArtifact(artifactId, hint = null) {
    const record = this.records.get(artifactId) ?? normalizeHint(hint);
    const key = keyForRecord(record, this.bucket);
    if (!record || !key) {
      return null;
    }
    const response = await this.#request('GET', key);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`S3 get failed for ${artifactId}: ${response.status} ${response.body}`);
    }
    return {
      artifact: publicRecord(record),
      content: response.buffer,
    };
  }

  listArtifacts({ jobId } = {}) {
    return [...this.records.values()]
      .filter((record) => !jobId || record.jobId === jobId)
      .map(publicRecord);
  }

  async deleteArtifact(artifactId, hint = null) {
    const record = this.records.get(artifactId) ?? normalizeHint(hint);
    const key = keyForRecord(record, this.bucket);
    if (!record || !key) {
      return false;
    }
    const response = await this.#request('DELETE', key);
    if (!response.ok && response.status !== 404) {
      throw new Error(`S3 delete failed for ${artifactId}: ${response.status} ${response.body}`);
    }
    this.records.delete(artifactId);
    return true;
  }

  createSignedDownloadUrl(artifactId, hint = null, { expiresInSeconds = 300 } = {}) {
    const record = this.records.get(artifactId) ?? normalizeHint(hint);
    const key = keyForRecord(record, this.bucket);
    if (!record || !key) {
      return null;
    }
    return this.#presignGet(key, expiresInSeconds);
  }

  async #request(method, key, { body, headers = {} } = {}) {
    const url = this.#urlForKey(key);
    const payloadHash = body ? createHash('sha256').update(body).digest('hex') : hashEmptyPayload();
    const signedHeaders = this.#signedHeaders(method, url, {
      ...headers,
      'x-amz-content-sha256': payloadHash,
    }, payloadHash);

    const response = await runFetch(this.fetch, url, {
      method,
      headers: signedHeaders,
      body,
    });
    return response;
  }

  #signedHeaders(method, url, headers, payloadHash) {
    const amzDate = amzTimestamp();
    const signed = {
      ...lowercaseHeaders(headers),
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    const signedHeaderNames = Object.keys(signed).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${normalizeHeaderValue(signed[name])}\n`)
      .join('');
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQueryString(url.searchParams),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const credentialScope = `${amzDate.slice(0, 8)}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signature = hmacHex(signingKey(this.secretAccessKey, amzDate.slice(0, 8), this.region), stringToSign);

    return {
      ...signed,
      authorization: [
        `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}`,
        `SignedHeaders=${signedHeaders}`,
        `Signature=${signature}`,
      ].join(', '),
    };
  }

  #presignGet(key, expiresInSeconds) {
    const url = this.#urlForKey(key);
    const amzDate = amzTimestamp();
    const credentialScope = `${amzDate.slice(0, 8)}/${this.region}/s3/aws4_request`;
    url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
    url.searchParams.set('X-Amz-Credential', `${this.accessKeyId}/${credentialScope}`);
    url.searchParams.set('X-Amz-Date', amzDate);
    url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
    url.searchParams.set('X-Amz-SignedHeaders', 'host');

    const canonicalHeaders = `host:${url.host}\n`;
    const canonicalRequest = [
      'GET',
      url.pathname,
      canonicalQueryString(url.searchParams),
      canonicalHeaders,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signature = hmacHex(signingKey(this.secretAccessKey, amzDate.slice(0, 8), this.region), stringToSign);
    url.searchParams.set('X-Amz-Signature', signature);
    return url.toString();
  }

  #urlForKey(key) {
    const url = new URL(this.endpoint);
    url.pathname = `/${awsEncode(this.bucket)}/${key.split('/').map(awsEncode).join('/')}`;
    return url;
  }

  #objectKey({ artifactId, jobId, name }) {
    return [
      this.prefix,
      sanitizeKeyPart(jobId),
      sanitizeKeyPart(artifactId),
      name,
    ].filter(Boolean).join('/');
  }
}

async function runFetch(fetchImpl, url, options) {
  if (fetchImpl?.request) {
    return normalizeTransportResponse(await fetchImpl.request(url, options));
  }
  if (fetchImpl?.sync) {
    return normalizeTransportResponse(fetchImpl.sync(url, options));
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function or expose request(url, options)');
  }
  const response = await fetchImpl(url, options);
  if (response?.arrayBuffer) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries(response.headers?.entries?.() ?? []),
      body: buffer.toString('utf8'),
      buffer,
    };
  }
  return normalizeTransportResponse(response);
}

function normalizeTransportResponse(response = {}) {
  const status = response.status ?? 0;
  const buffer = Buffer.isBuffer(response.buffer)
    ? response.buffer
    : Buffer.from(response.bodyBase64 ?? response.body ?? '');
  return {
    ok: response.ok ?? (status >= 200 && status < 300),
    status,
    headers: response.headers ?? {},
    body: response.body ?? buffer.toString('utf8'),
    buffer,
  };
}

function readArtifactContent(input) {
  if (input.contentBase64) {
    return Buffer.from(input.contentBase64, 'base64');
  }
  if (input.content !== undefined) {
    return Buffer.isBuffer(input.content) ? input.content : Buffer.from(String(input.content));
  }
  if (input.localPath) {
    return readFileSync(input.localPath);
  }
  return Buffer.alloc(0);
}

function normalizeHint(hint) {
  return hint ? { ...hint } : null;
}

function publicRecord(record) {
  const { localPath: _localPath, ...publicArtifact } = record;
  return { ...publicArtifact };
}

function keyForRecord(record, bucket) {
  if (!record) {
    return null;
  }
  if (record.metadata?.s3?.key) {
    return record.metadata.s3.key;
  }
  const prefix = `s3://${bucket}/`;
  return record.storageUri?.startsWith(prefix) ? record.storageUri.slice(prefix.length) : null;
}

function sanitizeName(name) {
  return path.basename(String(name)).replaceAll(/[^A-Za-z0-9._-]/g, '_') || 'artifact.bin';
}

function sanitizeKeyPart(value) {
  return String(value ?? 'unscoped').replaceAll(/[^A-Za-z0-9._=-]/g, '_');
}

function trimSlashes(value) {
  return String(value ?? '').replaceAll(/^\/+|\/+$/g, '');
}

function lowercaseHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function normalizeHeaderValue(value) {
  return String(value).trim().replaceAll(/\s+/g, ' ');
}

function canonicalQueryString(searchParams) {
  return [...searchParams.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    ))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function tagQuery(tags) {
  return Object.entries(tags)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function awsEncode(value) {
  return encodeURIComponent(value)
    .replaceAll('!', '%21')
    .replaceAll("'", '%27')
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('*', '%2A');
}

function amzTimestamp(date = new Date()) {
  return date.toISOString().replaceAll(/[:-]|\.\d{3}/g, '');
}

function hashEmptyPayload() {
  return createHash('sha256').update('').digest('hex');
}

function signingKey(secretAccessKey, date, region) {
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`), date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function hmacHex(key, data) {
  return createHmac('sha256', key).update(data).digest('hex');
}
