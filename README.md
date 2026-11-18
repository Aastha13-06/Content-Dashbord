# Video Automation Dashboard

## Quick start (local)

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # optional: or paste the key in Settings
node scripts/server.mjs
```

Open http://localhost:8000, then: paste reel links, pick a mood, click **Generate script**, then **Make video + carousel**.
Needs Node 20+, ffmpeg and fonts-dejavu-core. The AI script writer uses the Anthropic API (separate from a Claude chat plan, pay per use).
Instagram often hides captions from tools: if a link comes back empty, paste its caption instead. Nothing is downloaded from the reel.


A single-page dashboard for a 6-stage short-video workflow:
**Swipe → Script → Produce → Post → Analyze → Repurpose.**

- `index.html` is the whole UI (no build step, no dependencies). Host it on GitHub Pages.
- The **Produce** tab has a **Re-run** button. Connected to your repo, it starts a GitHub Actions workflow that renders a real 1080×1920 MP4 with ffmpeg. Not connected, it runs a simulation.
- All numbers on the other tabs are **sample data**. Replace them from `data/state.json` or by editing `DEFAULT` in `index.html`.

```
.
├── index.html                      # dashboard UI
├── data/state.json                 # optional overrides (handle, niche, any DEFAULT section)
├── pipeline.config.json            # video size, timing, font, voice provider
├── scripts/generate.mjs            # script → voice → visuals → edit → render
├── .github/workflows/generate-video.yml
└── output/                         # local render output (git-ignored)
```

---

## What's on the page

Nav, hero, the interactive Studio (six stages), How it works, a comparison, a **style picker**, a problem/solution grid, FAQ and a final call to action. Set your own brand name with `"brand": "Your Name"` in `data/state.json`. Everything on the page is original copy and design.

**Styles.** Pick one of five looks (midnight, sunrise, mono, forest, paper). The choice is sent to the workflow as the `style` input and changes the colours and type of both the video and the carousel. Edit or add styles under `styles` in `pipeline.config.json`. If your workflow file is older and has no `style` input, the dashboard detects that, runs without it and tells you in the log.

---

## Run it on your own computer (no GitHub needed)

Needs Node.js 20 or newer and ffmpeg. On Ubuntu:

```bash
sudo apt install ffmpeg fonts-dejavu-core
node -v                      # should print v20 or higher
cd path/to/get-ripping-dashboard
node scripts/server.mjs      # or: npm start
```

Open **http://localhost:8000**. The Produce tab now shows **Runs on this computer**. Write a script, pick a style, click **Generate**. Finished videos and carousel slides appear under **Recent runs** with download links. Files are also kept in `output/jobs/<number>/`.

Notes:
- The server listens on `127.0.0.1` only, so other devices on your network cannot reach it. It rejects requests from other websites.
- Use another port with `PORT=8100 node scripts/server.mjs`.
- On macOS use `brew install ffmpeg`. On Windows, install ffmpeg and set the `font` path in `pipeline.config.json` to a font file on your PC, for example `C:/Windows/Fonts/arialbd.ttf`.
- The dashboard picks the mode by itself: local server if it is running, GitHub if you connected a token, otherwise the simulation.

---

## 1. Create the GitHub repo (step by step)

1. Unzip or copy this folder to your computer, e.g. `video-dashboard/`.
2. On GitHub, click **New repository**. Name it `video-dashboard`, keep it **Public** (GitHub Pages is free for public repos), and **do not** tick "Add a README" (you already have one).
3. In a terminal, inside the folder:

```bash
git init -b main
git add .
git commit -m "Initial dashboard"
git remote add origin https://github.com/<your-username>/video-dashboard.git
git push -u origin main
```

4. Turn on the website: repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `/ (root)` → Save**.
5. After about a minute the dashboard is live at `https://<your-username>.github.io/video-dashboard/`.

## 2. Run the video pipeline on GitHub

1. Open the repo's **Actions** tab. If it asks, click **I understand my workflows, enable them**.
2. Pick **generate-video → Run workflow**, enter a title and a script (one line per scene), and run it.
3. When it finishes, open the run and download the **video** artifact (`video.mp4`).

The workflow steps are named `Script`, `Voice`, `Visuals`, `Edit`, `Render`, `Carousel`. The last one turns the same script into 1080×1350 carousel slides (cover, one slide per line, call-to-action slide), downloaded in the same artifact under `carousel/`. The dashboard maps those names to the checklist on the Produce tab.

## 3. Trigger it from the dashboard

1. Create a **fine-grained personal access token**: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained. Limit it to **only this repository**, permission **Actions: Read and write** (and Metadata: Read, added automatically).
2. Open the dashboard → **Produce** tab → click the gear or **Webhook**. Enter owner, repo, branch (`main`) and the token. Save.
3. Click **Re-run**. The dashboard calls the workflow-dispatch API, finds the new run and shows live progress in the Render log.

