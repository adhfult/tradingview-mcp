// Test fixture, preloaded with `node --import`. Once server.mjs has installed its
// stdio guard (process.stdout.write is replaced), it behaves like a chatty library:
// console output, raw stdout writes and a secret in stderr text.
const original = process.stdout.write;
const timer = setInterval(() => {
  if (process.stdout.write === original) return;
  clearInterval(timer);
  console.log('LEAK-LOG');
  console.info('LEAK-INFO');
  console.debug('LEAK-DEBUG');
  console.dir({ leak: 'LEAK-DIR' });
  console.table([{ leak: 'LEAK-TABLE' }]);
  process.stdout.write('LEAK-RAW\n');
  console.error('LEAK-ERROR secret=', process.env.TRADINGVIEW_SESSION_ID);
  console.warn('LEAK-WARN sessionid=cookievalue123');
}, 1);
