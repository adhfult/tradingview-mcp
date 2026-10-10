import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer } from '../server.mjs';

// Fake library: records every call (query as `args`, second argument as `opts`)
// and returns canned data. Nothing here touches the network.
function fakeLib(overrides = {}) {
  const calls = [];
  const clients = [];

  class TradingViewClient {
    constructor(options) {
      this.options = options;
      this.closeCount = 0;
      clients.push(this);
    }

    async close() {
      this.closeCount += 1;
    }
  }

  const defaults = {
    getCandles: () => [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, extra: 'dropped' }],
    getQuotes: (q) => Object.fromEntries(q.symbols.map((s) => [s, { lp: 1 }])),
    getIndicatorData: () => ({
      indicator: { description: 'Fake RSI' },
      candles: [],
      values: [],
      graphics: {},
      strategyReport: {},
    }),
    getSymbolInfo: () => ({ symbol: 'BTCUSD' }),
    searchMarkets: () => [],
    getScreener: () => ({ totalCount: 0, rows: [] }),
    getHotlist: () => ({ totalCount: 0, rows: [] }),
    getTechnicalAnalysis: () => null,
    summarizeStrategyReport: (report) => ({ tradeRecordCount: report.trades?.length ?? 0 }),
  };

  const lib = { TradingViewClient };
  for (const name of Object.keys(defaults)) {
    const impl = overrides[name] ?? defaults[name];
    lib[name] = (args, opts) => {
      calls.push({ name, args, opts });
      return impl(args, opts);
    };
  }
  return { lib, calls, clients, callsTo: (name) => calls.filter((c) => c.name === name) };
}

