/**
 * Voyage AI Embedding Helper Module
 * Story MY-1.4
 *
 * Reusable module for embedding text via the Voyage AI API.
 * Uses voyage-3-large model, returns 1024-dimensional vectors.
 *
 * Exports:
 *   embedText(text, inputType)      — Single text embedding -> number[1024]
 *   embedBatch(texts, inputType)    — Batch embedding -> number[][1024]
 *   getUsageStats()                 — Session token/cost stats
 *   resetUsageStats()               — Reset session counters
 *
 * Environment:
 *   VOYAGE_API_KEY — Required API key for Voyage AI
 *
 * Usage:
 *   import { embedText, embedBatch, getUsageStats } from './lib/voyage-embed.mjs';
 *   const vector = await embedText('some text', 'document');
 *   const vectors = await embedBatch(['a', 'b'], 'document');
 *   console.log(getUsageStats());
 *
 * @module voyage-embed
 */

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
export const VOYAGE_MODEL = 'voyage-3-large';
export const EMBEDDING_DIM = 1024;
const MAX_BATCH_SIZE = 128;
const MAX_RETRIES = 3;
const COST_PER_MILLION_TOKENS = 0.06;

/** Retryable HTTP status codes */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Session-level usage tracking */
let sessionStats = {
  totalTokens: 0,
  totalCost: 0,
  callCount: 0,
};

/**
 * Get the Voyage API key from environment.
 * @returns {string}
 */
function getApiKey() {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error(
      'VOYAGE_API_KEY environment variable is not set. ' +
        'Set it on the EC2 instance: export VOYAGE_API_KEY="your-key-here"'
    );
  }
  return key;
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call the Voyage AI embedding API with retry logic and exponential backoff.
 *
 * Retries on HTTP 429, 500, 502, 503, 504. Max 3 attempts.
 * Backoff: 1s, 2s, 4s.
 *
 * @param {string|string[]} input — Text or array of texts to embed
 * @param {string} inputType — 'document' or 'query'
 * @returns {Promise<{embeddings: number[][], totalTokens: number}>}
 */
