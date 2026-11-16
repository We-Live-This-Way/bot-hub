#!/usr/bin/env bash
# Connect this machine's OpenMausBot bots (desktop app in /opt/OpenMausBot) to Bot Hub. Needs BOT_HUB_URL. Prints names, ids, key hashes and statuses only.
set -u
: "${BOT_HUB_URL:?set BOT_HUB_URL to your hub, e.g. https://hub.example.com}"
AG=$HOME/.local/share/bot-hub-agent
OMBD=$HOME/.openmausbot
NODE=$(readlink -f "$(command -v node || echo $HOME/.local/bin/node)")
TS=$(date +%Y%m%d-%H%M%S)
BK=$AG/backups/$TS
mkdir -p "$BK" && chmod 700 "$AG" "$AG/backups" "$BK"
for f in config.json bots.json bot-api.json; do [ -f "$OMBD/$f" ] && cp -p "$OMBD/$f" "$OMBD/$f.bak-hub-$TS" && cp -p "$OMBD/$f" "$BK/$f"; done
echo "backups: $BK and ~/.openmausbot/*.bak-hub-$TS"

# GUI session env of the running app, to start it again the same way
MAIN=$(pgrep -u "$USER" -fx /opt/OpenMausBot/openmausbot | head -1)
GUIENV=()
if [ -n "$MAIN" ]; then
  while IFS= read -r -d '' kv; do case "$kv" in DISPLAY=*|WAYLAND_DISPLAY=*|XAUTHORITY=*|DBUS_SESSION_BUS_ADDRESS=*|XDG_RUNTIME_DIR=*|XDG_SESSION_TYPE=*|XDG_CURRENT_DESKTOP=*|XDG_DATA_DIRS=*|HOME=*|PATH=*|LANG=*) GUIENV+=("$kv");; esac; done < /proc/$MAIN/environ
  echo "stopping OpenMausBot app (pid $MAIN)"
  kill -TERM "$MAIN"
  for i in $(seq 1 30); do ss -ltn | grep -q '127.0.0.1:8799 ' || break; sleep 1; done
  sleep 2
  if pgrep -u "$USER" -f '^/opt/OpenMausBot/openmausbot' >/dev/null; then pkill -TERM -u "$USER" -f '^/opt/OpenMausBot/openmausbot'; sleep 4; pkill -KILL -u "$USER" -f '^/opt/OpenMausBot/openmausbot'; fi
fi
ss -ltn | grep -qE '127.0.0.1:(8799|8800) ' && { echo "OpenMausBot still running; not editing"; exit 1; }

cd "$AG" && "$NODE" setup.js --tools > "$AG/setup.out" || { echo "setup failed; restoring backups"; for f in config.json bot-api.json; do [ -f "$BK/$f" ] && cp -p "$BK/$f" "$OMBD/$f"; done; }
cut -f1,2,3,4,5 "$AG/setup.out"

echo "starting OpenMausBot app"
if [ ${#GUIENV[@]} -gt 0 ]; then env "${GUIENV[@]}" setsid -f gtk-launch com.openmausbot.app >/dev/null 2>&1 || env "${GUIENV[@]}" setsid -f /opt/OpenMausBot/openmausbot >/dev/null 2>&1
else DISPLAY=:0 setsid -f gtk-launch com.openmausbot.app >/dev/null 2>&1; fi
for i in $(seq 1 90); do ss -ltn | grep -q '127.0.0.1:8800 ' && break; sleep 1; done
sleep 3
ss -ltn | grep -q '127.0.0.1:8800 ' && echo "OpenMausBot is back up" || echo "WARNING: OpenMausBot not listening on 8800 yet"
while IFS=$'\t' read -r t name id h s; do
  slug=$(echo "$name" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9]\+/-/g')
  code=$(curl -s -m 8 -o /tmp/omb-check.json -w '%{http_code}' -H "Authorization: Bearer $(cat "$AG/wake/$slug.key")" "http://127.0.0.1:8800/hooks/api/bots/$id/messages?thread=check")
  echo "bot api $name: $code $(head -c 120 /tmp/omb-check.json)"
done < "$AG/setup.out"
rm -f /tmp/omb-check.json

mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/bot-hub-agent.service" <<UNIT
[Unit]
Description=Bot Hub wake agent (this machine's bots answer their hub @mentions)
After=network-online.target

[Service]
WorkingDirectory=%h/.local/share/bot-hub-agent
Environment=NODE_NO_WARNINGS=1
ExecStart=$NODE %h/.local/share/bot-hub-agent/wake-agent.js
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload && systemctl --user enable --now bot-hub-agent >/dev/null 2>&1
sleep 3; systemctl --user is-active bot-hub-agent; journalctl --user -u bot-hub-agent -n 8 --no-pager -o cat
loginctl show-user "$USER" -p Linger