function harness(t, { lib, env = {}, deadlineGraceMs } = {}) {
  const written = [];
  const logs = [];
  const input = new PassThrough();
  const server = createServer({
    lib,
    env,
    input,
    output: { write: (chunk) => { written.push(chunk); return true; } },
    log: (message) => logs.push(message),
    ...(deadlineGraceMs === undefined ? {} : { deadlineGraceMs }),
  });
  t.after(async () => {
    input.end();
    await server.close();
  });

  const request = async (req) => {
    const before = written.length;
    await server.handleLine(typeof req === 'string' ? req : JSON.stringify(req));
    assert.equal(written.length, before + 1, 'exactly one output line per request');
    assert.ok(written[before].endsWith('\n'), 'output line ends with a newline');
    return JSON.parse(written[before]);
  };

  return { server, request, written, logs, input };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('health reports version and credential presence, without echoing secrets', async (t) => {
  const { lib } = fakeLib();
  const cases = [
    [{ TRADINGVIEW_SESSION_ID: 'fake-session-id', TRADINGVIEW_SESSION_SIGN: 'fake-sign-value' }, true],
    [{ TRADINGVIEW_SESSION_ID: 'fake-session-id' }, false],
    [{ TRADINGVIEW_SESSION_SIGN: 'fake-sign-value' }, false],
    [{ TRADINGVIEW_SESSION_ID: '', TRADINGVIEW_SESSION_SIGN: '' }, false],
    [{}, false],
  ];
  for (const [env, expected] of cases) {
    const h = harness(t, { lib, env });
    const res = await h.request({ id: 1, method: 'health' });
    assert.equal(res.id, 1);
    assert.equal(res.result.ok, true);
    assert.equal(res.result.libVersion, '4.0.0');
    assert.equal(res.result.node, process.version);
    assert.equal(res.result.hasCredentials, expected, JSON.stringify(env));
    assert.ok(!h.written[0].includes('fake-session-id'));
    assert.ok(!h.written[0].includes('fake-sign-value'));
  }
});

test('candles uses count, or from/to/maxCount, and validates input', async (t) => {
  const fake = fakeLib();
  const h = harness(t, { lib: fake.lib });

  let res = await h.request({ id: 1, method: 'candles', params: { symbol: 'binance:btcusdt', timeframe: '60', count: 5 } });
  assert.deepEqual(res.result, [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
  let args = fake.callsTo('getCandles').at(-1).args;
  assert.equal(args.symbol, 'BINANCE:BTCUSDT');
  assert.equal(args.timeframe, '60');
  assert.equal(args.count, 5);
  assert.equal(args.timeoutMs, 15000);
  assert.equal('from' in args, false);

  res = await h.request({ id: 2, method: 'candles', params: { symbol: 'NASDAQ:AAPL', from: 1700000000, to: 1700086400, maxCount: 100 } });
  args = fake.callsTo('getCandles').at(-1).args;
  assert.equal(args.timeframe, 'D', 'timeframe defaults to D');
  assert.equal(args.from, 1700000000);
  assert.equal(args.to, 1700086400);
  assert.equal(args.maxCount, 100);
  assert.equal('count' in args, false);

  const bad = [
    { symbol: 'bad symbol!' },
    { symbol: 'BTCUSD', timeframe: '7' },
    { symbol: 'BTCUSD', count: 0 },
    { symbol: 'BTCUSD', count: 5001 },
    { symbol: 'BTCUSD', count: 5, from: 1700000000 },
    { symbol: 'BTCUSD', to: 1700000000 },
    { symbol: 'BTCUSD', from: 1700000000, to: 1600000000 },
  ];
  for (const params of bad) {
    const r = await h.request({ id: 3, method: 'candles', params });
    assert.equal(r.error.code, 'INVALID_PARAMETER', JSON.stringify(params));
  }
  assert.equal(fake.callsTo('getCandles').length, 2, 'invalid requests never reach the library');
});

test('timeoutMs is clamped for websocket calls', async (t) => {
  const fake = fakeLib();
  const h = harness(t, { lib: fake.lib });
  await h.request({ id: 1, method: 'candles', params: { symbol: 'BTCUSD', timeoutMs: 5 } });
  await h.request({ id: 2, method: 'candles', params: { symbol: 'BTCUSD', timeoutMs: 999999 } });
  const timeouts = fake.callsTo('getCandles').map((c) => c.args.timeoutMs);
  assert.deepEqual(timeouts, [1000, 60000]);
});

test('websocket calls get the shared client; HTTP calls get credentials only where their type allows', async (t) => {
  const fake = fakeLib();
  const h = harness(t, {
    lib: fake.lib,
    env: { TRADINGVIEW_SESSION_ID: 'fake-session', TRADINGVIEW_SESSION_SIGN: 'fake-signature' },
  });
  await h.request({ id: 1, method: 'candles', params: { symbol: 'BTCUSD' } });
  await h.request({ id: 2, method: 'quotes', params: { symbols: ['BTCUSD'] } });
  await h.request({ id: 3, method: 'screener', params: { columns: ['close'] } });
  await h.request({ id: 4, method: 'search', params: { query: 'bitcoin', type: 'crypto' } });

  assert.equal(fake.clients.length, 1, 'one shared client');
  assert.deepEqual(fake.clients[0].options, {
    credentials: { session: 'fake-session', signature: 'fake-signature' },
  });
  assert.equal(fake.callsTo('getCandles')[0].args.client, fake.clients[0]);
  assert.equal(fake.callsTo('getQuotes')[0].args.client, fake.clients[0]);

  const screener = fake.callsTo('getScreener')[0];
  assert.deepEqual(screener.opts.credentials, { session: 'fake-session', signature: 'fake-signature' });

  const search = fake.callsTo('searchMarkets')[0];
  assert.equal(search.args, 'bitcoin');
  assert.equal(search.opts.type, 'crypto');
  assert.equal('credentials' in search.opts, false, 'searchMarkets type has no credentials');
  assert.ok(search.opts.signal instanceof AbortSignal);
});

test('without credentials the client is anonymous', async (t) => {
  const fake = fakeLib();
  const h = harness(t, { lib: fake.lib, env: {} });
  await h.request({ id: 1, method: 'quotes', params: { symbols: ['BTCUSD'] } });
  assert.deepEqual(fake.clients[0].options, {});
});

test('concurrent requests are answered out of order and matched by id', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = fakeLib({ getCandles: async () => { await gate; return []; } });
  const h = harness(t, { lib: fake.lib });

  const slow = h.server.handleLine(JSON.stringify({ id: 'slow', method: 'candles', params: { symbol: 'BTCUSD' } }));
  await h.server.handleLine(JSON.stringify({ id: 'fast', method: 'health' }));
  assert.equal(h.written.length, 1);
  assert.equal(JSON.parse(h.written[0]).id, 'fast');

  release();
  await slow;
  assert.equal(h.written.length, 2);
  assert.equal(JSON.parse(h.written[1]).id, 'slow');
  assert.deepEqual(JSON.parse(h.written[1]).result, []);
});

test('library errors are mapped to bridge codes', async (t) => {
  const fake = fakeLib({
    getCandles: () => { throw Object.assign(new Error('too slow'), { code: 'TIMEOUT' }); },
  });
  const h = harness(t, { lib: fake.lib });
  const res = await h.request({ id: 7, method: 'candles', params: { symbol: 'BTCUSD' } });
  assert.deepEqual(res, { id: 7, error: { code: 'TIMEOUT', message: 'too slow' } });
});

test('error messages and logs are redacted', async (t) => {
  const env = {
    TRADINGVIEW_SESSION_ID: 'fake-session-value',
    TRADINGVIEW_SESSION_SIGN: 'fake-sign-value',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/111/fake-env-token',
  };
  const leaky = 'boom fake-session-value sessionid=abc123; bot123456:ABC-def '
    + 'https://discord.com/api/webhooks/222/other-token';
  const fake = fakeLib({
    getCandles: () => { throw Object.assign(new Error(leaky), { code: 'AUTH_ERROR' }); },
  });
  const h = harness(t, { lib: fake.lib, env });

  const res = await h.request({ id: 9, method: 'candles', params: { symbol: 'BTCUSD' } });
  assert.equal(res.error.code, 'AUTH_FAILED');
  assert.match(res.error.message, /sessionid=\[REDACTED\];/);
  assert.match(res.error.message, /bot\[REDACTED\]/);
  assert.match(res.error.message, /\[REDACTED_WEBHOOK\]/);

  const secrets = ['fake-session-value', 'abc123', 'ABC-def', 'discord.com', 'other-token'];
  const logText = h.logs.join('\n');
  for (const secret of secrets) {
    assert.equal(h.written[0].includes(secret), false, `output must not contain ${secret}`);
    assert.equal(logText.includes(secret), false, `log must not contain ${secret}`);
  }
  assert.ok(logText.includes('AUTH_FAILED'));
});

test('bad JSON gets the id:null error, and an unknown method gets INVALID_PARAMETER', async (t) => {
  const h = harness(t, { lib: fakeLib().lib });
  await h.server.handleLine('{not json');
  assert.equal(h.written[0], '{"id":null,"error":{"code":"INVALID_PARAMETER","message":"invalid JSON"}}\n');

  const res = await h.request({ id: 5, method: 'place_order' });
  assert.deepEqual(res, { id: 5, error: { code: 'INVALID_PARAMETER', message: 'unknown method' } });
});

test('blank lines produce no output', async (t) => {
  const h = harness(t, { lib: fakeLib().lib });
  await h.server.handleLine('   ');
  assert.equal(h.written.length, 0);
});

test('semaphore limits concurrent library calls to the configured maximum', async (t) => {
  const gates = [];
  const fake = fakeLib({
    getCandles: () => new Promise((resolve) => gates.push(() => resolve([]))),
  });
  const h = harness(t, { lib: fake.lib, env: { TRADINGVIEW_BRIDGE_MAX_INFLIGHT: '2' } });

  const tasks = [1, 2, 3].map((id) =>
    h.server.handleLine(JSON.stringify({ id, method: 'candles', params: { symbol: 'BTCUSD' } })));
  await settle();
  assert.equal(fake.callsTo('getCandles').length, 2, 'third call waits');

  gates.shift()();
  await settle();
  assert.equal(fake.callsTo('getCandles').length, 3, 'third call starts after a slot frees');

  gates.forEach((release) => release());
  await Promise.all(tasks);
  assert.equal(h.written.length, 3);
});

test('after a connection error the next call creates a new client', async (t) => {
  let fail = true;
  const fake = fakeLib({
    getCandles: () => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error('socket gone'), { code: 'DISCONNECTED' });
      }
      return [];
    },
  });
  const h = harness(t, { lib: fake.lib });

  const first = await h.request({ id: 1, method: 'candles', params: { symbol: 'BTCUSD' } });
  assert.equal(first.error.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(fake.clients.length, 1);

  const second = await h.request({ id: 2, method: 'candles', params: { symbol: 'BTCUSD' } });
  assert.deepEqual(second.result, []);
  assert.equal(fake.clients.length, 2, 'a new client was constructed');
  assert.equal(fake.clients[0].closeCount, 1, 'the broken client was closed');
  assert.equal(fake.callsTo('getCandles')[1].args.client, fake.clients[1]);
});

