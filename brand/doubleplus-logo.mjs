// Builds the doubleplus "+2x" logo SVGs into brand/ (node brand/doubleplus-logo.mjs).
// The "2" is Noto Sans Black's outline; the x is a "/" with its middle cut
// out and the Robinhood feather, mirrored to lean as "\", through the gap.
// Both outlines are in doubleplus-logo-paths.json (the feather traced from
// Robinhood's mark). render-doubleplus.sh turns the SVGs into PNGs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { two, feather } = JSON.parse(fs.readFileSync(path.join(here, "doubleplus-logo-paths.json"), "utf8"));

const CAP = 724; // the 2's height; the mark is drawn y-down in a CAP-tall box
// the plus: cap height, stroke as heavy as the 2's
const P = 600, PT = 168, PR = 18;
const plus = `<rect x="0" y="${CAP / 2 - PT / 2}" width="${P}" height="${PT}" rx="${PR}"/><rect x="${P / 2 - PT / 2}" y="${CAP / 2 - P / 2}" width="${PT}" height="${P}" rx="${PR}"/>`;
const twoX = 650 - two.bounds[0];
const twoGlyph = `<path transform="translate(${twoX} ${CAP}) scale(1 -1)" d="${two.d}"/>`;

// The x. H: height of the "/" on the baseline; T: its stroke; GAP: the cut the
// feather passes through; FH: the feather's height. The feather image is
// 432x578 px, its shaft running from (18, 577) up to about (380, 0).
const H = 480, T = 110, GAP = 280, FH = 540;
const ax = 362, ay = 577, an = Math.hypot(ax, ay);
const s = FH / 578;
const half = (H / 2) * ax / ay;
const cx = twoX + two.bounds[2] + 52 + half + T / 2, cy = CAP - H / 2;
const slash = `M${cx - half - T / 2} ${CAP} L${cx - half + T / 2} ${CAP} L${cx + half + T / 2} ${CAP - H} L${cx + half - T / 2} ${CAP - H} Z`;
// the cut runs along the mirrored feather's shaft
const ux = ax / an, uy = ay / an, nx = -uy, ny = ux, L = 600;
const band = [[-L, -GAP / 2], [L, -GAP / 2], [L, GAP / 2], [-L, GAP / 2]]
  .map(([a, b]) => `${cx + ux * a + nx * b} ${cy + uy * a + ny * b}`).join(" L");
// mirrored image px -> mark units, the shaft's midpoint (233, 288) on (cx, cy);
// the traced path is in 4x px, y-up, scaled by potrace's 0.1
const featherG = `<g transform="translate(${cx - 233 * s} ${cy - 288 * s}) scale(${s}) translate(432 0) scale(-1 1) scale(0.25) translate(0 2312) scale(0.1 -0.1)"><path d="${feather}"/></g>`;
let uid = 0;
const xMark = () => {
  const id = `cut${++uid}`;
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="-200" y="-400" width="4000" height="1600"><rect x="-200" y="-400" width="4000" height="1600" fill="#fff"/><path d="M${band} Z" fill="#000"/></mask><path d="${slash}" mask="url(#${id})"/>${featherG}`;
};
const W = Math.ceil(Math.max(cx + half + T / 2, cx - 233 * s + 432 * s));
const TOP = Math.min(0, Math.floor(cy - 288 * s)); // the feather may rise above the cap
const BOT = Math.max(CAP, Math.ceil(cy + 290 * s));
const mark = (fill) => `<g fill="${fill}">${plus}${twoGlyph}${xMark()}</g>`;

const gelText = `<linearGradient id="gt" x1="0" y1="${TOP}" x2="0" y2="${BOT}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9af06e"/><stop offset=".48" stop-color="#4fc236"/><stop offset=".52" stop-color="#36a024"/><stop offset="1" stop-color="#5fd040"/></linearGradient>`;
const gel = `<linearGradient id="gel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8ee866"/><stop offset=".48" stop-color="#3fae2a"/><stop offset=".52" stop-color="#2a8a1c"/><stop offset="1" stop-color="#4fc236"/></linearGradient>`;
const shineG = `<linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient>`;
const ink = `<linearGradient id="ink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#e2f8d8"/></linearGradient>`;
const svg = (vb, defs, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><defs>${defs}</defs>${inner}</svg>\n`;
const pad = 40, vbMark = `${-pad} ${TOP - pad} ${W + 2 * pad} ${BOT - TOP + 2 * pad}`;

// tile: rounded = transparent corners (favicon, title bar); square = full
// bleed (iOS, X avatar). markW: how wide the mark sits in the 512 box.
const tile = ({ rounded, markW }) => {
  const k = markW / W, tx = 256 - W * k / 2, ty = 256 - (TOP + BOT) * k / 2 + 4;
  const bg = rounded
    ? `<rect x="8" y="8" width="496" height="496" rx="96" fill="url(#gel)" stroke="#0e3d08" stroke-width="12"/>`
    : `<rect width="512" height="512" fill="url(#gel)"/>`;
  const shine = rounded
    ? `<path d="M20 112 Q20 20 112 20 H400 Q492 20 492 112 V200 Q256 262 20 200 Z" fill="url(#sh)" opacity=".5"/>`
    : `<path d="M0 0 H512 V196 Q256 262 0 196 Z" fill="url(#sh)" opacity=".45"/>`;
  const ds = `<filter id="ds" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="${7 / k}" stdDeviation="${6 / k}" flood-color="#04300a" flood-opacity=".6"/></filter>`;
  return svg("0 0 512 512", gel + shineG + ink + ds, `${bg}<g transform="translate(${tx} ${ty}) scale(${k})" filter="url(#ds)">${mark("url(#ink)")}</g>${shine}`);
};

const out = (name, body) => fs.writeFileSync(path.join(here, name), body);
out("doubleplus-mark-white.svg", svg(vbMark, "", mark("#fff")));
out("doubleplus-mark.svg", svg(vbMark, gelText, mark("url(#gt)")));
out("doubleplus-icon.svg", tile({ rounded: true, markW: 450 }));
out("doubleplus-icon-square.svg", tile({ rounded: false, markW: 400 }));
out("doubleplus-avatar.svg", tile({ rounded: false, markW: 330 }));
console.log(`mark ${W} x ${BOT - TOP}`);
