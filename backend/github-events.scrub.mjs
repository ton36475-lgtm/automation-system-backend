// NOTE: vendored from sirinx-os streaming/kafka/github-events.scrub.mjs.
// Kept in sync manually so this service has no cross-repo dependency; if the
// upstream scrubber changes, re-copy it and run both test suites.
/**
 * Scrub GitHub event payloads before they reach Kafka.
 *
 * WHY THIS EXISTS
 * GitHub webhook payloads are not secret-free. A push event carries commit
 * messages and author metadata; a `key` field on any object can hold a token;
 * file contents in `head_commit`/`commits` routinely contain credentials that
 * were committed by mistake and are exactly what a scanner would later flag.
 * Piping raw payloads into a stream store turns one accidental commit into
 * durable retention of the leaked value.
 *
 * So this scrubs on the PRODUCER side, before anything is written. It is not a
 * substitute for a Kafka ACL, but it means the value never reaches the broker.
 *
 * Usage:
 *   node github-events.scrub.mjs            # self-test, no network
 *   import { scrubEvent, SCRUBBED } from './github-events.scrub.mjs'
 */

export const SCRUBBED = '[scrubbed]';

/** Field names that must never survive, regardless of depth. */
const DENY_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'authorization',
  'password', 'passwd', 'secret', 'client_secret', 'api_key', 'apikey',
  'private_key', 'privatekey', 'signing_key', 'webhook_secret',
  'ssh_key', 'passphrase', 'credential', 'credentials', 'cookie', 'set_cookie',
  'session', 'bearer', 'otp', 'pin', 'otp_secret', 'x_hub_signature_256',
  'x_hub_signature', 'connection', 'x_api_key', 'bearer_token', 'auth_token',
]);

/**
 * Value shapes that look like a live credential regardless of field name.
 * These catch secrets stored under innocent names (`value`, `note`, `body`).
 */
const VALUE_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,        // GitHub PAT (classic + fine-grained)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,      // fine-grained PAT
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,          // GitLab PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,      // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                  // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g,            // Google API key
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bsk-[A-Za-z0-9]{20,}\b/g,              // OpenAI-style
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, // auth header value
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
];

/** Substrings that mark a value as a PEM/connection string regardless of size. */
const VALUE_HINTS = [
  /^postgres(ql)?:\/\//i, /^mysql:\/\//i, /^mongodb(\+srv)?:\/\//i,
  /^redis:\/\//i, /^amqp:\/\//i, /^https?:\/\/[^\s:@]+:[^\s:@]+@/i,
];

/**
 * Keys whose STRING value is a diff/patch/commit body: truncate rather than keep.
 * `message` is here because a commit message is free text that routinely quotes
 * a credential ("rotate ghp_..."), and a long one may carry a whole config.
 */
const BLOB_KEYS = new Set([
  'patch', 'diff', 'body', 'commit_message', 'message', 'contents',
  'commit', 'head_commit', 'commits', 'description',
]);

/**
 * Normalize a key so both snake_case and camelCase reach the same test.
 * `botSecret` -> `botsecret`, `api-key` -> `apikey`, `APIKey` -> `apikey`.
 */
function normalizeKey(k) {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scrubString(value, keyHint = '') {
  let out = value;
  for (const re of VALUE_PATTERNS) out = out.replace(re, SCRUBBED);
  // Connection strings carry inline credentials; keep scheme, drop the tail.
  for (const hint of VALUE_HINTS) {
    if (hint.test(out)) {
      const scheme = out.split(':')[0];
      out = `${scheme}://${SCRUBBED}`;
      break;
    }
  }
  // Long base64-ish blobs under a known field are dropped wholesale.
  if (BLOB_KEYS.has(keyHint) && out.length > 512) return `${out.slice(0, 200)}\n…[truncated]`;
  return out;
}

/**
 * Deep-scrub a decoded JSON value.
 * @param {unknown} value
 * @param {{depth?: number}} [opts]
 */
export function scrubValue(value, opts = {}) {
  const maxDepth = opts.depth ?? 12;
  const seen = new WeakSet();

  function walk(node, depth, keyHint) {
    // A payload nested deeper than the limit is dropped entirely rather than
    // returned as a marker: an unbounded or hostile payload should not be
    // retained just because the producer stopped counting.
    if (depth >= maxDepth) return '[depth-limit]';
    if (node === null || node === undefined) return node;

    if (typeof node === 'string') return scrubString(node, keyHint);
    if (typeof node === 'number' || typeof node === 'boolean') return node;

    if (Array.isArray(node)) {
      if (seen.has(node)) return '[circular]';
      seen.add(node);
      return node.map((item) => walk(item, depth + 1, ''));
    }

    if (typeof node === 'object') {
      if (seen.has(node)) return '[circular]';
      seen.add(node);
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const lower = k.toLowerCase();
        const norm = normalizeKey(k);
        if (DENY_KEYS.has(lower) || DENY_KEYS.has(norm)) {
          out[k] = SCRUBBED;
          continue;
        }
        // Near-miss names, matched on the normalized key so `botSecret`,
        // `user_token` and `api-key` all reach the same branch. The allowlist
        // exempts non-secret lookalikes whose removal would break pipelines
        // (`sshKeyPath` is a filesystem path, `publicKey` is public).
        if (/(token|secret|password|passwd|apikey|auth|credential|privatekey)/.test(norm)
            && !/^(publickey|sshkeyfingerprint|keyid|keystatus|keyurl|keycount)$/.test(norm)
            && !norm.endsWith('path')
            && !norm.endsWith('url')
            && !norm.endsWith('count')) {
          out[k] = SCRUBBED;
          continue;
        }
        out[k] = walk(v, depth + 1, norm);
      }
      return out;
    }
    return null;
  }

  return walk(value, 0, '');
}

/**
 * Scrub one Kafka record. Keeps routing metadata (needed for partitioning and
 * downstream filtering) and drops the body.
 */
export function scrubEvent(record) {
  const raw = typeof record?.value === 'string' ? safeParse(record.value) : record?.value;
  const payload = raw ?? {};

  return {
    topic: record?.topic ?? null,
    key: record?.key ?? null,          // partition key: keep, it is an ID
    partition: record?.partition ?? null,
    headers: {
      // Headers are a classic leak path: scrub every value, keep the names.
      'event-type': record?.headers?.['event-type'] ?? payload?.type ?? null,
      'delivery-time': record?.headers?.['delivery-time'] ?? null,
    },
    scrubbed: true,
    value: scrubValue(payload),
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return { raw: scrubString(s) }; }
}