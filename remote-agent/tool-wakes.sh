#!/usr/bin/env bash
# v0.6: give this machine's bots tool wake-ups (a "Bot Hub wake-ups" webhook trigger each; see omb-runs.js). Closes the
# OpenMausBot app while webhooks.json is edited, then starts it again the same way. Prints names and ids only.
set -u
AG=$HOME/.local/share/bot-hub-agent
OMBD=$HOME/.openmausbot
NODE=$(systemctl --user cat bot-hub-agent 2>/dev/null | sed -n 's/^ExecStart=\([^ ]*\) .*/\1/p' | head -1)
[ -x "$NODE" ] || NODE=$(readlink -f "$(command -v node)")
TS=$(date +%Y%m%d-%H%M%S); BK=$AG/backups/$TS; mkdir -p "$BK" && chmod 700 "$BK"
for f in config.json bots.json bot-api.json webhooks.json; do [ -f "$OMBD/$f" ] && cp -p "$OMBD/$f" "$BK/$f"; done
[ -f "$AG/wake-hooks.json" ] && cp -p "$AG/wake-hooks.json" "$BK/"
echo "backups: $BK"
MAIN=$(pgrep -u "$USER" -fx /opt/OpenMausBot/openmausbot | head -1)
GUIENV=()
if [ -n "$MAIN" ]; then
  while IFS= read -r -d '' kv; do case "$kv" in DISPLAY=*|WAYLAND_DISPLAY=*|XAUTHORITY=*|DBUS_SESSION_BUS_ADDRESS=*|XDG_RUNTIME_DIR=*|XDG_SESSION_TYPE=*|XDG_CURRENT_DESKTOP=*|XDG_DATA_DIRS=*|HOME=*|PATH=*|LANG=*) GUIENV+=("$kv");; esac; done < /proc/$MAIN/environ
  echo "stopping OpenMausBot app (pid $MAIN)"; kill -TERM "$MAIN"
  for i in $(seq 1 30); do ss -ltn | grep -qE '127.0.0.1:(8799|8800) ' || break; sleep 1; done; sleep 2
  if pgrep -u "$USER" -f '^/opt/OpenMausBot/openmausbot' >/dev/null; then pkill -TERM -u "$USER" -f '^/opt/OpenMausBot/openmausbot'; sleep 4; pkill -KILL -u "$USER" -f '^/opt/OpenMausBot/openmausbot'; fi
fi
ss -ltn | grep -qE '127.0.0.1:(8799|8800) ' && { echo "OpenMausBot still running; not editing"; exit 1; }
ARGS=$(python3 -c "import json;print(' '.join(b['botId']+'='+b['name'] for b in json.load(open('$AG/agent.json'))['bots']))")
cd "$AG" && "$NODE" omb-tool-hooks.js --omb-dir "$OMBD" --out "$AG/wake-hooks.json" $ARGS | cut -f1,2 || { echo "failed; restoring webhooks.json"; [ -f "$BK/webhooks.json" ] && cp -p "$BK/webhooks.json" "$OMBD/" || rm -f "$OMBD/webhooks.json"; }
echo "starting OpenMausBot app"
if [ ${#GUIENV[@]} -gt 0 ]; then env "${GUIENV[@]}" setsid -f gtk-launch com.openmausbot.app >/dev/null 2>&1 || env "${GUIENV[@]}" setsid -f /opt/OpenMausBot/openmausbot >/dev/null 2>&1
else DISPLAY=:0 setsid -f gtk-launch com.openmausbot.app >/dev/null 2>&1; fi
for i in $(seq 1 90); do ss -ltn | grep -q '127.0.0.1:8800 ' && break; sleep 1; done; sleep 3
ss -ltn | grep -q '127.0.0.1:8800 ' && echo "OpenMausBot is back up" || echo "WARNING: OpenMausBot not listening on 8800 yet"
systemctl --user restart bot-hub-agent && echo "bot-hub-agent restarted"
