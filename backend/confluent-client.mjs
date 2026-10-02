/**
 * Confluent Cloud client for cluster lkc-gqx1kx3 (environment env-9oqdnm).
 *
 * Two transports, deliberately:
 *
 * 1. `kafkajs` over TLS to the bootstrap brokers — for produce/consume. This is
 *    the data plane and needs a reachable broker.
 *
 * 2. Confluent REST Proxy v3 over HTTPS — for cluster metadata (topics, configs,
 *    consumer groups). This works without broker access and without the SRM
 *    port open, which is what you want for health checks and tooling.
 *
 * Credentials are read from the environment ONLY. There is deliberately no
 * fallback default: a client that silently falls back to a known key is worse
 * than one that refuses to start, because the failure looks like it worked.
 *
 * Required:
 *   CONFLUENT_CLUSTER_ID     e.g. lkc-gqx1kx3
 *   CONFLUENT_BOOTSTRAP      comma-separated host:port
 *   CONFLUENT_API_KEY        from the cluster's API Keys tab
 *   CONFLUENT_API_SECRET     from the same tab
 * Optional:
 *   CONFLUENT_REST_PROXY     defaults to https://api.confluent.cloud
 *   CONFLUENT_REGION
 *   CONFLUENT_SASL_MECHANISM basic (default) | plain
 *   CONFLUENT_TLS_CA         path to a CA bundle if the platform does not use
 *                            the public CA (Cloud Dedicated does not)
 *
 * Refuses to run if a key is present but no bootstrap is given, or if the
 * library is missing, rather than degrading silently.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Cluster this client was written for, surfaced so config drift is visible. */
export const EXPECTED_CLUSTER = {
  id: 'lkc-gqx1kx3',
  environment: 'env-9oqdnm',
  cloud: 'Confluent Cloud',
};

const REQUIRED = [
  'CONFLUENT_CLUSTER_ID',
  'CONFLUENT_BOOTSTRAP',
  'CONFLUENT_API_KEY',
  'CONFLUENT_API_SECRET',
];

export class ConfluentConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfluentConfigError';
  }
}

