/**
 * Indicator maths for the watcher. These mirror the Python functions in
 * src/tradingview_mcp/core/services/indicators_calc.py exactly (same seeds, same
 * nulls, same smoothing). bridge/test/fixtures/indicators.json holds Python
 * outputs, and a test checks that these functions agree with them.
 *
 * Every function returns arrays the same length as its input. Positions before
 * the first valid value hold null. Inputs are plain numbers (no NaN checks here:
 * candles come from the library).
 */

/** Simple moving average. The first period-1 values are null. */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    out[i] = sumRange(values, i - period + 1, i + 1) / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` values. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  out[period - 1] = sumRange(values, 0, period) / period;
  for (let i = period; i < values.length; i += 1) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Wilder RSI. The first `period` values are null; RSI is 100 when average loss is 0. */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    avgGain += Math.max(diff, 0);
    avgLoss += Math.max(-diff, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiValue(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

function rsiValue(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Bollinger bands: middle is the SMA, and the deviation is the POPULATION standard
 * deviation (divided by period), as in the Python code.
 */
export function bollinger(closes, period = 20, stddev = 2) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i += 1) {
    const mean = middle[i];
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = closes[j] - mean;
      sumSq += d * d;
    }
    const std = Math.sqrt(sumSq / period);
    upper[i] = mean + stddev * std;
    lower[i] = mean - stddev * std;
  }
  return { upper, middle, lower };
}

/**
 * Average True Range (Wilder). TR starts at index 1. The seed is the mean of the
 * first `period` TRs, placed at index `period`.
 */
export function atr(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;

  const trs = [];
  for (let i = 1; i < n; i += 1) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }

  let value = sumRange(trs, 0, period) / period;
  out[period] = value;
  for (let i = period + 1; i < n; i += 1) {
    value = (value * (period - 1) + trs[i - 1]) / period;
    out[i] = value;
  }
  return out;
}

function sumRange(values, from, to) {
  let total = 0;
  for (let i = from; i < to; i += 1) total += values[i];
  return total;
}
