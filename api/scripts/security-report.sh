#!/usr/bin/env bash
# Security events from the API, newest first, plus a per-kind and per-IP
# summary. Reads with the service key fetched from the Supabase CLI for this
# run only; nothing is written to disk.
#
#   api/scripts/security-report.sh [hours=24]
#   api/scripts/security-report.sh 168          # a week
#
# Live request logs: cd api && npx wrangler tail --format json
# Unblock an address:  npx wrangler kv key delete --binding GUARD --remote ip:<addr>
set -euo pipefail
HOURS="${1:-24}"
REF="fkdwbaovohfvuqcobbtl"
cd "$(dirname "$0")/.."
KEY=$(npx supabase projects api-keys --project-ref "$REF" -o json 2>/dev/null \
  | jq -r '[.[] | select(.name=="service_role" or (.api_key|startswith("sb_secret")))][0].api_key')
[ -n "$KEY" ] || { echo "could not read the service key (npx supabase login?)" >&2; exit 1; }
H=(-H "apikey: $KEY"); [[ $KEY != sb_* ]] && H+=(-H "Authorization: Bearer $KEY")
SINCE=$(date -u -d "-${HOURS} hours" +%Y-%m-%dT%H:%M:%SZ)
ROWS=$(curl -fsS "${H[@]}" "https://$REF.supabase.co/rest/v1/security_events?select=at,kind,ip,country,path,ua,detail&at=gte.$SINCE&order=id.desc&limit=5000")
unset KEY
echo "== last ${HOURS}h: $(jq length <<<"$ROWS") events"
echo "-- by kind";  jq -r 'group_by(.kind) | map("\(length)\t\(.[0].kind)") | sort | reverse[]' <<<"$ROWS"
echo "-- top addresses"; jq -r 'group_by(.ip) | map("\(length)\t\(.[0].ip)\t\(.[0].country // "")\t\(map(.kind) | unique | join(","))") | sort_by(-(split("\t")[0]|tonumber))[:15][]' <<<"$ROWS"
echo "-- latest 25"; jq -r '.[:25][] | "\(.at[0:19])  \(.kind)\t\(.ip)\t\(.path)\t\(.ua[0:60])"' <<<"$ROWS"
