#!/usr/bin/env bash
# Sets up the market watcher on a Raspberry Pi (Raspberry Pi OS 64-bit). Safe to re-run: every step checks first.
#
#   bash scripts/pi-setup.sh              checks + install + config (does NOT start the service)
#   bash scripts/pi-setup.sh --telegram   ask for your Telegram bot token (hidden), find your chat id, save both
#   bash scripts/pi-setup.sh --discord    ask for your Discord webhook URL (hidden) and save it
#   bash scripts/pi-setup.sh --sec-contact  ask for the SEC contact email (hidden) and save it
#   bash scripts/pi-setup.sh --finnhub    ask for the Finnhub API key (hidden) and save it (only for news.sources.finnhub)
#   bash scripts/pi-setup.sh --test       send one test message to every configured channel
#   bash scripts/pi-setup.sh --enable     install and start the systemd service (only after a passing --test)
#   bash scripts/pi-setup.sh --node       install Node 22 system-wide (the service needs /usr/bin/node, not nvm's)
#   bash scripts/pi-setup.sh --cgroup     turn on the memory cgroup so MemoryMax works (needs a reboot afterwards)
#   bash scripts/pi-setup.sh --pine       also set up the Pyne (7c) extra and time a script run
#   bash scripts/pi-setup.sh --images     also install Chromium for alert pictures (7b)
# Options combine and always run in this order: install, channels, pine/images, test, enable. So once the
# machine is set up, this is the whole thing:  bash scripts/pi-setup.sh --telegram --test --enable
#
# No editor needed. Secrets are typed hidden and written straight into /etc/tradingview-watcher.env; they are
# never printed or put on a command line. Paste the output back to Claude when something says FAIL or WARN.
set -u
# The service runs /usr/bin/node, so check and use that one, not an nvm node that happens to be first in this shell.
PATH=/usr/bin:$PATH

PINE=0 IMAGES=0 ENABLE=0 DISCORD=0 TELEGRAM=0 TEST=0 NODE=0 CGROUP=0 SEC_CONTACT=0 FINNHUB=0
for a in "$@"; do
  case "$a" in
    --pine) PINE=1 ;; --images) IMAGES=1 ;; --enable) ENABLE=1 ;;
    --node) NODE=1 ;; --cgroup) CGROUP=1 ;; --discord) DISCORD=1 ;; --telegram) TELEGRAM=1 ;; --test) TEST=1 ;;
    --sec-contact) SEC_CONTACT=1 ;;
    --finnhub) FINNHUB=1 ;;
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

# Refuse all prompts and writes unless one chmod attempt establishes private mode.
require_private_file() {
  [ -f "$ENVFILE" ] || { fail "settings file is missing; nothing saved"; exit 1; }
  local mode
  mode="$(stat -c %a "$ENVFILE")"
  if [ "$mode" != 600 ]; then
    local previous_mode="$mode"
    chmod 600 "$ENVFILE" 2>/dev/null || true
    mode="$(stat -c %a "$ENVFILE")"
    [ "$mode" != 600 ] || ok "repaired settings file mode $previous_mode to 600"
  fi
  [ "$mode" = 600 ] || { fail "mode is $mode; private mode 600 required; nothing saved; run: sudo chown $ME:$ME $ENVFILE && chmod 600 $ENVFILE"; exit 1; }
}

