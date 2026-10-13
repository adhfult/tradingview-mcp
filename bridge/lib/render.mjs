/**
 * Renders a PNG of the dashboard's /render page for an alert. The browser is started on demand and closed after
 * `idleMs` without a render: at most a handful of images an hour, so an idle Chromium would only cost RAM on the Pi.
 *
 * - One render at a time, at most `maxPerHour` in a rolling hour (a failed one counts: it used the same browser time).
 * - `timeoutMs` covers start-up, loading and the screenshot. A browser that hung or failed is closed, never reused.
 * - A dashboard token goes in a request header, and any request that is not to the dashboard is aborted, so the
 *   header cannot reach another site.
 * - playwright-core is imported only when the first image is made. No browser is ever downloaded: the path comes from
 *   the config or WATCHER_CHROMIUM_PATH.
 */
import { errorMessage } from './errors.mjs';

export const FRAME = { width: 960, height: 540 };

export class RenderError extends Error {
  /** `reason`: 'cap' (hourly limit), 'timeout', 'page' (the page said it failed) or 'browser' (start-up, crash, protocol). */
  constructor(reason, message) {
    super(message);
    this.name = 'RenderError';
    this.reason = reason;
  }
}

/** The URL the renderer opens. Plain query values only; the token is never part of it. */
export function renderUrl(baseUrl, chart) {
  const url = new URL('/render', baseUrl);
  url.searchParams.set('symbol', chart.symbol);
  url.searchParams.set('tf', chart.timeframe);
  url.searchParams.set('t', String(chart.barTime));
  if (chart.direction === 'up' || chart.direction === 'down') url.searchParams.set('dir', chart.direction);
  if (Number.isFinite(chart.level)) url.searchParams.set('level', String(chart.level));
  if (chart.ruleId) url.searchParams.set('rule', chart.ruleId);
  return url.href;
}

/** The dashboard page centred on the alert's bar (the deep link the dashboard reads). */
export function deepLink(baseUrl, chart) {
  const url = new URL('/', baseUrl);
  url.searchParams.set('symbol', chart.symbol);
  url.searchParams.set('tf', chart.timeframe);
  url.searchParams.set('t', String(chart.barTime));
  return url.href;
}

/** `{host, port}` as the dashboard reports its bound address -> a URL this machine can open (all-interfaces binds become loopback). */
export function dashboardBaseUrl({ host, port }) {
  const name = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${name.includes(':') ? `[${name}]` : name}:${port}`;
}

async function launchChromium(executablePath) {
  const { chromium } = await import('playwright-core');
  // Chromium refuses to start as root without --no-sandbox (a root systemd unit or a container); everywhere else keep the sandbox.
  const sandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  return chromium.launch({ executablePath, headless: true, args: [...sandbox, '--disable-gpu', '--disable-dev-shm-usage'] });
}

const oneLine = (err) => errorMessage(err).replace(/\s+/g, ' ').trim().slice(0, 200);
const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };

export function createRenderer({
  baseUrl, token = '', chromiumPath, maxPerHour = 6, timeoutMs = 10_000, idleMs = 30_000, clock = realClock, launch = launchChromium,
}) {
  const origin = new URL(baseUrl).origin;
  let browser = null;
  let idleTimer = null;
  let tail = Promise.resolve();
  const starts = [];

  const stopIdle = () => {
    if (idleTimer !== null) clock.clearTimeout(idleTimer);
    idleTimer = null;
  };

  async function closeBrowser() {
    stopIdle();
    const b = browser;
    browser = null;
    await b?.close().catch(() => {});
  }

  async function ensureBrowser() {
    if (browser !== null) return browser;
    let started;
    try {
      started = await launch(chromiumPath);
    } catch (err) {
      throw new RenderError('browser', `browser did not start: ${oneLine(err)}`);
    }
    browser = started;
    started.on('disconnected', () => { // a crash or a kill from outside: start again next time
      if (browser === started) {
        browser = null;
        stopIdle();
      }
    });
    return started;
  }

  async function capture(chart) {
    const b = await ensureBrowser();
    const context = await b.newContext({
      viewport: FRAME,
      ...(token === '' ? {} : { extraHTTPHeaders: { authorization: `Bearer ${token}` } }),
    });
    try {
      await context.route('**/*', async (route) => {
        let same = false;
        try {
          same = new URL(route.request().url()).origin === origin;
        } catch { /* not a URL: aborted below */ }
        await (same ? route.continue() : route.abort());
      });
      const page = await context.newPage();
      await page.goto(renderUrl(baseUrl, chart), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForFunction(() => window.__ready === true || window.__failed !== undefined, undefined, { timeout: timeoutMs });
      const failed = await page.evaluate(() => window.__failed ?? null);
      if (failed !== null) throw new RenderError('page', `the chart page failed: ${String(failed).slice(0, 200)}`);
      return await page.locator('#frame').screenshot({ type: 'png' });
    } finally {
      await context.close().catch(() => {});
    }
  }

  async function run(chart) {
    const hourAgo = clock.now() - 3_600_000;
    while (starts.length > 0 && starts[0] <= hourAgo) starts.shift();
    if (starts.length >= maxPerHour) throw new RenderError('cap', `image limit reached (${maxPerHour} per hour)`);
    starts.push(clock.now());
    stopIdle();

    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = clock.setTimeout(() => reject(new RenderError('timeout', `no image after ${timeoutMs} ms`)), timeoutMs);
    });
    const work = capture(chart);
    work.catch(() => {}); // when the timeout wins, a late failure of the abandoned work is not an unhandled rejection
    try {
      return await Promise.race([work, timedOut]);
    } catch (err) {
      await closeBrowser(); // a hung, crashed or confused browser is not reused
      throw err instanceof RenderError ? err : new RenderError('browser', oneLine(err));
    } finally {
      clock.clearTimeout(timer);
      if (browser !== null) idleTimer = clock.setTimeout(closeBrowser, idleMs);
    }
  }

  return {
    /** Resolves with the PNG bytes, or rejects with a RenderError. */
    render(chart) {
      const result = tail.then(() => run(chart));
      tail = result.catch(() => {});
      return result;
    },
    async close() {
      await tail;
      await closeBrowser();
    },
  };
}