test('close() closes the shared client once and is safe to repeat', async (t) => {
  const fake = fakeLib();
  const h = harness(t, { lib: fake.lib });
  await h.request({ id: 1, method: 'quotes', params: { symbols: ['BTCUSD'] } });
  await h.server.close();
  await h.server.close();
  assert.equal(fake.clients[0].closeCount, 1);
});

test('indicator maps values to {time, ...plots}, keeps the last count rows and summarizes strategies', async (t) => {
  const values = [1, 2, 3, 4, 5].map((n) => ({ $time: 1000 + n, plot_0: n * 10 }));
  const fake = fakeLib({
    getIndicatorData: () => ({
      indicator: { description: 'Relative Strength Index' },
      candles: [],
      values,
      graphics: {},
      strategyReport: { trades: [{}, {}] },
    }),
  });
  const h = harness(t, { lib: fake.lib });

  const res = await h.request({
    id: 1,
    method: 'indicator',
    params: { symbol: 'BINANCE:BTCUSDT', indicator: 'STD;RSI', count: 2 },
  });
  assert.deepEqual(res.result, {
    name: 'Relative Strength Index',
    values: [{ time: 1004, plot_0: 40 }, { time: 1005, plot_0: 50 }],
    strategy: { tradeRecordCount: 2 },
  });
  const args = fake.callsTo('getIndicatorData')[0].args;
  assert.equal(args.count, 2);
  assert.equal(args.indicator, 'STD;RSI');
  assert.equal(args.timeframe, 'D');
});

