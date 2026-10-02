import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig, ConfluentRestClient, ConfluentConfigError, EXPECTED_CLUSTER,
} from './confluent-client.mjs';

const VALID = {
  CONFLUENT_CLUSTER_ID: 'lkc-gqx1kx3',
  CONFLUENT_BOOTSTRAP: 'lkc-gqx1kx3.us-east-1.aws.confluent.cloud:9092',
  CONFLUENT_API_KEY: 'test-key',
  CONFLUENT_API_SECRET: 'test-secret',
};

test('valid config loads and normalizes', () => {
  const c = loadConfig(VALID);
  assert.equal(c.clusterId, 'lkc-gqx1kx3');
  assert.deepEqual(c.bootstrap, ['lkc-gqx1kx3.us-east-1.aws.confluent.cloud:9092']);
  assert.equal(c.sasl, 'basic');
  assert.equal(c.restProxy, 'https://api.confluent.cloud');
});

test('a comma-separated bootstrap list becomes an array', () => {
  const c = loadConfig({ ...VALID, CONFLUENT_BOOTSTRAP: 'a:9092, b:9092 ,c:9092' });
  assert.equal(c.bootstrap.length, 3);
  assert.ok(c.bootstrap.every((b) => !/\s/.test(b)), 'whitespace must be trimmed');
});

test('missing keys are named, and the error never leaks a secret value', () => {
  let err;
  try { loadConfig({}); } catch (e) { err = e; }
  assert.ok(err instanceof ConfluentConfigError);
  for (const k of ['CONFLUENT_BOOTSTRAP', 'CONFLUENT_API_KEY', 'CONFLUENT_API_SECRET']) {
    assert.ok(err.message.includes(k), `${k} should be named in the error`);
  }
  assert.ok(!/test-secret/.test(err.message), 'no secret material in the error');
});

test('a blank value is treated as missing, not as a valid empty string', () => {
  assert.throws(() => loadConfig({ ...VALID, CONFLUENT_API_KEY: '   ' }), ConfluentConfigError);
});

test('there is NO fallback key: an unset JWT-like secret cannot silently work', () => {
  // This is the whole point: a client that defaults to a known credential looks
  // like it connected when it did not.
  assert.throws(() => loadConfig({ ...VALID, CONFLUENT_API_SECRET: undefined }), ConfluentConfigError);
  assert.throws(() => loadConfig({ ...VALID, CONFLUENT_API_KEY: '' }), ConfluentConfigError);
});

test('an unknown cluster warns but does not throw', () => {
  const orig = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try {
    const c = loadConfig({ ...VALID, CONFLUENT_CLUSTER_ID: 'lkc-someother' });
    assert.equal(c.clusterId, 'lkc-someother');
  } finally { console.warn = orig; }
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(EXPECTED_CLUSTER.id), 'warning should name the expected cluster');
});

test('sasl plain is accepted for dedicated clusters', () => {
  assert.equal(loadConfig({ ...VALID, CONFLUENT_SASL_MECHANISM: 'plain' }).sasl, 'plain');
  assert.equal(loadConfig({ ...VALID, CONFLUENT_SASL_MECHANISM: 'nonsense' }).sasl, 'basic');
});

test('trailing slashes are stripped from the REST proxy url', () => {
  assert.equal(loadConfig({ ...VALID, CONFLUENT_REST_PROXY: 'https://x.dev///' }).restProxy, 'https://x.dev');
});

test('rest client signs requests with basic auth and the v3 content type', async () => {
  const seen = {};
  const client = new ConfluentRestClient(loadConfig(VALID), {
    fetchImpl: async (url, init) => {
      seen.url = String(url);
      seen.auth = init.headers.Authorization;
      seen.ct = init.headers['Content-Type'];
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });
  await client.health();
  assert.ok(seen.auth.startsWith('Basic '));
  const decoded = Buffer.from(seen.auth.slice(6), 'base64').toString('utf8');
  assert.equal(decoded, 'test-key:test-secret');
  assert.equal(seen.ct, 'application/vnd.kafka.json.v3+json');
  assert.ok(seen.url.includes('/kafka/v3/clusters'));
});

test('health reports latency and only passes on a real 200', async () => {
  const ok = new ConfluentRestClient(loadConfig(VALID), {
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  const h = await ok.health();
  assert.equal(h.ok, true);
  assert.equal(h.clusterId, 'lkc-gqx1kx3');
  assert.ok(typeof h.latencyMs === 'number');

  const bad = new ConfluentRestClient(loadConfig(VALID), {
    fetchImpl: async () => new Response('nope', { status: 401 }),
  });
  await assert.rejects(() => bad.health(), /401/);
});

test('a REST error surfaces status and message, not the key', async () => {
  const client = new ConfluentRestClient(loadConfig(VALID), {
    fetchImpl: async () => new Response(
      JSON.stringify({ error_code: 40101, message: 'Unauthorized' }),
      { status: 401 },
    ),
  });
  let err;
  try { await client.health(); } catch (e) { err = e; }
  assert.match(err.message, /40101|Unauthorized/);
  assert.ok(!err.message.includes('test-secret'), 'secret leaked into error');
});

test('a non-JSON error body does not crash the parser', async () => {
  const client = new ConfluentRestClient(loadConfig(VALID), {
    fetchImpl: async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
  });
  await assert.rejects(() => client.health(), /502/);
});

test('a cluster with no fetch implementation fails loudly', () => {
  assert.throws(
    () => new ConfluentRestClient(loadConfig(VALID), { fetchImpl: null }),
    ConfluentConfigError,
  );
});

test('the kafka client lazily requires kafkajs and fails on a bad broker, not a crash', async () => {
  const { ConfluentKafkaClient } = await import('./confluent-client.mjs');
  const c = new ConfluentKafkaClient(loadConfig(VALID));
  // kafkajs is a real dependency, so this exercises the actual data-plane path:
  // an unresolvable bootstrap must surface as a connection error, not a crash.
  await assert.rejects(
    () => c.produce({ topic: 't', value: {} }),
    (err) => {
      assert.ok(
        /ENOTFOUND|ECONNREFUSED|KafkaJS.*Retries|Connection error/i.test(err.message),
        `unexpected error: ${err.message}`,
      );
      return true;
    },
  );
  await c.disconnect();
});

test('the REST path works with no broker reachable and no kafkajs at all', async () => {
  // Metadata calls must never depend on the data plane, or a health check
  // would report an outage whenever the broker port is firewalled.
  const client = new ConfluentRestClient(loadConfig(VALID), {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ topic_name: 't' }] }), { status: 200 }),
  });
  assert.equal((await client.health()).ok, true);
});