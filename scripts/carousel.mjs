// Designed carousel slides (1080x1350) rendered from HTML with headless Chrome/Chromium.
// Returns the number of slides, or throws if no browser is available (caller falls back to the plain ffmpeg slides).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function findBrowser() {
  const cands = [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/snap/bin/chromium", "/opt/google/chrome/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  return cands.find((p) => existsSync(p)) || null;
}

// Wrap the "important" words in <mark>: numbers, quoted bits, otherwise the longest word.
function hl(text, mode = "auto") {
  const words = String(text).trim().split(/\s+/), mark = new Set();
  if (mode === "tail") { const n = words.length >= 5 ? 2 : 1; for (let i = words.length - n; i < words.length; i++) mark.add(i); }
  else {
    words.forEach((w, i) => { if (/[\d%₹$€£]/.test(w)) mark.add(i); });
    if (!mark.size) { let b = -1, len = 0; words.forEach((w, i) => { const l = w.replace(/\W/g, "").length; if (l > len && l >= 5) { len = l; b = i; } }); if (b >= 0) mark.add(b); }
  }
  let out = "", open = false;
  words.forEach((w, i) => {
    const m = mark.has(i);
    if (m && !open) { out += (out ? " " : "") + "<mark>"; open = true; out += esc(w); }
    else if (m) out += " " + esc(w);
    else { if (open) { out += "</mark>"; open = false; } out += (out ? " " : "") + esc(w); }
  });
  if (open) out += "</mark>";
  return out;
}