> **Token safety.** The token is stored in your browser's localStorage and sent only to `api.github.com`. Anyone with access to your browser profile can read it, so use a repo-scoped token, set a short expiry, and don't save it on shared computers. For a team setup, put a small proxy (Cloudflare Worker, for example) in front of the GitHub API and keep the token there.

## 4. Make the video real

Edit `pipeline.config.json`:

| Key | What it does |
| --- | --- |
| `width` / `height` / `fps` | Output format. Default 1080×1920 at 30 fps (vertical). |
| `secondsPerWord`, `minSecondsPerLine` | How long each scene stays on screen. |
| `palette` | Gradient colours that scenes cycle through. |
| `voice.provider` | `none` (silent) or `openai`. |

For narration, set `"provider": "openai"` and add a repo secret named `OPENAI_API_KEY` (**Settings → Secrets and variables → Actions**). The OpenAI voice path is written but was **not tested** here; the silent path was.

Run it locally (needs Node 22+ and ffmpeg):

```bash
TOPIC="Test" SCRIPT=$'Stop giving out free trials.\nEvery free user costs real money.' node scripts/generate.mjs all
```

Ideas for the next iteration: swap the gradient scenes for Remotion or HTML-to-video templates, add stock footage per line, burn in word-by-word captions, and add a final workflow step that uploads to your social scheduler.

## 5. Customise the dashboard data

Create or edit `data/state.json`. Top-level keys replace the matching section of the built-in sample (it is a shallow merge, so provide a whole section when you override it). For example:

```json
{
  "handle": "@mybrand",
  "niche": "Study abroad",
  "script": {
    "title": "Why your visa got rejected",
    "duration": "0:45",
    "source": "From Research",
    "hook": "Your student visa was rejected for one boring reason.",
    "body": ["Most people never read the financial proof rules.", "Here is the checklist."],
    "comment": "Comment CHECKLIST and I'll send it.",
    "checks": ["Hook in the first 3 s", "One idea a line", "Ends on a comment", "Same words on screen"]
  }
}
```

`data/state.json` loads only over http(s) (GitHub Pages or a local server). Opening `index.html` straight from disk uses the built-in sample instead. To preview locally: `python3 -m http.server 8000`, then open `http://localhost:8000`.

Keyboard: `←` `→` change stage, `Space` toggles autoplay.

---

## Reverse engineering with REA (optional)

