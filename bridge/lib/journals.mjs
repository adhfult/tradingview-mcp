/**
 * Whitelisted dashboard summaries for untrusted gauntlet reports and paper journals.
 * Required fields are validated and copied into fresh, bounded objects.
 */
export const TIMEFRAME_BY_INTERVAL = { '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
export const PAPER_EVENT_LIMIT = 50;

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const finiteOrNull = (value) => Number.isFinite(value) ? value : null;

/** Parses an untrusted report into a bounded dashboard summary. */
export const parseGauntletReport = (text, options = {}) => {
  try {
    if (typeof text !== 'string') return null;

    const fileFingerprint = options?.fileFingerprint;
    if (typeof fileFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fileFingerprint)) return null;

    const report = JSON.parse(text);
    if (!isPlainObject(report) || report.fingerprint !== fileFingerprint) return null;
    if (!isPlainObject(report.inputs) || typeof report.inputs.strategy !== 'string') return null;
    if (typeof report.created_utc !== 'string' || typeof report.verdict !== 'string') return null;
    if (!Array.isArray(report.gates)) return null;

    const tvSymbol = report.inputs.tv_symbol;
    const symbol = typeof tvSymbol === 'string' && tvSymbol.length > 0 ? tvSymbol : report.inputs.symbol;
    const interval = report.inputs.interval;
    if (typeof symbol !== 'string' || typeof interval !== 'string') return null;

    const gates = [];
    for (const item of report.gates) {
      if (!isPlainObject(item) || typeof item.gate !== 'string' || typeof item.status !== 'string') continue;
      gates.push({ gate: item.gate.slice(0, 64), status: item.status.slice(0, 64) });
      if (gates.length === 20) break;
    }

    return {
      fingerprint: fileFingerprint,
      created_utc: report.created_utc.slice(0, 200),
      strategy: report.inputs.strategy.slice(0, 200),
      symbol: symbol.slice(0, 200),
      interval: interval.slice(0, 200),
      timeframe: Object.hasOwn(TIMEFRAME_BY_INTERVAL, interval) ? TIMEFRAME_BY_INTERVAL[interval] : null,
      verdict: report.verdict.slice(0, 200),
      gates,
    };
  } catch {
    return null;
  }
};

/** Parses JSON Lines into bounded paper-journal events. */
export const parsePaperJournal = (text, options = {}) => {
  try {
    if (typeof text !== 'string') return [];

    const requestedLimit = options?.limit;
    const limit = requestedLimit === undefined
      ? PAPER_EVENT_LIMIT
      : Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : PAPER_EVENT_LIMIT;
    const events = [];

    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(event) || !['start', 'entry', 'exit', 'summary'].includes(event.type)) continue;

      events.push({
        ts: typeof event.ts === 'string' ? event.ts.slice(0, 200) : null,
        type: event.type,
        price: finiteOrNull(event.price),
        bar_time: finiteOrNull(event.bar_time),
        return_pct: finiteOrNull(event.return_pct),
      });
    }

    return limit === 0 ? [] : events.slice(-limit);
  } catch {
    return [];
  }
};