test('indicator strategy is null when the report is missing or summarizing fails', async (t) => {
  const fake = fakeLib({
    getIndicatorData: () => ({ indicator: {}, values: [], strategyReport: undefined }),
  });
  const h = harness(t, { lib: fake.lib });
  let res = await h.request({ id: 1, method: 'indicator', params: { symbol: 'BTCUSD', indicator: 'STD;RSI' } });
  assert.equal(res.result.strategy, null);
  assert.equal(res.result.name, null);

  const failing = fakeLib({
    getIndicatorData: () => ({ indicator: {}, values: [], strategyReport: { trades: [] } }),
    summarizeStrategyReport: () => { throw new Error('bad report'); },
  });
  const h2 = harness(t, { lib: failing.lib });
  res = await h2.request({ id: 2, method: 'indicator', params: { symbol: 'BTCUSD', indicator: 'STD;RSI' } });
  assert.equal(res.result.strategy, null);
});

test('quotes validates the symbol list and returns the record', async (t) => {
  const h = harness(t, { lib: fakeLib().lib });
  let res = await h.request({ id: 1, method: 'quotes', params: { symbols: ['btcusd', 'ethusd'] } });
  assert.deepEqual(res.result, { BTCUSD: { lp: 1 }, ETHUSD: { lp: 1 } });

  for (const symbols of [[], Array.from({ length: 51 }, (_, i) => `S${i}`), 'BTCUSD']) {
    res = await h.request({ id: 2, method: 'quotes', params: { symbols } });
    assert.equal(res.error.code, 'INVALID_PARAMETER');
  }
});

test('symbol_info keeps only primitive top-level fields, at most 40 keys', async (t) => {
  const info = {
    symbol: 'BTCUSD',
    pricescale: 100,
    is_tradable: true,
    nested: { a: 1 },
    list: [1],
    nothing: null,
  };
  for (let i = 0; i < 50; i += 1) info[`extra_${i}`] = 'v';
  const h = harness(t, { lib: fakeLib({ getSymbolInfo: () => info }).lib });
  const res = await h.request({ id: 1, method: 'symbol_info', params: { symbol: 'BTCUSD' } });
  assert.equal(res.result.symbol, 'BTCUSD');
  assert.equal(res.result.pricescale, 100);
  assert.equal(res.result.is_tradable, true);
  assert.equal('nested' in res.result, false);
  assert.equal('list' in res.result, false);
  assert.equal('nothing' in res.result, false);
  assert.equal(Object.keys(res.result).length, 40);
});

