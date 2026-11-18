#!/usr/bin/env node
// Local server: serves the dashboard and runs the video pipeline on this computer.
// Usage: node scripts/server.mjs   (then open http://localhost:8000)
// No dependencies. Listens on 127.0.0.1 only.
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, statSync, mkdirSync, readdirSync, writeFileSync, createReadStream } from "node:fs";
import { join, resolve, extname, sep } from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 8000);
const cfg = JSON.parse(readFileSync(join(ROOT, "pipeline.config.json"), "utf8"));
const JOBS_DIR = join(ROOT, "output", "jobs");
mkdirSync(JOBS_DIR, { recursive: true });
const STAGES = ["script", "voice", "visuals", "edit", "render", "carousel"];
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".png": "image/png", ".mp4": "video/mp4", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

const jobs = new Map();
let seq = 0;
for (const d of readdirSync(JOBS_DIR)) {
  const m = join(JOBS_DIR, d, "meta.json");
  if (/^\d+$/.test(d) && existsSync(m)) {
    try { const j = JSON.parse(readFileSync(m, "utf8")); if (j.status === "running") { j.status = "failed"; j.log.push("Interrupted by a restart."); } jobs.set(d, j); seq = Math.max(seq, Number(d)); } catch {}
  }
}

const save = (j) => writeFileSync(join(JOBS_DIR, j.id, "meta.json"), JSON.stringify(j));
const files = (j) => {
  const dir = join(JOBS_DIR, j.id), out = { video: null, slides: [] };
  if (existsSync(join(dir, "video.mp4"))) out.video = `/output/jobs/${j.id}/video.mp4`;
  const cd = join(dir, "carousel");
  if (existsSync(cd)) out.slides = readdirSync(cd).filter((f) => /^slide\d+\.png$/.test(f)).sort().map((f) => `/output/jobs/${j.id}/carousel/${f}`);
  return out;
};
const view = (j) => ({ id: j.id, title: j.title, style: j.style, status: j.status, createdAt: j.createdAt, steps: j.steps, log: j.log.slice(-60), files: files(j) });

function runStage(j, stage) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [join("scripts", "generate.mjs"), stage], {
      cwd: ROOT,
      env: { ...process.env, OUT_DIR: join("output", "jobs", j.id), TOPIC: j.title, SCRIPT: j.script, STYLE: j.style, ...(j.custom ? { STYLE_CUSTOM: JSON.stringify(j.custom) } : {}), HANDLE: j.handle || "", SCENES: JSON.stringify(j.scenes || []), ...(j.voiceDir ? { VOICE_DIR: j.voiceDir } : {}), ...(j.fx && Object.keys(j.fx).length ? { FX: JSON.stringify(j.fx) } : {}) },
    });
    const take = (b) => b.toString().split("\n").map((l) => l.trim()).filter(Boolean).forEach((l) => j.log.push(l));
    p.stdout.on("data", take); p.stderr.on("data", take);
    p.on("error", (e) => { j.log.push("Error: " + e.message); done(1); });
    p.on("close", done);
  });
}
async function runJob(j) {
  for (const st of STAGES) {
    j.steps[st] = "running"; save(j);
    const code = await runStage(j, st);
    j.steps[st] = code === 0 ? "done" : "failed"; save(j);
    if (code !== 0) { j.status = "failed"; j.log.push(`Stage '${st}' failed. Is ffmpeg installed? (sudo apt install ffmpeg fonts-dejavu-core)`); save(j); return; }
  }
  j.status = "done"; save(j);
}

const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const okOrigin = (req) => { const o = req.headers.origin; return !o || o === `http://localhost:${PORT}` || o === `http://127.0.0.1:${PORT}`; };
const readBody = (req) => new Promise((ok, no) => { let n = 0; const c = []; req.on("data", (d) => { n += d.length; if (n > 80000) { no(new Error("Body too large")); req.destroy(); } else c.push(d); }); req.on("end", () => ok(Buffer.concat(c).toString())); req.on("error", no); });


// ---- Read public pages (reel links) -> caption/title text. Blocks private network addresses.
const isPrivateIp = (ip) => {
  if (net.isIPv4(ip)) { const [a, b] = ip.split(".").map(Number); return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
  const x = ip.toLowerCase(); if (x.startsWith("::ffff:")) return isPrivateIp(x.slice(7));
  return x === "::" || x === "::1" || x.startsWith("fe80") || x.startsWith("fc") || x.startsWith("fd");
};
async function safeUrl(raw) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) links");
  if (u.port && !["80", "443"].includes(u.port)) throw new Error("Unusual port blocked");
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Private address blocked");
  return u;
}
const decode = (t) => t.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[e.toLowerCase()] ?? (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : m)));
function extract(html) {
  const meta = {};
  for (const m of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const k = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(m[0]), v = /content\s*=\s*["']([^"']*)["']/i.exec(m[0]);
    if (k && v) meta[k[1].toLowerCase()] = decode(v[1]);
  }
  const title = meta["og:title"] || decode((/<title[^>]*>([^<]*)/i.exec(html) || [, ""])[1]).trim();
  const desc = meta["og:description"] || meta["twitter:description"] || meta["description"] || "";
  let body = "";
  if (desc.length < 80) body = decode(html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 1500);
  return { title: title.slice(0, 200), text: [title, desc, body].filter(Boolean).join("\n").slice(0, 3000) };
}
const UAS = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", // many sites expose caption meta tags to link-preview bots
];
async function readPageWith(raw, ua) {
  let u = await safeUrl(raw);
  for (let i = 0; i < 4; i++) {
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "User-Agent": ua, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "en" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { u = await safeUrl(new URL(r.headers.get("location"), u).href); continue; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const ct = r.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|xml/.test(ct)) throw new Error("Not a web page");
    return extract(Buffer.from(await r.arrayBuffer()).subarray(0, 800000).toString("utf8"));
  }
  throw new Error("Too many redirects");
}
const looksEmpty = (r) => r.text.replace(/\s+/g, " ").length < 40 || /^(instagram|log in|login|tiktok)\b/i.test(r.title) && r.text.length < 120;
async function readPage(raw) {
  let best = null, err = null;
  for (const ua of UAS) {
    try { const r = await readPageWith(raw, ua); if (!best || r.text.length > best.text.length) best = r; if (!looksEmpty(r)) return r; }
    catch (e) { err = e; }
  }
  if (best && best.text.trim()) return best;
  throw err || new Error("No caption found. Paste it instead");
}