[`morluto/rea`](https://github.com/morluto/rea) is an MCP server and CLI that lets an AI agent analyse software: websites, JavaScript/Electron apps, HAR captures, APKs, binaries and more. It does **not** generate video. Here it is useful for one thing: **studying how a reference app or site behaves** (its pages, network calls, data shapes) so you can design your own data model and API.

Setup (needs Node.js 22+):

```bash
npx rea-agents setup        # registers the MCP server with Claude Code, Codex, Cursor, Gemini CLI
# restart your agent, then ask it, for example:
#   "Use REA to observe https://<site you are allowed to analyse> and summarise its API calls and page data model."
```

Or analyse a HAR file you exported from your browser's DevTools (Network tab → Save all as HAR), or an extracted JS bundle:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Use it only on software you own or are authorised to examine. Take the *learnings* (flow, endpoints, schema) rather than copying someone else's code, copy or branding. The dashboard here is an original implementation of the workflow.

---

## Troubleshooting

- **Re-run says `GitHub answered 404`**: owner/repo/branch typo, or the token isn't scoped to this repo.
- **`GitHub answered 403` or `422`**: token lacks *Actions: Read and write*, or the branch doesn't contain `generate-video.yml`.
- **Pages shows a 404**: wait a minute after enabling Pages, and check the branch/folder setting.
- **Text missing in the video**: the workflow installs `fonts-dejavu-core`. Locally, point `font` in `pipeline.config.json` to any `.ttf` on your machine.

## Learn a style (Sources tab)

Stage 1 collects references and builds a prompt, no API key needed:

1. Add reel links (local server reads the public title and caption), `.md` / `.txt` scripts, or pasted captions.
2. Upload a dashboard screenshot to take its colours as a custom video style.
3. The tab measures hook length, scene length, "you" hooks, CTAs and common words.
4. Click **Build prompt**, copy it into a Claude chat, then paste the answer back and click **Use in Script tab**.

Notes: Instagram and TikTok often hide captions behind a login, so paste the caption or transcript for those. Nothing is downloaded or copied from the video itself. Custom screenshot styles work in local mode; GitHub mode falls back to Midnight.

## v4: sections and Claude sign-in

Sidebar: Discover (ideas, video frame-by-frame breakdown), Scripts, Studio, Calendar, Analytics, Insights, Remix, Library, Settings.

- **Claude sign-in:** run `npm install -g @anthropic-ai/claude-code` then `claude login`, restart the server. The app uses your Claude plan through that command. No command found? Add an Anthropic API key in Settings. Settings → "Use" picks Auto / Claude command / API key.
- **Video breakdown:** upload a video file in Discover. It extracts up to 12 frames with ffmpeg, Claude reads them, you get hook, on-screen text, structure and a script. Optional speech transcript if `whisper` is installed.
- **Analytics:** add posts by hand, or sync from Instagram with a user ID and token in Settings (Business/Creator account + Meta developer app needed). Tokens expire.
- It cannot log in to Instagram, download other creators' reels, or post for you.

## v7: animated reels, reference reels, daily script

- **Animated videos:** scenes are animated in headless Chrome (kinetic text, counting numbers, lists, call-to-action) and encoded with ffmpeg. Needs Google Chrome or Chromium; without it the app falls back to simple text scenes. Expect about a minute per 20-second video.
- **13 looks:** Midnight, Sunrise, Mono, Forest, Paper, Neon, Blueprint, Whiteboard, Retro 80s, Minimal, Luxury, Brutalist, Glossy. The same look styles the video and the carousel.
- **Reference reels:** up to 5, all optional. "Read with Claude" works out the character, tone, hook style, pacing and a matching look from what can be read of each reel (title, caption, description). "Write my script from this" and "Import as script" are on every reference.
- **Link → script + video:** one button in the Studio fetches the links, reads them, writes the script and makes the video.
- **Home:** today's script from a topic queue, avoiding your recent scripts, plus a set-up checklist, upcoming posts and latest videos.

## v8: faster render, designed stickers

- Video no longer waits on an extra AI "motion planning" call; scenes are planned instantly, and frames render in parallel with a live "N% rendered" bar.
- Every look now has props: icon stickers (chart, coin, rocket, bulb, AI chip...) picked from the script's keywords, burst/pill badges (FACT, PRO TIP), sparkles, and a themed card per look (sticky note, chalk frame, comic panel, glossy glass...).
- Tune speed in pipeline.config.json: motionFps (default 20) and motionScale (default 0.667).

## v9: Publish to Instagram and more (Metricool or Composio)

Every finished video has a **Publish…** button (also the **Publishing** card at the bottom of the sidebar).

1. **Public address.** Metricool and Composio download the video from the internet, so run a free Cloudflare quick tunnel in a second terminal:
   `cloudflared tunnel --url http://localhost:8000` and paste the `https://….trycloudflare.com` address it prints.
   Through the tunnel the server answers only one thing: a signed, unguessable link to the single video you publish (`/pub/<job>.<signature>/video.mp4`). The dashboard, the API and your other files return 404. The signing secret is created in `output/.pubsecret`.
2. **Metricool** (schedule, Instagram Reel / YouTube Short / Facebook Reel / TikTok): needs an API plan. Token from Account settings → API; user ID and brand (blog) ID are in the browser address bar when a brand is open. Tick "Save as a draft" the first time.
3. **Composio** (Instagram only, posts immediately): connect Instagram in Composio first, then paste your Composio API key and the user ID you connected it under.
4. **Preview** shows the exact request without sending anything.

Keys are kept in this browser only (localStorage) and are sent to your local server, which forwards them to Metricool or Composio. They are never written to disk by the server.

Dev hooks: `METRICOOL_BASE`, `COMPOSIO_BASE`, `PUB_SKIP_CHECK=1` (for mocks).

### v9.1: GitHub hosting (no tunnel)

In the Publish dialog, "Where the video is hosted" now defaults to **GitHub repo**. The dashboard uploads the finished video to a PUBLIC repo you own (for example `reel-media`) through the GitHub API and gives Metricool / Instagram a jsDelivr link (falls back to the raw GitHub link). Create a token at github.com/settings/personal-access-tokens/new for only that repo with **Contents: Read and write**. Keep the video in the repo until the post is published. The Cloudflare tunnel option is still there.
Dev hooks: `GH_API_BASE`, `GH_RAW_BASE`, `JSDELIVR_BASE`.

## v10: voice-over, 25 looks, effects, virality, accounts

- **Voice-over** (Studio step 4): ElevenLabs (key stays in your browser), free Edge voices (`pip install edge-tts`), or your own recording. The voice is made line by line, so every scene lasts exactly as long as its spoken line.
- **25 looks** and an **Effects** panel: caption styles, transitions, camera moves, particles, glow, film grain, chroma split, sticker toggle, and four presets (Clean, Hype, Cinematic, Glitch).
- **Virality score** under the script (0 to 100) with fixes pinned to seconds. Pace (Calm, Balanced, Punchy) changes the timing estimate. Saved scripts show their score.
- **Learning loop**: when you add a post in Analytics, choose the Studio render it came from. Its engagement scores that render's look, captions, transitions and pace. Insights ranks them (UCB1) and "Use these in Studio" applies the top picks. Insights also shows which hook features (number, question, "you", short, money, negative) earn more engagement.
- **Accounts** page: add several Instagram accounts (each with its own user ID and token), see views, reach, interactions and followers against the previous period, the follower line, and top recent reels. "All accounts" sums them.

Not tested against the real services: ElevenLabs, Edge TTS and the Instagram Graph insights endpoints were tested against local mocks.
