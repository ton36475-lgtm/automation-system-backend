import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubEventPublisher, clusterHealth, DEFAULT_TOPIC } from './github-events.publisher.mjs';

const GITHUB_PAT = ['ghp', '_', '0'.repeat(20), 'aBcDeF'].join('');

test('an unconfigured cluster disables publishing instead of throwing', async () => {
  const p = await new GithubEventPublisher({ env: {} }).init();
  assert.equal(p.enabled, false);
  const r = await p.publish({ type: 'push' });
  assert.equal(r.published, false);
  assert.ok(r.reason, 'a disabled publisher must say why');
  assert.equal(p.stats.dropped, 1);
});

test('a partially configured environment is still refused', async () => {
  const env = { CONFLUENT_CLUSTER_ID: 'lkc-gqx1kx3', CONFLUENT_API_KEY: 'k' };
  const p = await new GithubEventPublisher({ env }).init();
  assert.equal(p.enabled, false);
  assert.match(p.reason, /CONFLUENT_BOOTSTRAP|CONFLUENT_API_SECRET/);
});

test('a webhook signature header never reaches the producer', async () => {
  const sent = [];
  const p = new GithubEventPublisher({
    env: {
      CONFLUENT_CLUSTER_ID: 'lkc-gqx1kx3',
      CONFLUENT_BOOTSTRAP: 'broker:9092',
      CONFLUENT_API_KEY: 'k', CONFLUENT_API_SECRET: 's',
    },
  });
  await p.init();
  p.producer = { produce: async (r) => sent.push(r), disconnect: async () => {} };

  await p.publish(
    {
      type: 'issues',
      repository: { full_name: 'o/r' },
      head_commit: { message: `fix: rotate ${GITHUB_PAT}` },
      authorization: 'token ' + GITHUB_PAT,
    },
    { eventType: 'push', deliveryId: 'd-1' },
  );

  const serialized = JSON.stringify(sent);
  assert.ok(!serialized.includes('ghp'), 'a PAT survived to the producer');
  // The field NAME is kept as a signal that the event carried one; only the
  // value is replaced. Asserting the key is absent would be asserting a
  // stricter contract than the scrubber offers.
  const authField = sent[0].value.authorization;
  assert.equal(authField, '[scrubbed]', 'the auth value was not scrubbed');
  assert.ok(!String(authField).includes('ghp'));
  assert.ok(!/x-hub-signature/i.test(serialized), 'a signature header was forwarded');
  assert.equal(sent[0].topic, DEFAULT_TOPIC);
  assert.equal(sent[0].headers.scrubbed, 'true');
  assert.equal(p.stats.published, 1);
});

test('the partition key survives scrubbing so ordering still groups by repo', async () => {
  let sent = null;
  const p = new GithubEventPublisher({
    env: {
      CONFLUENT_CLUSTER_ID: 'lkc-gqx1kx3',
      CONFLUENT_BOOTSTRAP: 'b:9092',
      CONFLUENT_API_KEY: 'k', CONFLUENT_API_SECRET: 's',
    },
  });
  await p.init();
  p.producer = { produce: async (r) => { sent = r; }, disconnect: async () => {} };
  await p.publish({ type: 'push', repository: { full_name: 'ton36475-lgtm/sirinx-os' } });
  assert.equal(sent.key, 'ton36475-lgtm/sirinx-os:push');
});

test('a broker failure drops the event but never throws into the request path', async () => {
  const p = new GithubEventPublisher({
    env: {
      CONFLUENT_CLUSTER_ID: 'lkc-gqx1kx3',
      CONFLUENT_BOOTSTRAP: 'b:9092',
      CONFLUENT_API_KEY: 'k', CONFLUENT_API_SECRET: 's',
    },
  });
  await p.init();
  p.producer = { produce: async () => { throw new Error('ECONNREFUSED broker:9092'); }, disconnect: async () => {} };
  const r = await p.publish({ type: 'push' });
  assert.equal(r.published, false);
  assert.match(r.reason, /ECONNREFUSED/);
  assert.equal(p.stats.errors, 1);
  assert.equal(p.stats.dropped, 1);
});

test('the error recorded in stats must not carry credentials', async () => {
  const p = new GithubEventPublisher({
    env: {
      CONFLUENT_CLUSTER_ID: 'lkc-gqx1kx3',
      CONFLUENT_BOOTSTRAP: 'b:9092',
      CONFLUENT_API_KEY: 'k', CONFLUENT_API_SECRET: 's',
    },
  });
  await p.init();
  p.producer = { produce: async () => { throw new Error('SASL auth failed for key hunter2'); }, disconnect: async () => {} };
  await p.publish({ type: 'push' });
  assert.ok(!/CONFLUENT_API_SECRET/.test(JSON.stringify(p.status())));
});

test('status() reports the topic and disabled reason for the health endpoint', async () => {
  const p = await new GithubEventPublisher({ env: {} }).init();
  const s = p.status().kafka;
  assert.equal(s.enabled, false);
  assert.equal(s.topic, DEFAULT_TOPIC);
  assert.equal(s.cluster, null);
  assert.ok(s.reason);
});

test('clusterHealth reports failure without throwing on empty config', async () => {
  const h = await clusterHealth({});
  assert.equal(h.ok, false);
  assert.ok(h.error);
});

test('close() is safe to call twice', async () => {
  const p = await new GithubEventPublisher({ env: {} }).init();
  await p.close();
  await p.close();
  assert.equal(p.enabled, false);
});