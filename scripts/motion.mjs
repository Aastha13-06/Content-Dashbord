// Motion-graphic reel renderer.
// Scenes are animated in a headless Chrome page (kinetic text, counters, rings, lists, CTA),
// every frame is captured over the DevTools pipe and streamed straight into ffmpeg.
// No extra packages needed: Chrome/Chromium + ffmpeg only.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { findBrowser } from "./carousel.mjs";

const words = (t) => String(t).trim().split(/\s+/).filter(Boolean);
const CTA_RE = /\b(follow|comment|save|share|subscribe|dm\b|link in|send me|tag)\b/i;

// ---- classify each script line into a motion scene -----------------------------------
function parseStat(t) {
  const m = String(t).match(/(?:(\$|₹|€|£)\s?)?(\d[\d,]*(?:\.\d+)?)\s?(%|x|X|k|K|M|L|cr|lakh|lakhs|million|billion)?/);
  if (!m) return null;
  const value = parseFloat(m[2].replace(/,/g, ""));
  if (!isFinite(value)) return null;
  const prefix = m[1] || "", suffix = m[3] || "";
  if (!prefix && !suffix && (value < 10 || (value >= 1900 && value <= 2100))) return null;
  return { value, prefix, suffix, decimals: (m[2].split(".")[1] || "").length };
}
function parseList(t) {
  const m = String(t).match(/^([^:]{3,44}):\s*(.+)$/);
  if (!m) return null;
  const items = m[2].split(/\s*(?:,|;|\band\b|\bor\b|\/)\s*/i).map((x) => x.replace(/[.!?]+$/, "").trim()).filter(Boolean);
  if (items.length < 2 || items.length > 5 || items.some((x) => words(x).length > 8)) return null;
  return { title: m[1].trim(), items };
}
function emphasis(t) {
  const w = words(t), mark = new Set();
  w.forEach((x, i) => { if (/[\d%₹$€£]/.test(x)) mark.add(i); });
  if (!mark.size) { let b = -1, len = 0; w.forEach((x, i) => { const l = x.replace(/\W/g, "").length; if (l > len && l >= 5) { len = l; b = i; } }); if (b >= 0) mark.add(b); }
  return [...mark].slice(0, 2);
}
export function planScenes(texts, over = [], cfg = {}, durs = []) {
  const spw = cfg.secondsPerWord || 0.38, minS = cfg.minSecondsPerLine || 1.8;
  let stats = 0;
  const use = Array.isArray(over) && over.length === texts.length ? over : [];
  let t0 = 0;
  const out = texts.map((text, i) => {
    const o = use[i] || {};
    let kind = ["hook", "point", "stat", "list", "cta"].includes(o.kind) ? o.kind : null;
    const last = i === texts.length - 1 && texts.length > 1;
    let stat = null, list = null;
    if (!kind) {
      if (i === 0) kind = "hook";
      else if (last || (i >= texts.length - 2 && CTA_RE.test(text) && texts.length > 3 && i === texts.length - 1)) kind = "cta";
      else if ((list = parseList(text))) kind = "list";
      else if (words(text).length <= 16 && stats < 3 && (stat = parseStat(text))) { kind = "stat"; stats++; }
      else kind = "point";
    }
    if (kind === "stat" && !stat) stat = (o.stat && isFinite(+o.stat.value)) ? { value: +o.stat.value, prefix: String(o.stat.prefix || "").slice(0, 2), suffix: String(o.stat.suffix || "").slice(0, 8), decimals: Math.min(2, +o.stat.decimals || 0) } : parseStat(text);
    if (kind === "stat" && !stat) kind = "point";
    if (kind === "list" && !list) list = Array.isArray(o.items) && o.items.length >= 2 ? { title: String(o.title || ""), items: o.items.slice(0, 5).map((x) => String(x).slice(0, 60)) } : parseList(text);
    if (kind === "list" && !list) kind = "point";
    const hl = Array.isArray(o.hl) && o.hl.length ? o.hl.map(Number).filter((n) => n >= 0 && n < words(text).length).slice(0, 3) : emphasis(text);
    const vd = +(durs && durs[i]) || 0;
    let dur = vd > 0 ? vd : Math.max(minS, words(text).length * spw);
    if (kind === "hook") dur = Math.max(2.4, dur);
    if (kind === "stat") dur = Math.max(3.2, dur);
    if (kind === "list") dur = Math.max(1.6 + list.items.length * 0.8, dur);
    if (kind === "cta") dur = Math.max(3, dur);
    dur = Math.min(vd > 0 ? Math.max(9, vd) : 9, +dur.toFixed(2));
    const s = { kind, text, hl, dur, start: +t0.toFixed(2), stat, list };
    t0 += dur;
    return s;
  });
  return out;
}

// ---- themes: colours come from the style config, decoration from the id ---------------
const DECO = { neon: "neon", blueprint: "blueprint", whiteboard: "paper", retro: "retro", minimal: "minimal", luxury: "luxury", brutal: "brutal", glossy: "glossy", comic: "comic", chalkboard: "chalk", aurora: "aurora", scifi: "scifi", pixel: "pixel", clay: "clay", editorial: "editorial", cinematic: "cinema", collage: "collage", watercolour: "water", newsroom: "news", vaporwave: "vapor" };
const FONTS = {
  sans: '"Inter Tight","Inter","Helvetica Neue",Arial,"DejaVu Sans",sans-serif',
  serif: 'Georgia,"Playfair Display","DejaVu Serif",serif',
  mono: '"JetBrains Mono","DejaVu Sans Mono",Menlo,Consolas,monospace',
  impact: 'Impact,"Arial Black","Anton","DejaVu Sans",sans-serif',
  hand: '"Comic Neue","Comic Sans MS","Segoe Print","DejaVu Sans",cursive',
  comic: '"Bangers","Comic Neue","Comic Sans MS",Impact,"DejaVu Sans",sans-serif',
};
const FONT_OF = { luxury: "serif", blueprint: "mono", brutal: "impact", whiteboard: "hand", comic: "comic", chalkboard: "hand", scifi: "mono", pixel: "mono", editorial: "serif", cinematic: "serif", collage: "impact", watercolour: "hand", clay: "hand" };
const hex = (h) => "#" + String(h).replace(/^0x|^#/i, "");
export function themeFor(id, style) {
  const g = style.gradients || [["0a0d28", "1a1f5a"]];
  const tx = hex(style.text || "ffffff");
  const lum = (h) => { const [r, g2, b] = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255); return 0.2126 * r + 0.7152 * g2 + 0.0722 * b; };
  return {
    id, deco: DECO[id] || "glow", font: FONTS[FONT_OF[id] || "sans"],
    c1: hex(g[0][0]), c2: hex(g[0][1]), c3: hex((g[1] || g[0])[1]), text: tx, hi: hex(style.hi || style.accent || "ffd23f"), hit: hex(style.hiText || style.accentText || "17171a"),
    dark: lum(tx) > 0.5,
  };
}

