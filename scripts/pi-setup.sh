#!/usr/bin/env bash
# Sets up the market watcher on a Raspberry Pi (Raspberry Pi OS 64-bit). Safe to re-run: every step checks first.
#
#   bash scripts/pi-setup.sh            checks + install + config (does NOT start the service)
#   bash scripts/pi-setup.sh --pine     also set up the Pyne (7c) extra and time a script run
#   bash scripts/pi-setup.sh --images   also install Chromium for alert pictures (7b)
#   bash scripts/pi-setup.sh --enable   also install and start the systemd service
#
# It never prints secret values. You fill /etc/tradingview-watcher.env yourself; the script only lists which
# variable NAMES are set. Paste its whole output back to Claude when something says FAIL or WARN.
set -u

PINE=0 IMAGES=0 ENABLE=0
for a in "$@"; do
  case "$a" in
    --pine) PINE=1 ;; --images) IMAGES=1 ;; --enable) ENABLE=1 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ME="$(id -un)"
CONF_DIR="$HOME/.config/tradingview-watcher"
CONF="$CONF_DIR/config.json"
STATE="$HOME/.local/state/tradingview-watcher"
ENVFILE=/etc/tradingview-watcher.env
UNIT=/etc/systemd/system/tradingview-watcher.service
FAILS=0 WARNS=0

ok()   { echo "  ok    $*"; }
warn() { echo "  WARN  $*"; WARNS=$((WARNS+1)); }
fail() { echo "  FAIL  $*"; FAILS=$((FAILS+1)); }
step() { echo; echo "== $*"; }

step "1. This machine"
echo "  user=$ME  repo=$REPO"
[ "$(uname -m)" = "aarch64" ] && ok "arm64" || warn "not arm64 ($(uname -m)); the Pi 400 should be aarch64 (64-bit OS)"
grep -h PRETTY_NAME /etc/os-release | sed 's/^/  /'
free -m | awk 'NR==2{printf "  RAM total %s MB, available %s MB\n",$2,$7}'
df -h "$HOME" | awk 'NR==2{printf "  disk: %s free on %s\n",$4,$6}'
if command -v vcgencmd >/dev/null; then echo "  $(vcgencmd get_throttled)  (0x0 = no under-voltage ever seen)"; fi

step "2. Tools"
if command -v node >/dev/null; then
  NODE_V="$(node -v)"; NODE_PATH_="$(command -v node)"
  major="${NODE_V#v}"; major="${major%%.*}"
  [ "$major" -ge 22 ] 2>/dev/null && ok "node $NODE_V" || fail "node $NODE_V is too old, want 22 (NodeSource, not the apt package: https://github.com/nodesource/distributions)"
  [ "$NODE_PATH_" = /usr/bin/node ] && ok "node is /usr/bin/node" \
    || fail "node is $NODE_PATH_ not /usr/bin/node: the unit would die with 203/EXEC (nvm?). Install node system-wide."
else
  fail "node is not installed"
fi
for t in git npm; do command -v "$t" >/dev/null && ok "$t" || fail "$t missing (sudo apt install -y $t)"; done
[ "$(systemctl is-active systemd-timesyncd 2>/dev/null)" = active ] && ok "systemd-timesyncd active" \
  || warn "systemd-timesyncd not active: the clock-sync wait in the unit only works with it"
