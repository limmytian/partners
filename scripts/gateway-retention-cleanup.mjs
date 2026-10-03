#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_ARTIFACT_RETENTION_POLICY,
  generateS3LifecycleConfiguration,
  LocalArtifactStore,
  PostgresGatewayStore,
  selectExpiredArtifactManifests,
  S3ArtifactStore,
  validateS3LifecycleConfiguration,
} from '../src/index.js';

const [command = 'cleanup', ...rawArgs] = process.argv.slice(2);
const options = parseOptions(rawArgs);

if (command === 's3-policy') {
  const configuration = generateS3LifecycleConfiguration({
    prefix: options.prefix ?? process.env.S3_PREFIX ?? 'gateway-artifacts',
  });
  console.log(JSON.stringify(configuration, null, 2));
  process.exit(0);
}

if (command === 'validate-s3-policy') {
  const policyFile = required(options.file, '--file');
  const configuration = JSON.parse(await readFile(policyFile, 'utf8'));
  validateS3LifecycleConfiguration(configuration);
  console.log(JSON.stringify({ ok: true, ruleCount: configuration.Rules.length }, null, 2));
  process.exit(0);
}

if (command !== 'cleanup') {
  throw new Error(`Unknown retention command: ${command}`);
}

const output = process.env.POSTGRES_URL && process.env.RETENTION_LOCAL_FILES_ONLY !== '1'
  ? await cleanupPostgresManifests(options)
  : await cleanupLocalFiles(options);

console.log(JSON.stringify(output, null, 2));

async function cleanupPostgresManifests(opts) {
  const dryRun = boolEnv('RETENTION_DRY_RUN', true);
  const limit = integerOption(opts.limit ?? process.env.RETENTION_MANIFEST_LIMIT, 1000);
  const now = new Date(process.env.RETENTION_NOW ?? Date.now());
  const allowMissingObjects = boolEnv('RETENTION_ALLOW_MISSING_OBJECTS', false);
  const assumeObjectLifecycle = boolEnv('RETENTION_ASSUME_OBJECT_LIFECYCLE', false);
  const store = new PostgresGatewayStore({ connectionString: process.env.POSTGRES_URL });
  const artifactStore = dryRun || assumeObjectLifecycle ? null : buildArtifactStore();
  const deletedObjects = [];
  const deletedManifests = [];
  const skipped = [];

  try {
    const manifests = await store.listArtifactManifests({ limit });
    const expired = selectExpiredArtifactManifests(manifests, {
      now,
      policy: DEFAULT_ARTIFACT_RETENTION_POLICY,
    });

    for (const candidate of expired) {
      const artifact = candidate.artifact;
      if (!candidate.deleteEligible) {
        skipped.push({ artifactId: artifact.id, reason: candidate.reason });
        continue;
      }

      if (dryRun) {
        continue;
      }

      let objectDeleted = assumeObjectLifecycle;
      if (!assumeObjectLifecycle) {
        objectDeleted = await artifactStore.deleteArtifact(artifact.id, artifact);
      }
      if (!objectDeleted && !allowMissingObjects) {
        skipped.push({ artifactId: artifact.id, reason: 'object_not_deleted' });
        continue;
      }
      deletedObjects.push({
        artifactId: artifact.id,
        storageUri: artifact.storageUri ?? null,
        assumedLifecycle: assumeObjectLifecycle,
        missingAllowed: !objectDeleted && allowMissingObjects,
      });
      const deletedManifest = await store.deleteArtifactManifest(artifact.id);
      if (deletedManifest) {
        deletedManifests.push(artifact.id);
      }
    }

    return {
      ok: true,
      mode: 'postgres-manifests',
      dryRun,
      now: now.toISOString(),
      scannedCount: manifests.length,
      expiredCount: expired.length,
      deletedObjectCount: deletedObjects.length,
      deletedManifestCount: deletedManifests.length,
      skippedCount: skipped.length,
      expired: expired.map(summarizeCandidate),
      deletedObjects,
      deletedManifests,
      skipped,
    };
  } finally {
    await store.close();
  }
}

async function cleanupLocalFiles(opts) {
  const rootDir = opts.rootDir ?? process.env.GATEWAY_ARTIFACT_ROOT ?? '/tmp/partners-artifacts';
  const maxAgeHours = parseNumber(process.env.RETENTION_MAX_AGE_HOURS, 24 * 7);
  const dryRun = boolEnv('RETENTION_DRY_RUN', true);
  const now = Date.now();
  const cutoffMs = now - (maxAgeHours * 60 * 60 * 1000);
  const deleted = [];
  const kept = [];

  for (const entry of await walk(rootDir)) {
    const entryStat = await stat(entry);
    if (!entryStat.isFile()) {
      continue;
    }
    if (entryStat.mtimeMs >= cutoffMs) {
      kept.push(entry);
      continue;
    }
    deleted.push(entry);
    if (!dryRun) {
      await rm(entry, { force: true });
    }
  }

  return {
    ok: true,
    mode: 'local-files',
    rootDir,
    dryRun,
    maxAgeHours,
    cutoff: new Date(cutoffMs).toISOString(),
    deletedCount: deleted.length,
    keptCount: kept.length,
    deleted,
  };
}

function buildArtifactStore() {
  const requested = (process.env.GATEWAY_ARTIFACT_STORE ?? (process.env.S3_ENDPOINT ? 's3' : 'local')).toLowerCase();
  if (requested === 's3') {
    return new S3ArtifactStore({
      endpoint: process.env.S3_ENDPOINT,
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      prefix: process.env.S3_PREFIX ?? 'gateway-artifacts',
    });
  }
  return new LocalArtifactStore({
    rootDir: process.env.GATEWAY_ARTIFACT_ROOT ?? '/tmp/partners-artifacts',
  });
}

function summarizeCandidate(candidate) {
  return {
    artifactId: candidate.artifact.id,
    jobId: candidate.artifact.jobId ?? null,
    retentionClass: candidate.retentionClass,
    storageUri: candidate.artifact.storageUri ?? null,
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
    reason: candidate.reason,
  };
}

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walk(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      parsed._ = [...(parsed._ ?? []), arg];
      continue;
    }
    const key = camelCase(arg.slice(2));
    const value = args[index + 1] && !args[index + 1].startsWith('--')
      ? args[++index]
      : true;
    parsed[key] = value;
  }
  return parsed;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return !['0', 'false', 'no'].includes(String(value).toLowerCase());
}

function integerOption(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function required(value, name) {
  if (!value) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function camelCase(value) {
  return value.replaceAll(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}
