/* ezCLI usage parser — a tiny, dependency-free reader for explicit usage
 * records printed by local CLIs. It never estimates unreported tokens/costs. */
(function attachUsageParser(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ezCliUsage = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function usageParser() {
  const METRICS = ['input', 'output', 'cached', 'cost'];
  const ANSI = /\x1b(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|\x9b[0-?]*[ -/]*[@-~]/g;
  const NUMBER = '([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?\\s*[kKmM]?)';
  const PREFIX = '(?:^|[^A-Za-z0-9_])';
  const LABELS = {
    input: new RegExp(PREFIX + '(?:["\']?input(?:[_\\s-]*tokens?)?["\']?|["\']?prompt(?:[_\\s-]*tokens?)?["\']?)\\s*[:=]\\s*["\']?' + NUMBER, 'ig'),
    output: new RegExp(PREFIX + '(?:["\']?output(?:[_\\s-]*tokens?)?["\']?|["\']?completion(?:[_\\s-]*tokens?)?["\']?|["\']?reasoning(?:[_\\s-]*output)(?:[_\\s-]*tokens?)?["\']?)\\s*[:=]\\s*["\']?' + NUMBER, 'ig'),
    cached: new RegExp(PREFIX + '["\']?(?:cached?|cache)(?:[_\\s-]*(?:read|creation|input|tokens?))*["\']?\\s*[:=]\\s*["\']?' + NUMBER, 'ig'),
    cost: new RegExp(PREFIX + '["\']?(?:total[_\\s-]*)?(?:estimated[_\\s-]*)?cost(?:[_\\s-]*usd)?["\']?\\s*[:=]?\\s*(?:USD\\s*)?\\$?\\s*' + NUMBER, 'ig')
  };

  function emptyMetrics() {
    return { input: null, output: null, cached: null, cost: null };
  }

  function parseNumber(raw) {
    const match = String(raw).replace(/[\s,]/g, '').match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
    if (!match) return null;
    const multiplier = match[2] ? ({ k: 1e3, m: 1e6 }[match[2].toLowerCase()]) : 1;
    const value = Number(match[1]) * multiplier;
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function stripAnsi(value) {
    return String(value || '').replace(ANSI, '');
  }

  function tokenMetrics(metrics) {
    return ['input', 'output', 'cached'].filter((metric) => metrics[metric] != null);
  }

  function metricCount(metrics) {
    return METRICS.filter((metric) => metrics[metric] != null).length;
  }

  function addMetric(target, metric, value) {
    if (value == null) return;
    target[metric] = (target[metric] || 0) + value;
  }

  function labelledMetrics(line) {
    const metrics = emptyMetrics();
    for (const metric of METRICS) {
      LABELS[metric].lastIndex = 0;
      for (const match of line.matchAll(LABELS[metric])) addMetric(metrics, metric, parseNumber(match[1]));
    }
    return metrics;
  }

  function normalizedFingerprint(kind, metrics) {
    return kind + ':' + METRICS.map((metric) => metric + '=' + (metrics[metric] ?? '')).join(';');
  }

  function numericField(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  function incrementalValue(current, previous) {
    // JSON telemetry can contain decimal currency. Keep a presentation-safe
    // delta instead of exposing binary floating-point residue in the footer.
    return Number(Math.max(0, current - previous).toFixed(12));
  }

  function structuredRecord(line) {
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object' || !data.usage || typeof data.usage !== 'object') return null;

    const usage = data.usage;
    const metrics = emptyMetrics();
    let scopes = {};
    if (data.type === 'result') {
      metrics.input = numericField(usage.input_tokens);
      metrics.output = numericField(usage.output_tokens);
      const cacheRead = numericField(usage.cache_read_input_tokens);
      const cacheCreated = numericField(usage.cache_creation_input_tokens);
      if (cacheRead != null || cacheCreated != null) metrics.cached = (cacheRead || 0) + (cacheCreated || 0);
      metrics.cost = numericField(data.total_cost_usd);
      // Claude result token fields describe the completed turn while its cost
      // is a running total, so only cost is a session snapshot.
      scopes = { cost: 'session' };
    } else if (data.type === 'turn.completed') {
      metrics.input = numericField(usage.input_tokens);
      metrics.output = (numericField(usage.output_tokens) || 0) + (numericField(usage.reasoning_output_tokens) || 0);
      const cached = numericField(usage.cached_input_tokens);
      if (cached != null) metrics.cached = cached;
    } else {
      return null;
    }
    if (!metricCount(metrics)) return null;
    return {
      metrics,
      scope: 'turn',
      scopes,
      fingerprint: normalizedFingerprint(data.type, metrics)
    };
  }

  function textRecord(metrics, scope) {
    if (metricCount(metrics) < 2) return null;
    return {
      metrics,
      scope,
      scopes: {},
      fingerprint: normalizedFingerprint(scope, metrics)
    };
  }

  function createUsageState() {
    return {
      buffer: '',
      textBlock: null,
      observed: false,
      total: emptyMetrics(),
      turn: emptyMetrics(),
      updatedAt: 0,
      lastFingerprint: '',
      lastFingerprintAt: 0
    };
  }

  function remember(state, fingerprint) {
    const now = Date.now();
    // Terminals redraw their status row repeatedly. Suppress only an immediate
    // repeat so genuinely separate turns with identical usage still count.
    if (state.lastFingerprint === fingerprint && now - state.lastFingerprintAt < 1200) return false;
    state.lastFingerprint = fingerprint;
    state.lastFingerprintAt = now;
    return true;
  }

  function apply(state, parsed) {
    if (!remember(state, parsed.fingerprint)) return false;
    const turn = emptyMetrics();
    for (const metric of METRICS) {
      const value = parsed.metrics[metric];
      if (value == null) continue;
      const scope = parsed.scopes[metric] || parsed.scope;
      if (scope === 'session') {
        const previous = state.total[metric];
        turn[metric] = previous == null ? value : incrementalValue(value, previous);
        state.total[metric] = value;
      } else {
        turn[metric] = value;
        state.total[metric] = (state.total[metric] || 0) + value;
      }
    }
    state.turn = turn;
    state.observed = true;
    state.updatedAt = Date.now();
    return true;
  }

  function flushTextBlock(state) {
    if (!state.textBlock) return false;
    const block = state.textBlock;
    state.textBlock = null;
    const parsed = textRecord(block.metrics, block.scope);
    return parsed ? apply(state, parsed) : false;
  }

  function handleLine(state, raw) {
    const line = stripAnsi(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (!line || line.length > 6000) return flushTextBlock(state);

    const structured = structuredRecord(line);
    if (structured) {
      const flushed = flushTextBlock(state);
      return apply(state, structured) || flushed;
    }

    const metrics = labelledMetrics(line);
    if (!metricCount(metrics)) return flushTextBlock(state);
    const scope = /\b(?:total|session|cumulative)\b|(?:total|session|cumulative)[_\s-]*(?:tokens?|cost)/i.test(line)
      ? 'session'
      : 'turn';
    state.textBlock ||= { metrics: emptyMetrics(), scope };
    for (const metric of METRICS) {
      if (metrics[metric] != null) state.textBlock.metrics[metric] = metrics[metric];
    }
    if (scope === 'session') state.textBlock.scope = 'session';
    // A complete labelled summary on one terminal row is safe to report now.
    return metricCount(metrics) >= 2 ? flushTextBlock(state) : false;
  }

  function ingest(state, chunk, flush) {
    // Keep raw terminal bytes until a full line is available; an ANSI control
    // sequence or JSON field can be split over any two PTY chunks.
    const text = state.buffer + String(chunk || '');
    const lines = text.split(/\r\n|[\r\n]/);
    const endsAtBoundary = /(?:\r\n|[\r\n])$/.test(text);
    if (flush || endsAtBoundary) {
      state.buffer = '';
      // The final empty item is the separator's sentinel, not a blank line.
      // Keep any earlier empty item: that is an intentional blank separator
      // for a multi-line usage summary.
      if (endsAtBoundary) lines.pop();
    } else {
      state.buffer = (lines.pop() || '').slice(-6000);
    }
    let changed = false;
    for (const line of lines) if (handleLine(state, line)) changed = true;
    if (flush && flushTextBlock(state)) changed = true;
    return changed;
  }

  function parseLine(raw) {
    const line = stripAnsi(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    return structuredRecord(line) || textRecord(labelledMetrics(line), /\b(?:total|session|cumulative)\b/i.test(line) ? 'session' : 'turn');
  }

  function tokenTotal(metrics) {
    return tokenMetrics(metrics).reduce((sum, metric) => sum + (metrics[metric] || 0), 0);
  }

  function formatTokens(value) {
    if (value == null) return '—';
    if (value >= 1e6) return (value / 1e6).toFixed(value % 1e6 ? 1 : 0) + 'm';
    if (value >= 1e3) return (value / 1e3).toFixed(value % 1e3 ? 1 : 0) + 'k';
    return String(Math.round(value));
  }

  function formatCost(value) {
    if (value == null) return '—';
    if (value < 0.01) return '$' + value.toFixed(3);
    return '$' + value.toFixed(2);
  }

  return { createUsageState, formatCost, formatTokens, ingest, parseLine, tokenTotal };
});
