/**
 * Usage statistics tracker
 * Records token usage per model, per account, per API key
 * In-memory with periodic summary (no database needed)
 */

const usageRecords = [];
const MAX_RECORDS = 10000;

/**
 * Record a completed request
 */
export function recordUsage(entry) {
  usageRecords.push({
    timestamp: Date.now(),
    model: entry.model || 'unknown',
    account: entry.account || 'unknown',
    apiKey: entry.apiKey ? entry.apiKey.slice(0, 10) + '...' : 'unknown',
    inputTokens: entry.inputTokens || 0,
    outputTokens: entry.outputTokens || 0,
    durationMs: entry.durationMs || 0
  });
  if (usageRecords.length > MAX_RECORDS) {
    usageRecords.splice(0, usageRecords.length - MAX_RECORDS);
  }
}

/**
 * Get usage summary
 */
export function getUsageSummary() {
  const now = Date.now();
  const h1 = now - 3600000;
  const h24 = now - 86400000;
  const h7d = now - 604800000;

  const summaries = {
    last1h: buildSummary(usageRecords.filter(r => r.timestamp >= h1)),
    last24h: buildSummary(usageRecords.filter(r => r.timestamp >= h24)),
    last7d: buildSummary(usageRecords.filter(r => r.timestamp >= h7d)),
    all: buildSummary(usageRecords)
  };

  return summaries;
}

/**
 * Get recent request records
 */
export function getRecentRecords(limit) {
  limit = limit || 50;
  return usageRecords.slice(-limit).reverse().map(r => ({
    time: new Date(r.timestamp).toISOString(),
    model: r.model,
    account: r.account,
    apiKey: r.apiKey,
    input: r.inputTokens,
    output: r.outputTokens,
    total: r.inputTokens + r.outputTokens,
    duration: r.durationMs
  }));
}

/**
 * Get per-model breakdown
 */
export function getModelBreakdown(hoursBack) {
  hoursBack = hoursBack || 24;
  const cutoff = Date.now() - hoursBack * 3600000;
  const filtered = usageRecords.filter(r => r.timestamp >= cutoff);
  const byModel = {};

  for (const r of filtered) {
    if (!byModel[r.model]) {
      byModel[r.model] = { requests: 0, inputTokens: 0, outputTokens: 0, totalDurationMs: 0 };
    }
    const m = byModel[r.model];
    m.requests++;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.totalDurationMs += r.durationMs;
  }

  return byModel;
}

function buildSummary(records) {
  if (records.length === 0) {
    return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, avgDurationMs: 0 };
  }

  let input = 0, output = 0, dur = 0;
  for (const r of records) {
    input += r.inputTokens;
    output += r.outputTokens;
    dur += r.durationMs;
  }

  return {
    requests: records.length,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    avgDurationMs: Math.round(dur / records.length)
  };
}
