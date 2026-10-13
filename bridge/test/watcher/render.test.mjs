import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRenderer, deepLink, renderUrl, RenderError } from '../../lib/render.mjs';
import { createFakeClock, settle } from './support.mjs';

const BASE = 'http://127.0.0.1:8788';
const CHART = { symbol: 'BINANCE:BTCUSDT', timeframe: '60', barTime: 1760000000, direction: 'up', level: 100000, ruleId: 'btc100k' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A browser double. `behave(page)` can replace any page method to simulate a hang, a failure or a crash. */
function fakeBrowserFactory(behave = () => {}) {
  const state = { launches: [], browsers: [], pages: 0, openPages: 0, maxOpenPages: 0, contexts: [], visited: [], screenshots: [], routes: [] };
  const launch = async (chromiumPath) => {
    state.launches.push(chromiumPath);
    const browser = Object.assign(new EventEmitter(), { closed: false });
    browser.close = async () => { browser.closed = true; };
    browser.newContext = async (options) => {
      state.contexts.push(options);
      const opened = [];
      return {
        route: async (pattern, handler) => { state.routes.push({ pattern, handler }); },
        close: async () => { for (const page of opened.splice(0)) await page.close(); }, // closing a context closes its pages
        newPage: async () => {
          state.pages += 1;
          state.openPages += 1;
          state.maxOpenPages = Math.max(state.maxOpenPages, state.openPages);
          const page = {
            goto: async (url) => { state.visited.push(url); },
            waitForFunction: async () => {},
            evaluate: async () => null,
            locator: (selector) => ({
              screenshot: async (opts) => { state.screenshots.push({ selector, opts }); return PNG; },
            }),
            close: async () => { state.openPages -= 1; },
          };
          behave(page, state);
          opened.push(page);
          return page;
        },
      };
    };
    state.browsers.push(browser);
    return browser;
  };
  return { launch, state };
}

const make = (overrides = {}) => {
  const clock = createFakeClock();
  const factory = fakeBrowserFactory(overrides.behave);
  const renderer = createRenderer({
    baseUrl: BASE, chromiumPath: '/usr/bin/chromium', maxPerHour: 6, timeoutMs: 10_000, idleMs: 30_000,
    clock, launch: factory.launch, ...overrides.options,
  });
  return { renderer, clock, ...factory };
};

// ---------------------------------------------------------------- the two links

test('renderUrl carries the chart as plain, encoded query values and never a token', () => {
  const url = new URL(renderUrl(BASE, CHART));
  assert.equal(url.origin, BASE);
  assert.equal(url.pathname, '/render');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    symbol: 'BINANCE:BTCUSDT', tf: '60', t: '1760000000', dir: 'up', level: '100000', rule: 'btc100k',
  });
  assert.doesNotMatch(renderUrl(BASE, CHART), /token/i);
});

test('renderUrl leaves out what the alert does not have', () => {
  const url = new URL(renderUrl(BASE, { symbol: 'X', timeframe: 'D', barTime: 5, direction: null, level: null, ruleId: 'r' }));
  assert.deepEqual([...url.searchParams.keys()].sort(), ['rule', 'symbol', 't', 'tf']);
});

test('deepLink is the dashboard page centred on the alert bar, the same URL the dashboard reads', () => {
  const url = new URL(deepLink(BASE, CHART));
  assert.equal(url.pathname, '/');
  assert.deepEqual(Object.fromEntries(url.searchParams), { symbol: 'BINANCE:BTCUSDT', tf: '60', t: '1760000000' });
});

// ---------------------------------------------------------------- rendering

test('render opens the /render URL, screenshots the frame as a PNG and returns the bytes', async () => {
  const { renderer, state } = make();
  const png = await renderer.render(CHART);
  assert.deepEqual(png, PNG);
  assert.deepEqual(state.launches, ['/usr/bin/chromium']);
  assert.equal(state.visited[0], renderUrl(BASE, CHART));
  assert.deepEqual(state.screenshots, [{ selector: '#frame', opts: { type: 'png' } }]);
  assert.equal(state.openPages, 0, 'the page is closed again');
});

test('the dashboard token goes in a header, never in the URL', async () => {
  const { renderer, state } = make({ options: { token: 'secret-token-0123456789' } });
  await renderer.render(CHART);
  assert.equal(state.contexts[0].extraHTTPHeaders.authorization, 'Bearer secret-token-0123456789');
  assert.doesNotMatch(state.visited[0], /secret-token/);
});

test('a request that is not to the dashboard is aborted', async () => {
  const { renderer, state } = make();
  await renderer.render(CHART);
  const { handler } = state.routes[0];
  const seen = [];
  const route = (url) => ({ request: () => ({ url: () => url }), continue: async () => seen.push(['continue', url]), abort: async () => seen.push(['abort', url]) });
  await handler(route(`${BASE}/api/candles?x=1`));
  await handler(route('https://evil.example/x.png'));
  await handler(route(`${BASE}.evil.example/`));
  assert.deepEqual(seen.map((s) => s[0]), ['continue', 'abort', 'abort']);
});

test('a page that reports a failure becomes a RenderError with that reason', async () => {
  const { renderer } = make({ behave: (page) => { page.evaluate = async () => 'no candles'; } });
  await assert.rejects(renderer.render(CHART), (err) => err instanceof RenderError && err.reason === 'page' && /no candles/.test(err.message));
});

test('renders run one at a time', async () => {
  const { renderer, state } = make({ behave: (page) => { page.goto = async () => { await settle(); }; } });
  await Promise.all([renderer.render(CHART), renderer.render(CHART), renderer.render(CHART)]);
  assert.equal(state.maxOpenPages, 1);
  assert.equal(state.pages, 3);
});