/**
 * Read and validate configuration. Never returns secret values in errors.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    throw new ConfluentConfigError(
      `Missing required Kafka/Confluent config: ${missing.join(', ')}. ` +
      `Set them in the environment (never inline in source) — see ` +
      `cluster ${EXPECTED_CLUSTER.id} > API Keys.`,
    );
  }

  const clusterId = String(env.CONFLUENT_CLUSTER_ID).trim();
  if (clusterId !== EXPECTED_CLUSTER.id) {
    // Not fatal: someone may add a second cluster. But it must be a warning,
    // because a bootstrap list from one cluster cannot talk to another.
    console.warn(
      `[confluent] configured cluster is ${clusterId}, this client was built ` +
      `for ${EXPECTED_CLUSTER.id} — verify the bootstrap list and API key match.`,
    );
  }

  const bootstrap = String(env.CONFLUENT_BOOTSTRAP)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!bootstrap.length) {
    throw new ConfluentConfigError('CONFLUENT_BOOTSTRAP parsed to an empty list.');
  }

  const mechanism = (env.CONFLUENT_SASL_MECHANISM || 'basic').toLowerCase();

  return {
    clusterId,
    bootstrap,
    apiKey: String(env.CONFLUENT_API_KEY).trim(),
    apiSecret: String(env.CONFLUENT_API_SECRET).trim(),
    restProxy: (env.CONFLUENT_REST_PROXY || 'https://api.confluent.cloud').replace(/\/+$/, ''),
    region: env.CONFLUENT_REGION || null,
    sasl: mechanism === 'plain' ? 'plain' : 'basic',
    tlsCaPath: env.CONFLUENT_TLS_CA || null,
    clientId: env.CONFLUENT_CLIENT_ID || `asb-${clusterId}`,
  };
}

/** Basic auth header for the REST Proxy v3 API. */
function restAuth(cfg) {
  const raw = `${cfg.apiKey}:${cfg.apiSecret}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/**
 * Confluent Cloud REST Proxy v3 — metadata only, no broker needed.
 * @param {ReturnType<typeof loadConfig>} cfg
 */
export class ConfluentRestClient {
  constructor(cfg = loadConfig(), { fetchImpl = globalThis.fetch } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    if (typeof this.fetch !== 'function') {
      throw new ConfluentConfigError('No fetch implementation available (need Node 18+).');
    }
  }

  async #request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${this.cfg.restProxy}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: restAuth(this.cfg),
        'Content-Type': 'application/vnd.kafka.json.v3+json',
        Accept: 'application/vnd.kafka.json.v3+json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });

    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

    if (!res.ok) {
      const detail = parsed?.message || parsed?.error_code || text.slice(0, 200);
      throw new Error(
        `Confluent REST ${method} ${url.pathname} -> ${res.status} ${detail}`,
      );
    }
    return parsed;
  }

  /** Liveness probe: true only if the cluster answers. */
  async health() {
    const t0 = Date.now();
    await this.#request('/kafka/v3/clusters', { query: { page_size: 1 } });
    return { ok: true, clusterId: this.cfg.clusterId, latencyMs: Date.now() - t0 };
  }

  async listTopics({ limit = 100 } = {}) {
    const r = await this.#request('/kafka/v3/clusters', {
      query: { page_size: limit },
    });
    // The list-topics endpoint lives under the cluster resource path.
    const topics = await this.#request(`/kafka/v3/clusters/${this.cfg.clusterId}/topics`, {
      query: { page_size: limit },
    });
    return { raw: r, topics: topics?.data ?? [] };
  }

  async describeTopic(topic) {
    return this.#request(`/kafka/v3/clusters/${this.cfg.clusterId}/topics/${encodeURIComponent(topic)}`);
  }

  async listConsumerGroups() {
    const r = await this.#request(
      `/kafka/v3/clusters/${this.cfg.clusterId}/consumer-groups`,
      { query: { page_size: 100 } },
    );
    return r?.data ?? [];
  }
}

/**
 * KafkaJS producer/consumer over TLS + SASL.
 * Lazy: the library is required only when a data-plane call is made, so the
 * REST metadata path works in an environment with no native deps installed.
 */
export class ConfluentKafkaClient {
  constructor(cfg = loadConfig()) {
    this.cfg = cfg;
    this.kafka = null;
    this.producer = null;
    this.consumer = null;
  }

  #connect() {
    if (this.kafka) return this.kafka;
    let Kafka;
    try {
      Kafka = require('kafkajs').Kafka;
    } catch {
      throw new ConfluentConfigError(
        'kafkajs is not installed. Run `npm install kafkajs` to use the ' +
        'produce/consume path; the REST metadata client works without it.',
      );
    }

    this.kafka = new Kafka({
      clientId: this.cfg.clientId,
      brokers: this.cfg.bootstrap,
      ssl: this.cfg.tlsCaPath ? { ca: require('node:fs').readFileSync(this.cfg.tlsCaPath, 'utf8') } : true,
      sasl: {
        mechanism: this.cfg.sasl,
        username: this.cfg.apiKey,
        password: this.cfg.apiSecret,
      },
      retry: { initialRetryTime: 300, retries: 5 },
    });
    return this.kafka;
  }

  /**
   * Produce one record. The value is scrubbed by the caller BEFORE this point —
   * this client deliberately does not know about payload shape.
   */
  async produce({ topic, key, value, headers }) {
    if (!this.producer) {
      this.producer = this.#connect().producer({ allowAutoTopicCreation: false });
      await this.producer.connect();
    }
    const messages = [{
      key: key != null ? String(key) : undefined,
      value: typeof value === 'string' ? value : JSON.stringify(value),
      headers: headers ?? undefined,
    }];
    const meta = await this.producer.send({ topic, messages });
    return { topic, partition: meta[0]?.partition, offset: meta[0]?.baseOffset };
  }

  /** Subscribe from a group. `eachMessage` receives already-JSON values. */
  async consume({ topic, groupId, fromBeginning = false, eachMessage }) {
    if (!this.consumer) {
      this.consumer = this.#connect().consumer({ groupId });
      await this.consumer.connect();
    }
    await this.consumer.subscribe({ topic, fromBeginning });
    await this.consumer.run({
      eachMessage: async ({ topic: t, partition, message }) => {
        let parsed = message.value;
        try { parsed = JSON.parse(message.value); } catch { /* keep raw */ }
        await eachMessage({ topic: t, partition, key: message.key, value: parsed, headers: message.headers });
      },
    });
  }

  async disconnect() {
    await this.producer?.disconnect();
    await this.consumer?.disconnect();
    this.producer = null;
    this.consumer = null;
    this.kafka = null;
  }
}

export default { loadConfig, ConfluentRestClient, ConfluentKafkaClient, ConfluentConfigError, EXPECTED_CLUSTER };