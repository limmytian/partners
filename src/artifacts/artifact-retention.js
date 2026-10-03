export const GatewayArtifactRetentionClass = Object.freeze({
  Transient: 'transient',
  Review: 'review',
  Audit: 'audit',
  LegalHold: 'legal_hold',
  Forever: 'forever',
});

export const DEFAULT_ARTIFACT_RETENTION_POLICY = Object.freeze({
  [GatewayArtifactRetentionClass.Transient]: { ttlHours: 24, deleteObjects: true },
  [GatewayArtifactRetentionClass.Review]: { ttlHours: 24 * 7, deleteObjects: true },
  [GatewayArtifactRetentionClass.Audit]: { ttlHours: 24 * 365, deleteObjects: true },
  [GatewayArtifactRetentionClass.LegalHold]: { ttlHours: null, deleteObjects: false, hold: true },
  [GatewayArtifactRetentionClass.Forever]: { ttlHours: null, deleteObjects: false, hold: true },
});

export function evaluateArtifactRetention(artifact, {
  now = new Date(),
  policy = DEFAULT_ARTIFACT_RETENTION_POLICY,
} = {}) {
  const retentionClass = normalizeRetentionClass(artifact.retentionClass);
  const rule = policy[retentionClass] ?? policy[GatewayArtifactRetentionClass.Review];
  const createdAt = parseDate(artifact.createdAt) ?? parseDate(artifact.metadata?.createdAt);
  const explicitExpiresAt = parseDate(artifact.metadata?.retention?.expiresAt);
  const legalHold = Boolean(
    rule.hold
    || artifact.metadata?.retention?.legalHold
    || artifact.metadata?.legalHold,
  );

  if (legalHold) {
    return result(artifact, {
      retentionClass,
      createdAt,
      expiresAt: null,
      expired: false,
      deleteEligible: false,
      reason: 'legal_hold',
    });
  }

  const expiresAt = explicitExpiresAt ?? (
    Number.isFinite(rule.ttlHours) && createdAt
      ? new Date(createdAt.getTime() + (rule.ttlHours * 60 * 60 * 1000))
      : null
  );
  const expired = Boolean(expiresAt && expiresAt <= asDate(now));

  return result(artifact, {
    retentionClass,
    createdAt,
    expiresAt,
    expired,
    deleteEligible: expired && rule.deleteObjects !== false,
    reason: expired ? 'expired' : 'retained',
  });
}

export function selectExpiredArtifactManifests(artifacts, options = {}) {
  return artifacts
    .map((artifact) => evaluateArtifactRetention(artifact, options))
    .filter((evaluation) => evaluation.expired);
}

export function generateS3LifecycleConfiguration({
  prefix = 'gateway-artifacts',
  policy = DEFAULT_ARTIFACT_RETENTION_POLICY,
} = {}) {
  const cleanPrefix = trimSlashes(prefix);
  const rules = Object.entries(policy)
    .filter(([_retentionClass, rule]) => Number.isFinite(rule.ttlHours) && rule.deleteObjects !== false)
    .map(([retentionClass, rule]) => {
      const days = Math.max(1, Math.ceil(rule.ttlHours / 24));
      return {
        ID: `partners-${retentionClass}-${days}d`,
        Status: 'Enabled',
        Filter: {
          And: {
            Prefix: cleanPrefix ? `${cleanPrefix}/` : '',
            Tags: [{ Key: 'retentionClass', Value: retentionClass }],
          },
        },
        Expiration: { Days: days },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      };
    });

  return { Rules: rules };
}

export function validateS3LifecycleConfiguration(configuration, {
  policy = DEFAULT_ARTIFACT_RETENTION_POLICY,
} = {}) {
  const rules = configuration?.Rules;
  if (!Array.isArray(rules)) {
    throw new TypeError('S3 lifecycle configuration requires a Rules array');
  }
  const expectedClasses = Object.entries(policy)
    .filter(([_retentionClass, rule]) => Number.isFinite(rule.ttlHours) && rule.deleteObjects !== false)
    .map(([retentionClass]) => retentionClass);
  for (const retentionClass of expectedClasses) {
    const found = rules.some((rule) => (
      rule.Filter?.And?.Tags?.some((tag) => (
        tag.Key === 'retentionClass' && tag.Value === retentionClass
      ))
      && Number.isInteger(rule.Expiration?.Days)
    ));
    if (!found) {
      throw new Error(`Missing lifecycle rule for retentionClass=${retentionClass}`);
    }
  }
  return true;
}

function result(artifact, evaluation) {
  return {
    artifact,
    ...evaluation,
    createdAt: evaluation.createdAt?.toISOString() ?? null,
    expiresAt: evaluation.expiresAt?.toISOString() ?? null,
  };
}

function normalizeRetentionClass(value) {
  return Object.values(GatewayArtifactRetentionClass).includes(value)
    ? value
    : GatewayArtifactRetentionClass.Review;
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function trimSlashes(value) {
  return String(value ?? '').replaceAll(/^\/+|\/+$/g, '');
}