// ---- AI engine: Claude Code CLI (your Claude plan, `claude login`) or the Anthropic API (key). Auto = CLI if found, else API.
import { execFile } from "node:child_process";
import { dirname, basename } from "node:path";
import { createWriteStream, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
const CLI = process.env.CLAUDE_BIN || "claude";
let cliCache = { at: 0, ok: false };
const cliAvailable = () => new Promise((res) => {
  if (Date.now() - cliCache.at < 60000) return res(cliCache.ok);
  execFile(CLI, ["--version"], { timeout: 8000 }, (e) => { cliCache = { at: Date.now(), ok: !e }; res(!e); });
});
function askCli(prompt, images) {
  return new Promise((ok, no) => {
    const args = ["-p", "--output-format", "text"];
    let p = prompt;
    if (images.length) {
      [...new Set(images.map((i) => dirname(resolve(i))))].forEach((d) => args.push("--add-dir", d));
      args.push("--allowedTools", "Read");
      p += "\n\nImages to look at (open each file with the Read tool, they are in time order):\n" + images.map((i) => resolve(i)).join("\n");
    }
    const c = spawn(CLI, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { c.kill("SIGKILL"); no(new Error("Claude took too long (3 min)")); }, 180000);
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("error", (e) => { clearTimeout(t); no(new Error("Could not start the claude command: " + e.message)); });
    c.on("close", (code) => {
      clearTimeout(t);
      const msg = (err + " " + out).slice(0, 400);
      if (code !== 0 || !out.trim()) { const e = new Error(/log ?in|auth|credential/i.test(msg) ? "Claude is not logged in. Run  claude login  in a terminal, then try again." : "Claude command failed: " + msg.trim()); e.code = 502; return no(e); }
      ok(out.trim());
    });
    c.stdin.end(p);
  });
}
async function askApi(prompt, images, key) {
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) { const e = new Error("no_ai"); e.code = 400; throw e; }
  const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const content = [...images.map((f) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(f).toString("base64") } })), { type: "text", text: prompt }];
  const r = await fetch(base + "/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(120000),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.SCRIPT_MODEL || "claude-sonnet-5-5", max_tokens: 1500, messages: [{ role: "user", content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || "Anthropic API error " + r.status); e.code = r.status === 401 ? 401 : 502; throw e; }
  return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
}
async function askAI({ prompt, images = [], engine, apiKey }) {
  const key = process.env.ANTHROPIC_API_KEY || String(apiKey || "");
  const mode = ["cli", "api"].includes(engine) ? engine : "auto";
  const useCli = mode === "cli" || (mode === "auto" && (await cliAvailable()));
  if (useCli) {
    if (!(await cliAvailable())) { const e = new Error("The claude command was not found. Install Claude Code, or switch to API key in Settings."); e.code = 400; throw e; }
    return askCli(prompt, images);
  }
  return askApi(prompt, images, key);
}

