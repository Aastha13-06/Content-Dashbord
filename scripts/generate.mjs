#!/usr/bin/env node
// Minimal pipeline: script -> voice -> visuals -> edit -> render -> carousel.
// Usage: node scripts/generate.mjs <stage|all>
// Inputs (env): TOPIC, SCRIPT (multi-line text). Output goes to ./output
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderCarousel } from "./carousel.mjs";
import { renderMotion, planScenes } from "./motion.mjs";

const OUT = process.env.OUT_DIR || "output";
const cfg = JSON.parse(readFileSync("pipeline.config.json", "utf8"));
const stage = process.argv[2] || "all";
let style = cfg.styles[process.env.STYLE] || cfg.styles[cfg.defaultStyle];
if (process.env.STYLE_CUSTOM) {
  // Palette taken from an uploaded screenshot (validated by the server)
  try {
    const c = JSON.parse(process.env.STYLE_CUSTOM), g = c.gradients, t = "0x" + c.text;
    style = { name: "Custom", gradients: g, text: t, cover: "0x" + g[0][0], coverText: t, accent: "0x" + (c.accent || g[0][1]), accentText: "0x" + (c.accentText || c.text), hi: c.accent || g[0][1], hiText: c.accentText || c.text };
  } catch { /* fall back to the preset */ }
}
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const ff = (args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
const readJson = (f) => JSON.parse(readFileSync(join(OUT, f), "utf8"));

function lines() {
  const raw = (process.env.SCRIPT || "").trim();
  if (!raw) throw new Error("SCRIPT is empty. Pass the workflow input 'script'.");
  // GitHub's form is single-line, so also accept literal "\\n", " | " and plain sentences.
  const parts = raw.replace(/\\n/g, "\n").split(/\r?\n|\s*\|\s*/).map((l) => l.trim()).filter(Boolean);
  // Several lines: one scene per line. A single block of text: one scene per sentence.
  if (parts.length >= 2) return parts;
  return (parts[0] || "").split(/(?<=[.!?])\s+(?=\S)|(?<=[a-z][.!?])(?=[A-Z])/).map((l) => l.trim()).filter(Boolean);
}
const secsFor = (t) => Math.max(cfg.minSecondsPerLine, t.split(/\s+/).length * cfg.secondsPerWord);

function script() {
  const L = lines();
  const items = L.map((text, i) => ({ i, text, seconds: +secsFor(text).toFixed(2) }));
  writeFileSync(join(OUT, "script.json"), JSON.stringify({ topic: process.env.TOPIC || "", items }, null, 2));
  log(`Style: ${process.env.STYLE || cfg.defaultStyle}`);
  log(`Script locked: ${items.length} lines, ${items.reduce((a, b) => a + b.seconds, 0).toFixed(1)} s`);
}

const V_LEAD = 0.1;
const wordsN = (t) => (String(t).trim().match(/\S+/g) || []).length;
async function voice() {
  const { items } = readJson("script.json");
  const vd = process.env.VOICE_DIR;
  if (vd && existsSync(join(vd, "voice.json"))) {
    const V = JSON.parse(readFileSync(join(vd, "voice.json"), "utf8"));
    const save = () => writeFileSync(join(OUT, "script.json"), JSON.stringify({ topic: process.env.TOPIC || "", items }, null, 2));
    if (V.kind === "lines" && V.lines.length === items.length) {
      items.forEach((it, i) => { it.voiceDur = +(V.lead + V.lines[i].dur + V.tail).toFixed(3); it.seconds = Math.max(it.seconds, it.voiceDur); });
      save(); writeFileSync(join(OUT, "voice_plan.json"), JSON.stringify({ kind: "lines", lead: V.lead, files: V.lines.map((l) => join(vd, l.file)), durs: items.map((it) => it.voiceDur) }));
      log(`Voice: using your voice-over (${items.length} lines, ${items.reduce((a, b) => a + b.voiceDur, 0).toFixed(1)} s)`); return;
    }
    if (V.kind === "own") {
      const tw = items.reduce((a, it) => a + wordsN(it.text), 0) || 1;
      items.forEach((it) => { it.voiceDur = +(V.total * wordsN(it.text) / tw).toFixed(3); it.seconds = Math.max(1.2, it.voiceDur); });
      save(); writeFileSync(join(OUT, "voice_plan.json"), JSON.stringify({ kind: "own", file: join(vd, V.file) }));
      log(`Voice: using your recording (${V.total.toFixed(1)} s), scenes scaled to fit`); return;
    }
    log("Voice: the script changed after the voice-over was made, so this video has no voice. Generate the voice again to match.");
  }
  const p = cfg.voice.provider;
  if (p === "openai" && process.env.OPENAI_API_KEY) {
    const text = items.map((x) => x.text).join(" ");
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.voice.openaiModel, voice: cfg.voice.openaiVoice, input: text, response_format: "mp3" }),
    });
    if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
    writeFileSync(join(OUT, "voice.mp3"), Buffer.from(await res.arrayBuffer()));
    log("Voice: generated with OpenAI TTS");
  } else {
    log("Voice: provider 'none' (silent video). Set voice.provider to 'openai' and add OPENAI_API_KEY.");
  }
}