test('search returns at most 20 slim results and forwards type', async (t) => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `EX:S${i}`, symbol: `S${i}`, exchange: 'EX', fullExchange: 'EXCHANGE', type: 'stock', description: 'd',
    currency: 'USD', country: 'US',
  }));
  const fake = fakeLib({ searchMarkets: () => many });
  const h = harness(t, { lib: fake.lib });
  const res = await h.request({ id: 1, method: 'search', params: { query: 'S', type: 'stock' } });
  assert.equal(res.result.length, 20);
  assert.deepEqual(Object.keys(res.result[0]).sort(), ['description', 'exchange', 'fullExchange', 'id', 'symbol', 'type']);
  assert.equal(fake.callsTo('searchMarkets')[0].opts.type, 'stock');

  const bad = await h.request({ id: 2, method: 'search', params: { query: '' } });
  assert.equal(bad.error.code, 'INVALID_PARAMETER');
});

test('screener validates columns, sort, filter and range, and returns totalCount and rows', async (t) => {
  const fake = fakeLib({ getScreener: () => ({ totalCount: 1, rows: [{ symbol: 'X', values: { close: 2 } }] }) });
  const h = harness(t, { lib: fake.lib });

  const ok = await h.request({
    id: 1,
    method: 'screener',
    params: {
      market: 'crypto',
      columns: ['close', 'change'],
      filter: [{ left: 'volume', operation: 'greater', right: 1000 }],
      sort: { sortBy: 'change', sortOrder: 'desc' },
      range: [0, 10],
    },
  });
  assert.deepEqual(ok.result, { totalCount: 1, rows: [{ symbol: 'X', values: { close: 2 } }] });
  const q = fake.callsTo('getScreener')[0].args;
  assert.deepEqual(q.range, [0, 10]);
  assert.equal(q.market, 'crypto');

  const badParams = [
    { columns: [] },
    { columns: Array.from({ length: 21 }, (_, i) => `c${i}`) },
    { columns: ['close'], range: [5, 5] },
    { columns: ['close'], range: [0, 201] },
    { columns: ['close'], sort: { sortBy: 'close', sortOrder: 'up' } },
    { columns: ['close'], filter: [{ left: 'x' }] },
  ];
  for (const params of badParams) {
    const r = await h.request({ id: 2, method: 'screener', params });
    assert.equal(r.error.code, 'INVALID_PARAMETER', JSON.stringify(params));
  }
});

test('hotlist validates kind and does not pass credentials', async (t) => {
  const fake = fakeLib({ getHotlist: () => ({ totalCount: 0, rows: [] }) });
  const h = harness(t, {
    lib: fake.lib,
    env: { TRADINGVIEW_SESSION_ID: 'fake-session', TRADINGVIEW_SESSION_SIGN: 'fake-signature' },
  });
  const res = await h.request({ id: 1, method: 'hotlist', params: { kind: 'gainers', range: [0, 10] } });
  assert.deepEqual(res.result, { totalCount: 0, rows: [] });
  const call = fake.callsTo('getHotlist')[0];
  assert.equal(call.args.kind, 'gainers');
  assert.deepEqual(call.args.range, [0, 10]);
  assert.equal('credentials' in call.opts, false, 'getHotlist type has no credentials');

  const bad = await h.request({ id: 2, method: 'hotlist', params: { kind: 'gainers2' } });
  assert.equal(bad.error.code, 'INVALID_PARAMETER');
});

test('technical returns the library result or null', async (t) => {
  const analysis = { '1D': { Other: 0.1, All: 0.5, MA: 0.9 } };
  const h1 = harness(t, { lib: fakeLib({ getTechnicalAnalysis: () => analysis }).lib });
  assert.deepEqual((await h1.request({ id: 1, method: 'technical', params: { symbol: 'BTCUSD' } })).result, analysis);

  const h2 = harness(t, { lib: fakeLib({ getTechnicalAnalysis: () => null }).lib });
  assert.equal((await h2.request({ id: 1, method: 'technical', params: { symbol: 'BTCUSD' } })).result, null);
});

test('reads newline-delimited requests from input and resolves done after stdin closes', async (t) => {
  const fake = fakeLib();
  const input = new PassThrough();
  const written = [];
  const server = createServer({
    lib: fake.lib,
    env: {},
    input,
    output: { write: (chunk) => { written.push(chunk); return true; } },
    log: () => {},
  });
  t.after(() => server.close());

  input.write('{"id":1,"method":"health"}\n\n{"id":2,"method":"quotes","params":{"symbols":["BTCUSD"]}}\n');
  input.end();
  await server.done;

  assert.equal(written.length, 2);
  assert.deepEqual(written.map((line) => JSON.parse(line).id).sort(), [1, 2]);
});

// ---- Review additions -------------------------------------------------------

