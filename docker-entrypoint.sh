#!/bin/sh
set -eu

if [ -n "${APP_SECRETS_FILE:-}" ] && [ -f "$APP_SECRETS_FILE" ]; then
  SECRET_JSON="$(cat "$APP_SECRETS_FILE")"

  eval "$({
    printf '%s' "$SECRET_JSON" | node -e '
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const data = JSON.parse(input);
for (const [key, value] of Object.entries(data)) {
  if (value === undefined || value === null) continue;
  const escaped = JSON.stringify(String(value));
  process.stdout.write(`export ${key}=${escaped}\n`);
}
'
  })"
elif [ -n "${APP_SECRETS_JSON:-}" ]; then
  SECRET_JSON="$APP_SECRETS_JSON"

  eval "$({
    printf '%s' "$SECRET_JSON" | node -e '
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const data = JSON.parse(input);
for (const [key, value] of Object.entries(data)) {
  if (value === undefined || value === null) continue;
  const escaped = JSON.stringify(String(value));
  process.stdout.write(`export ${key}=${escaped}\n`);
}
'
  })"
else
  echo "APP_SECRETS_FILE or APP_SECRETS_JSON must be set" >&2
  exit 1
fi

exec node server.js