// ---------------------------------------------------------------- limits

test('at most max_per_hour renders in a rolling hour, then a cap error until the hour has passed', async () => {
  const { renderer, clock, state } = make({ options: { maxPerHour: 2 } });
  await renderer.render(CHART);
  clock.advance(10 * 60_000);
  await renderer.render(CHART);
  await assert.rejects(renderer.render(CHART), (err) => err.reason === 'cap');
  assert.equal(state.pages, 2, 'a capped request opens no page');
  clock.advance(51 * 60_000); // the first render is now over an hour old
  await renderer.render(CHART);
  assert.equal(state.pages, 3);
});

test('a failed render still counts against the cap (it cost the same browser time)', async () => {
  const { renderer } = make({ options: { maxPerHour: 1 }, behave: (page) => { page.evaluate = async () => 'boom'; } });
  await assert.rejects(renderer.render(CHART), (err) => err.reason === 'page');
  await assert.rejects(renderer.render(CHART), (err) => err.reason === 'cap');
});

test('a render that hangs ends at timeout_ms with a timeout error and the browser is thrown away', async () => {
  const { renderer, clock, state } = make({ behave: (page) => { page.goto = () => new Promise(() => {}); } });
  const pending = renderer.render(CHART);
  const outcome = assert.rejects(pending, (err) => err instanceof RenderError && err.reason === 'timeout');
  await settle();
  clock.advance(10_000);
  await outcome;
  assert.equal(state.browsers[0].closed, true, 'a hung browser is not reused');
});

// ---------------------------------------------------------------- browser lifetime

test('the browser is closed after idle_ms and started again for the next render', async () => {
  const { renderer, clock, state } = make();
  await renderer.render(CHART);
  assert.equal(state.browsers[0].closed, false);
  clock.advance(29_000);
  assert.equal(state.browsers[0].closed, false);
  clock.advance(2_000);
  assert.equal(state.browsers[0].closed, true);
  await renderer.render(CHART);
  assert.equal(state.launches.length, 2);
});

test('two renders close together share one browser, and the idle timer restarts after each', async () => {
  const { renderer, clock, state } = make();
  await renderer.render(CHART);
  clock.advance(20_000);
  await renderer.render(CHART);
  clock.advance(20_000);
  assert.equal(state.launches.length, 1);
  assert.equal(state.browsers[0].closed, false, 'only 20 s since the last render');
});

test('a browser that crashes (disconnects) is started again for the next render', async () => {
  const { renderer, state } = make();
  await renderer.render(CHART);
  state.browsers[0].emit('disconnected');
  await renderer.render(CHART);
  assert.equal(state.launches.length, 2);
});

test('a render that fails closes the browser, so the next one starts clean', async () => {
  let fail = true;
  const { renderer, state } = make({ behave: (page) => { page.goto = async () => { if (fail) { fail = false; throw new Error('Target closed'); } }; } });
  await assert.rejects(renderer.render(CHART), (err) => err instanceof RenderError && err.reason === 'browser');
  assert.equal(state.browsers[0].closed, true);
  await renderer.render(CHART);
  assert.equal(state.launches.length, 2);
});

test('a browser that cannot start is a RenderError, and the next render tries again', async () => {
  let fail = true;
  const clock = createFakeClock();
  const renderer = createRenderer({
    baseUrl: BASE, chromiumPath: '/nope', clock,
    launch: async () => { if (fail) { fail = false; throw new Error('Executable doesn\'t exist at /nope'); } return fakeBrowserFactory().launch('/nope'); },
  });
  await assert.rejects(renderer.render(CHART), (err) => err instanceof RenderError && err.reason === 'browser');
  await renderer.render(CHART);
});

test('close() shuts the browser and clears the idle timer', async () => {
  const { renderer, clock, state } = make();
  await renderer.render(CHART);
  await renderer.close();
  assert.equal(state.browsers[0].closed, true);
  assert.equal(clock.pending(), 0);
});

// ---------------------------------------------------------------- real browser (optional)

test('real browser: renders a PNG from a real dashboard (set WATCHER_TEST_CHROMIUM to a chromium or chrome path)', { skip: !process.env.WATCHER_TEST_CHROMIUM }, async (t) => {
  const { createDashboard, defaultAssets } = await import('../../lib/dashboard.mjs');
  const candles = Array.from({ length: 150 }, (_, i) => ({
    time: 1_760_000_000 + i * 3600, open: 100 + i, high: 103 + i, low: 98 + i, close: 101 + i + (i % 5), volume: 10,
  }));
  const dashboard = createDashboard({
    host: '127.0.0.1', port: 0, token: '', bus: new EventEmitter(),
    streams: { list: () => [{ key: 'X|60', symbol: 'X', timeframe: '60', status: 'healthy' }], candles: () => candles },
    getAlerts: () => [], rules: [], timezone: 'UTC', home: '/nonexistent', assets: defaultAssets(),
    logger: { info() {}, warn(m) { assert.fail(m); }, error() {} },
  });
  const { port } = await dashboard.listen();
  const renderer = createRenderer({ baseUrl: `http://127.0.0.1:${port}`, chromiumPath: process.env.WATCHER_TEST_CHROMIUM, timeoutMs: 20_000 });
  t.after(async () => { await renderer.close(); await dashboard.close(); });
  const png = await renderer.render({ symbol: 'X', timeframe: '60', barTime: candles[140].time, direction: 'up', level: 200, ruleId: 'r1' });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG signature');
  assert.ok(png.length > 5000, `a drawn chart, not a blank page (${png.length} bytes)`);
});