test('a client that closed while idle is replaced before the next call', async (t) => {
  const fake = fakeLib();
  const h = harness(t, { lib: fake.lib });
  await h.request({ id: 1, method: 'quotes', params: { symbols: ['BTCUSD'] } });
  assert.equal(fake.clients.length, 1);

  fake.clients[0].isClosed = true; // e.g. server hang-up or inactivity timeout while idle
  const res = await h.request({ id: 2, method: 'quotes', params: { symbols: ['BTCUSD'] } });
  assert.ok(res.result);
  assert.equal(fake.clients.length, 2, 'a fresh client was constructed');
  assert.equal(fake.callsTo('getQuotes')[1].args.client, fake.clients[1]);
});

test('a call that fails because its client closed under it drops that client', async (t) => {
  let first = true;
  const fake = fakeLib({
    getQuotes: (q) => {
      if (first) {
        first = false;
        fake.clients[0].isClosed = true;
        throw Object.assign(new Error('The provided client is closed'), { code: 'INVALID_STATE' });
      }
      return Object.fromEntries(q.symbols.map((s) => [s, {}]));
    },
  });
  const h = harness(t, { lib: fake.lib });
  const a = await h.request({ id: 1, method: 'quotes', params: { symbols: ['BTCUSD'] } });
  assert.equal(a.error.code, 'UPSTREAM_ERROR');
  const b = await h.request({ id: 2, method: 'quotes', params: { symbols: ['BTCUSD'] } });
  assert.ok(b.result);
  assert.equal(fake.clients.length, 2);
});

test('AUTH_ERROR and a timeout before the connection was ready both drop the client', async (t) => {
  const codes = ['AUTH_ERROR', 'TIMEOUT'];
  const fake = fakeLib({
    getCandles: () => {
      const code = codes.shift();
      if (code) {
        fake.clients.at(-1).isAuthenticated = false;
        throw Object.assign(new Error('nope'), { code });
      }
      return [];
    },
  });
  const h = harness(t, { lib: fake.lib });
  for (const id of [1, 2, 3]) await h.request({ id, method: 'candles', params: { symbol: 'BTCUSD' } });
  assert.equal(fake.clients.length, 3, 'each failed client was replaced');
  assert.equal(fake.clients[0].closeCount, 1);
  assert.equal(fake.clients[1].closeCount, 1);
});

test('a timeout on an authenticated client keeps the shared client', async (t) => {
  let first = true;
  const fake = fakeLib({
    getCandles: () => {
      if (first) {
        first = false;
        fake.clients[0].isAuthenticated = true;
        throw Object.assign(new Error('slow symbol'), { code: 'TIMEOUT' });
      }
      return [];
    },
  });
  const h = harness(t, { lib: fake.lib });
  await h.request({ id: 1, method: 'candles', params: { symbol: 'BTCUSD' } });
  await h.request({ id: 2, method: 'candles', params: { symbol: 'BTCUSD' } });
  assert.equal(fake.clients.length, 1);
});

test('a library call that ignores its timeout is cut off at the deadline, frees its slot and drops the client', async (t) => {
  let hangs = true;
  const fake = fakeLib({
    getCandles: () => (hangs ? new Promise(() => {}) : []),
  });
  const h = harness(t, { lib: fake.lib, env: { TRADINGVIEW_BRIDGE_MAX_INFLIGHT: '1' }, deadlineGraceMs: 30 });

  const started = Date.now();
  const res = await h.request({ id: 1, method: 'candles', params: { symbol: 'BTCUSD', timeoutMs: 1000 } });
  assert.equal(res.error.code, 'TIMEOUT');
  assert.ok(Date.now() - started >= 1000, 'the library keeps its full timeoutMs before the backstop fires');
  assert.equal(fake.clients[0].closeCount, 1, 'stuck client closed');

  hangs = false;
  const next = await h.request({ id: 2, method: 'candles', params: { symbol: 'BTCUSD' } });
  assert.deepEqual(next.result, [], 'the single slot was released');
  assert.equal(fake.clients.length, 2);
});