[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && ok "clock is synchronized" || warn "clock not synchronized yet"
if grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null; then ok "memory cgroup on (MemoryMax will work)"
else warn "memory cgroup OFF: add 'cgroup_enable=memory cgroup_memory=1' to /boot/firmware/cmdline.txt and reboot, or MemoryMax=512M is ignored"; fi
[ "$FAILS" -gt 0 ] && { echo; echo "Fix the FAIL lines above, then re-run."; exit 1; }

step "3. Bridge dependencies (npm ci --ignore-scripts)"
if npm --prefix "$REPO/bridge" ci --ignore-scripts --no-audit --no-fund >/tmp/tvw-npm.log 2>&1; then ok "installed"
else fail "npm ci failed, last lines:"; tail -8 /tmp/tvw-npm.log; exit 1; fi

step "4. Config (day one: max_per_hour 10, trending off, so a first night is quiet)"
mkdir -p "$CONF_DIR" "$STATE"
if [ ! -f "$CONF" ]; then
  cp "$REPO/bridge/watcher.config.example.json" "$CONF"
  node -e '
    const fs=require("fs"),p=process.argv[1],c=JSON.parse(fs.readFileSync(p,"utf8"));
    c.alerts.max_per_hour=10; c.trending.enabled=false;
    fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");' "$CONF"
  ok "created $CONF from the example (edit the watchlist and rules to taste)"
else ok "$CONF already exists, left alone"; fi
node "$REPO/bridge/watcher.mjs" --config "$CONF" --check-config 2>&1 | sed 's/^/  /'

step "5. Secrets file (you fill it in; values are never printed)"
if [ ! -f "$ENVFILE" ]; then
  sudo cp "$REPO/bridge/watcher.env.example" "$ENVFILE" && sudo chown "$ME:$ME" "$ENVFILE" && sudo chmod 600 "$ENVFILE" \
    && ok "created $ENVFILE (mode 600)" || fail "could not create $ENVFILE"
  echo "  -> now run:  nano $ENVFILE   (at minimum DISCORD_WEBHOOK_URL or the Telegram pair; leave the TradingView cookies"
  echo "     EMPTY for the first 24 h: crypto is real-time anonymously). Then re-run this script."
fi
if [ -f "$ENVFILE" ]; then
  mode="$(stat -c %a "$ENVFILE")"; [ "$mode" = 600 ] && ok "mode 600" || fail "mode is $mode, run: chmod 600 $ENVFILE"
  echo "  variables with a value (names only):"
  awk -F= '!/^#/ && NF>1 && $2!="" {print "    " $1}' "$ENVFILE"
fi

if [ "$PINE" = 1 ]; then
  step "6. Pyne scripts (7c)"
  PY=python3
  "$PY" -c 'import sys; sys.exit(0 if sys.version_info>=(3,11) else 1)' 2>/dev/null \
    && ok "$("$PY" --version)" || { fail "Python 3.11+ needed for the pine extra"; PINE=0; }
fi
if [ "$PINE" = 1 ]; then
  VENV="$REPO/.venv-pi"
  [ -d "$VENV" ] || "$PY" -m venv "$VENV" || fail "venv failed (sudo apt install -y python3-venv)"
  if "$VENV/bin/pip" install -q "$REPO[pine]" >/tmp/tvw-pip.log 2>&1; then ok "pip install '.[pine]'"
  else fail "pip install failed, last lines:"; tail -10 /tmp/tvw-pip.log; fi
  mkdir -p "$HOME/.tradingview-mcp/strategies"
  cp -n "$REPO/docs/examples/pine/ema_cross.py" "$HOME/.tradingview-mcp/strategies/" && ok "example script in place"
  "$VENV/bin/python" - <<'PY'
import resource, time, random
from datetime import date, timedelta
from tradingview_mcp.core.services import pine_service as pine
print("  pine available:", pine.available())
random.seed(1); price = 100.0; candles = []
for i in range(600):
    o = price; price = max(5.0, price * (1 + random.uniform(-0.02, 0.021)))
    candles.append({"date": str(date(2022, 1, 3) + timedelta(days=i)), "open": round(o, 4),
                    "high": round(max(o, price) * 1.004, 4), "low": round(min(o, price) * 0.996, 4),
                    "close": round(price, 4), "volume": 1000.0})
t = time.perf_counter(); trades = pine.run_script("ema_cross", candles); one = time.perf_counter() - t
t = time.perf_counter()
for _ in range(20): pine.run_script("ema_cross", candles)
twenty = time.perf_counter() - t
print(f"  1 run: {one:.2f}s ({len(trades)} trades), 20 runs: {twenty:.1f}s (a gauntlet asks for about 20 neighbours)")
print(f"  peak memory of this python: {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024:.0f} MB")
PY
  [ -z "$(ls -A "$HOME/.tradingview-mcp/strategies" | grep -v '\.py$')" ] && ok "strategies folder holds only .py files" \
    || warn "strategies folder has extra files: $(ls -A "$HOME/.tradingview-mcp/strategies")"
fi

if [ "$IMAGES" = 1 ]; then
  step "7. Chromium for alert pictures (7b)"
  sudo apt-get install -y chromium >/tmp/tvw-apt.log 2>&1 || sudo apt-get install -y chromium-browser >>/tmp/tvw-apt.log 2>&1
  CHROMIUM="$(command -v chromium || command -v chromium-browser || true)"
  [ -n "$CHROMIUM" ] && ok "chromium at $CHROMIUM ($("$CHROMIUM" --version 2>/dev/null))" || { fail "chromium not installed:"; tail -5 /tmp/tvw-apt.log; }
  echo "  -> to turn pictures on: set WATCHER_CHROMIUM_PATH=$CHROMIUM in $ENVFILE and \"images\": {\"enabled\": true} in $CONF"
  echo "     then measure while an alert picture renders:  grep Pss /proc/\$(pgrep -f chromium | head -1)/smaps_rollup"
fi

if [ "$ENABLE" = 1 ]; then
  step "8. systemd service"
  if [ ! -f "$ENVFILE" ] || ! awk -F= '!/^#/ && ($1=="DISCORD_WEBHOOK_URL"||$1=="TELEGRAM_BOT_TOKEN") && $2!=""{f=1} END{exit !f}' "$ENVFILE"; then
    fail "no Discord or Telegram value set in $ENVFILE; refusing to start a watcher that cannot alert"; exit 1
  fi
  # the shipped unit assumes user 'pi' and /home/pi/code/tradingview-mcp; adapt it to this machine
  sed -e "s#^User=pi#User=$ME#" -e "s#/home/pi/code/tradingview-mcp#$REPO#g" -e "s#/home/pi#$HOME#g" \
      "$REPO/bridge/watcher.service.example" | sudo tee "$UNIT" >/dev/null && ok "wrote $UNIT"
  sudo systemctl daemon-reload && sudo systemctl enable --now tradingview-watcher && ok "enabled and started"
  sleep 8
  [ "$(systemctl is-active tradingview-watcher)" = active ] && ok "service is active" || fail "service is $(systemctl is-active tradingview-watcher)"
  mm="$(cat /sys/fs/cgroup/system.slice/tradingview-watcher.service/memory.max 2>/dev/null)"
  [ "$mm" = 536870912 ] && ok "memory.max = 512 MB" || warn "memory.max is '$mm' (expected 536870912)"
  echo "  last log lines:"; journalctl -u tradingview-watcher -n 15 --no-pager | sed 's/^/    /'
fi

step "Next"
if [ "$ENABLE" = 0 ]; then
  cat <<EOF
  1. Test the channels (sends one message to each configured channel):
       cd $REPO && (set -a; . $ENVFILE; set +a; node bridge/watcher.mjs --config $CONF --test-notify)
  2. See alerts without sending them, for about an hour:
       cd $REPO && (set -a; . $ENVFILE; set +a; node bridge/watcher.mjs --config $CONF --dry-run)
  3. When both look right:  bash scripts/pi-setup.sh --enable
EOF
fi
echo; echo "Done: $FAILS FAIL, $WARNS WARN."