async function visuals() {
  const { items } = readJson("script.json");
  if (process.env.MOTION !== "off") {
    try {
      let over = []; try { over = JSON.parse(process.env.SCENES || "[]"); } catch {}
      const r = await renderMotion({ items, over, durs: items.map((x) => x.voiceDur || 0), fx: (() => { try { return JSON.parse(process.env.FX || "{}"); } catch { return {}; } })(), style, styleId: process.env.STYLE_CUSTOM ? "custom" : (process.env.STYLE || cfg.defaultStyle), handle: process.env.HANDLE || "", outFile: join(OUT, "motion.mp4"), cfg, log });
      log(`Visuals: animated video ready (${r.seconds}s)`);
      writeFileSync(join(OUT, "timeline.json"), JSON.stringify(planScenes(items.map((x) => x.text), over, cfg, items.map((x) => x.voiceDur || 0)).map((s) => ({ start: s.start, dur: s.dur }))));
      return;
    } catch (e) { log(`Visuals: animation unavailable (${e.message}). Using simple text scenes. Install Google Chrome or Chromium for animated reels.`); }
  }
  const { width: W, height: H, fps, font, fontSize } = cfg;
  items.forEach((it, i) => {
    const [c1, c2] = style.gradients[i % style.gradients.length];
    const txt = join(OUT, `line${i}.txt`);
    // wrap to ~22 chars per row so text fits a 1080 px wide frame
    const wrapped = it.text.replace(/(.{1,22})(\s+|$)/g, "$1\n").trim();
    writeFileSync(txt, wrapped);
    // Diagonal gradient built from a tiny frame (works on old ffmpeg, no 'gradients' filter needed)
    const bg = join(OUT, `bg${i}.png`);
    const rgb = (h) => [0, 2, 4].map((k) => parseInt(String(h).replace(/^#/, "").slice(k, k + 2), 16));
    const [a, b] = [rgb(c1), rgb(c2)];
    const mix = (k) => `${a[k]}+(${b[k] - a[k]})*(X/W+Y/H)/2`;
    ff([
      "-f", "lavfi", "-i", `color=c=black:s=54x96,format=gbrp,geq=r='${mix(0)}':g='${mix(1)}':b='${mix(2)}'`,
      "-frames:v", "1", "-vf", `scale=${W}:${H}:flags=bicubic`, bg,
    ]);
    ff([
      "-loop", "1", "-framerate", String(fps), "-i", bg,
      "-vf", `drawtext=fontfile=${font}:textfile=${txt}:fontcolor=${style.text}:fontsize=${fontSize}:line_spacing=18:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=0x2146d9@0.0`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", String(it.seconds), join(OUT, `clip${i}.mp4`),
    ]);
  });
  { let t = 0; writeFileSync(join(OUT, "timeline.json"), JSON.stringify(items.map((it) => { const o = { start: +t.toFixed(2), dur: it.seconds }; t += it.seconds; return o; }))); }
  log(`Visuals: ${items.length} scenes drawn`);
}

function edit() {
  const { items } = readJson("script.json");
  if (existsSync(join(OUT, "motion.mp4"))) { ff(["-i", join(OUT, "motion.mp4"), "-c", "copy", join(OUT, "edited.mp4")]); log("Edit: animated scenes ready"); return; }
  writeFileSync(join(OUT, "concat.txt"), items.map((_, i) => `file 'clip${i}.mp4'`).join("\n"));
  ff(["-f", "concat", "-safe", "0", "-i", join(OUT, "concat.txt"), "-c", "copy", join(OUT, "edited.mp4")]);
  log("Edit: scenes joined");
}

function render() {
  const a = join(OUT, "voice.mp3");
  const plan = existsSync(join(OUT, "voice_plan.json")) ? readJson("voice_plan.json") : null;
  const args = ["-i", join(OUT, "edited.mp4")];
  let withAudio = false;
  if (plan && plan.kind === "lines" && existsSync(join(OUT, "timeline.json"))) {
    // every spoken line starts right after its scene starts; each segment is padded to its scene length so audio and picture stay in step
    const tl = readJson("timeline.json"); plan.files.forEach((f) => args.push("-i", f));
    const fc = plan.files.map((_, i) => `[${i + 1}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round(plan.lead * 1000)}|${Math.round(plan.lead * 1000)},apad=whole_dur=${tl[i].dur},atrim=0:${tl[i].dur}[a${i}]`).join(";") + ";" + plan.files.map((_, i) => `[a${i}]`).join("") + `concat=n=${plan.files.length}:v=0:a=1[aout]`;
    args.push("-filter_complex", fc, "-map", "0:v", "-map", "[aout]", "-shortest"); withAudio = true;
  } else if (plan && plan.kind === "own") { args.push("-i", plan.file, "-map", "0:v", "-map", "1:a", "-shortest"); withAudio = true; }
  else if (existsSync(a)) { args.push("-i", a, "-map", "0:v", "-map", "1:a", "-shortest"); withAudio = true; }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  if (withAudio) args.push("-c:a", "aac", "-b:a", "160k");
  args.push(join(OUT, "video.mp4"));
  ff(args);
  const { items } = readJson("script.json");
  writeFileSync(join(OUT, "run.json"), JSON.stringify({ topic: process.env.TOPIC || "", lines: items.length, createdAt: new Date().toISOString(), file: "video.mp4" }, null, 2));
  log("Render: output/video.mp4 ready");
}

function wrap(text, n) { return text.replace(new RegExp(`(.{1,${n}})(\\s+|$)`, "g"), "$1\n").trim(); }

function carousel() {
  // Slides from the same script: cover, one slide per line, final call-to-action slide. 1080x1350 PNGs.
  const { topic, items } = readJson("script.json");
  try {
    const n = renderCarousel({ items, topic, style, handle: process.env.HANDLE || "", outDir: join(OUT, "carousel") });
    log(`Carousel: ${n} designed slides in output/carousel`);
    return;
  } catch (e) {
    log(`Carousel: designed slides unavailable (${e.message}). Using the simple layout. Install Google Chrome or Chromium for the designed one.`);
  }
  const dir = join(OUT, "carousel");
  mkdirSync(dir, { recursive: true });
  const W = 1080, H = 1350, font = cfg.font;
  const body = items.slice(0, -1).slice(0, 6);
  const cta = items[items.length - 1].text;
  const slides = [
    { bg: style.cover, fg: style.coverText, tag: "SWIPE  >", text: topic || items[0].text, size: 84 },
    ...body.map((it, i) => ({ bg: "white", fg: "0x17171a", tag: String(i + 1), text: it.text, size: 66 })),
    { bg: style.accent, fg: style.accentText, tag: "NEXT", text: cta, size: 66 },
  ];
  slides.forEach((sl, i) => {
    const f = join(dir, `text${i}.txt`), t = join(dir, `tag${i}.txt`);
    writeFileSync(f, wrap(sl.text, 20));
    writeFileSync(t, sl.tag);
    const tagColor = sl.bg === "white" ? style.accent : sl.fg;
    const vf = [
      `drawtext=fontfile=${font}:textfile=${t}:fontcolor=${tagColor}:fontsize=${sl.tag.length > 2 ? 44 : 120}:x=80:y=110`,
      `drawtext=fontfile=${font}:textfile=${f}:fontcolor=${sl.fg}:fontsize=${sl.size}:line_spacing=20:x=80:y=h-text_h-170`,
    ].join(",");
    ff(["-f", "lavfi", "-i", `color=c=${sl.bg}:s=${W}x${H}:d=1`, "-vf", vf, "-frames:v", "1", join(dir, `slide${String(i + 1).padStart(2, "0")}.png`)]);
  });
  log(`Carousel: ${slides.length} slides in output/carousel`);
}

const table = { script, voice, visuals, edit, render, carousel };
const order = ["script", "voice", "visuals", "edit", "render", "carousel"];
try {
  for (const s of stage === "all" ? order : [stage]) {
    if (!table[s]) throw new Error(`Unknown stage '${s}'`);
    await table[s]();
  }
} catch (e) {
  console.error("::error::" + e.message);
  process.exit(1);
}
