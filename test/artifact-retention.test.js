import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateArtifactRetention,
  GatewayArtifactRetentionClass,
  generateS3LifecycleConfiguration,
  selectExpiredArtifactManifests,
  validateS3LifecycleConfiguration,
} from '../src/index.js';

test('evaluates artifact retention classes and legal holds', () => {
  const now = new Date('2026-07-10T00:00:00.000Z');
  const expiredReview = evaluateArtifactRetention({
    id: 'art_review_old',
    retentionClass: GatewayArtifactRetentionClass.Review,
    createdAt: '2026-07-01T00:00:00.000Z',
  }, { now });
  assert.equal(expiredReview.expired, true);
  assert.equal(expiredReview.deleteEligible, true);

  const retainedAudit = evaluateArtifactRetention({
    id: 'art_audit_recent',
    retentionClass: GatewayArtifactRetentionClass.Audit,
    createdAt: '2026-07-01T00:00:00.000Z',
  }, { now });
  assert.equal(retainedAudit.expired, false);

  const held = evaluateArtifactRetention({
    id: 'art_hold',
    retentionClass: GatewayArtifactRetentionClass.Review,
    createdAt: '2020-01-01T00:00:00.000Z',
    metadata: { retention: { legalHold: true } },
  }, { now });
  assert.equal(held.expired, false);
  assert.equal(held.reason, 'legal_hold');
});

test('selects expired manifests and generates S3 lifecycle rules by retention tag', () => {
  const expired = selectExpiredArtifactManifests([
    {
      id: 'art_old',
      retentionClass: GatewayArtifactRetentionClass.Transient,
      createdAt: '2026-07-01T00:00:00.000Z',
    },
    {
      id: 'art_hold',
      retentionClass: GatewayArtifactRetentionClass.LegalHold,
      createdAt: '2020-01-01T00:00:00.000Z',
    },
  ], {
    now: new Date('2026-07-05T00:00:00.000Z'),
  });
  assert.deepEqual(expired.map((item) => item.artifact.id), ['art_old']);

  const lifecycle = generateS3LifecycleConfiguration({ prefix: 'gateway-artifacts' });
  assert.ok(validateS3LifecycleConfiguration(lifecycle));
  assert.ok(lifecycle.Rules.some((rule) => (
    rule.Filter.And.Tags.some((tag) => (
      tag.Key === 'retentionClass' && tag.Value === GatewayArtifactRetentionClass.Review
    ))
  )));
  assert.ok(!lifecycle.Rules.some((rule) => /legal_hold/.test(rule.ID)));
});
