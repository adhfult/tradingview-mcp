/**
 * Renders a PNG of the dashboard's /render page for an alert. The browser is started on demand and closed after
 * `idleMs` without a render: at most a handful of images an hour, so an idle Chromium would only cost RAM on the Pi.
 *
 * - One render at a time, at most `maxPerHour` in a rolling hour (a failed one counts: it used the same browser time).
 * - `timeoutMs` covers start-up, loading and the screenshot, and the error is raised at the deadline without waiting
 *   for the browser to shut down, so the text alert is not held up. A browser that hung or failed is closed, never reused.
 *   A browser still starting when its render gave up is kept for the next render or closed by the idle timer, never
 *   started a second time; the abandoned render opens no page on it.
 * - A dashboard token goes in a request header. Every page request the renderer can see is checked against the
 *   dashboard's origin and aborted otherwise, and service workers are blocked (Playwright's `route` cannot see what
 *   they fetch). It does not follow redirects hop by hop: the dashboard has none that leave its own origin.
 * - After `close()` no render is accepted and no browser is started.
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

/**
 * What chromium.launch gets. Playwright adds --no-sandbox itself unless `chromiumSandbox` is true, so the sandbox is
 * asked for by name; only root (a container, a root service) cannot use it, because Chromium refuses to start then.
 */
export function chromiumLaunchOptions(executablePath, options) {
  const uid = 'uid' in options ? options.uid : process.getuid?.();
  return {
    executablePath, headless: true, timeout: options.timeout, chromiumSandbox: uid !== 0, args: ['--disable-gpu', '--disable-dev-shm-usage'],
  };
}

async function launchChromium(executablePath, { timeout }) {
  const { chromium } = await import('playwright-core');
  return chromium.launch(chromiumLaunchOptions(executablePath, { timeout }));
}

const oneLine = (err) => errorMessage(err).replace(/\s+/g, ' ').trim().slice(0, 200);
const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };

export function createRenderer({
  baseUrl, token = '', chromiumPath, maxPerHour = 6, timeoutMs = 10_000, idleMs = 30_000, clock = realClock, launch = launchChromium,
}) {
  const origin = new URL(baseUrl).origin;
  let browser = null; // the live browser, if any
  let launching = null; // a launch in progress, shared by whoever needs the browser meanwhile
  let idleTimer = null;
  let tail = Promise.resolve();
  let current = null; // the render in progress
  let busy = false;
  let closed = false;
  const starts = [];

  const stopIdle = () => {
    if (idleTimer !== null) clock.clearTimeout(idleTimer);
    idleTimer = null;
  };

  /** Forgets the browser and starts closing it. The returned promise never rejects; failure paths do not wait for it. */
  function dropBrowser() {
    stopIdle();
    const b = browser;
    browser = null;
    return b === null ? Promise.resolve() : b.close().catch(() => {});
  }

  const armIdle = () => {
    stopIdle();
    idleTimer = clock.setTimeout(() => { idleTimer = null; void dropBrowser(); }, idleMs);
  };

  function startLaunch() {
    const attempt = (async () => {
      let started;
      try {
        started = await launch(chromiumPath, { timeout: timeoutMs });
      } catch (err) {
        throw new RenderError('browser', `browser did not start: ${oneLine(err)}`);
      }
      if (closed) {
        await started.close().catch(() => {});
        throw new RenderError('browser', 'renderer closed');
      }
      browser = started;
      started.on('disconnected', () => { // a crash or a kill from outside: start again next time
        if (browser === started) {
          browser = null;
          stopIdle();
        }
      });
      if (!busy) armIdle(); // it finished starting after the render that wanted it had given up
      return started;
    })();
    launching = attempt;
    const clear = () => { if (launching === attempt) launching = null; };
    attempt.then(clear, clear);
    return attempt;
  }

  async function capture(chart, job) {
    const live = () => {
      if (job.abandoned) throw new RenderError('browser', 'render abandoned');
    };
    const b = browser ?? await (launching ?? startLaunch());
    live();
    const context = await b.newContext({
      viewport: FRAME,
      serviceWorkers: 'block',
      ...(token === '' ? {} : { extraHTTPHeaders: { authorization: `Bearer ${token}` } }),
    });
    try {
      live();
      await context.route('**/*', async (route) => {
        let same = false;
        try {
          same = new URL(route.request().url()).origin === origin;
        } catch { /* not a URL: aborted below */ }
        await (same ? route.continue() : route.abort());
      });
      live();
      const page = await context.newPage();
      live();
      await page.goto(renderUrl(baseUrl, chart), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      live();
      await page.waitForFunction(() => window.__ready === true || window.__failed !== undefined, undefined, { timeout: timeoutMs });
      live();
      const failed = await page.evaluate(() => window.__failed ?? null);
      if (failed !== null) throw new RenderError('page', `the chart page failed: ${String(failed).slice(0, 200)}`);
      return await page.locator('#frame').screenshot({ type: 'png' });
    } finally {
      await context.close().catch(() => {});
    }
  }

  async function run(chart) {
    if (closed) throw new RenderError('browser', 'renderer closed');
    const hourAgo = clock.now() - 3_600_000;
    while (starts.length > 0 && starts[0] <= hourAgo) starts.shift();
    if (starts.length >= maxPerHour) throw new RenderError('cap', `image limit reached (${maxPerHour} per hour)`);
    starts.push(clock.now());
    stopIdle();
    busy = true;

    const job = { abandoned: false, cancel: () => {} };
    current = job;
    const cancelled = new Promise((_, reject) => { job.cancel = reject; });
    const timer = clock.setTimeout(() => job.cancel(new RenderError('timeout', `no image after ${timeoutMs} ms`)), timeoutMs);
    const work = capture(chart, job);
    work.catch(() => {}); // when the deadline wins, a late failure of the abandoned work is not an unhandled rejection
    try {
      return await Promise.race([work, cancelled]);
    } catch (err) {
      job.abandoned = true;
      void dropBrowser(); // a hung, crashed or confused browser is not reused, and the caller does not wait for it to close
      throw err instanceof RenderError ? err : new RenderError('browser', oneLine(err));
    } finally {
      clock.clearTimeout(timer);
      current = null;
      busy = false;
      if (browser !== null) armIdle();
    }
  }

  return {
    /** Resolves with the PNG bytes, or rejects with a RenderError. */
    render(chart) {
      const result = tail.then(() => run(chart));
      tail = result.catch(() => {});
      return result;
    },
    /** Refuses later renders, fails the one in progress at once, and closes the browser. */
    async close() {
      closed = true;
      current?.cancel(new RenderError('browser', 'renderer closed'));
      await dropBrowser();
    },
  };
}