test('an HTTP call aborted by the bridge timer is reported as TIMEOUT and releases its slot', async (t) => {
  const fake = fakeLib({
    searchMarkets: (_query, opts) => new Promise((_, reject) => {
      // what the library does when fetch is aborted: a generic HTTP_ERROR
      opts.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted due to timeout'), { code: 'HTTP_ERROR' }));
      });
    }),
  });
  const h = harness(t, { lib: fake.lib, env: { TRADINGVIEW_BRIDGE_MAX_INFLIGHT: '1' } });
  const res = await h.request({ id: 1, method: 'search', params: { query: 'btc', timeoutMs: 1000 } });
  assert.equal(res.error.code, 'TIMEOUT');

  const again = await h.request({ id: 2, method: 'health' });
  assert.equal(again.result.ok, true);
  const sem = await h.request({ id: 3, method: 'technical', params: { symbol: 'BTCUSD' } });
  assert.equal(sem.result, null, 'the slot is free again');
});

test('HTTP calls each get their own abort signal; technical and hotlist never get credentials', async (t) => {
  const fake = fakeLib();
  const h = harness(t, {
    lib: fake.lib,
    env: { TRADINGVIEW_SESSION_ID: 'fake-session', TRADINGVIEW_SESSION_SIGN: 'fake-signature' },
  });
  await h.request({ id: 1, method: 'technical', params: { symbol: 'btcusd' } });
  await h.request({ id: 2, method: 'hotlist', params: { kind: 'losers' } });
  await h.request({ id: 3, method: 'screener', params: { columns: ['close'] } });
  const tech = fake.callsTo('getTechnicalAnalysis')[0];
  assert.equal(tech.args, 'BTCUSD');
  assert.ok(tech.opts.signal instanceof AbortSignal);
  assert.equal('credentials' in tech.opts, false);
  assert.ok(fake.callsTo('getHotlist')[0].opts.signal instanceof AbortSignal);
  assert.ok(fake.callsTo('getScreener')[0].opts.signal instanceof AbortSignal);
});

