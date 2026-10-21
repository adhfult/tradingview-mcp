Recorded real responses (2026-10-14) for the news tests. No test may fetch live.
- `sec-getcurrent-8k-page1.atom`, `sec-getcurrent-8k-page2.atom`: SEC `browse-edgar?action=getcurrent&type=8-K&count=100&start=0|100&output=atom` (100 entries each; page 2 is older than page 1).
- `tradingview-newsflow-3tickers.json`: `news-mediator.tradingview.com/news-flow/v2/news` for NASDAQ:AAPL, NASDAQ:MSFT, NYSE:JPM, cut to the newest 25 items.
N1b, recorded 2026-10-20 with a bare `Mozilla/5.0` user agent, one request each:
- `tickertick-aapl.json`: `api.tickertick.com/feed?q=tt:aapl&n=15` (whole response; it includes off-topic stories tagged aapl). The poller queries `z:<ticker>` as the approved plan says; the response shape is identical, and a `z:aapl` probe on 2026-10-21 also returned a few off-topic stories.
- `yahoo-aapl.rss`: `feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL&region=US&lang=en-US` (whole response).
- `nasdaq-aapl.rss`: `www.nasdaq.com/feed/rssoutbound?symbol=AAPL` (whole response).
- `google-aapl.rss`: `news.google.com/rss/search?q=AAPL+stock+when:1d&hl=en-US&gl=US&ceid=US:en`, cut to the first 12 items; the `webMaster` contact is replaced by a placeholder.
- `nasdaq-earnings-calendar.json`: `api.nasdaq.com/api/calendar/earnings?date=2026-10-21`, cut to the first 40 of 91 rows. The source stays off by default until Nasdaq's terms are checked.
- `finnhub-company-news-documented.json`: NOT a recording. Finnhub needs an API key that workers and this repo do not hold, so this is built by hand from the documented `/api/v1/company-news` schema (category, datetime in unix seconds, headline, id, image, related, source, summary, url). Replace it with a redacted real sample when one exists.
Add hostile variants as separate files; do not edit these.