async function callVoyageApi(input, inputType) {
  const apiKey = getApiKey();
  const body = {
    model: VOYAGE_MODEL,
    input: Array.isArray(input) ? input : [input],
    input_type: inputType,
  };

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(VOYAGE_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const responseBody = await response.text();
        const errMsg = `Voyage AI API returned HTTP ${response.status}: ${responseBody}`;

        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
          const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
          console.log(
            `[voyage-embed] Retry ${attempt}/${MAX_RETRIES} after HTTP ${response.status}, waiting ${delayMs}ms...`
          );
          lastError = new Error(errMsg);
          await sleep(delayMs);
          continue;
        }

        throw new Error(errMsg);
      }

      const data = await response.json();

      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Voyage AI API returned unexpected response format: missing data array');
      }

      // Sort by index to maintain input order
      const sorted = data.data.sort((a, b) => a.index - b.index);
      const embeddings = sorted.map((item) => item.embedding);
      const totalTokens = data.usage?.total_tokens || 0;

      // Validate embedding dimensions
      for (let i = 0; i < embeddings.length; i++) {
        if (!embeddings[i] || embeddings[i].length !== EMBEDDING_DIM) {
          throw new Error(
            `Embedding at index ${i} has ${embeddings[i]?.length ?? 0} dimensions, expected ${EMBEDDING_DIM}`
          );
        }
      }

      return { embeddings, totalTokens };
    } catch (err) {
      lastError = err;

      // Retry on network/fetch errors (not validation errors)
      const isRetryable =
        err.message.includes('HTTP 429') ||
        err.message.includes('HTTP 500') ||
        err.message.includes('HTTP 502') ||
        err.message.includes('HTTP 503') ||
        err.message.includes('HTTP 504') ||
        err.message.includes('fetch failed') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('ETIMEDOUT');

      if (isRetryable && attempt < MAX_RETRIES) {
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        console.log(
          `[voyage-embed] Retry ${attempt}/${MAX_RETRIES}: ${err.message.slice(0, 100)}, waiting ${delayMs}ms...`
        );
        await sleep(delayMs);
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('Voyage AI API call failed after all retries');
}

/**
 * Embed a single text string.
 *
 * @param {string} text — The text to embed
 * @param {'document'|'query'} inputType — 'document' for articles, 'query' for search queries
 * @returns {Promise<number[]>} — 1024-dimensional embedding vector
 */
export async function embedText(text, inputType = 'document') {
  if (!text || typeof text !== 'string') {
    throw new Error('embedText requires a non-empty string input');
  }

  if (inputType !== 'document' && inputType !== 'query') {
    throw new Error(`Invalid input_type "${inputType}". Must be "document" or "query".`);
  }

  const { embeddings, totalTokens } = await callVoyageApi(text, inputType);
  const cost = (totalTokens / 1_000_000) * COST_PER_MILLION_TOKENS;

  // Update session stats
  sessionStats.totalTokens += totalTokens;
  sessionStats.totalCost += cost;
  sessionStats.callCount += 1;

  console.log(
    `[voyage-embed] Embedded 1 text, ${totalTokens} tokens, cost ~$${cost.toFixed(6)}`
  );

  return embeddings[0];
}

/**
 * Embed a batch of text strings.
 * Automatically chunks into multiple API calls if input exceeds 128.
 *
 * @param {string[]} texts — Array of texts to embed
 * @param {'document'|'query'} inputType — 'document' for articles, 'query' for search queries
 * @returns {Promise<number[][]>} — Array of 1024-dimensional embedding vectors (same order as input)
 */
export async function embedBatch(texts, inputType = 'document') {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('embedBatch requires a non-empty array of strings');
  }

  if (inputType !== 'document' && inputType !== 'query') {
    throw new Error(`Invalid input_type "${inputType}". Must be "document" or "query".`);
  }

  // Filter out empty strings but track their indices for zero-fill
  const validEntries = [];
  const emptyIndices = new Set();

  for (let i = 0; i < texts.length; i++) {
    if (texts[i] && typeof texts[i] === 'string' && texts[i].trim().length > 0) {
      validEntries.push({ originalIndex: i, text: texts[i] });
    } else {
      emptyIndices.add(i);
    }
  }

  if (validEntries.length === 0) {
    throw new Error('embedBatch requires at least one non-empty string');
  }

  // Chunk into batches of MAX_BATCH_SIZE
  const chunks = [];
  for (let i = 0; i < validEntries.length; i += MAX_BATCH_SIZE) {
    chunks.push(validEntries.slice(i, i + MAX_BATCH_SIZE));
  }

  let totalTokensAll = 0;
  const allEmbeddings = new Array(texts.length).fill(null);

  // Process each chunk
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const chunkTexts = chunk.map((e) => e.text);

    if (chunks.length > 1) {
      console.log(
        `[voyage-embed] Processing batch chunk ${chunkIdx + 1}/${chunks.length} (${chunkTexts.length} texts)...`
      );
    }

    const { embeddings, totalTokens } = await callVoyageApi(chunkTexts, inputType);
    totalTokensAll += totalTokens;

    // Place embeddings back into their original positions
    for (let i = 0; i < chunk.length; i++) {
      allEmbeddings[chunk[i].originalIndex] = embeddings[i];
    }
  }

  // For empty string entries, fill with zero vectors
  for (const idx of emptyIndices) {
    allEmbeddings[idx] = new Array(EMBEDDING_DIM).fill(0);
  }

  const cost = (totalTokensAll / 1_000_000) * COST_PER_MILLION_TOKENS;

  // Update session stats
  sessionStats.totalTokens += totalTokensAll;
  sessionStats.totalCost += cost;
  sessionStats.callCount += chunks.length;

  console.log(
    `[voyage-embed] Embedded ${texts.length} texts (${chunks.length} API call${chunks.length > 1 ? 's' : ''}), ${totalTokensAll} tokens, cost ~$${cost.toFixed(6)}`
  );

  return allEmbeddings;
}

/**
 * Get session-level usage statistics.
 *
 * @returns {{ totalTokens: number, totalCost: number, callCount: number }}
 */
export function getUsageStats() {
  return { ...sessionStats };
}

/**
 * Reset session-level usage statistics.
 */
export function resetUsageStats() {
  sessionStats = { totalTokens: 0, totalCost: 0, callCount: 0 };
}

// Re-export constants for external use
export { VOYAGE_MODEL, EMBEDDING_DIM, MAX_BATCH_SIZE };
