/**
 * GitHub -> Confluent Cloud bridge.
 *
 * github-integration-service already receives signed webhooks. This publishes
 * them to cluster lkc-gqx1kx3 WITHOUT letting a credential or a webhook signature
 * reach the broker:
 *
 *   - the signature is verified before this module is called, and the raw
 *     `x-hub-signature-256` header is never forwarded;
 *   - every payload is scrubbed (github-events.scrub.mjs) on the producer side,
 *     so an accidental committed PAT does not become durable Kafka retention;
 *   - if Kafka is unconfigured or the broker is down, the webhook still
 *     returns 200 to GitHub and the event is logged as dropped. A monitoring
 *     system should not see a delivery failure for a non-critical audit stream.
 *
 * Delivery failure is surfaced through `stats`, not by throwing into the
 * request path — losing an event is observable, breaking GitHub's retries is not.
 */

import { ConfluentKafkaClient, ConfluentRestClient, loadConfig, ConfluentConfigError } from './confluent-client.mjs';
import { scrubEvent } from './github-events.scrub.mjs';

export const DEFAULT_TOPIC = 'github.webhook.events.v1';

export class GithubEventPublisher {
  /**
   * @param {{topic?: string, env?: NodeJS.ProcessEnv}} [opts]
   */
  constructor(opts = {}) {
    this.topic = opts.topic || DEFAULT_TOPIC;
    this.env = opts.env || process.env;
    this.enabled = false;
    this.reason = 'not initialised';
    this.producer = null;
    this.stats = { published: 0, scrubbed: 0, dropped: 0, errors: 0, lastError: null };
  }

  /**
   * Attempt to attach a producer. Never throws: an unconfigured cluster must
   * not stop the webhook service from booting.
   */
  async init() {
    try {
      this.cfg = loadConfig(this.env);
      this.producer = new ConfluentKafkaClient(this.cfg);
      // Prove connectivity now rather than on the first webhook, so the
      // health endpoint can report the truth.
      await this.producer.producer?.connect?.();
      this.enabled = true;
      this.reason = `connected to ${this.cfg.clusterId}`;
    } catch (err) {
      this.enabled = false;
      this.reason = err instanceof ConfluentConfigError ? err.message : `${err.name}: ${err.message}`;
    }
    return this;
  }

  /**
   * Publish one verified webhook event.
   * @param {Record<string, unknown>} event  the verified, parsed GitHub payload
   * @param {{eventType?: string, deliveryId?: string}} [meta]
   * @returns {Promise<{published: boolean, reason?: string}>}
   */
  async publish(event, meta = {}) {
    if (!this.enabled || !this.producer) {
      this.stats.dropped += 1;
      return { published: false, reason: this.reason };
    }

    // Scrub BEFORE any network call. A record that reaches kafkajs unsanitized
    // is already too late to fix cheaply.
    const record = scrubEvent({
      topic: this.topic,
      key: `${event?.repository?.full_name ?? 'unknown'}:${event?.type ?? 'unknown'}`,
      headers: {
        'event-type': meta.eventType ?? event?.type ?? null,
        'delivery-time': String(meta.deliveryId ?? ''),
      },
      value: event,
    });
    this.stats.scrubbed += 1;

    try {
      await this.producer.produce({
        topic: this.topic,
        key: record.key,
        value: record.value,
        headers: { 'event-type': record.headers['event-type'], 'scrubbed': 'true' },
      });
      this.stats.published += 1;
      return { published: true };
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastError = err.message;
      this.stats.dropped += 1;
      return { published: false, reason: err.message };
    }
  }

  /** Health payload for GET /health. */
  status() {
    return {
      kafka: {
        enabled: this.enabled,
        topic: this.topic,
        cluster: this.cfg?.clusterId ?? null,
        reason: this.enabled ? null : this.reason,
        ...this.stats,
      },
    };
  }

  async close() {
    await this.producer?.disconnect();
    this.producer = null;
    this.enabled = false;
  }
}

export async function clusterHealth(env = process.env, fetchImpl = globalThis.fetch) {
  try {
    const cfg = loadConfig(env);
    return { ok: true, ...(await new ConfluentRestClient(cfg, { fetchImpl }).health()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default GithubEventPublisher;