const MOODS = ["Happy", "Sad", "Funny", "Motivational", "Angry", "Educational", "Storytelling", "Shocking"];
const LANGS = { English: "English", Hinglish: "Hinglish (Hindi written in English letters, mixed with English)", Hindi: "Hindi (Devanagari script)" };
const WORDS = { 15: 40, 30: 80, 60: 150 };
const str = (v, n) => String(v || "").slice(0, n).trim();
const refBlock = (refs) => (Array.isArray(refs) ? refs : []).map(String).slice(0, 5).map((t, i) => `--- Reference ${i + 1} ---\n${t.slice(0, 1500)}`).join("\n\n");
const RULES = `Rules:
- One scene per line. No numbering, bullets, headings, quotes or stage directions.
- Line 1 is the hook, 14 words or fewer.
- Every other line is 22 words or fewer.
- The last line is a call to action (comment, follow or save).
- Return only the script lines.`;
const cleanScenes = (a) => (Array.isArray(a) ? a : []).slice(0, 24).map((o) => {
  o = o && typeof o === "object" ? o : {};
  const r = { kind: ["hook", "point", "stat", "list", "cta"].includes(o.kind) ? o.kind : "point", hl: (Array.isArray(o.hl) ? o.hl : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 60).slice(0, 3) };
  if (r.kind === "stat" && o.stat && isFinite(+o.stat.value)) r.stat = { value: +o.stat.value, prefix: str(o.stat.prefix, 2), suffix: str(o.stat.suffix, 8), decimals: Math.min(2, Math.max(0, +o.stat.decimals || 0)) };
  if (r.kind === "list" && Array.isArray(o.items)) { r.title = str(o.title, 60); r.items = o.items.map((x) => str(x, 60)).filter(Boolean).slice(0, 5); }
  return r;
});
function promptFor(kind, b) {
  const mood = MOODS.includes(b.mood) ? b.mood : "Funny", len = WORDS[b.length] ? Number(b.length) : 30, lang = LANGS[b.lang] || LANGS.English;
  const topic = str(b.topic, 200), ch = str(b.character, 300), niche = str(b.niche, 120), avoid = (Array.isArray(b.avoid) ? b.avoid : []).map((x) => str(x, 90)).filter(Boolean).slice(0, 12);
  if (kind === "script") {
    const refs = refBlock(b.refs);
    return `You write scripts for short vertical videos (Instagram Reels).

${refs ? `Study these reference reels. Copy their structure, rhythm and hook style. Do NOT copy their sentences.\n\n${refs}\n\n` : ""}Write ONE new script.
- Topic: ${topic || (refs ? "the same subject as the references, with a fresh angle" : "a surprising, useful idea")}
- Mood: ${mood}
- Language: ${lang}
- Length: about ${WORDS[len]} words (${len} seconds spoken)
${ch ? `- Presenter / character: ${ch}. Write in this person's voice.\n` : ""}${niche ? `- Creator's niche: ${niche}\n` : ""}${avoid.length ? `- These scripts were already posted. Pick a DIFFERENT angle, hook and examples:\n${avoid.map((x) => "  * " + x).join("\n")}\n` : ""}${b.daily ? `- This is today's daily reel in an ongoing series. Make it a fresh, standalone lesson that still feels like the same creator.\n` : ""}
${RULES}`;
  }
  if (kind === "ideas") {
    return `You plan content for short vertical videos (Instagram Reels).
Niche: ${niche || "general"}
${b.refs && b.refs.length ? `Study what these saved references have in common (topic, hook style):\n\n${refBlock(b.refs)}\n\n` : ""}Give 8 fresh reel ideas for this niche. Each idea is ONE line in this exact format:
Hook line (14 words or fewer) | angle in 8 words or fewer | Mood (one of: ${MOODS.join(", ")})
No numbering, no extra text.`;
  }
  if (kind === "remix") {
    const src = str(b.source, 3000), how = str(b.how, 30);
    const T = {
      hooks: `Write 5 NEW alternative hooks (14 words or fewer each) for this script. Different angles: a question, a number, a mistake, a bold claim, a story opener. One per line, no numbering.`,
      mood: `Rewrite the whole script in a ${mood} mood. Keep the same facts and message.\n${RULES}`,
      language: `Rewrite the whole script in ${lang}. Keep the same facts and message.\n${RULES}`,
      short: `Cut this script down to about 40 words (15 seconds) keeping the strongest hook and the call to action.\n${RULES}`,
      carousel: `Turn this script into carousel slide text: one slide per line, each slide 14 words or fewer, first line is a punchy cover title, last line is a call to action. Return only the lines.`,
      comment: `Rewrite the ending so the call to action asks viewers to comment one keyword to get a free resource. Keep everything else. Return the full script.\n${RULES}`,
    };
    return `You are editing a short-video script.\n\nScript:\n${src}\n\nTask: ${T[how] || T.hooks}`;
  }
  if (kind === "insights") {
    return `You are a social media analyst for short videos. Here are stats for a creator's recent posts (JSON):\n${str(b.stats, 6000)}\n\nWrite 6 short, specific, actionable recommendations for what to make next, based only on this data. Plain lines, each starting with "- ". Mention numbers. If the data is too thin to conclude something, say so.`;
  }
  if (kind === "profile") {
    return `You are reading short-video reels (Instagram) so a creator can make similar ones. Below is whatever could be read from each reel (title, caption, description, transcript). It may be partial. Do not invent details that are not supported by the text; say "unclear" where needed.

${refBlock(b.refs)}

Reply with ONLY a JSON object with these keys:
"summary": one sentence on what these reels have in common,
"character": the presenter or character as you can tell from the text (who speaks, how they sound, 25 words or fewer),
"tone": 3 to 5 words,
"mood": one of ${MOODS.join(", ")},
"hookStyle": how the reels open, 15 words or fewer,
"structure": array of 4 to 6 short beats the reels follow (e.g. "hook", "myth", "fact", "cta"),
"pacing": "fast", "medium" or "slow",
"theme": the visual look that fits best, one of ${Object.keys(cfg.styles).join(", ")}.`;
  }
  if (kind === "storyboard") {
    const lines = (Array.isArray(b.lines) ? b.lines : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 24);
    return `Plan the on-screen motion for a short vertical video. The script has ${lines.length} lines, one scene each:
${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}

For EACH line choose a scene type:
- "hook": opening line (use for line 1)
- "point": a normal statement
- "stat": the line centres on one number (value, optional prefix like $ or ₹, optional suffix like % or x or K)
- "list": a title, a colon, then 2 to 5 short items
- "cta": the closing call to action (last line)
Also give "hl": zero-based indexes of the 1 or 2 most important words to highlight.
Reply with ONLY a JSON array with exactly ${lines.length} objects in order, like:
[{"kind":"hook","hl":[2]},{"kind":"stat","stat":{"value":90,"prefix":"","suffix":"%"},"hl":[]},{"kind":"list","title":"Three parts","items":["agent","environment","reward"],"hl":[]}]`;
  }
  throw new Error("Unknown AI task");
}
const cleanLines = (t) => String(t).replace(/```[a-z]*\n?|```/g, "").split(/\r?\n/).map((l) => l.replace(/^\s*(?:\d+[.)])\s+/, "").replace(/^["“]|["”]$/g, "").trim())
  .filter((l) => l && !/^(here'?s|here is|sure|okay)\b.*:$/i.test(l));
async function runAi(b) {
  const kind = String(b.kind || "script");
  const text = await askAI({ prompt: promptFor(kind, b), engine: b.engine, apiKey: b.apiKey });
  if (kind === "insights") return { text };
  if (kind === "profile" || kind === "storyboard") {
    const m = kind === "profile" ? /\{[\s\S]*\}/.exec(text) : /\[[\s\S]*\]/.exec(text);
    let j = null; try { j = JSON.parse(m ? m[0] : text); } catch { throw new Error("The AI answer could not be read. Try again."); }
    if (kind === "profile") { const mood = MOODS.includes(j.mood) ? j.mood : ""; return { profile: { summary: str(j.summary, 300), character: str(j.character, 300), tone: str(j.tone, 80), mood, hookStyle: str(j.hookStyle, 200), structure: (Array.isArray(j.structure) ? j.structure : []).map((x) => str(x, 40)).slice(0, 8), pacing: ["fast", "medium", "slow"].includes(j.pacing) ? j.pacing : "medium", theme: cfg.styles[j.theme] ? j.theme : "" } }; }
    return { scenes: cleanScenes(j) };
  }
  const lines = cleanLines(text).map((l) => (kind === "script" || kind === "remix" ? l.replace(/^\s*[-*•]\s+/, "") : l));
  if (!lines.length) throw new Error("The AI returned an empty answer");
  if (kind === "ideas") return { ideas: lines.slice(0, 10).map((l) => { const [hook, angle, mood] = l.split("|").map((x) => x.trim()); return { hook: hook || l, angle: angle || "", mood: MOODS.includes(mood) ? mood : "" }; }) };
  return { text: lines.join("\n"), script: lines.join("\n") };
}

// ---- Video breakdown: upload -> frames (+ optional speech transcript) -> Claude looks at the frames
const UP = join(ROOT, "output", "uploads"), FR = join(ROOT, "output", "frames");
mkdirSync(UP, { recursive: true }); mkdirSync(FR, { recursive: true });
const run = (cmd, args, ms = 120000) => new Promise((ok, no) => execFile(cmd, args, { timeout: ms, maxBuffer: 20e6 }, (e, out, err) => (e ? no(new Error((err || e.message).toString().slice(-300))) : ok(String(out)))));
function receiveUpload(req, name) {
  return new Promise((ok, no) => {
    const ext = extname(name).toLowerCase();
    if (![".mp4", ".mov", ".webm", ".mkv", ".m4v"].includes(ext)) return no(Object.assign(new Error("Use an .mp4, .mov, .webm or .mkv video"), { code: 400 }));
    const id = randomBytes(6).toString("hex"), file = join(UP, id + ext);
    const ws = createWriteStream(file); let n = 0, dead = false;
    req.on("data", (d) => { n += d.length; if (n > 250e6 && !dead) { dead = true; ws.destroy(); rmSync(file, { force: true }); no(Object.assign(new Error("Video is over 250 MB"), { code: 413 })); req.destroy(); } });
    req.pipe(ws); ws.on("finish", () => !dead && ok({ id, file })); ws.on("error", no);
  });
}
const findUpload = (id) => (/^[0-9a-f]{12}$/.test(id) ? readdirSync(UP).map((f) => join(UP, f)).find((f) => basename(f).startsWith(id + ".")) : null);
async function analyzeVideo(b) {
  const file = findUpload(String(b.id || ""));
  if (!file) throw Object.assign(new Error("Upload not found. Upload the video again."), { code: 404 });
  const dur = parseFloat(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], 30000)) || 30;
  const N = 12, fps = Math.min(1, N / dur), dir = join(FR, b.id);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-vf", `fps=${fps.toFixed(4)},scale=540:-2`, "-frames:v", String(N), "-q:v", "5", join(dir, "f%02d.jpg")], 180000);
  const frames = readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
  if (!frames.length) throw new Error("Could not read frames from this video");
  let transcript = "";
  if (b.transcribe) {
    try {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", join(dir, "a.wav")], 120000);
      await run(process.env.WHISPER_BIN || "whisper", [join(dir, "a.wav"), "--model", "base", "--output_dir", dir, "--output_format", "txt"], 600000);
      transcript = readFileSync(join(dir, "a.txt"), "utf8").trim().slice(0, 4000);
    } catch (e) { transcript = ""; b.note = "Speech transcript skipped: whisper is not installed (pip install openai-whisper)."; }
  }
  const step = dur / frames.length;
  const prompt = `These ${frames.length} images are frames from a ${Math.round(dur)}-second short vertical video, in time order (about one every ${step.toFixed(1)} seconds).
${transcript ? `Speech transcript:\n${transcript}\n\n` : ""}Break the video down. Reply with ONLY a JSON object, no other text, with these keys:
"summary": one or two sentences on what the video is about,
"onScreenText": array of the text lines visible on screen, in order,
"hook": the opening hook as a single line,
"structure": array of objects {"frame": number (1-based), "what": short description of what happens or is shown, "role": one of "hook","setup","point","proof","cta"},
"mood": one word,
"theme": the visual look closest to this video, one of ${Object.keys(cfg.styles).join(", ")},
"character": the presenter or character you can see (who they are, how they appear, 20 words or fewer),
"script": array of 5 to 8 script lines that capture the spoken or on-screen message (rewrite in your own words, one scene per line, last line a call to action).`;
  const raw = await askAI({ prompt, images: frames.map((f) => join(dir, f)), engine: b.engine, apiKey: b.apiKey });
  let a = null; const m = /\{[\s\S]*\}/.exec(raw); try { a = JSON.parse(m ? m[0] : raw); } catch { a = { summary: raw.slice(0, 800), onScreenText: [], hook: "", structure: [], mood: "", script: [] }; }
  return { id: b.id, duration: Math.round(dur), note: b.note || "", transcript, frames: frames.map((f, i) => ({ url: `/output/frames/${b.id}/${f}`, t: Math.round(i * step) })), analysis: a };
}