// ---- the page that animates everything ------------------------------------------------
function pageHtml(data) {
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1920px;overflow:hidden;background:#000}
#st{position:relative;width:1080px;height:1920px;overflow:hidden;font-family:var(--font);color:var(--tx)}
.L{position:absolute;inset:0;pointer-events:none}
#scene{position:absolute;inset:0;padding:230px 90px 220px;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:34px}
.big,.txt{font-weight:800;letter-spacing:-.035em;line-height:1.04;text-wrap:balance}
.w{display:inline-block;margin-right:.26em;will-change:transform}
.w.hl{background:var(--hlb,var(--hi));color:var(--hlt,var(--hit));padding:.02em .2em .06em;border-radius:.18em;transform-origin:left center}
.cb{position:relative;width:100%;background:var(--cbbg);color:var(--cbfg);border:var(--cbbd);box-shadow:var(--cbsh);border-radius:var(--cbr);padding:var(--cbp);transform:rotate(var(--cbrot))}
.cb.win::before{content:"\\25CF  \\25CF  \\25CF";display:block;font-size:24px;letter-spacing:6px;color:rgba(255,255,255,.75);border-bottom:3px solid rgba(255,255,255,.4);margin:0 -44px 28px;padding:0 44px 14px}
.lb{position:absolute;inset:0;display:grid;place-items:center;font-family:Impact,"Arial Black","DejaVu Sans",sans-serif;font-weight:900;letter-spacing:.02em;line-height:1;text-align:center}
.pl{display:inline-block;padding:14px 40px;border-radius:999px;font-family:Impact,"Arial Black","DejaVu Sans",sans-serif;font-weight:900;font-size:40px;letter-spacing:.08em;white-space:nowrap}
.tp{position:absolute;top:-26px;width:150px;height:46px;background:rgba(255,255,255,.55);box-shadow:0 2px 6px rgba(0,0,0,.18)}
.stk{position:absolute;opacity:0;pointer-events:none;filter:drop-shadow(5px 0 0 var(--ol)) drop-shadow(-5px 0 0 var(--ol)) drop-shadow(0 5px 0 var(--ol)) drop-shadow(0 -5px 0 var(--ol)) drop-shadow(0 16px 18px rgba(0,0,0,.35))}
.num{font-size:44px;font-weight:800;color:var(--hi);letter-spacing:.04em;font-variant-numeric:tabular-nums}
.rule{height:8px;border-radius:8px;background:var(--hi);width:0}
.ring{position:relative;width:640px;height:640px;margin:0 auto}
.ring svg{position:absolute;inset:0;transform:rotate(-90deg)}
.ring .val{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:190px;font-weight:800;letter-spacing:-.05em;font-variant-numeric:tabular-nums}
.ring .val small{font-size:.5em;margin:0 .04em;color:var(--hi)}
.lab{font-size:54px;font-weight:600;line-height:1.2;text-align:center;width:100%;opacity:.92}
.ltitle{font-size:64px;font-weight:800;letter-spacing:-.03em;margin-bottom:6px}
ul{list-style:none;width:100%;display:flex;flex-direction:column;gap:22px}
li{display:flex;align-items:center;gap:28px;padding:30px 34px;border-radius:30px;font-size:58px;font-weight:700;line-height:1.1;background:var(--card);border:var(--cardb)}
.chk{flex:none;width:76px;height:76px;border-radius:50%;background:var(--hi);color:var(--hit);display:grid;place-items:center;font-size:46px;font-weight:900}
.pill{display:inline-flex;align-items:center;gap:20px;padding:36px 64px;border-radius:999px;background:var(--hi);color:var(--hit);font-size:60px;font-weight:800;box-shadow:0 20px 60px -10px var(--hi)}
.arrow{font-size:120px;color:var(--hi);line-height:1}
.cf{position:absolute;width:18px;height:18px;border-radius:5px;background:var(--hi)}
#bar{position:absolute;left:60px;right:60px;top:70px;display:flex;gap:8px}
#bar i{flex:1;height:7px;border-radius:7px;background:var(--bt);overflow:hidden;display:block}
#bar b{display:block;height:100%;width:0;background:var(--tx);border-radius:7px}
#foot{position:absolute;left:70px;right:70px;bottom:90px;display:flex;justify-content:space-between;align-items:center;font-size:40px;font-weight:700;opacity:.82}
#foot span:first-child{display:flex;align-items:center;gap:16px}
#foot em{width:22px;height:22px;border-radius:50%;background:var(--hi);display:block;font-style:normal}
.glow .big,.glow .txt,.glow .num{text-shadow:0 0 30px var(--glo),0 0 70px var(--glo)}
.chroma .big,.chroma .txt,.chroma .num{text-shadow:-5px 0 rgba(255,0,80,.75),5px 0 rgba(0,220,255,.75)}
#gr{position:absolute;inset:-80px;pointer-events:none;opacity:.2;mix-blend-mode:overlay;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}
#fl{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
.pt{position:absolute;left:0;top:0;will-change:transform}
</style><div id="st"><div class="L" id="b0"></div><div class="L" id="b1"></div><div class="L" id="b2"></div><div class="L" id="b3"></div><div id="scene"></div><div id="bar"></div><div id="foot"><span><em></em><span id="hd"></span></span><span id="ct"></span></div></div>
<script>
const D=${JSON.stringify(data)};
const T=D.theme, st=document.getElementById("st"), scene=document.getElementById("scene");
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)), eo=x=>1-Math.pow(1-clamp(x),3), eb=x=>{x=clamp(x);const c=1.70158;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2)}, seg=(t,a,d)=>clamp((t-a)/d);
const css=(k,v)=>st.style.setProperty(k,v);
css("--font",T.font);css("--tx",T.text);css("--hi",T.hi);css("--hit",T.hit);
const FX=Object.assign({caption:"pop",transition:"fade",camera:"still",particles:"none",glow:false,grain:false,chroma:false,motifs:true},D.fx||{});
css("--card",T.dark?"rgba(255,255,255,.09)":"rgba(0,0,0,.06)");css("--cardb",T.deco==="brutal"?"6px solid "+T.text:T.deco==="luxury"?"2px solid "+T.hi:"1px solid "+(T.dark?"rgba(255,255,255,.14)":"rgba(0,0,0,.1)"));
css("--bt",T.dark?"rgba(255,255,255,.22)":"rgba(0,0,0,.16)");
document.getElementById("hd").textContent=D.handle;
document.getElementById("bar").innerHTML=D.scenes.map(()=>"<i><b></b></i>").join("");
const bars=[...document.querySelectorAll("#bar b")];
const B=[0,1,2,3].map(i=>document.getElementById("b"+i));
const rgba=(h,a)=>{const n=parseInt(h.slice(1),16);return "rgba("+(n>>16)+","+((n>>8)&255)+","+(n&255)+","+a+")"};
// decoration layers
(function(){
  if(T.deco==="neon"||T.deco==="retro"||T.deco==="vapor"){B[1].innerHTML='<div style="position:absolute;left:-60%;right:-60%;bottom:0;height:46%;transform:perspective(520px) rotateX(62deg);transform-origin:50% 100%;background:repeating-linear-gradient(90deg,'+rgba(T.hi,.55)+' 0 3px,transparent 3px 90px),repeating-linear-gradient(0deg,'+rgba(T.hi,.55)+' 0 3px,transparent 3px 90px);-webkit-mask-image:linear-gradient(to top,#000,transparent 85%)" id="floor"></div>';}
  if(T.deco==="retro"||T.deco==="vapor"){B[2].innerHTML='<div id="sun" style="position:absolute;left:50%;top:330px;width:620px;height:620px;margin-left:-310px;border-radius:50%;background:linear-gradient(180deg,'+T.hi+','+T.c3+');opacity:.9;-webkit-mask-image:repeating-linear-gradient(180deg,#000 0 34px,transparent 34px 44px)"></div>';}
  if(T.deco==="blueprint"){B[1].innerHTML='<div id="grid" style="position:absolute;inset:-100px;background:repeating-linear-gradient(90deg,rgba(255,255,255,.12) 0 2px,transparent 2px 90px),repeating-linear-gradient(0deg,rgba(255,255,255,.12) 0 2px,transparent 2px 90px)"></div><div style="position:absolute;inset:40px;border:3px solid rgba(255,255,255,.4)"></div>';}
  if(T.deco==="paper"){B[1].innerHTML='<div id="grid" style="position:absolute;inset:-60px;background-image:radial-gradient(rgba(0,0,0,.16) 3px,transparent 3.5px);background-size:64px 64px"></div>';}
  if(T.deco==="luxury"){B[1].innerHTML='<div style="position:absolute;inset:44px;border:2px solid '+rgba(T.hi,.7)+'"></div><div style="position:absolute;inset:62px;border:1px solid '+rgba(T.hi,.35)+'"></div>';B[2].innerHTML='<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,transparent 40%,rgba(0,0,0,.55))"></div>';}
  if(T.deco==="brutal"){B[1].innerHTML='<div style="position:absolute;inset:34px;border:10px solid '+T.text+'"></div><div id="strip" style="position:absolute;right:-40px;top:140px;width:360px;height:70px;background:repeating-linear-gradient(135deg,'+T.text+' 0 22px,transparent 22px 44px);transform:rotate(8deg)"></div>';}
  if(T.deco==="comic"){B[1].innerHTML='<div id="rays" style="position:absolute;left:-50%;top:-20%;width:200%;height:140%;background:repeating-conic-gradient(from 0deg at 50% 45%,rgba(255,255,255,.34) 0 7deg,transparent 7deg 14deg)"></div><div style="position:absolute;inset:0;background-image:radial-gradient(rgba(0,0,0,.16) 4px,transparent 5px);background-size:34px 34px"></div><div style="position:absolute;inset:26px;border:10px solid #111"></div>';}
  if(T.deco==="chalk"){B[1].innerHTML='<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(255,255,255,.08),transparent 55%),radial-gradient(ellipse at 80% 80%,rgba(255,255,255,.06),transparent 50%)"></div><div style="position:absolute;inset:0;border:34px solid #8b5e34;box-shadow:inset 0 0 40px rgba(0,0,0,.55)"></div><div style="position:absolute;inset:70px;border:3px dashed rgba(255,255,255,.28);border-radius:14px"></div>';}
  if(T.deco==="glossy"){B[3].innerHTML=[0,1,2,3].map(i=>'<div class="bbl" style="position:absolute;left:'+[80,820,600,180][i]+'px;top:'+[1500,420,1620,700][i]+'px;width:'+[130,90,170,70][i]+'px;height:'+[130,90,170,70][i]+'px;border-radius:50%;background:radial-gradient(circle at 30% 28%,#fff,rgba(255,255,255,.25) 38%,rgba(124,58,237,.18));border:2px solid rgba(255,255,255,.7)"></div>').join("");}
  if(T.deco==="neon"){B[3].innerHTML='<div class="rg" style="position:absolute;left:760px;top:1380px;width:300px;height:300px;border-radius:50%;border:4px solid '+rgba(T.hi,.7)+';box-shadow:0 0 30px '+rgba(T.hi,.6)+'"></div><div class="rg" style="position:absolute;left:-90px;top:260px;width:240px;height:240px;border-radius:50%;border:4px solid '+rgba("#ff2daa",.7)+';box-shadow:0 0 30px '+rgba("#ff2daa",.6)+'"></div>';}
  if(T.deco==="blueprint"){B[3].innerHTML='<div style="position:absolute;left:84px;top:104px;font:600 26px var(--font);letter-spacing:.12em;color:rgba(255,255,255,.7)">REEL SPEC · 1080 x 1920 · 9:16</div>';}
  if(T.deco==="glow"||T.deco==="glossy"||T.deco==="neon"){B[2].innerHTML='<div id="o1" style="position:absolute;width:1100px;height:1100px;border-radius:50%;background:radial-gradient(circle,'+rgba(T.deco==="glossy"?T.c3:T.hi,T.deco==="glossy"?.34:.13)+',transparent 65%)"></div><div id="o2" style="position:absolute;width:1000px;height:1000px;border-radius:50%;background:radial-gradient(circle,'+rgba(T.c3,.38)+',transparent 65%)"></div>';}
  if(T.deco==="aurora"){B[1].innerHTML=[[T.hi,-300,-200,1000],["#22d3ee",420,500,900],["#a78bfa",-200,1100,1000],[T.hi,500,1500,800]].map((c,i)=>'<div class="au" style="position:absolute;left:'+c[1]+'px;top:'+c[2]+'px;width:'+c[3]+'px;height:'+c[3]+'px;border-radius:50%;filter:blur(110px);background:'+rgba(c[0],i%2?.4:.32)+'"></div>').join("");B[2].innerHTML='<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,transparent 50%,rgba(0,0,0,.35))"></div>';}
  if(T.deco==="water"){B[1].innerHTML=[["#7cc4ff",-200,-100,820],["#f6a6ff",500,300,760],["#ffd6a5",-150,1000,800],["#b8f2c9",450,1450,760]].map((c,i)=>'<div class="au" style="position:absolute;left:'+c[1]+'px;top:'+c[2]+'px;width:'+c[3]+'px;height:'+c[3]+'px;border-radius:46% 54% 50% 50%;filter:blur(46px);background:'+rgba(c[0],.55)+'"></div>').join("");B[2].innerHTML='<div style="position:absolute;inset:0;background-image:radial-gradient(rgba(60,80,120,.07) 2px,transparent 3px);background-size:22px 22px"></div>';}
  if(T.deco==="scifi"){const cn=[["left","top"],["right","top"],["left","bottom"],["right","bottom"]];B[1].innerHTML='<div id="grid" style="position:absolute;inset:-100px;background:repeating-linear-gradient(90deg,'+rgba(T.hi,.1)+' 0 2px,transparent 2px 80px),repeating-linear-gradient(0deg,'+rgba(T.hi,.1)+' 0 2px,transparent 2px 80px)"></div>'+cn.map(c=>'<div style="position:absolute;'+c[0]+':44px;'+c[1]+':44px;width:120px;height:120px;border-'+c[0]+':6px solid '+T.hi+';border-'+c[1]+':6px solid '+T.hi+'"></div>').join("");B[3].innerHTML='<div style="position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.2) 0 2px,transparent 2px 5px)"></div><div id="scan" style="position:absolute;left:0;right:0;top:0;height:200px;background:linear-gradient(180deg,transparent,'+rgba(T.hi,.16)+',transparent)"></div><div style="position:absolute;left:84px;top:112px;font:600 26px var(--font);letter-spacing:.16em;color:'+rgba(T.hi,.85)+'">SYS//ONLINE  ·  REEL.EXE</div>';}
  if(T.deco==="pixel"){B[1].innerHTML=Array.from({length:26},(_,i)=>{const z=[12,16,20,24][i%4];return '<div class="px" style="position:absolute;left:'+((i*173)%1000+20)+'px;top:'+((i*331)%1800+20)+'px;width:'+z+'px;height:'+z+'px;background:'+(i%3?T.hi:"#fff")+';opacity:.7"></div>'}).join("")+'<div style="position:absolute;inset:34px;border:12px solid '+rgba(T.hi,.85)+';box-shadow:inset 0 0 0 6px #000,0 0 0 6px #000"></div>';}
  if(T.deco==="clay"){B[1].innerHTML=[["#ff9ec4",-80,160,260],["#ffd166",830,330,200],["#8ecae6",780,1450,300],["#b8f2c9",-60,1330,220],["#c3a6ff",430,1700,200]].map(c=>'<div class="blob" style="position:absolute;left:'+c[1]+'px;top:'+c[2]+'px;width:'+c[3]+'px;height:'+c[3]+'px;border-radius:50%;background:'+c[0]+';box-shadow:inset -22px -26px 44px rgba(0,0,0,.13),inset 20px 20px 34px rgba(255,255,255,.7),0 30px 40px rgba(0,0,0,.12)"></div>').join("");}
  if(T.deco==="editorial"){B[1].innerHTML='<div style="position:absolute;left:70px;right:70px;top:128px;border-top:7px solid '+T.text+'"></div><div style="position:absolute;left:70px;right:70px;top:146px;border-top:2px solid '+T.text+'"></div><div style="position:absolute;left:70px;top:164px;font:700 28px Georgia,serif;letter-spacing:.3em;color:'+T.text+'">THE REEL  ·  VOL. 01</div><div style="position:absolute;left:70px;right:70px;bottom:190px;border-top:2px solid '+T.text+'"></div>';}
  if(T.deco==="cinema"){B[2].innerHTML='<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,159,67,.14),transparent 32%,rgba(20,184,166,.16))"></div><div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,transparent 38%,rgba(0,0,0,.6))"></div>';B[3].innerHTML='<div style="position:absolute;left:0;right:0;top:0;height:120px;background:#000"></div><div style="position:absolute;left:0;right:0;bottom:0;height:120px;background:#000"></div>';}
  if(T.deco==="collage"){B[1].innerHTML='<div style="position:absolute;inset:0;background-image:radial-gradient(rgba(0,0,0,.12) 5px,transparent 6px);background-size:30px 30px"></div>'+[[T.hi,-60,170,520,90,-8],["#ffd23f",640,1560,520,80,6],["#5ec2b7",-80,1620,430,70,5],["#111",700,210,420,60,-5]].map(c=>'<div class="cl" data-r="'+c[5]+'" style="position:absolute;left:'+c[1]+'px;top:'+c[2]+'px;width:'+c[3]+'px;height:'+c[4]+'px;background:'+c[0]+';transform:rotate('+c[5]+'deg);box-shadow:6px 8px 0 rgba(0,0,0,.2)"></div>').join("");}
  if(T.deco==="news"){B[1].innerHTML='<div style="position:absolute;left:70px;top:112px;display:flex;gap:0;font:900 34px var(--font);letter-spacing:.06em"><span style="background:'+T.hi+';color:'+T.hit+';padding:8px 22px">LIVE</span><span style="background:#fff;color:#0a1224;padding:8px 22px">REEL NEWS</span></div>';B[3].innerHTML='<div style="position:absolute;left:0;right:0;bottom:168px;height:76px;background:'+T.hi+';overflow:hidden"><div id="tick" style="white-space:nowrap;font:900 36px var(--font);color:'+T.hit+';line-height:76px;width:9000px">'+Array.from({length:12},()=>'<span style="display:inline-block;width:760px">BREAKING  ●  WATCH THIS  ●</span>').join("")+'</div></div>';}
})();
function bgAt(t){
  const a=150+22*Math.sin(t*.35);
  st.style.background="linear-gradient("+a+"deg,"+T.c1+","+T.c2+")";
  const o1=document.getElementById("o1"),o2=document.getElementById("o2");
  if(o1)o1.style.transform="translate("+(-250+140*Math.sin(t*.5))+"px,"+(-200+120*Math.cos(t*.4))+"px)";
  if(o2)o2.style.transform="translate("+(420+130*Math.cos(t*.45))+"px,"+(1000+150*Math.sin(t*.5))+"px)";
  const f=document.getElementById("floor"); if(f)f.style.backgroundPosition="0 "+((t*90)%90)+"px,"+((t*40)%90)+"px 0";
  const g=document.getElementById("grid"); if(g)g.style.transform="translate("+((t*14)%90)+"px,"+((t*10)%90)+"px)";
  const sn=document.getElementById("sun"); if(sn)sn.style.transform="translateY("+(8*Math.sin(t*.8))+"px)";
  document.querySelectorAll(".bbl").forEach((e,i)=>e.style.transform="translateY("+(Math.sin(t*.9+i*1.9)*34)+"px)");
  document.querySelectorAll(".rg").forEach((e,i)=>e.style.transform="scale("+(1+.07*Math.sin(t*1.6+i*2))+")");
  const ry=document.getElementById("rays"); if(ry)ry.style.transform="rotate("+(t*5)+"deg)";
  document.querySelectorAll(".au").forEach((e,i)=>e.style.transform="translate("+(Math.sin(t*.4+i*1.7)*90)+"px,"+(Math.cos(t*.35+i*2.3)*110)+"px)");
  document.querySelectorAll(".blob").forEach((e,i)=>e.style.transform="translateY("+(Math.sin(t*.9+i*1.3)*26)+"px) scale("+(1+.04*Math.sin(t*1.2+i))+")");
  document.querySelectorAll(".px").forEach((e,i)=>e.style.opacity=.35+.4*Math.abs(Math.sin(t*2+i)));
  document.querySelectorAll(".cl").forEach((e,i)=>e.style.transform="rotate("+(+e.dataset.r+Math.sin(t*.8+i)*1.6)+"deg)");
  const sc=document.getElementById("scan"); if(sc)sc.style.transform="translateY("+(((t*260)%2300)-200)+"px)";
  const tk=document.getElementById("tick"); if(tk)tk.style.transform="translateX("+(-((t*150)%760))+"px)";
  const sp=document.getElementById("strip"); if(sp)sp.style.transform="rotate(8deg) translateX("+(-30*Math.abs(Math.sin(t*.7)))+"px)";
}
/* ===== stickers, badges and designed cards ===== */
const IC={
 bulb:'<circle cx="100" cy="80" r="54" fill="#ffd23f"/><path d="M76 122c5 14 5 22 5 30h38c0-8 0-16 5-30z" fill="#ffe27a"/><rect x="78" y="148" width="44" height="14" rx="6" fill="#9ca3af"/><rect x="85" y="164" width="30" height="12" rx="6" fill="#6b7280"/><path d="M82 70l18 22 18-22" stroke="#f59e0b" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
 rocket:'<path d="M100 12c40 34 42 94 22 142H78C58 106 60 46 100 12z" fill="#f3f4f6"/><path d="M100 12c40 34 42 94 22 142H100z" fill="#d1d5db"/><circle cx="100" cy="78" r="18" fill="#38bdf8" stroke="#1f2937" stroke-width="7"/><path d="M78 120L46 154l12 22 30-16zM122 120l32 34-12 22-30-16z" fill="#ef4444"/><path d="M84 158c4 22 10 32 16 38 6-6 12-16 16-38z" fill="#fb923c"/>',
 fire:'<path d="M100 10c14 40 62 58 54 112-5 36-30 64-54 64s-50-28-54-64c-4-30 18-48 30-70 6 14 12 18 18 14 4-18 2-36 6-56z" fill="#ff7a18"/><path d="M100 90c10 22 34 34 30 64-3 20-16 32-30 32s-27-12-30-32c-3-22 14-32 22-46 4 8 8 8 10 4 0-8-2-14-2-22z" fill="#ffd23f"/>',
 ai:'<rect x="40" y="40" width="120" height="120" rx="22" fill="#6366f1"/><path d="M70 22v18M100 22v18M130 22v18M70 160v18M100 160v18M130 160v18M22 70h18M22 100h18M22 130h18M160 70h18M160 100h18M160 130h18" stroke="#a5b4fc" stroke-width="9" stroke-linecap="round"/>',
 chart:'<rect x="20" y="20" width="160" height="160" rx="24" fill="#fff"/><rect x="44" y="108" width="26" height="52" rx="6" fill="#93c5fd"/><rect x="87" y="82" width="26" height="78" rx="6" fill="#60a5fa"/><rect x="130" y="52" width="26" height="108" rx="6" fill="#22c55e"/><path d="M40 90l44-24 30 14 46-40" stroke="#ef4444" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
 clock:'<circle cx="100" cy="100" r="82" fill="#fff" stroke="#1f2937" stroke-width="10"/><path d="M100 48v54l34 20" stroke="#1f2937" stroke-width="12" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="100" cy="100" r="9" fill="#ef4444"/><rect x="82" y="2" width="36" height="14" rx="6" fill="#1f2937"/>',
 plane:'<path d="M14 92L188 18 122 184 96 114z" fill="#fff"/><path d="M188 18L96 114 122 184z" fill="#cbd5e1"/><path d="M96 114l-8 52 22-26z" fill="#94a3b8"/>',
 case:'<rect x="22" y="62" width="156" height="110" rx="20" fill="#b45309"/><path d="M72 62V44a14 14 0 0114-14h28a14 14 0 0114 14v18" stroke="#78350f" stroke-width="12" fill="none"/><rect x="22" y="104" width="156" height="14" fill="#78350f"/><rect x="88" y="96" width="24" height="30" rx="6" fill="#fcd34d"/>',
 cap:'<path d="M100 26L192 74 100 122 8 74z" fill="#1f2937"/><path d="M44 104v42c0 16 26 30 56 30s56-14 56-30v-42l-56 28z" fill="#374151"/><path d="M176 82v62" stroke="#fbbf24" stroke-width="8" stroke-linecap="round"/><circle cx="176" cy="150" r="12" fill="#fbbf24"/>',
 bell:'<path d="M100 18c-34 0-54 26-54 62 0 40-16 50-24 60h156c-8-10-24-20-24-60 0-36-20-62-54-62z" fill="#fbbf24"/><path d="M100 18c34 0 54 26 54 62 0 40 16 50 24 60h-78z" fill="#f59e0b"/><circle cx="100" cy="164" r="18" fill="#92400e"/>',
 trophy:'<path d="M54 24h92v52c0 32-20 52-46 52S54 108 54 76z" fill="#fbbf24"/><path d="M54 40H22c0 36 12 54 38 60M146 40h32c0 36-12 54-38 60" stroke="#f59e0b" stroke-width="10" fill="none"/><rect x="88" y="126" width="24" height="26" fill="#f59e0b"/><rect x="56" y="152" width="88" height="24" rx="8" fill="#92400e"/>',
 warn:'<path d="M100 14L192 174H8z" fill="#fbbf24" stroke="#1f2937" stroke-width="10" stroke-linejoin="round"/><rect x="92" y="68" width="16" height="58" rx="8" fill="#1f2937"/><circle cx="100" cy="148" r="10" fill="#1f2937"/>',
 check:'<circle cx="100" cy="100" r="84" fill="#22c55e"/><path d="M58 104l28 28 58-62" stroke="#fff" stroke-width="18" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
 cross:'<circle cx="100" cy="100" r="84" fill="#ef4444"/><path d="M64 64l72 72M136 64l-72 72" stroke="#fff" stroke-width="18" stroke-linecap="round"/>',
 heart:'<path d="M100 176C22 122 14 62 58 46c20-6 38 6 42 22 4-16 22-28 42-22 44 16 36 76-42 130z" fill="#ef4444"/><path d="M62 62c-12 4-18 16-14 30" stroke="#fff" stroke-opacity=".6" stroke-width="9" fill="none" stroke-linecap="round"/>',
 bolt:'<path d="M118 8L36 112h52l-14 80 90-110h-54z" fill="#fde047" stroke="#f59e0b" stroke-width="8" stroke-linejoin="round"/>',
 star:'<path d="M100 12l26 58 62 6-47 42 14 62-55-33-55 33 14-62-47-42 62-6z" fill="#fbbf24" stroke="#f59e0b" stroke-width="7" stroke-linejoin="round"/>',
 coin:'<circle cx="100" cy="100" r="84" fill="#fbbf24"/><circle cx="100" cy="100" r="64" fill="none" stroke="#f59e0b" stroke-width="8"/>',
 q:'<circle cx="100" cy="100" r="84" fill="#8b5cf6"/>',
 sparkle:'<path d="M100 8C108 68 132 92 192 100 132 108 108 132 100 192 92 132 68 108 8 100 68 92 92 68 100 8z" fill="FILL"/>',
 diamond:'<path d="M100 14L176 100 100 186 24 100z" fill="FILL"/><path d="M100 14L176 100H24z" fill="#fff" fill-opacity=".28"/>',
 arrow:'<path d="M26 150C50 50 120 30 168 96" stroke="FILL" stroke-width="12" fill="none" stroke-linecap="round"/><path d="M130 82l42 18-8-46" stroke="FILL" stroke-width="12" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
 squig:'<path d="M12 100c14-30 28-30 42 0s28 30 42 0 28-30 42 0 22 24 32 8" stroke="FILL" stroke-width="12" fill="none" stroke-linecap="round"/>',
 bubble:'<circle cx="100" cy="100" r="86" fill="FILL" fill-opacity=".35" stroke="#fff" stroke-opacity=".8" stroke-width="5"/><path d="M52 70a60 60 0 0138-30" stroke="#fff" stroke-width="10" fill="none" stroke-linecap="round" stroke-opacity=".9"/>'
};
const KW=[[/(₹|\\$|€|£|rupee|salary|income|price|money|cost|pay|earn|fee|cash|rich|invest)/i,"coin"],[/(rocket|launch|grow|growth|scale|boost|level up|faster)/i,"rocket"],[/(\\bai\\b|agent|model|learn|neural|algorithm|robot|machine|code|data)/i,"ai"],[/(idea|tip|trick|hack|secret|insight|remember)/i,"bulb"],[/(fire|hot|viral|trend|crazy|insane|stop scrolling)/i,"fire"],[/(mistake|wrong|never|danger|avoid|fail|risk|scam|myth|warning|careful)/i,"warn"],[/(percent|%|stat|chart|number|growth|rank|metric|result)/i,"chart"],[/(minute|second|hour|day|week|fast|quick|time|deadline|years?)/i,"clock"],[/(visa|passport|travel|fly|abroad|canada|germany|uk\\b|usa|australia|country|immigra|border|move to)/i,"plane"],[/(job|work|career|hire|hiring|employ|office|company|business|boss)/i,"case"],[/(study|student|degree|univers|college|exam|school|course|learn)/i,"cap"],[/(follow|subscribe|save|comment|share|notify|dm\\b)/i,"bell"],[/(win|reward|best|top|champion|score|game|prize)/i,"trophy"],[/(love|heart|care|favou?rite)/i,"heart"],[/(fact|true|correct|right|yes|proof|works)/i,"check"],[/\\?/,"q"]];
const KIND_IC={hook:"fire",point:"star",stat:"chart",list:"check",cta:"bell"};
function pickIcon(t,k){for(const [r,n] of KW)if(r.test(t))return n;return KIND_IC[k]||"star"}
const ICL={ai:["AI","#fff",.34],coin:["$","#b45309",.44],q:["?","#fff",.6]};
function svg(inner,size,fill,key){const l=key&&ICL[key];return '<div style="position:relative;width:'+size+'px;height:'+size+'px"><svg viewBox="0 0 200 200" width="'+size+'" height="'+size+'">'+inner.replace(/FILL/g,fill||"#fff")+'</svg>'+(l?'<span class="lb" style="font-size:'+Math.round(size*l[2])+'px;color:'+l[1]+'">'+l[0]+'</span>':"")+'</div>'}
function burstPath(n,r1,r2){let d="";for(let i=0;i<n*2;i++){const a=Math.PI*i/n-Math.PI/2,r=i%2?r2:r1;d+=(i?"L":"M")+(100+r*Math.cos(a)).toFixed(1)+" "+(100+r*Math.sin(a)).toFixed(1)}return d+"Z"}
function burst(txt,bg,ink,line,sz){const fs=Math.round(sz*(txt.length<=3?.28:txt.length<=5?.22:.17));return '<div style="position:relative;width:'+sz+'px;height:'+sz+'px"><svg viewBox="0 0 200 200" width="'+sz+'" height="'+sz+'"><path d="'+burstPath(14,98,74)+'" fill="'+bg+'" stroke="'+line+'" stroke-width="7" stroke-linejoin="round"/></svg><span class="lb" style="font-size:'+fs+'px;color:'+ink+';transform:rotate(-8deg)">'+txt+'</span></div>'}
function pill(txt,bg,ink,line){return '<div class="pl" style="background:'+bg+';color:'+ink+';border:5px solid '+line+'">'+txt+'</div>'}
const DECOS_CARD={
 paper:{bg:"#fff59d",fg:"#1f2937",bd:"none",sh:"0 34px 50px -22px rgba(0,0,0,.4)",rad:"6px",pad:"58px 54px",rot:-1.6,hlb:"#ff6aa8",hlt:"#fff",tape:1},
 blueprint:{bg:"rgba(6,26,66,.55)",fg:"#fff",bd:"3px solid rgba(255,255,255,.75)",sh:"none",rad:"6px",pad:"26px 44px 44px",rot:0,win:1},
 brutal:{bg:"#fff",fg:"#0e0e10",bd:"8px solid #0e0e10",sh:"16px 16px 0 #0e0e10",rad:"10px",pad:"46px",rot:-1.2},
 comic:{bg:"#fff",fg:"#111",bd:"8px solid #111",sh:"14px 14px 0 #111",rad:"28px",pad:"46px",rot:1.2,hlb:"#ef4444",hlt:"#fff"},
 glossy:{bg:"rgba(255,255,255,.58)",fg:"#1b1233",bd:"2px solid rgba(255,255,255,.9)",sh:"0 40px 70px -30px rgba(76,29,149,.5)",rad:"52px",pad:"50px",rot:0},
 neon:{bg:"rgba(10,3,40,.62)",fg:"#fff",bd:"3px solid HI",sh:"0 0 46px HIA",rad:"38px",pad:"46px",rot:0},
 retro:{bg:"rgba(26,4,48,.6)",fg:"#fff",bd:"4px solid HI",sh:"12px 12px 0 #ff2daa",rad:"18px",pad:"46px",rot:0},
 luxury:{bg:"rgba(0,0,0,.34)",fg:"HI2",bd:"2px solid HI",sh:"none",rad:"4px",pad:"62px 54px",rot:0},
 scifi:{bg:"rgba(2,16,28,.62)",fg:"#fff",bd:"2px solid HI",sh:"0 0 34px HIA",rad:"6px",pad:"44px",rot:0},
 pixel:{bg:"rgba(12,6,34,.78)",fg:"#fff",bd:"8px solid HI",sh:"10px 10px 0 #000",rad:"0px",pad:"44px",rot:0},
 clay:{bg:"#fff",fg:"#3b1f2b",bd:"none",sh:"0 34px 50px -20px rgba(255,107,107,.55),inset 0 -12px 0 rgba(0,0,0,.06)",rad:"62px",pad:"52px",rot:0},
 collage:{bg:"#fff",fg:"#1a1a1a",bd:"none",sh:"12px 14px 0 rgba(0,0,0,.2)",rad:"4px",pad:"52px",rot:-1.4,hlb:"#ff4d6d",hlt:"#fff",tape:1},
 water:{bg:"rgba(255,255,255,.58)",fg:"HI2",bd:"2px solid rgba(255,255,255,.95)",sh:"0 34px 60px -34px rgba(59,130,246,.45)",rad:"44px",pad:"50px",rot:0},
 news:{bg:"rgba(5,10,24,.72)",fg:"#fff",bd:"none",sh:"inset 14px 0 0 HI",rad:"6px",pad:"44px 44px 44px 66px",rot:0},
 vapor:{bg:"rgba(30,8,60,.58)",fg:"#fff",bd:"3px solid #ff71ce",sh:"10px 10px 0 #05ffa1",rad:"8px",pad:"46px",rot:0}
};
const CARD=DECOS_CARD[T.deco];
if(CARD){const c=CARD,sub=x=>x.replace(/HI2/g,T.text).replace(/HIA/g,rgba(T.hi,.55)).replace(/HI/g,T.hi);css("--cbbg",sub(c.bg));css("--cbfg",sub(c.fg));css("--cbbd",sub(c.bd));css("--cbsh",sub(c.sh));css("--cbr",c.rad);css("--cbp",c.pad);css("--cbrot",c.rot+"deg");if(c.hlb){css("--hlb",c.hlb);css("--hlt",c.hlt)}}
const OUTL=T.deco==="brutal"||T.deco==="comic"?"#0e0e10":T.deco==="chalk"?"#fff":T.deco==="neon"?T.hi:"#fff";
st.style.setProperty("--ol",OUTL);
function cardWrap(inner){if(!CARD)return inner;return '<div class="cb'+(CARD.win?" win":"")+'">'+(CARD.tape?'<i class="tp" style="left:34px;transform:rotate(-8deg)"></i><i class="tp" style="right:34px;transform:rotate(7deg)"></i>':"")+inner+'</div>'}
function stickersFor(s,i){
  if(T.deco==="minimal"||T.deco==="cinema"||T.deco==="editorial"||!FX.motifs)return [];
  const t=s.text,low=t.toLowerCase(),ic=pickIcon(low,s.kind);
  const slots=[[736,96,250],[24,1548,220],[790,1540,200],[-24,980,150]];
  const r=i%3,order=[slots[r],slots[(r+1)%3],slots[(r+2)%3]];
  const out=[];
  const gold=T.deco==="luxury";
  out.push({x:order[0][0],y:order[0][1],sz:order[0][2],html:svg(gold?IC[ic].replace(/#(fbbf24|f59e0b|ffd23f)/g,T.hi):IC[ic],order[0][2],"",ic),rot:(i%2?8:-9),a:.5});
  const lab=/^myth/i.test(t)?"MYTH":/^fact/i.test(t)?"FACT":s.kind==="hook"?["WATCH","NEW","LISTEN","PSA"][i%4]:s.kind==="stat"?"FACT":s.kind==="list"?"CHECKLIST":s.kind==="cta"?"FOLLOW":["KEY IDEA","PRO TIP","REMEMBER","NOTE"][i%4];
  const bsz=order[1][2];
  const bcol=T.deco==="paper"?["#ff6aa8","#fff"]:T.deco==="brutal"||T.deco==="comic"?["#ef4444","#fff"]:T.deco==="luxury"?[T.hi,"#0c0a07"]:T.deco==="chalk"?["#fde68a","#1f3a2e"]:T.deco==="glossy"?["#fff","#7c3aed"]:[T.hi,T.hit];
  const useBurst=["brutal","comic","retro","neon","paper"].includes(T.deco)&&s.kind!=="list";
  out.push({x:order[1][0],y:order[1][1]+(useBurst?0:70),sz:bsz,html:useBurst?burst(lab,bcol[0],bcol[1],OUTL==="#fff"?"#0e0e10":OUTL,bsz):pill(lab,bcol[0],bcol[1],T.deco==="glossy"?"#fff":OUTL==="#fff"?"rgba(255,255,255,.0)":OUTL),rot:(i%2?-7:6),a:.75});
  const sp=T.deco==="glossy"?svg(IC.bubble,order[2][2]*.7,T.c3):svg(gold?IC.diamond:IC.sparkle,order[2][2]*.75,gold?T.hi:T.deco==="chalk"?"#fff":T.deco==="comic"?"#fff":T.hi);
  out.push({x:order[2][0],y:order[2][1]-40,sz:order[2][2]*.75,html:sp,rot:12,a:1,spin:1});
  if(s.kind==="cta")out.push({x:30,y:300,sz:150,html:svg(IC.heart,150),rot:-14,a:1.1});
  if(s.kind==="stat")out.push({x:30,y:240,sz:150,html:svg(IC.sparkle,150,T.hi),rot:0,a:1,spin:1});
  return out;
}
function stickerHtml(arr){return arr.map((k,n)=>'<div class="stk" data-n="'+n+'" style="left:'+k.x+'px;top:'+k.y+'px;width:'+k.sz+'px">'+k.html+'</div>').join("")}
function animStickers(arr,p,s){const els=scene.querySelectorAll(".stk");els.forEach((e,n)=>{const k=arr[n];if(!k)return;const q=eb(seg(p,.35+k.a*.4,.6)),bob=Math.sin(p*2.4+n*1.7)*12,wig=Math.sin(p*3+n)*3;e.style.opacity=clamp(q*1.6);e.style.transform="translateY("+bob+"px) rotate("+((k.spin?p*40:k.rot+wig))+"deg) scale("+q+")"})}

const fs=n=>n<=24?156:n<=44?124:n<=70?102:n<=100?86:72;
const wordsHtml=(s,cls)=>s.text.split(/\\s+/).map((w,i)=>'<span class="w'+(s.hl.includes(i)?" hl":"")+'"><span>'+w.replace(/</g,"&lt;")+'</span></span>').join("");
const esc=x=>String(x).replace(/&/g,"&amp;").replace(/</g,"&lt;");
const tpl={
  hook:(s)=>cardWrap('<h1 class="big" style="font-size:'+Math.round(fs(s.text.length)*(CARD?.86:1))+'px">'+wordsHtml(s)+'</h1>'),
  point:(s,i)=>'<div class="num">'+String(i+1).padStart(2,"0")+'</div><div class="rule"></div><'+cardWrap('<p class="txt" style="font-size:'+Math.round(fs(s.text.length)*(CARD?.72:.86))+'px">'+wordsHtml(s)+'</p>'),
  stat:(s)=>'<div class="ring"><svg viewBox="0 0 200 200" width="640" height="640"><circle cx="100" cy="100" r="86" fill="none" stroke="'+(T.dark?"rgba(255,255,255,.14)":"rgba(0,0,0,.1)")+'" stroke-width="12"/><circle id="arc" cx="100" cy="100" r="86" fill="none" stroke="'+T.hi+'" stroke-width="12" stroke-linecap="round" stroke-dasharray="540.4" stroke-dashoffset="540.4"/></svg><div class="val"><small>'+esc(s.stat.prefix)+'</small><span id="n">0</span><small>'+esc(s.stat.suffix)+'</small></div></div><p class="lab" id="lab" style="font-size:'+(s.text.length>70?44:54)+'px">'+esc(s.text)+'</p>',
  list:(s)=>(s.list.title?'<h2 class="ltitle">'+esc(s.list.title)+'</h2>':"")+'<ul>'+s.list.items.map(x=>'<li><span class="chk">✓</span><span>'+esc(x)+'</span></li>').join("")+'</ul>',
  cta:(s)=>cardWrap('<p class="txt" style="font-size:'+Math.round(fs(s.text.length)*(CARD?.66:.8))+'px">'+wordsHtml(s)+'</p>')+'<div class="pill" id="pill">Follow '+esc(D.handle)+'</div><div class="arrow" id="arw">↓</div>'+Array.from({length:16},(_,i)=>'<i class="cf" data-i="'+i+'"></i>').join(""),
};
let cur=-1,E={};
function build(i){
  const s=D.scenes[i],ST=stickersFor(s,i);scene.innerHTML=tpl[s.kind](s,i)+stickerHtml(ST);cur=i;
  E={w:[...scene.querySelectorAll(".w")],li:[...scene.querySelectorAll("li")],num:scene.querySelector(".num"),rule:scene.querySelector(".rule"),arc:scene.querySelector("#arc"),n:scene.querySelector("#n"),lab:scene.querySelector("#lab"),pill:scene.querySelector("#pill"),arw:scene.querySelector("#arw"),cf:[...scene.querySelectorAll(".cf")],ring:scene.querySelector(".ring"),lt:scene.querySelector(".ltitle"),st:ST};
}
const el=x=>x<=0?0:x>=1?1:1-Math.pow(2,-8*x)*Math.cos(x*Math.PI*3.5);
function wordsIn(p,a0,step){const m=FX.caption;E.w.forEach((w,i)=>{const a=a0+i*step;let tr="",op=1;
  if(m==="type"){const on=p>=a*.85;op=on?1:0;tr="scale("+(on?1:.9)+")"}
  else if(m==="slide"){const k=eo(seg(p,a,.45));tr="translateX("+((1-k)*-130)+"px)";op=clamp(k*1.6)}
  else if(m==="bounce"){const q=seg(p,a,.75),k=el(q);tr="translateY("+((1-k)*-170)+"px) scale("+(.55+.45*k)+")";op=clamp(q*4)}
  else if(m==="glitch"){const k=eb(seg(p,a,.4)),j=(1-seg(p,a,.4)),f=Math.floor(p*24+i*3);tr="translate("+(Math.sin(f*7.3)*26*j)+"px,"+(Math.cos(f*5.1)*10*j)+"px) skewX("+(Math.sin(f*3.7)*14*j)+"deg) scale("+(.8+.2*k)+")";op=p<a?0:(j>.1&&f%3===0?.35:1)}
  else{const k=eb(seg(p,a,.5));tr="translateY("+((1-k)*70)+"px) scale("+(.72+.28*k)+")";op=clamp(k*1.6);if(w.classList.contains("hl"))tr+=" rotate("+((1-k)*-5)+"deg)"}
  w.style.transform=tr;w.style.opacity=op})}
const anim={
  hook:(s,p)=>{wordsIn(p,.1,.1);const h=scene.firstChild;h.style.transform="scale("+(1+.035*p/s.dur)+")";h.style.transformOrigin="left center"},
  point:(s,p)=>{const k=eo(seg(p,0,.5));E.num.style.transform="translateX("+((1-k)*-260)+"px)";E.num.style.opacity=k;E.rule.style.width=(eo(seg(p,.1,.6))*260)+"px";wordsIn(p,.3,.07)},
  stat:(s,p)=>{const v=s.stat,k=eo(seg(p,.2,1.4));let x=v.value*k;const d=v.decimals||0;E.n.textContent=d?x.toFixed(d):Math.round(x).toLocaleString("en-US");const frac=v.suffix==="%"?clamp(v.value/100):.78;E.arc.style.strokeDashoffset=(540.4*(1-k*frac))+"";const r=eb(seg(p,0,.6));E.ring.style.transform="scale("+(.7+.3*r)+")";E.ring.style.opacity=clamp(r*1.5);const l=eo(seg(p,1,.5));E.lab.style.opacity=l;E.lab.style.transform="translateY("+((1-l)*40)+"px)"},
  list:(s,p)=>{if(E.lt){const k=eo(seg(p,0,.4));E.lt.style.opacity=k;E.lt.style.transform="translateY("+((1-k)*30)+"px)"}E.li.forEach((li,i)=>{const a=.3+i*.38,k=eo(seg(p,a,.5));li.style.opacity=k;li.style.transform="translateX("+((1-k)*180)+"px)";const c=li.firstChild,q=eb(seg(p,a+.15,.4));c.style.transform="scale("+q+")"})},
  cta:(s,p)=>{wordsIn(p,.05,.08);const k=eb(seg(p,.7,.6));E.pill.style.transform="scale("+(k*(1+.04*Math.sin(p*7)))+")";E.pill.style.opacity=clamp(k*1.5);const a=eo(seg(p,1,.4));E.arw.style.opacity=a;E.arw.style.transform="translateY("+(Math.abs(Math.sin(p*5))*24)+"px)";E.cf.forEach(c=>{const i=+c.dataset.i,q=seg(p,.5+(i%5)*.06,1.8),x=(i*137%1000)+40,y=1500-q*(500+(i*53%300));c.style.opacity=q>0&&q<1?1-q*.8:0;c.style.transform="translate("+x+"px,"+y+"px) rotate("+(q*360*(i%2?1:-1))+"deg)";c.style.background=i%3?T.hi:T.text})}
};
function camAt(t,p,s){const q=p/s.dur;if(FX.camera==="push")return{sc:1+.06*q,x:0,y:0,r:0};if(FX.camera==="drift")return{sc:1.03,x:Math.sin(t*.6)*18,y:Math.cos(t*.5)*14,r:Math.sin(t*.3)*.4};if(FX.camera==="shake")return{sc:1.025,x:Math.sin(t*37)*5+Math.sin(t*23)*3,y:Math.cos(t*41)*5,r:Math.sin(t*29)*.35};return{sc:1,x:0,y:0,r:0}}
const rn=(i,k)=>Math.abs(Math.sin(i*127.1+k*311.7)*43758.5453)%1;
if(FX.glow){css("--glo",rgba(T.hi,.75));st.classList.add("glow")}
if(FX.chroma)st.classList.add("chroma");
const PN=FX.particles==="none"?0:28;
const PL=document.createElement("div");PL.className="L";PL.id="fxp";
PL.innerHTML=Array.from({length:PN},(_,i)=>{
  if(FX.particles==="sparkles")return '<div class="pt"><svg viewBox="0 0 200 200" width="'+(30+rn(i,1)*50)+'" height="'+(30+rn(i,1)*50)+'"><path d="M100 8C108 68 132 92 192 100 132 108 108 132 100 192 92 132 68 108 8 100 68 92 92 68 100 8z" fill="'+(i%3?T.hi:"#fff")+'"/></svg></div>';
  if(FX.particles==="confetti")return '<div class="pt" style="width:'+(14+rn(i,2)*14)+'px;height:'+(24+rn(i,3)*16)+'px;background:'+[T.hi,"#fff","#ff4d6d","#38bdf8","#fde047"][i%5]+'"></div>';
  const z=70+rn(i,4)*150;return '<div class="pt" style="width:'+z+'px;height:'+z+'px;border-radius:50%;filter:blur(7px);background:radial-gradient(circle,'+rgba(i%2?T.hi:T.c3,.55)+','+rgba(i%2?T.hi:T.c3,.05)+' 70%)"></div>'}).join("");
st.insertBefore(PL,document.getElementById("bar"));
const PE=[...PL.children];
function partAt(t){PE.forEach((e,i)=>{const bx=rn(i,5)*1000,by=rn(i,6)*1900,sp=.5+rn(i,7);let x,y,r=0,o=1,sc=1;
  if(FX.particles==="sparkles"){x=bx;y=by-((t*40*sp)%140);o=.25+.75*Math.abs(Math.sin(t*2.4*sp+i));sc=.6+.5*Math.abs(Math.sin(t*1.7+i));r=t*30*sp}
  else if(FX.particles==="confetti"){y=((by+t*(220+160*sp))%2100)-120;x=bx+Math.sin(t*1.6+i)*50;r=t*240*(i%2?1:-1);o=.9}
  else{x=bx+Math.sin(t*.5*sp+i)*60;y=by-((t*28*sp)%160)+Math.cos(t*.4+i)*40;o=.35+.3*Math.sin(t*.9+i)}
  e.style.opacity=o;e.style.transform="translate("+x+"px,"+y+"px) rotate("+r+"deg) scale("+sc+")"})}
if(FX.grain){const g=document.createElement("div");g.id="gr";st.appendChild(g)}
{const f=document.createElement("div");f.id="fl";st.appendChild(f)}
function setT(t){
  const tt=Math.min(t,D.total-.001);let i=D.scenes.findIndex(s=>tt>=s.start&&tt<s.start+s.dur);if(i<0)i=D.scenes.length-1;
  if(i!==cur)build(i);const s=D.scenes[i],p=tt-s.start;
  const inn=eo(seg(p,0,.18)),out=eo(seg(p,s.dur-.26,.26));
  const cam=camAt(tt,p,s);let tr="",op=inn*(1-out),clip="",ts="";
  const x=FX.transition;
  if(x==="ring"){const r=(p<s.dur/2?inn:1-out)*150;clip="circle("+r+"% at 50% 50%)";op=1}
  else if(x==="zoom"){tr="scale("+(1+(1-inn)*.25+out*.25)+")"}
  else if(x==="slide"){tr="translateX("+((1-inn)*170-out*170)+"px)"}
  else if(x==="flash"){}
  else if(x==="glitch"){const g=(1-inn)+out;if(g>.01){const f=Math.floor(tt*30);tr="translateX("+(Math.sin(f*9.1)*46*g)+"px) skewX("+(Math.sin(f*4.3)*10*g)+"deg)";ts="-"+(16*g)+"px 0 rgba(255,0,80,.85),"+(16*g)+"px 0 rgba(0,220,255,.85)";op=(f%4===0&&g>.3)?.45:op}}
  else{tr="translateY("+(-out*36)+"px) scale("+(1-out*.025)+")"}
  scene.style.opacity=op;scene.style.clipPath=clip;scene.style.textShadow=ts;
  scene.style.transform=tr+" translate("+cam.x+"px,"+cam.y+"px) rotate("+cam.r+"deg) scale("+cam.sc+")";
  B.forEach(b=>b.style.transform="translate("+(cam.x*.5)+"px,"+(cam.y*.5)+"px) scale("+(1+(cam.sc-1)*.6)+")");
  const fl=document.getElementById("fl");fl.style.opacity=x==="flash"&&i>0?(1-seg(p,0,.2))*.9:0;
  const gr=document.getElementById("gr");if(gr){const f=Math.floor(tt*24);gr.style.transform="translate("+((f*137)%80)+"px,"+((f*91)%80)+"px)"}
  partAt(tt);
  anim[s.kind](s,p);animStickers(E.st,p,s);bgAt(tt);
  bars.forEach((b,j)=>b.style.width=(j<i?100:j===i?clamp(p/s.dur)*100:0)+"%");
  document.getElementById("ct").textContent=String(i+1).padStart(2,"0")+" / "+String(D.scenes.length).padStart(2,"0");
}
setT(0);
</script>`;
}

// ---- DevTools pipe client -------------------------------------------------------------
function cdp(proc) {
  const wr = proc.stdio[3], rd = proc.stdio[4];
  let id = 0, buf = ""; const waits = new Map(), evs = [];
  rd.on("data", (d) => {
    buf += d.toString("utf8");
    let k; while ((k = buf.indexOf("\0")) >= 0) {
      const raw = buf.slice(0, k); buf = buf.slice(k + 1);
      let m; try { m = JSON.parse(raw); } catch { continue; }
      if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.no(new Error(m.error.message)) : w.ok(m.result); }
      else if (m.method) evs.forEach((f) => f(m));
    }
  });
  return {
    on: (f) => evs.push(f),
    send: (method, params = {}, sessionId, ms = 30000) => new Promise((ok, no) => {
      const i = ++id, t = setTimeout(() => { waits.delete(i); no(new Error("Chrome did not answer: " + method)); }, ms);
      waits.set(i, { ok: (r) => { clearTimeout(t); ok(r); }, no: (e) => { clearTimeout(t); no(e); } });
      wr.write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    }),
  };
}

export async function renderMotion({ items, over, style, styleId, handle, outFile, cfg = {}, durs = [], fx = {}, log = () => {} }) {
  const chrome = findBrowser();
  if (!chrome) throw new Error("No Chrome/Chromium found");
  const W = 1080, H = 1920, fps = cfg.motionFps || 20, SC = cfg.motionScale || 0.667;
  const scenes = planScenes(items.map((x) => x.text), over, cfg, durs);
  const total = +(scenes.reduce((a, s) => a + s.dur, 0) + 0.35).toFixed(2);
  const h = /^@?[\w.]{1,30}$/.test(handle || "") ? (handle.startsWith("@") ? handle : "@" + handle) : "@yourhandle";
  const data = { scenes, total, theme: themeFor(styleId, style), handle: h, fx: fx && typeof fx === "object" ? fx : {} };
  const dir = mkdtempSync(join(tmpdir(), "reel-motion-"));
  const page = join(dir, "motion.html"); writeFileSync(page, pageHtml(data));
  const ch = spawn(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--disable-dev-shm-usage", "--force-device-scale-factor=1", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", `--user-data-dir=${join(dir, "profile")}`, "--remote-debugging-pipe", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const ffp = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-", "-vf", `scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-movflags", "+faststart", outFile], { stdio: ["pipe", "inherit", "inherit"] });
  const ffDone = new Promise((ok, no) => { ffp.on("close", (c) => (c === 0 ? ok() : no(new Error("ffmpeg failed while encoding the motion video")))); ffp.on("error", no); });
  ffDone.catch(() => {});
  ffp.stdin.on("error", () => {});
  try {
    const c = cdp(ch);
    const cores = cpus().length || 2, K = cores >= 2 ? Math.min(4, Math.max(2, cores - 1)) : 1;
    const N = Math.ceil(total * fps);
    const mk = async () => {
      const { browserContextId } = await c.send("Target.createBrowserContext");
      const { targetId } = await c.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      const S = (m, p, ms) => c.send(m, p, sessionId, ms);
      await S("Page.enable");
      await S("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
      const loaded = new Promise((ok) => c.on((m) => m.method === "Page.loadEventFired" && m.sessionId === sessionId && ok()));
      await S("Page.navigate", { url: pathToFileURL(page).href }); await loaded;
      await S("Runtime.evaluate", { expression: "document.fonts.ready.then(()=>1)", awaitPromise: true });
      return S;
    };
    const workers = await Promise.all(Array.from({ length: K }, mk));
    log(`Motion: ${scenes.length} animated scenes, ${total}s, ${N} frames, ${K} render process${K === 1 ? "" : "es"} (${scenes.map((s) => s.kind).join(", ")})`);
    const bufs = new Array(N), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), t0 = Date.now();
    let next = 0, written = 0, failed = null, lastPct = -1;
    const work = async (S) => {
      try {
        while (!failed) {
          const f = next++; if (f >= N) return;
          while (f - written > 60 && !failed) await sleep(8);
          await S("Runtime.evaluate", { expression: `setT(${(f / fps).toFixed(4)})` });
          const r = await S("Page.captureScreenshot", { format: "jpeg", quality: 88, optimizeForSpeed: true, clip: { x: 0, y: 0, width: W, height: H, scale: SC } });
          bufs[f] = Buffer.from(r.data, "base64");
        }
      } catch (e) { failed = e; }
    };
    const writeAll = async () => {
      while (written < N) {
        if (failed) throw failed;
        if (Date.now() - t0 > (cfg.motionTimeoutSec || 900) * 1000) throw new Error("rendering took too long");
        if (!bufs[written]) { await sleep(4); continue; }
        const b = bufs[written]; bufs[written] = null; written++;
        if (!ffp.stdin.write(b)) await once(ffp.stdin, "drain");
        const pct = Math.floor((written / N) * 20) * 5; if (pct !== lastPct) { lastPct = pct; log(`Motion: ${pct}% rendered`); }
      }
    };
    try { await Promise.all([...workers.map(work), writeAll()]); } catch (e) { failed = failed || e; throw e; }
    if (failed) throw failed;
    ffp.stdin.end(); await ffDone;
    return { scenes, seconds: total };
  } finally {
    try { ffp.stdin.destroy(); } catch {} ffp.kill("SIGKILL"); ch.kill("SIGKILL");
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 800);
  }
}