const lum = (hex) => { const h = hex.replace(/^0x|#/g, ""); const [r, g, b] = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const clean = (h) => String(h).replace(/^0x|#/g, "");

const ARROW = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const ICONS = {
  save: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>',
  share: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3L11 14M22 3l-7 19-4-8-8-4z"/></svg>',
  chat: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 01-11.6 7.1L3 21l1.9-5.4A8 8 0 1121 12z"/></svg>',
  x: '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  ok: '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
};

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{--tx:#TX;--c1:#C1;--c2:#C2;--hi:#HI;--hit:#HIT;--card:CARD;--line:LINE}
html,body{width:1080px;height:1350px;overflow:hidden}
html{background:var(--c1)}
body{font-family:Inter,"Helvetica Neue",Arial,"DejaVu Sans",sans-serif;color:var(--tx);background:linear-gradient(160deg,var(--c1),var(--c2));position:relative;-webkit-font-smoothing:antialiased}
body.cta{--tx:var(--hit);--card:rgba(0,0,0,.09);--line:rgba(0,0,0,.16);background:var(--hi);background:linear-gradient(160deg,var(--hi),color-mix(in srgb,var(--hi) 78%,#fff))}
.glow{position:absolute;border-radius:50%;filter:blur(100px)}
.glow.a{width:640px;height:640px;right:-200px;top:-180px;background:var(--hi);opacity:.3}
.glow.b{width:560px;height:560px;left:-220px;bottom:-220px;background:var(--hi);opacity:.2}
body.cta .glow{background:#fff;opacity:.35}
.dots{position:absolute;right:64px;top:170px;width:190px;height:190px;background-image:radial-gradient(var(--tx) 3px,transparent 3.5px);background-size:38px 38px;opacity:.28}
.grain{position:absolute;inset:0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:90px 90px;opacity:.35;-webkit-mask-image:radial-gradient(ellipse at 50% 40%,#000,transparent 75%);mask-image:radial-gradient(ellipse at 50% 40%,#000,transparent 75%)}
.top{position:absolute;left:70px;right:70px;top:62px;display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:28px}
.pill{background:var(--card);border:2px solid var(--line);border-radius:999px;padding:13px 28px;letter-spacing:.03em}
.pill.hi{background:var(--hi);color:var(--hit);border-color:transparent;font-weight:800}
.foot{position:absolute;left:70px;right:70px;bottom:58px;display:flex;align-items:center;justify-content:space-between}
.prog{display:flex;gap:10px;align-items:center}
.prog i{width:14px;height:14px;border-radius:50%;background:var(--tx);opacity:.25}
.prog i.on{opacity:1;width:50px;border-radius:10px;background:var(--hi)}
body.cta .prog i.on{background:var(--hit)}
.arrow{width:92px;height:92px;border-radius:50%;background:var(--hi);color:var(--hit);display:grid;place-items:center;box-shadow:0 16px 40px -12px rgba(0,0,0,.45)}
.swipe{font-weight:700;font-size:26px;letter-spacing:.06em;opacity:.8;margin-right:18px}
mark{color:var(--hit);background:var(--hi);padding:.02em .16em;border-radius:.2em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.box{position:absolute;left:70px;right:70px;display:flex;flex-direction:column}
.fit{font-weight:900;letter-spacing:-.04em;line-height:1.02}
.sub{font-size:36px;line-height:1.35;font-weight:500;opacity:.78;max-width:860px}
.chip{align-self:flex-start;font-weight:800;font-size:26px;letter-spacing:.12em;text-transform:uppercase;background:var(--hi);color:var(--hit);padding:12px 26px;border-radius:999px}
.big{position:absolute;font-weight:900;font-size:560px;line-height:.8;letter-spacing:-.06em;color:transparent;-webkit-text-stroke:3px var(--tx);opacity:.16}
.card{position:absolute;left:70px;right:70px;background:var(--card);border:2px solid var(--line);border-radius:58px;padding:58px 62px;display:flex;flex-direction:column;gap:30px;overflow:hidden;box-shadow:0 40px 90px -40px rgba(0,0,0,.5)}
.card::before{content:"";position:absolute;left:0;top:58px;bottom:58px;width:14px;border-radius:0 10px 10px 0;background:var(--hi)}
.card .tw{flex:1;min-height:0;display:flex;align-items:center}
.card .fit{font-weight:800;letter-spacing:-.03em;line-height:1.1}
.vs{position:absolute;left:70px;right:70px;display:flex;flex-direction:column;gap:30px;top:300px;bottom:210px}
.vs .c{flex:1;min-height:0;background:var(--card);border:2px solid var(--line);border-radius:50px;padding:40px 48px;display:flex;gap:34px;align-items:center;position:relative}
.vs .ic{width:104px;height:104px;border-radius:50%;display:grid;place-items:center;flex:none}
.vs .m .ic{background:#ff5d5d;color:#fff}.vs .f .ic{background:#2ed47a;color:#08261a}
.vs .lab{font-weight:900;font-size:30px;letter-spacing:.14em;margin-bottom:10px;opacity:.85}
.vs .tw{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:center}
.vs .fit{font-weight:800;letter-spacing:-.03em;line-height:1.1}
.row3{display:flex;gap:26px;margin-top:10px}
.row3 div{flex:1;border:2px solid var(--line);background:var(--card);border-radius:40px;padding:30px 10px;display:flex;flex-direction:column;align-items:center;gap:14px;font-weight:800;font-size:28px}
.btn{align-self:flex-start;display:flex;align-items:center;gap:22px;background:var(--hit);color:var(--hi);font-weight:900;font-size:44px;padding:28px 48px;border-radius:999px;box-shadow:0 24px 50px -20px rgba(0,0,0,.6)}
body.cta .arrow{background:var(--hit);color:var(--hi)}
`;

const FIT = `<script>
function fit(el,max,min){const box=el.closest('[data-box]');let s=max;el.style.fontSize=s+'px';
 while(s>min&&(el.scrollHeight>box.clientHeight||el.scrollWidth>box.clientWidth)){s-=4;el.style.fontSize=s+'px';}}
document.querySelectorAll('.fit').forEach(e=>fit(e,+e.dataset.max,+e.dataset.min));
</script>`;

function page(theme, body, cls = "") {
  const css = CSS.replace("#TX", "#" + theme.tx).replace("#C1", "#" + theme.c1).replace("#C2", "#" + theme.c2).replace("#HIT", "#" + theme.hit).replace("#HI", "#" + theme.hi)
    .replace("CARD", theme.dark ? "rgba(255,255,255,.075)" : "rgba(0,0,0,.055)").replace("LINE", theme.dark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.12)");
  return `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;800;900&display=swap" rel="stylesheet"><style>${css}body{--hi2:#${theme.hi2}}</style></head>
<body class="${cls}"><div class="glow a"></div><div class="glow b"></div><div class="grain"></div>${body}${FIT}</body></html>`;
}
const prog = (i, n) => `<div class="prog">${Array.from({ length: n }, (_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>`;
const foot = (i, n, last) => `<div class="foot">${prog(i, n)}${last ? "" : `<div style="display:flex;align-items:center"><span class="swipe">SWIPE</span><div class="arrow">${ARROW}</div></div>`}</div>`;
const top = (handle, right) => `<div class="top"><span class="pill">${esc(handle)}</span><span class="pill hi">${esc(right)}</span></div>`;

export function renderCarousel({ items, topic, style, handle, outDir }) {
  const chrome = findBrowser();
  if (!chrome) throw new Error("No Chrome/Chromium found");
  const bg = style.gradients[0], tx = clean(style.text);
  const theme = { tx, c1: clean(bg[0]), c2: clean(bg[1]), hi: clean(style.hi || style.accent), hit: clean(style.hiText || style.accentText), dark: lum(tx) > 0.5, hi2: clean(style.hi2 || (style.gradients[1] || bg)[1]) };
  handle = /^@?[\w.]{1,30}$/.test(handle || "") ? (handle.startsWith("@") ? handle : "@" + handle) : "@yourhandle";
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  let scenes = items.map((i) => i.text);
  const ctaRe = /comment|follow|save|share|dm\b|link in|subscribe/i;
  let cta = ctaRe.test(scenes[scenes.length - 1] || "") && scenes.length > 1 ? scenes.pop() : `Save this for later. Follow ${handle} for more.`;
  const title = topic || scenes[0] || "Swipe";
  if (!topic || norm(topic) === norm(scenes[0] || "")) scenes = scenes.slice(1);
  scenes = scenes.slice(0, 9);

  // pair "Myth: ..." with the following "Fact: ..." into one slide
  const slides = [{ kind: "cover" }];
  for (let i = 0; i < scenes.length; i++) {
    const m = /^myth\s*[:\-–]\s*(.+)/i.exec(scenes[i]), f = scenes[i + 1] && /^fact\s*[:\-–]\s*(.+)/i.exec(scenes[i + 1]);
    if (m && f) { slides.push({ kind: "mf", myth: m[1], fact: f[1] }); i++; } else slides.push({ kind: "tip", text: scenes[i] });
  }
  slides.push({ kind: "cta" });
  const N = slides.length;
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "carousel-")), prof = join(work, "profile");
  let tipNo = 0;
  const tipTotal = slides.filter((x) => x.kind === "tip").length;

  slides.forEach((s, i) => {
    let html;
    if (s.kind === "cover") {
      html = page(theme, `${top(handle, "SAVE THIS")}<div class="dots"></div>
        <div class="box" style="top:230px;bottom:230px;justify-content:center;gap:40px"><div class="chip">Swipe to learn</div>
          <div data-box style="flex:1;min-height:0;display:flex;align-items:center"><h1 class="fit" data-max="170" data-min="70">${hl(title, "tail")}</h1></div>
          <p class="sub">${esc(scenes[0] && norm(scenes[0]) !== norm(title) ? scenes[0] : "A quick guide in " + Math.max(1, N - 2) + " slides")}</p></div>${foot(i, N)}`);
    } else if (s.kind === "tip") {
      tipNo++;
      const odd = tipNo % 2 === 1, num = String(tipNo).padStart(2, "0");
      html = page(theme, `${top(handle, "TIP " + num)}
        <div class="big" style="${odd ? "left:30px;top:120px" : "right:30px;bottom:140px"}">${tipNo}</div>
        <div class="card" style="${odd ? "top:470px;bottom:210px" : "top:200px;bottom:480px"}"><div class="chip">${num} / ${String(tipTotal).padStart(2, "0")}</div>
          <div class="tw" data-box><div class="fit" data-max="104" data-min="44">${hl(s.text)}</div></div></div>${foot(i, N)}`);
    } else if (s.kind === "mf") {
      html = page(theme, `${top(handle, "MYTH vs FACT")}<div class="dots"></div>
        <div class="vs"><div class="c m"><div class="ic">${ICONS.x}</div><div class="tw" data-box><div class="lab">MYTH</div><div class="fit" data-max="64" data-min="34">${esc(s.myth)}</div></div></div>
          <div class="c f"><div class="ic">${ICONS.ok}</div><div class="tw" data-box><div class="lab">FACT</div><div class="fit" data-max="64" data-min="34">${hl(s.fact)}</div></div></div></div>${foot(i, N)}`);
    } else {
      html = page(theme, `${top(handle, "THE END")}
        <div class="box" style="top:230px;bottom:250px;justify-content:center;gap:44px">
          <div data-box style="flex:1;min-height:0;display:flex;align-items:center"><h1 class="fit" data-max="120" data-min="56" style="font-weight:900">${esc(cta)}</h1></div>
          <div class="btn">Follow ${esc(handle)}${ARROW}</div>
          <div class="row3"><div>${ICONS.save}Save</div><div>${ICONS.share}Share</div><div>${ICONS.chat}Comment</div></div></div>${foot(i, N, true)}`, "cta");
    }
    const file = join(work, `s${i}.html`), png = resolve(outDir, `slide${String(i + 1).padStart(2, "0")}.png`);
    writeFileSync(file, html);
    const args = ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1080,1350", "--virtual-time-budget=5000", "--run-all-compositor-stages-before-draw", "--user-data-dir=" + prof, "--screenshot=" + png, "file://" + file];
    try { execFileSync(chrome, ["--headless=new", ...args], { stdio: "ignore", timeout: 60000 }); }
    catch { execFileSync(chrome, ["--headless", ...args], { stdio: "ignore", timeout: 60000 }); }
    if (!existsSync(png)) throw new Error("Browser did not produce " + png);
  });
  rmSync(work, { recursive: true, force: true });
  return N;
}
