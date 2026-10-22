#!/usr/bin/env bash
# Renders the doubleplus PNGs (favicons, iOS icon, X avatar and header, link
# card) from the SVGs doubleplus-logo.mjs writes. Needs a Chromium: set CHROME
# or keep Playwright's at its default path. Run from anywhere.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pub="$here/../web/public"
CHROME="${CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | tail -1)}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
shoot() { # html w h out [transparent]
  "$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --force-device-scale-factor=1 ${5:+--default-background-color=00000000} \
    --window-size="$2,$3" --screenshot="$4" "file://$1" 2>/dev/null
}
img() { # svg w h out [transparent]
  printf '<html><body style="margin:0;background:transparent"><img src="file://%s" width="%s" height="%s" style="display:block"></body></html>' "$here/$1" "$2" "$3" > "$tmp/i.html"
  shoot "$tmp/i.html" "$2" "$3" "$4" "${5:-}"
}
img doubleplus-icon.svg 64 64 "$pub/doubleplus-icon-64.png" t
img doubleplus-icon.svg 192 192 "$here/doubleplus-icon.png" t
img doubleplus-icon-square.svg 180 180 "$pub/doubleplus-touch.png"
img doubleplus-avatar.svg 400 400 "$here/doubleplus-avatar.png"

BG="background:radial-gradient(700px 260px at 12% 80%, rgb(40 140 60 / .22), transparent 70%),radial-gradient(900px 400px at 85% 10%, rgb(50 90 200 / .25), transparent 70%),linear-gradient(#0b1430,#050914 70%);"
cat > "$tmp/banner.html" <<HTML
<html><body style="margin:0;width:1500px;height:500px;$BG;font-family:'Noto Sans';display:flex;align-items:center;justify-content:center;gap:44px;overflow:hidden">
<img src="file://$here/doubleplus-mark.svg" style="height:190px;filter:drop-shadow(0 0 30px rgb(110 230 90 / .35))">
<div style="display:grid;gap:6px"><div style="font:700 72px 'Noto Sans';color:#fff;letter-spacing:-.01em">doubleplus<span style="color:#7fe08a">.fun</span></div>
<div style="font:400 30px 'Noto Sans';color:#9fb2d9">coins on Robinhood Chain</div></div>
</body></html>
HTML
shoot "$tmp/banner.html" 1500 500 "$here/doubleplus-banner-x.png"

rows=""
for r in "Every coin starts|on a bonding curve that rises with each buy" "When the curve fills|it moves to a Uniswap pool, locked for good" "If a raise misses|every buyer gets their ETH back" "Creator's fee|0 to 4% per trade, fixed at launch"; do
  rows+="<tr style=\"border-top:1px solid #243560\"><td style=\"padding:9px 0;color:#8496c4;width:250px\">${r%%|*}</td><td style=\"color:#e8eeff\">${r#*|}</td></tr>"
done
cat > "$tmp/card.html" <<HTML
<html><body style="margin:0;width:1200px;height:630px;$BG;font-family:'Noto Sans';position:relative;overflow:hidden">
<div style="position:absolute;left:58px;top:42px;width:1084px;height:474px;border-radius:10px;border:1px solid #3a4f8a;background:rgb(6 10 26 / .92);box-shadow:0 0 0 1px #000,0 20px 60px rgb(0 0 0 / .6);overflow:hidden">
 <div style="height:48px;display:flex;align-items:center;gap:12px;padding:0 16px;background:linear-gradient(#5a78c0,#2c4386 50%,#22356f 51%,#2e4a8e);border-bottom:1px solid #000">
  <img src="file://$here/doubleplus-icon.svg" width="28" height="28"><span style="font:600 21px 'Noto Sans';color:#fff;text-shadow:0 1px 2px #000">doubleplus</span>
  <span style="margin-left:auto;display:flex;gap:4px"><i style="width:30px;height:22px;border-radius:3px;background:#3557a8;border:1px solid #0b1a44"></i><i style="width:30px;height:22px;border-radius:3px;background:#3557a8;border:1px solid #0b1a44"></i><i style="width:46px;height:22px;border-radius:3px;background:#c9483c;border:1px solid #4a0d08"></i></span></div>
 <div style="margin:6px 16px;height:24px;border:1px solid #2c3d70;border-radius:3px;background:#070c1e;font:14px 'Noto Sans';color:#a9b8de;display:flex;align-items:center;padding:0 10px">doubleplus.fun ▸&nbsp;<span style="color:#fff">Coins</span></div>
 <div style="padding:30px 50px 0">
  <div style="display:flex;align-items:center;gap:26px"><img src="file://$here/doubleplus-mark.svg" style="height:86px"><div><div style="font:600 56px/1.05 'Noto Sans';color:#eef3ff">doubleplus</div><div style="font:22px 'Noto Sans';color:#9fb2d9;margin-top:4px">Coins on Robinhood Chain</div></div></div>
  <table style="margin-top:28px;width:100%;border-collapse:collapse;font:19px 'Noto Sans'">$rows</table></div></div>
<div style="position:absolute;left:0;right:0;bottom:0;height:56px;background:linear-gradient(#2a3f80,#14204a 50%,#0c1536 51%,#121d44);border-top:1px solid #4a63a8;display:flex;align-items:center;padding:0 16px">
 <span style="height:38px;padding:0 26px;border-radius:19px;display:flex;align-items:center;font:italic 700 20px 'Noto Sans';color:#fff;text-shadow:1px 1px 2px #000;background:linear-gradient(#78dd55,#3fae2a 48%,#2e8b1f 52%,#49b733);border:1px solid #1d5c11">start</span>
 <span style="margin-left:auto;display:flex;align-items:center;gap:12px"><img src="file://$here/doubleplus-mark.svg" style="height:34px"><span style="font:600 26px 'Noto Sans';color:#eef3ff">doubleplus<span style="color:#7fe08a">.fun</span></span></span></div>
</body></html>
HTML
shoot "$tmp/card.html" 1200 630 "$pub/doubleplus-card.png"
echo "rendered"