test('after close() requests fail cleanly and no new client is created', async (t) => {
  const fake = fakeLib();
  const h = harness(t, { lib: fake.lib });
  await h.request({ id: 1, method: 'quotes', params: { symbols: ['BTCUSD'] } });
  await h.server.close();
  const res = await h.request({ id: 2, method: 'quotes', params: { symbols: ['BTCUSD'] } });
  assert.equal(res.error.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(fake.clients.length, 1);
});

test('invalid input never reaches the library', async (t) => {
  const fake = fakeLib();
  const h = harness(t, { lib: fake.lib });
  const inputs = JSON.parse('{"__proto__": {"polluted": true}}');
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  const cases = [
    ['candles', { symbol: '\u00df' }], // sharp s upper-cases to SS
    ['candles', { symbol: 'BTC USD' }],
    ['candles', { symbol: 'BTC/USD' }],
    ['candles', { symbol: 'A'.repeat(41) }],
    ['candles', { symbol: 'BTCUSD', timeframe: 'D ' }],
    ['candles', { symbol: 'BTCUSD', count: 1.5 }],
    ['candles', { symbol: 'BTCUSD', count: '5' }],
    ['candles', { symbol: 'BTCUSD', from: 1700000000000 }], // milliseconds
    ['candles', { symbol: 'BTCUSD', from: 1700000000, maxCount: 20001 }],
    ['candles', { symbol: 'BTCUSD', timeoutMs: '1000' }],
    ['quotes', { symbols: [] }],
    ['quotes', { symbols: ['BTCUSD', 5] }],
    ['indicator', { symbol: 'BTCUSD', indicator: '   ' }],
    ['indicator', { symbol: 'BTCUSD', indicator: 'x'.repeat(201) }],
    ['indicator', { symbol: 'BTCUSD', indicator: 'STD;RSI', count: 501 }],
    ['indicator', { symbol: 'BTCUSD', indicator: 'STD;RSI', inputs: [1] }],
    ['indicator', { symbol: 'BTCUSD', indicator: 'STD;RSI', inputs }],
    ['indicator', { symbol: 'BTCUSD', indicator: 'STD;RSI', inputs: deep }],
    ['search', { query: '   ' }],
    ['search', { query: 'x'.repeat(61) }],
    ['search', { query: 'btc', type: 5 }],
    ['symbol_info', { symbol: '' }],
    ['screener', { columns: ['close'], market: '../admin' }],
    ['screener', { columns: ['close'], market: 'a/b' }],
    ['screener', { columns: ['close', 'close'] }],
    ['screener', { columns: ['  '] }],
    ['screener', { columns: ['close'], filter: [{ left: 'x', operation: 'eq', right: { a: 1 } }] }],
    ['hotlist', { kind: 'gainers', market: 'q?x=1' }],
    ['hotlist', { kind: '__proto__' }],
    ['technical', { symbol: 'x y' }],
    ['technical', {}],
  ];
  for (const [method, params] of cases) {
    const r = await h.request({ id: 1, method, params });
    assert.equal(r.error?.code, 'INVALID_PARAMETER', `${method} ${JSON.stringify(params)}`);
  }
  // 1e999 parses to Infinity, which JSON.stringify cannot carry further.
  const inf = await h.request('{"id":4,"method":"indicator","params":{"symbol":"BTCUSD","indicator":"STD;RSI","inputs":{"n":1e999}}}');
  assert.equal(inf.error.code, 'INVALID_PARAMETER');
  // params must be an object; oversize lines are refused before parsing.
  assert.equal((await h.request({ id: 2, method: 'candles', params: ['BTCUSD'] })).error.code, 'INVALID_PARAMETER');
  const big = await h.request(`{"id":3,"method":"health","params":{"pad":"${'x'.repeat(1_000_001)}"}}`);
  assert.equal(big.error.code, 'INVALID_PARAMETER');
  assert.equal(fake.clients.length, 0);
  assert.equal(fake.callsTo('getCandles').length + fake.callsTo('searchMarkets').length
    + fake.callsTo('getScreener').length + fake.callsTo('getHotlist').length
    + fake.callsTo('getTechnicalAnalysis').length + fake.callsTo('getQuotes').length
    + fake.callsTo('getIndicatorData').length + fake.callsTo('getSymbolInfo').length, 0);
});

test('quotes drops duplicate symbols', async (t) => {
  const fake = fakeLib();
  const h = harness(t, { lib: fake.lib });
  await h.request({ id: 1, method: 'quotes', params: { symbols: ['btcusd', 'BTCUSD', 'ETHUSD'] } });
  assert.deepEqual(fake.callsTo('getQuotes')[0].args.symbols, ['BTCUSD', 'ETHUSD']);
});

test('indicator gives strategy null for a plain study with an empty report', async (t) => {
  const fake = fakeLib({
    getIndicatorData: () => ({
      indicator: {}, values: [], strategyReport: { trades: [], history: {}, performance: {} },
    }),
  });
  const h = harness(t, { lib: fake.lib });
  const r = await h.request({ id: 1, method: 'indicator', params: { symbol: 'BTCUSD', indicator: 'STD;RSI' } });
  assert.equal(r.result.strategy, null);
});

test('screener accepts valid market, filter lists and passes only validated fields', async (t) => {
  const fake = fakeLib();
  const h = harness(t, { lib: fake.lib });
  const r = await h.request({
    id: 1,
    method: 'screener',
    params: {
      market: 'america',
      columns: ['close|60', 'Recommend.All'],
      filter: [{ left: 'type', operation: 'in_range', right: ['stock', 'dr'], extra: 'dropped' }],
      unknown: 'dropped',
    },
  });
  assert.ok(r.result);
  const q = fake.callsTo('getScreener')[0].args;
  assert.deepEqual(q, {
    market: 'america',
    columns: ['close|60', 'Recommend.All'],
    filter: [{ left: 'type', operation: 'in_range', right: ['stock', 'dr'] }],
  });
});

test('logs from failed client closes are redacted too', async (t) => {
  const env = { TRADINGVIEW_SESSION_ID: 'fake-session-value' };
  const fake = fakeLib();
  const h = harness(t, { lib: fake.lib, env });
  await h.request({ id: 1, method: 'quotes', params: { symbols: ['BTCUSD'] } });
  fake.clients[0].close = async () => { throw new Error('close failed for fake-session-value'); };
  await h.server.close();
  const text = h.logs.join('\n');
  assert.ok(text.includes('client close failed'));
  assert.equal(text.includes('fake-session-value'), false);
});

test('a log sink that throws never breaks a request', async (t) => {
  const fake = fakeLib({ getCandles: () => { throw new Error('boom'); } });
  const written = [];
  const server = createServer({
    lib: fake.lib,
    env: {},
    input: null,
    output: { write: (chunk) => { written.push(chunk); return true; } },
    log: () => { throw new Error('sink down'); },
  });
  t.after(() => server.close());
  await server.handleLine('{"id":1,"method":"candles","params":{"symbol":"BTCUSD"}}');
  assert.equal(JSON.parse(written[0]).error.code, 'UPSTREAM_ERROR');
});