# set_var NAME VALUE: set NAME= in the secrets file in place (the file is ours, mode 600, so no sudo and no temp copy).
# The value travels in the environment of one node process, never on a command line.
set_var() {
  require_private_file
  N="$1" V="$2" node -e '
    const fs = require("fs"), f = process.argv[1], n = process.env.N, v = process.env.V;
    let lines = fs.readFileSync(f, "utf8").split("\n"), hit = false;
    lines = lines.map((l) => (l.startsWith(n + "=") ? (hit = true, n + "=" + v) : l));
    if (!hit) { if (lines[lines.length - 1] === "") lines.pop(); lines.push(n + "=" + v, ""); }
    fs.writeFileSync(f, lines.join("\n"));' "$ENVFILE"
}
# ask_hidden "prompt" VARNAME: read one line without echoing it
ask_hidden() { local v; read -rsp "  $1: " v; echo; printf -v "$2" '%s' "$v"; }
# tg METHOD: call the Telegram Bot API for $TOK without the token showing up in `ps`
tg() { printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$TOK" "$1" | curl -s -m 15 -K -; }

step "1. This machine"
echo "  user=$ME  repo=$REPO"
[ "$(uname -m)" = "aarch64" ] && ok "arm64" || warn "not arm64 ($(uname -m)); the Pi 400 should be aarch64 (64-bit OS)"
grep -h PRETTY_NAME /etc/os-release | sed 's/^/  /'
free -m | awk 'NR==2{printf "  RAM total %s MB, available %s MB\n",$2,$7}'
df -h "$HOME" | awk 'NR==2{printf "  disk: %s free on %s\n",$4,$6}'
if command -v vcgencmd >/dev/null; then echo "  $(vcgencmd get_throttled)  (0x0 = no under-voltage ever seen)"; fi

if [ "$NODE" = 1 ]; then
  step "1b. Node 22 system-wide (NodeSource)"
  # not nvm: systemd does not load your shell setup, and an nvm path breaks on every upgrade. Not Debian's apt
  # nodejs either: its version varies by release. NodeSource's 22.x is what the README prescribes.
  if /usr/bin/node -v 2>/dev/null | grep -q '^v22\.'; then ok "already have $(/usr/bin/node -v) at /usr/bin/node"
  else
    tmp="$(mktemp)" && curl -fsSL -o "$tmp" https://deb.nodesource.com/setup_22.x \
      && sudo -E bash "$tmp" >/tmp/tvw-node.log 2>&1 && sudo apt-get install -y nodejs >>/tmp/tvw-node.log 2>&1 \
      && ok "installed $(/usr/bin/node -v) at /usr/bin/node" || { fail "Node install failed, last lines:"; tail -8 /tmp/tvw-node.log; }
    rm -f "$tmp"
  fi
fi

step "2. Tools"
if command -v node >/dev/null; then
  NODE_V="$(node -v)"; NODE_PATH_="$(command -v node)"
  major="${NODE_V#v}"; major="${major%%.*}"
  [ "$major" -ge 22 ] 2>/dev/null && ok "node $NODE_V" || fail "node $NODE_V is too old, want 22: run with --node"
  [ "$NODE_PATH_" = /usr/bin/node ] && ok "node is /usr/bin/node" \
    || fail "node is $NODE_PATH_, not /usr/bin/node: the service would die with 203/EXEC. Run with --node"
else
  fail "node is not installed"
fi
for t in git npm; do command -v "$t" >/dev/null && ok "$t" || fail "$t missing (sudo apt install -y $t)"; done
[ "$(systemctl is-active systemd-timesyncd 2>/dev/null)" = active ] && ok "systemd-timesyncd active" \
  || warn "systemd-timesyncd not active: the clock-sync wait in the unit only works with it"
[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && ok "clock is synchronized" || warn "clock not synchronized yet"
if grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null; then ok "memory cgroup on (MemoryMax will work)"
else
  CMDLINE=/boot/firmware/cmdline.txt; [ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
  if grep -q 'cgroup_enable=memory' "$CMDLINE" 2>/dev/null; then
    warn "memory cgroup is set in $CMDLINE but not active yet: reboot (sudo reboot), or MemoryMax=512M is ignored"
  elif [ "$CGROUP" = 1 ]; then
    # cmdline.txt is ONE line: append to it, keep a backup next to it
    sudo cp "$CMDLINE" "$CMDLINE.bak" && sudo sed -i '1 s/[[:space:]]*$/ cgroup_enable=memory cgroup_memory=1/' "$CMDLINE" \
      && warn "added the memory cgroup to $CMDLINE (backup: $CMDLINE.bak). REBOOT needed: sudo reboot" \
      || fail "could not edit $CMDLINE"
  else
    warn "memory cgroup OFF, so MemoryMax=512M would be ignored: run with --cgroup, then reboot"
  fi
fi
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
fi
require_private_file
if [ -f "$ENVFILE" ] && ! grep -q '^WATCHER_LOCAL_TOKEN=.\+' "$ENVFILE"; then
  # guards POST /notify and is what switches on the local API, which also serves /health; never printed
  command -v openssl >/dev/null && sudo sed -i "s|^WATCHER_LOCAL_TOKEN=.*|WATCHER_LOCAL_TOKEN=$(openssl rand -hex 24)|" "$ENVFILE"
  grep -q '^WATCHER_LOCAL_TOKEN=.\+' "$ENVFILE" && ok "generated WATCHER_LOCAL_TOKEN (turns on /health at 127.0.0.1:8787)" \
    || warn "could not set WATCHER_LOCAL_TOKEN: /health on 8787 stays off (set it by hand or use the dashboard Health panel)"
fi
ok "mode 600"

if [ "$DISCORD" = 1 ] || [ "$TELEGRAM" = 1 ] || [ "$SEC_CONTACT" = 1 ] || [ "$FINNHUB" = 1 ]; then
  [ -t 0 ] || { fail "channel/contact options ask you questions: run this in an interactive terminal (ssh -t ...)"; exit 1; }
  [ -w "$ENVFILE" ] || { fail "cannot write $ENVFILE"; exit 1; }
fi
if [ "$TELEGRAM" = 1 ]; then
  require_private_file
  step "5b. Telegram"
  echo "  1) In Telegram open @BotFather, send /newbot, pick a name; it replies with a token like 123456:ABC..."
  ask_hidden "Paste the bot token (typing is hidden)" TOK
  me="$(tg getMe)"
  if printf '%s' "$me" | grep -q '"ok":true'; then
    bot="$(printf '%s' "$me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.username)}catch{}})')"
    ok "Telegram accepts the token (bot @${bot:-?})"
    echo "  2) Open @${bot:-your bot} in Telegram, press Start, and send it any message (for a group: add it, send a message)."
    read -rp "     Press Enter here when you have sent it: " _
    CHAT="$(tg getUpdates | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
      const u=(JSON.parse(s).result||[]).map(r=>r.message||r.channel_post||r.edited_message).filter(Boolean).pop();
      if(u) console.log(u.chat.id)}catch{}})')"
    if [ -n "$CHAT" ]; then ok "found your chat id ($CHAT)"
    else read -rp "     Could not find it automatically. Type your chat id (a number): " CHAT; fi
    case "$CHAT" in
      -[0-9]*|[0-9]*) set_var TELEGRAM_BOT_TOKEN "$TOK"; set_var TELEGRAM_CHAT_ID "$CHAT"; ok "saved Telegram token and chat id" ;;
      *) fail "chat id must be a number; nothing saved" ;;
    esac
  else
    fail "Telegram rejected that token (check you copied all of it); nothing saved"
  fi
  TOK=""