// ---- Instagram Graph API sync (Business/Creator account). Token is sent by the dashboard per request and never stored here.
const GRAPH = process.env.GRAPH_BASE || "https://graph.facebook.com/v21.0";
async function graph(path, token) {
  const r = await fetch(`${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || "Instagram API error " + r.status);
  return j;
}
async function igSync(b) {
  const token = String(b.token || ""), uid = String(b.userId || "");
  if (!/^[\w.-]{20,600}$/.test(token) || !/^\d{5,25}$/.test(uid)) throw Object.assign(new Error("Add your Instagram user ID and access token in Settings first"), { code: 400 });
  const lim = Math.min(25, Math.max(1, +b.limit || 25));
  const list = await graph(`/${uid}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url&limit=${lim}`, token);
  const posts = [];
  for (const m of (list.data || []).slice(0, lim)) {
    const p = { id: m.id, caption: m.caption || "", type: m.media_product_type === "REELS" ? "Reel" : m.media_type === "CAROUSEL_ALBUM" ? "Carousel" : m.media_type === "VIDEO" ? "Video" : "Image",
      link: m.permalink || "", date: (m.timestamp || "").slice(0, 10), likes: m.like_count || 0, comments: m.comments_count || 0, views: 0, reach: 0, saves: 0, shares: 0, thumb: m.thumbnail_url || m.media_url || "" };
    for (const metrics of ["views,reach,saved,shares", "reach,saved,shares", "reach,saved"]) {
      try { const ins = await graph(`/${m.id}/insights?metric=${metrics}`, token); for (const d of ins.data || []) { const v = (d.values && d.values[0] && d.values[0].value) || d.total_value?.value || 0; if (d.name === "views") p.views = v; else if (d.name === "reach") p.reach = v; else if (d.name === "saved") p.saves = v; else if (d.name === "shares") p.shares = v; } break; } catch { /* try fewer metrics */ }
    }
    if (!p.views) p.views = p.reach;
    posts.push(p);
  }
  return { posts };
}

// Account-level insights for one Instagram account: totals for the period and the one before it, follower series, recent reels.
async function igInsights(b) {
  const token = String(b.token || ""), uid = String(b.userId || ""), days = [7, 14, 28, 90].includes(+b.days) ? +b.days : 28;
  if (!/^[\w.-]{20,600}$/.test(token) || !/^\d{5,25}$/.test(uid)) throw Object.assign(new Error("This account needs a user ID and an access token"), { code: 400 });
  const now = Math.floor(Date.now() / 1000), DAY = 86400, since = now - days * DAY, pSince = since - days * DAY;
  const totals = async (a, z) => {
    const out = { views: 0, reach: 0, interactions: 0 }, map = { views: "views", reach: "reach", total_interactions: "interactions" };
    for (const m of Object.keys(map)) {
      try { const r = await graph(`/${uid}/insights?metric=${m}&period=day&metric_type=total_value&since=${a}&until=${z}`, token); const d = (r.data || [])[0]; out[map[m]] = (d && (d.total_value ? d.total_value.value : (d.values || []).reduce((t, v) => t + (+v.value || 0), 0))) || 0; } catch {}
    }
    return out;
  };
  const prof = await graph(`/${uid}?fields=username,followers_count,media_count`, token);
  const [cur, prev] = [await totals(since, now), await totals(pSince, since)];
  let series = [];
  try { const r = await graph(`/${uid}/insights?metric=follower_count&period=day&since=${Math.max(since, now - 29 * DAY)}&until=${now}`, token); series = ((r.data || [])[0] || {}).values?.map((v) => ({ date: String(v.end_time || "").slice(0, 10), value: +v.value || 0 })) || []; } catch {}
  let reels = []; try { reels = (await igSync({ token, userId: uid, limit: Math.min(12, +b.reels || 12) })).posts; } catch {}
  return { account: { id: uid, username: prof.username || "", followers: prof.followers_count || 0, media: prof.media_count || 0 }, days, cur, prev, series, reels };
}

// ---------- Publishing (Metricool / Composio) ----------
// Both services pull the video from a public https link, so each finished video gets a signed, unguessable link
// that is served through your Cloudflare tunnel. Everything else on the dashboard stays local-only.
const PUBSECRET = (() => {
  const f = join(ROOT, "output", ".pubsecret");
  try { const v = readFileSync(f, "utf8").trim(); if (v.length >= 32) return v; } catch {}
  const v = randomBytes(24).toString("hex"); try { writeFileSync(f, v, { mode: 0o600 }); } catch {} return v;
})();
const pubSig = (id) => createHmac("sha256", PUBSECRET).update(String(id)).digest("hex").slice(0, 24);
const sigOk = (id, sig) => { const a = Buffer.from(pubSig(id)), b = Buffer.from(String(sig)); return a.length === b.length && timingSafeEqual(a, b); };
const pubUrl = (base, id, name) => `${base.replace(/\/+$/, "")}/pub/${id}.${pubSig(id)}/${name}`;
const METRICOOL = process.env.METRICOOL_BASE || "https://app.metricool.com";
const COMPOSIO = process.env.COMPOSIO_BASE || "https://backend.composio.dev";
const clip = (v, n = 300) => String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, n);
const deep = (o, keys, d = 0) => { if (!o || typeof o !== "object" || d > 5) return undefined; for (const k of keys) if (o[k] !== undefined && o[k] !== null && typeof o[k] !== "object") return o[k]; for (const v of Object.values(o)) { const r = deep(v, keys, d + 1); if (r !== undefined) return r; } return undefined; };

function serveFile(req, res, file) {
  const st = statSync(file), size = st.size, type = TYPES[extname(file)] || "application/octet-stream";
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let a = 0, b = size - 1, code = 200;
  if (m && (m[1] || m[2])) { if (m[1]) { a = Number(m[1]); if (m[2]) b = Math.min(Number(m[2]), size - 1); } else { a = Math.max(0, size - Number(m[2])); } if (a > b || a >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); } code = 206; }
  const h = { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": b - a + 1, "Cache-Control": "no-store" };
  if (code === 206) h["Content-Range"] = `bytes ${a}-${b}/${size}`;
  res.writeHead(code, h);
  if (req.method === "HEAD") return res.end();
  createReadStream(file, { start: a, end: b }).pipe(res);
}

const nowIn = (tz, plusMin) => {
  const d = new Date(Date.now() + plusMin * 60000);
  try { return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d).replace(" ", "T"); }
  catch { return d.toISOString().slice(0, 19); }
};

async function httpJson(url, opt, what) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60000);
  let r, txt;
  try { r = await fetch(url, { ...opt, signal: ctl.signal }); txt = await r.text(); }
  catch (e) { throw Object.assign(new Error(`${what}: could not reach the service (${e.cause?.code || e.message})`), { code: 502 }); }
  finally { clearTimeout(t); }
  let j = null; try { j = JSON.parse(txt); } catch {}
  if (!r.ok) throw Object.assign(new Error(`${what}: ${r.status} ${clip(j?.error?.message || j?.message || j?.error || txt, 240)}`), { code: r.status === 401 || r.status === 403 ? 401 : 502, status: r.status });
  return { j, txt };
}

// ---------- Voice-over: ElevenLabs, Edge (free) or your own recording ----------
// Each script line is spoken on its own, so every scene can be exactly as long as its line.
const VOICE_ROOT = join(ROOT, "output", "voice"); mkdirSync(VOICE_ROOT, { recursive: true });
const EL_BASE = process.env.ELEVEN_BASE || "https://api.elevenlabs.io/v1";
const EDGE_BIN = process.env.EDGE_BIN || "edge-tts";
const EL_MODELS = ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5"];
const V_LEAD = 0.1, V_TAIL = 0.2;
const tokOk = (t) => /^[0-9a-f]{12}$/.test(String(t || ""));
const vdir = (t) => join(VOICE_ROOT, t);
function voiceErr(msg, code = 400) { return Object.assign(new Error(msg), { code }); }
function elFriendly(status, d) {
  const msg = (d && (d.message || (typeof d === "string" ? d : ""))) || "";
  if (status === 401) return "ElevenLabs rejected the API key. Check that you copied all of it.";
  if (status === 402 || /quota|credit|subscription/i.test(msg) || /quota_exceeded|payment/i.test(String(d && d.status || ""))) return "Your ElevenLabs plan is out of credits or does not include this voice.";
  if (status === 404) return "ElevenLabs could not find that voice. Pick another one.";
  if (status === 422) return "ElevenLabs refused the request: " + (msg || "check the voice and model.");
  if (status === 429) return "ElevenLabs says you are sending too many requests. Wait a moment and try again.";
  return msg || `ElevenLabs returned an error (HTTP ${status}).`;
}
async function elFetch(path, key, init) {
  if (!key) throw voiceErr("Add your ElevenLabs API key first.");
  let r; try { r = await fetch(EL_BASE + path, { ...init, headers: { "xi-api-key": key, ...(init && init.headers) }, signal: AbortSignal.timeout(90000) }); }
  catch { throw voiceErr("Could not reach ElevenLabs. Check your internet connection.", 502); }
  if (!r.ok) { let d = null; try { const j = await r.json(); d = j.detail; if (Array.isArray(d)) d = { message: d.map((x) => x.msg).join("; ") }; } catch {} throw voiceErr(elFriendly(r.status, d), r.status === 401 ? 401 : 502); }
  return r;
}
const spawnOut = (cmd, args, ms = 60000) => new Promise((ok, no) => {
  let out = "", err = ""; let p;
  try { p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return no(e); }
  const t = setTimeout(() => { p.kill("SIGKILL"); no(new Error("timed out")); }, ms);
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
  p.on("error", (e) => { clearTimeout(t); no(e); });
  p.on("close", (c) => { clearTimeout(t); c === 0 ? ok(out) : no(new Error((err || out || "exit " + c).slice(-300))); });
});
async function edgeRun(args, ms) {
  try { return await spawnOut(EDGE_BIN, args, ms); }
  catch (e) { if (e.code === "ENOENT") throw voiceErr("Edge voices need a small free package. Run once in a terminal: pip install edge-tts   then try again.", 400); throw voiceErr("Edge voice failed: " + String(e.message).slice(0, 200), 502); }
}
async function voiceList(b) {
  if (b.provider === "eleven") {
    const j = await (await elFetch("/voices", String(b.apiKey || "").trim())).json();
    return { voices: (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category || "", labels: v.labels || {} })) };
  }
  const out = await edgeRun(["--list-voices"], 30000);
  const voices = out.split(/\r?\n/).map((l) => /^([A-Za-z]{2,3}-[A-Za-z0-9-]+Neural)\s+(Female|Male)/.exec(l.trim())).filter(Boolean).map((m) => ({ id: m[1], name: m[1].replace(/Neural$/, ""), gender: m[2] }));
  return { voices };
}
async function probeDur(file) { return parseFloat(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], 30000)) || 0; }
async function voiceLine(b) {
  const idx = Number(b.index), text = String(b.text || "").trim();
  if (!Number.isInteger(idx) || idx < 0 || idx > 60) throw voiceErr("Bad line number");
  if (!text || text.length > 1200) throw voiceErr("A script line is empty or too long");
  let token = b.token; if (token === undefined || token === null || token === "") { token = randomBytes(6).toString("hex"); mkdirSync(vdir(token), { recursive: true }); }
  else if (!tokOk(token) || !existsSync(vdir(token))) throw voiceErr("Unknown voice session. Generate again.");
  const file = join(vdir(token), `line${idx}.mp3`);
  if (b.provider === "eleven") {
    const voiceId = String(b.voiceId || ""), model = EL_MODELS.includes(b.model) ? b.model : EL_MODELS[0];
    if (!/^[\w-]{6,40}$/.test(voiceId)) throw voiceErr("Pick an ElevenLabs voice first.");
    const r = await elFetch(`/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, String(b.apiKey || "").trim(), { method: "POST", headers: { "Content-Type": "application/json", Accept: "audio/mpeg" }, body: JSON.stringify({ text, model_id: model }) });
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  } else {
    const voice = String(b.voice || "en-US-AriaNeural"), rate = /^[+-]\d{1,3}%$/.test(String(b.rate || "")) ? b.rate : "+0%";
    if (!/^[A-Za-z]{2,3}-[A-Za-z0-9-]+$/.test(voice)) throw voiceErr("Bad Edge voice name");
    await edgeRun([`--text=${text}`, "--voice", voice, `--rate=${rate}`, "--write-media", file], 60000);
  }
  let dur = 0; try { dur = await probeDur(file); } catch {}
  if (!(dur > 0.2)) throw voiceErr("The voice service returned audio that could not be read. Try again.", 502);
  return { token, index: idx, duration: +dur.toFixed(3) };
}
async function voiceFinish(b) {
  const token = b.token, n = Number(b.count);
  if (!tokOk(token) || !existsSync(vdir(token)) || !Number.isInteger(n) || n < 1 || n > 61) throw voiceErr("Unknown voice session. Generate again.");
  const lines = [];
  for (let i = 0; i < n; i++) { const f = join(vdir(token), `line${i}.mp3`); if (!existsSync(f)) throw voiceErr(`Line ${i + 1} is missing. Generate again.`); lines.push({ file: `line${i}.mp3`, dur: +(await probeDur(f)).toFixed(3) }); }
  writeFileSync(join(vdir(token), "voice.json"), JSON.stringify({ kind: "lines", lead: V_LEAD, tail: V_TAIL, lines }));
  const args = []; lines.forEach((l) => args.push("-i", join(vdir(token), l.file)));
  const fc = lines.map((l, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round(V_LEAD * 1000)}|${Math.round(V_LEAD * 1000)},apad=pad_dur=${V_TAIL}[a${i}]`).join(";") + ";" + lines.map((_, i) => `[a${i}]`).join("") + `concat=n=${lines.length}:v=0:a=1[out]`;
  await run("ffmpeg", ["-y", "-loglevel", "error", ...args, "-filter_complex", fc, "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "4", join(vdir(token), "preview.mp3")], 120000);
  const durations = lines.map((l) => +(V_LEAD + l.dur + V_TAIL).toFixed(3));
  return { token, durations, total: +durations.reduce((a, x) => a + x, 0).toFixed(2), preview: `/output/voice/${token}/preview.mp3` };
}
function receiveOwnVoice(req, ext) {
  return new Promise((ok, no) => {
    if (!/^(mp3|wav|m4a|ogg|webm|aac)$/.test(ext)) return no(voiceErr("Use an MP3, WAV, M4A or OGG recording"));
    const token = randomBytes(6).toString("hex"); mkdirSync(vdir(token), { recursive: true });
    const file = join(vdir(token), `own.${ext}`), w = createWriteStream(file); let n = 0, dead = false;
    req.on("data", (d) => { n += d.length; if (n > 60e6 && !dead) { dead = true; w.destroy(); req.destroy(); no(voiceErr("Recording is over 60 MB", 413)); } });
    req.pipe(w);
    w.on("finish", async () => {
      if (dead) return;
      try {
        const total = await probeDur(file); if (!(total > 1)) throw voiceErr("Could not read that recording");
        if (total > 600) throw voiceErr("Recording is longer than 10 minutes");
        writeFileSync(join(vdir(token), "voice.json"), JSON.stringify({ kind: "own", file: `own.${ext}`, total: +total.toFixed(3) }));
        await run("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-c:a", "libmp3lame", "-q:a", "4", join(vdir(token), "preview.mp3")], 120000);
        ok({ token, total: +total.toFixed(2), preview: `/output/voice/${token}/preview.mp3` });
      } catch (e) { no(e.code ? e : voiceErr("Could not read that recording: " + String(e.message).slice(0, 120))); }
    });
    w.on("error", no);
  });
}
function pruneVoices() { // keep the newest 12 voice sessions
  try { const d = readdirSync(VOICE_ROOT).map((n) => ({ n, t: statSync(join(VOICE_ROOT, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(12); for (const x of d) rmSync(join(VOICE_ROOT, x.n), { recursive: true, force: true }); } catch {}
}

const FX_OPT = { caption: ["pop", "type", "slide", "bounce", "glitch"], transition: ["fade", "ring", "zoom", "slide", "flash", "glitch"], camera: ["still", "push", "drift", "shake"], particles: ["none", "sparkles", "confetti", "bokeh"] };
function cleanFx(f) {
  const o = {}; if (!f || typeof f !== "object") return o;
  for (const [k, v] of Object.entries(FX_OPT)) if (v.includes(f[k])) o[k] = f[k];
  for (const k of ["glow", "grain", "chroma", "motifs"]) if (typeof f[k] === "boolean") o[k] = f[k];
  return o;
}
const GH_API = process.env.GH_API_BASE || "https://api.github.com", GH_RAW = process.env.GH_RAW_BASE || "https://raw.githubusercontent.com", JSD = process.env.JSDELIVR_BASE || "https://cdn.jsdelivr.net";
// Hosts the finished video in a PUBLIC GitHub repo you own and returns a link Metricool / Instagram can download.
async function ghHost(b, id, dry, video) {
  const g = b.gh || {}, repo = String(g.repo || "").trim(), token = String(g.token || "").trim(), branch = String(g.branch || "main").trim() || "main";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Object.assign(new Error("GitHub repo should look like yourname/reel-media"), { code: 400 });
  if (!/^[\w./-]{1,60}$/.test(branch)) throw Object.assign(new Error("That branch name looks wrong"), { code: 400 });
  const name = `reels/${id}-${Date.now().toString(36)}.mp4`;
  if (dry) return { url: `${JSD}/gh/${repo}@<commit>/${name}`, note: "The video would be uploaded to your GitHub repo first." };
  if (!token) throw Object.assign(new Error("Add your GitHub token (Contents: read and write on that repo)"), { code: 400 });
  const H = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "reel-studio" };
  const info = (await httpJson(`${GH_API}/repos/${repo}`, { headers: H }, "GitHub repo check")).j;
  if (info && info.private) throw Object.assign(new Error("That repo is private. Make it public (Settings, Danger zone), or use a separate public repo like reel-media. Instagram and Metricool cannot open private files."), { code: 400 });
  const buf = readFileSync(video); if (buf.length > 45 * 1024 * 1024) throw Object.assign(new Error("Video is over 45 MB, too big for GitHub upload here"), { code: 400 });
  const put = (await httpJson(`${GH_API}/repos/${repo}/contents/${name}`, { method: "PUT", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ message: `reel ${id}`, content: buf.toString("base64"), branch }) }, "GitHub upload")).j;
  const sha = put && put.commit && put.commit.sha;
  const cands = [];
  if (sha && buf.length <= 19 * 1024 * 1024) cands.push([`${JSD}/gh/${repo}@${sha}/${name}`, "jsDelivr"]);
  cands.push([`${GH_RAW}/${repo}/${sha || branch}/${name}`, "GitHub raw"]);
  if (process.env.PUB_SKIP_CHECK) return { url: cands[0][0], note: "via " + cands[0][1] };
  for (const [u, via] of cands) for (let k = 0; k < 3; k++) {
    try { const r = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(15000) }); if (r.ok) return { url: u, note: "via " + via + (/video/.test(r.headers.get("content-type") || "") ? "" : " (generic file type)") }; } catch {}
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  throw Object.assign(new Error("Uploaded to GitHub, but the link could not be opened yet. Wait a minute and press the button again."), { code: 502 });
}

async function publish(b) {
  const provider = b.provider === "composio" ? "composio" : b.provider === "metricool" ? "metricool" : null;
  if (!provider) throw Object.assign(new Error("Pick Metricool or Composio"), { code: 400 });
  const id = String(b.jobId || ""); if (!/^\d+$/.test(id)) throw Object.assign(new Error("Pick a finished video"), { code: 400 });
  const video = join(JOBS_DIR, id, "video.mp4"); if (!existsSync(video)) throw Object.assign(new Error("That video is not finished yet"), { code: 400 });
  const caption = String(b.caption || "").slice(0, 2200), title = String(b.title || caption.split("\n")[0] || "Reel").slice(0, 90);
  const nets = (Array.isArray(b.networks) ? b.networks : []).filter((n) => ["instagram", "facebook", "youtube", "tiktok"].includes(n));
  if (!nets.length) throw Object.assign(new Error("Pick at least one network"), { code: 400 });
  const dry = !!b.dry, creds = b.creds || {};
  let url, hostNote = "";
  if (b.host === "github") {
    const h = await ghHost(b, id, dry, video); url = h.url; hostNote = h.note;
  } else {
    const base = String(b.publicBase || "").trim().replace(/\/+$/, "");
    if (!/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(base) || !base.includes(".")) throw Object.assign(new Error("Paste your public tunnel address, like https://something.trycloudflare.com"), { code: 400 });
    if (/^https:\/\/[\d.]+$/.test(base)) throw Object.assign(new Error("Use the tunnel's web address, not an IP"), { code: 400 });
    url = pubUrl(base, id, "video.mp4");
    if (!dry && !process.env.PUB_SKIP_CHECK) { // make sure the outside world can really reach the file before handing the link over
      const host = new URL(base).hostname;
      try { const addrs = await dns.lookup(host, { all: true }); if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("private"); }
      catch { throw Object.assign(new Error("That tunnel address does not resolve to a public server. Is cloudflared running?"), { code: 400 }); }
      let ok = false; try { const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) }); ok = r.ok && /video/.test(r.headers.get("content-type") || ""); } catch {}
      if (!ok) throw Object.assign(new Error("Cannot open the video through your tunnel yet. Check that cloudflared is running and the address is exactly what it printed."), { code: 400 });
    }
  }

  if (provider === "metricool") {
    const token = String(creds.token || "").trim(), userId = String(creds.userId || "").trim(), blogId = String(creds.blogId || "").trim();
    if (!dry && (!token || !/^\d+$/.test(userId) || !/^\d+$/.test(blogId))) throw Object.assign(new Error("Metricool needs the API token, user ID and brand (blog) ID"), { code: 400 });
    const tz = String(b.timezone || "UTC"); let dateTime;
    if (b.when && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(b.when)) dateTime = b.when.slice(0, 16) + ":00"; else dateTime = nowIn(tz, 3);
    const draft = !!b.draft;
    const info = (media) => {
      const o = { publicationDate: { dateTime, timezone: tz }, text: caption, providers: nets.map((n) => ({ network: n })), autoPublish: true, draft, media };
      if (nets.includes("instagram")) o.instagramData = { type: "REEL", showReelOnFeed: true };
      if (nets.includes("facebook")) o.facebookData = { type: "REEL", title };
      if (nets.includes("youtube")) o.youtubeData = { title, type: "short", privacy: "public", madeForKids: false };
      if (nets.includes("tiktok")) o.tiktokData = { title: caption.slice(0, 150), privacyOption: "PUBLIC_TO_EVERYONE" };
      return o;
    };
    if (dry) return { dry: true, provider, videoUrl: url, hostNote, steps: [`GET ${METRICOOL}/api/actions/normalize/image/url?url=<video link>`, `POST ${METRICOOL}/api/v2/scheduler/posts`], body: info([url]) };
    const q = `userId=${encodeURIComponent(userId)}&blogId=${encodeURIComponent(blogId)}`, hd = { "X-Mc-Auth": token };
    const n = await httpJson(`${METRICOOL}/api/actions/normalize/image/url?url=${encodeURIComponent(url)}&${q}`, { headers: hd }, "Metricool media step");
    const ref = (typeof n.j === "string" ? n.j : deep(n.j, ["url", "mediaUrl", "normalizedUrl", "mediaId", "id"])) || n.txt.replace(/^"|"$/g, "").trim() || url;
    const shapes = [[String(ref)], { mediaId: String(deep(n.j, ["mediaId", "id"]) || ref) }];
    let last, out;
    for (const m of shapes) {
      try { out = await httpJson(`${METRICOOL}/api/v2/scheduler/posts?${q}`, { method: "POST", headers: { ...hd, "Content-Type": "application/json" }, body: JSON.stringify(info(m)) }, "Metricool scheduling"); break; }
      catch (e) { last = e; if (e.status !== 400) throw e; }
    }
    if (!out) throw last;
    const pid = deep(out.j, ["id", "postId", "uuid"]), planner = deep(out.j, ["plannerUrl", "url"]);
    return { ok: true, provider, hostNote, videoUrl: url, scheduled: dateTime + " " + tz, draft, postId: pid ?? null, plannerUrl: planner ?? null };
  }

  // Composio: publishes an Instagram Reel now (the Instagram API itself has no scheduling for reels)
  if (!nets.every((n) => n === "instagram")) throw Object.assign(new Error("Composio publishing here is Instagram only. Use Metricool for several networks."), { code: 400 });
  const key = String(creds.apiKey || "").trim(), uid = String(creds.userId || "").trim() || "default";
  if (!dry && !key) throw Object.assign(new Error("Composio needs your API key"), { code: 400 });
  const run = async (slug, args) => (await httpJson(`${COMPOSIO}/api/v3/tools/execute/${slug}`, { method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: uid, arguments: args }) }, `Composio ${slug}`)).j;
  const plan = { video_url: url, media_type: "REELS", caption, share_to_feed: true };
  if (dry) return { dry: true, provider, videoUrl: url, hostNote, steps: ["INSTAGRAM_GET_USER_INFO", "INSTAGRAM_POST_IG_USER_MEDIA (create container)", "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH"], body: plan };
  const who = await run("INSTAGRAM_GET_USER_INFO", { ig_user_id: "me" });
  if (who && who.successful === false) throw Object.assign(new Error("Composio: Instagram is not connected for this user. Connect it in the Composio dashboard first. " + clip(who.error, 160)), { code: 400 });
  const igId = String(deep(who?.data, ["id", "ig_user_id"]) || "me");
  const made = await run("INSTAGRAM_POST_IG_USER_MEDIA", { ig_user_id: igId, ...plan });
  if (made && made.successful === false) throw Object.assign(new Error("Composio: " + clip(made.error, 240)), { code: 502 });
  const cid = deep(made?.data, ["creation_id", "id"]); if (!cid) throw Object.assign(new Error("Composio did not return a container id: " + clip(made, 200)), { code: 502 });
  const pub = await run("INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", { ig_user_id: igId, creation_id: String(cid) });
  if (pub && pub.successful === false) throw Object.assign(new Error("Composio publish: " + clip(pub.error, 240)), { code: 502 });
  return { ok: true, provider, hostNote, videoUrl: url, published: true, mediaId: deep(pub?.data, ["id", "media_id"]) ?? null };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = decodeURIComponent(url.pathname);
    const hostName = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostName)) { // reached through the tunnel: only signed video links, nothing else
      const pm = /^\/pub\/(\d+)\.([0-9a-f]{24})\/(video\.mp4|slide\d+\.png)$/.exec(path);
      if (!pm || !(req.method === "GET" || req.method === "HEAD") || !sigOk(pm[1], pm[2])) return send(res, 404, "Not found", "text/plain");
      const f = pm[3] === "video.mp4" ? join(JOBS_DIR, pm[1], "video.mp4") : join(JOBS_DIR, pm[1], "carousel", pm[3]);
      if (!existsSync(f)) return send(res, 404, "Not found", "text/plain");
      return serveFile(req, res, f);
    }
    if (path.startsWith("/api/voice/") && req.method === "POST") {
      if (!okOrigin(req)) return send(res, 403, { error: "Forbidden origin" });
      try {
        if (path === "/api/voice/own") { pruneVoices(); return send(res, 200, await receiveOwnVoice(req, String(url.searchParams.get("ext") || "").toLowerCase())); }
        const b = JSON.parse(await readBody(req) || "{}");
        if (path === "/api/voice/voices") return send(res, 200, await voiceList(b));
        if (path === "/api/voice/line") { if (b.token === undefined || b.token === null || b.token === "") pruneVoices(); return send(res, 200, await voiceLine(b)); }
        if (path === "/api/voice/finish") return send(res, 200, await voiceFinish(b));
        return send(res, 404, { error: "Not found" });
      } catch (e) { return send(res, e.code >= 400 && e.code < 600 ? e.code : 502, { error: String(e.message || e) }); }
    }
    if (path === "/api/publish" && req.method === "POST") {
      if (!okOrigin(req)) return send(res, 403, { error: "Forbidden origin" });
      try { return send(res, 200, await publish(JSON.parse(await readBody(req) || "{}"))); }
      catch (e) { return send(res, e.code >= 400 && e.code < 600 ? e.code : 502, { error: String(e.message || e) }); }
    }
    if (path === "/api/ping") return send(res, 200, { ok: true, local: true, hasKey: !!process.env.ANTHROPIC_API_KEY, cli: await cliAvailable(), styles: Object.keys(cfg.styles) });
    if (path === "/api/jobs" && req.method === "GET") return send(res, 200, { jobs: [...jobs.values()].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 12).map(view) });
    const m = path.match(/^\/api\/jobs\/(\d+)$/);
    if (m && req.method === "GET") { const j = jobs.get(m[1]); return j ? send(res, 200, view(j)) : send(res, 404, { error: "Not found" }); }
    if (path === "/api/generate" && req.method === "POST") {
      if (!okOrigin(req)) return send(res, 403, { error: "Forbidden origin" });
      const b = JSON.parse(await readBody(req) || "{}");
      const script = String(b.script || "").trim(), title = String(b.title || "Untitled").slice(0, 120);
      if (!script || script.length > 5000) return send(res, 400, { error: "Script is empty or too long" });
      let style = cfg.styles[b.style] ? b.style : cfg.defaultStyle, custom = null;
      if (b.style === "custom" && b.custom) {
        const hex = (x) => typeof x === "string" && /^[0-9a-fA-F]{6}$/.test(x);
        const c = b.custom;
        if (Array.isArray(c.gradients) && c.gradients.length >= 1 && c.gradients.length <= 4 && c.gradients.every((p) => Array.isArray(p) && p.length === 2 && p.every(hex)) && hex(c.text) && (c.accent === undefined || hex(c.accent)) && (c.accentText === undefined || hex(c.accentText))) {
          custom = { gradients: c.gradients, text: c.text, accent: c.accent, accentText: c.accentText }; style = "custom";
        }
      }
      if ([...jobs.values()].some((x) => x.status === "running")) return send(res, 409, { error: "A job is already running" });
      const id = String(++seq);
      mkdirSync(join(JOBS_DIR, id), { recursive: true });
      const handle = /^@?[\w.]{1,30}$/.test(String(b.handle || "")) ? String(b.handle) : "";
      const fx = cleanFx(b.fx);
      const voiceDir = tokOk(b.voice) && existsSync(join(vdir(b.voice), "voice.json")) ? vdir(b.voice) : "";
      const scenes = cleanScenes(b.scenes);
      const j = { id, title, style, custom, handle, scenes, voiceDir, fx, script, status: "running", createdAt: new Date().toISOString(), steps: Object.fromEntries(STAGES.map((s) => [s, "pending"])), log: [`Job ${id} started (${style})`] };
      jobs.set(id, j); save(j); runJob(j);
      return send(res, 202, { id });
    }
    if ((path === "/api/ai" || path === "/api/script") && req.method === "POST") {
      if (!okOrigin(req)) return send(res, 403, { error: "Forbidden origin" });
      try { const b = JSON.parse(await readBody(req) || "{}"); if (path === "/api/script") b.kind = "script"; return send(res, 200, await runAi(b)); }
      catch (e) { return send(res, e.code || 500, { error: e.message === "no_ai" || e.message === "no_key" ? "no_ai" : String(e.message || e) }); }
    }
    if (path === "/api/upload" && req.method === "POST") {
      if (!okOrigin(req)) return send(res, 403, { error: "Forbidden origin" });
      try { const { id } = await receiveUpload(req, url.searchParams.get("name") || "video.mp4"); return send(res, 200, { id }); }
      catch (e) { return send(res, e.code || 500, { error: String(e.message || e) }); }
    }
    if (path === "/api/analyze" && req.method === "POST") {
      if (!okOrigin(req)) return send(res, 403, { error: "Forbidden origin" });
      try { return send(res, 200, await analyzeVideo(JSON.parse(await readBody(req) || "{}"))); }
      catch (e) { return send(res, e.code || 500, { error: e.message === "no_ai" ? "no_ai" : String(e.message || e) }); }
    }
    if (path === "/api/ig/insights" && req.method === "POST") {
      if (!okOrigin(req)) return send(res, 403, { error: "Forbidden origin" });
      try { return send(res, 200, await igInsights(JSON.parse(await readBody(req) || "{}"))); }
      catch (e) { return send(res, e.code || 502, { error: String(e.message || e) }); }
    }
    if (path === "/api/ig/sync" && req.method === "POST") {
      if (!okOrigin(req)) return send(res, 403, { error: "Forbidden origin" });
      try { return send(res, 200, await igSync(JSON.parse(await readBody(req) || "{}"))); }
      catch (e) { return send(res, e.code || 502, { error: String(e.message || e) }); }
    }
    if (path === "/api/fetch" && req.method === "POST") {
      if (!okOrigin(req)) return send(res, 403, { error: "Forbidden origin" });
      const b = JSON.parse(await readBody(req) || "{}");
      const urls = (Array.isArray(b.urls) ? b.urls : []).map(String).slice(0, 5);
      const results = [];
      for (const url of urls) {
        try { const r = await readPage(url); results.push({ url, ok: true, ...r }); }
        catch (e) { results.push({ url, ok: false, error: String(e.message || e) }); }
      }
      return send(res, 200, { results });
    }
    if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
    // static files
    let rel = path === "/" ? "/index.html" : path;
    const allowed = rel === "/index.html" || /^\/output\/voice\/[0-9a-f]{12}\/preview\.mp3$/.test(rel) || rel.startsWith("/data/") || /^\/output\/jobs\/\d+\/(video\.mp4|carousel\/slide\d+\.png)$/.test(rel) || /^\/output\/frames\/[0-9a-f]{12}\/f\d+\.jpg$/.test(rel);
    const file = resolve(ROOT, "." + rel);
    if (!allowed || !(file === ROOT || file.startsWith(ROOT + sep)) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
});
server.listen(PORT, "127.0.0.1", () => console.log(`Dashboard running at http://localhost:${PORT}  (Ctrl+C to stop)`));