fi
if [ "$DISCORD" = 1 ]; then
  require_private_file
  step "5c. Discord"
  echo "  In Discord: Server Settings > Integrations > Webhooks > New Webhook > Copy Webhook URL"
  ask_hidden "Paste the webhook URL (typing is hidden)" URL
  case "$URL" in
    https://discord.com/api/webhooks/*|https://discordapp.com/api/webhooks/*) set_var DISCORD_WEBHOOK_URL "$URL"; ok "saved Discord webhook" ;;
    *) fail "that is not a Discord webhook URL (it starts with https://discord.com/api/webhooks/); nothing saved" ;;
  esac
  URL=""
fi
if [ "$SEC_CONTACT" = 1 ]; then
  require_private_file
  step "5d. SEC EDGAR contact"
  ask_hidden "Contact email for SEC's required User-Agent (typing is hidden)" CONTACT
  if [[ ${#CONTACT} -le 254 && "$CONTACT" =~ ^[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}$ ]]; then
    set_var WATCHER_SEC_CONTACT "$CONTACT" && ok "saved WATCHER_SEC_CONTACT" || fail "could not save SEC contact"
  else fail "enter a contact email address; nothing saved"; fi
  CONTACT=""
fi
if [ "$FINNHUB" = 1 ]; then
  require_private_file
  step "5e. Finnhub API key"
  echo "  Free key: finnhub.io/register (personal, non-professional use only; see bridge/README.md)"
  ask_hidden "Paste the Finnhub API key (typing is hidden)" KEY
  # Letters, digits, _ and - only (8 to 200). The file is sourced by bash (--test) and parsed by systemd, so a quote,
  # $, ;, # or \ in the value would run or change; the watcher accepts more, but a real key never needs it. C locale so the ranges mean ASCII.
  if (LC_ALL=C; [[ "$KEY" =~ ^[A-Za-z0-9_-]{8,200}$ ]]); then
    set_var FINNHUB_API_KEY "$KEY" && ok "saved FINNHUB_API_KEY" || fail "could not save the Finnhub key"
  else fail "that does not look like a Finnhub key (8 to 200 letters, digits, _ or -); nothing saved"; fi
  KEY=""
fi
if [ -f "$ENVFILE" ]; then
  echo "  variables with a value (names only):"; awk -F= '!/^#/ && NF>1 && $2!="" {print "    " $1}' "$ENVFILE"
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

has_channel() {   # Discord URL, or Telegram token AND chat id (names only, values are not read out)
  awk -F= '!/^#/ && $2!="" {s[$1]=1} END{exit !(s["DISCORD_WEBHOOK_URL"] || (s["TELEGRAM_BOT_TOKEN"] && s["TELEGRAM_CHAT_ID"]))}' "$ENVFILE"
}

TEST_OK=0
if [ "$TEST" = 1 ] || [ "$ENABLE" = 1 ]; then
  step "7. Test message"
  if ! has_channel; then
    fail "no channel yet: run with --telegram or --discord first"
  else
    out="$(cd "$REPO" && set -a && . "$ENVFILE" && set +a && node bridge/watcher.mjs --config "$CONF" --test-notify 2>&1)"; rc=$?
    echo "$out" | sed 's/^/  /'
    [ "$rc" = 0 ] && { TEST_OK=1; ok "test sent: look at your Telegram/Discord for the message"; } || fail "the test message failed (exit $rc)"
  fi
fi

if [ "$ENABLE" = 1 ]; then
  step "8. systemd service"
  [ "$TEST_OK" = 1 ] || { fail "not starting the service: the test message did not go through"; exit 1; }
  # the shipped unit assumes user 'pi' and /home/pi/code/tradingview-mcp; adapt it to this machine
  sed -e "s#^User=pi#User=$ME#" -e "s#/home/pi/code/tradingview-mcp#$REPO#g" -e "s#/home/pi#$HOME#g" \
      "$REPO/bridge/watcher.service.example" | sudo tee "$UNIT" >/dev/null && ok "wrote $UNIT"
  sudo systemctl daemon-reload && sudo systemctl enable --now tradingview-watcher && ok "enabled and started"
  sleep 8
  [ "$(systemctl is-active tradingview-watcher)" = active ] && ok "service is active" || fail "service is $(systemctl is-active tradingview-watcher)"
  mm="$(cat /sys/fs/cgroup/system.slice/tradingview-watcher.service/memory.max 2>/dev/null)"
  [ "$mm" = 536870912 ] && ok "memory.max = 512 MB" || warn "memory.max is '$mm' (expected 536870912)"
  echo "  health: $(curl -s -m 5 127.0.0.1:8787/health || echo 'no answer (no WATCHER_LOCAL_TOKEN, or still starting)')"
  echo "  last log lines:"; journalctl -u tradingview-watcher -n 15 --no-pager | sed 's/^/    /'
fi

step "Next"
if ! has_channel 2>/dev/null; then
  echo "  No alert channel yet. Pick one (it asks you; typing is hidden):"
  echo "     bash scripts/pi-setup.sh --telegram --test --enable      (or --discord)"
elif [ "$ENABLE" = 0 ]; then
  echo "  Send a test message and start the service:"
  echo "     bash scripts/pi-setup.sh --test --enable"
  echo "  (Optional first: watch alerts without sending them, about an hour:"
  echo "     cd $REPO && (set -a; . $ENVFILE; set +a; node bridge/watcher.mjs --config $CONF --dry-run))"
fi
echo; echo "Done: $FAILS FAIL, $WARNS WARN."
