<p align="center">
  <img src="assets/lain.png" width="340" alt="Lain">
</p>

<h1 align="center"><img src="assets/lain-face.png" width="34" alt="" align="top"> Lain</h1>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-0078D6" alt="Windows only">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
</p>

**A personal AI manager that lives on your PC and adapts to you** — it chats, directs coding
work across your projects, occasionally glances at your screen to offer help only when it's
actually useful, and learns more about you the more you use it. It's a Windows desktop app
(Electron + Claude Agent SDK).

> A local orchestrator where a manager agent ("Lain") directs Claude Code workers
> ("Navi") across many projects — each Navi runs in its own isolated git worktree,
> and Lain plans, dispatches, reviews, and merges their work from one screen.
> Lain also learns its user over time: lessons, a user profile, and a customizable persona.

**🇰🇷 Korean-only UI for now** — Lain's conversation, UI copy, and prompts are all in Korean
today. See [로드맵](#roadmap) below for i18n plans. ([한국어로 보기](README.md))

## What Lain does

- **Conversation** — Responds like a person, with token streaming and a fast conversational
  lane. Remembers and briefs you on context from before you last closed the app.
- **Directs coding work** — Give it an instruction in chat and a per-project worker (Navi,
  running Claude Code) does the work in an isolated git worktree, verifies it, and hands it
  back for you to merge or discard. Multiple projects can run at once.
- **Learning (taming)** — Automatically extracts lessons from conversations and tasks and
  applies them to future judgment, while building a profile of your preferences and habits.
  The more you use it, the more it adapts to your way of working.
- **User watch** — (opt-in) Watches only development screens (terminals, editors, dev-related
  browser tabs) and speaks up only when it's genuinely useful — an error, a failed build.
  Anything else is never captured, and it stays quiet the rest of the time.
- **Voice** — Supports 3 TTS engines (Edge/Supertonic/GPT-SoVITS) and Discord voice calls.
- **Mobile** — Chat, dispatch tasks, approve, and check status from anywhere via Telegram.
- **Safety** — Dangerous-command approval queue, secret-file access blocking, and
  spec-gaming defenses for autonomous mode.

## Quick start

**Prerequisites**

1. **Windows** (Windows-only for now — macOS/Linux are not supported)
2. **[Claude Code](https://docs.claude.com/claude-code) login** — Lain's brain is Claude. You
   need to have run `claude` in a terminal and logged in (Claude subscription or API key). If
   you're not logged in, Lain shows a 🔑 auth prompt instead of responding.

**Install**

> Prebuilt installers (Releases) are on the way. For now, build from source below.

**Build from source** — requires Node.js 20+ (LTS 20/22 recommended), Git 2.x+

```sh
git clone https://github.com/bestcow/Lain.git
cd Lain
npm install
npm run dev        # run in dev mode
npm run dist       # build installer (dist\Lain Setup *.exe)
```

> Native opus for Discord voice is optional — `npm install` completes fine without build tools (it falls back to the pure-JS opusscript automatically).

**First 5 minutes**

1. Launch it — Lain greets you. Just start talking.
2. Register a project: add a folder to manage from the Projects panel. (You can also point an
   environment variable at your workspace root for auto-scanning — see the Korean README's
   [설정](README.md#설정) section for details.)
3. Ask it to do something in a registered project via chat — e.g. "add a login feature to
   project X".
4. Open preferences (⚙) to customize how it addresses you, the model, Telegram, and more.

## Screenshots

> _Coming soon._

## Roadmap

- **Full UI i18n** — Today the UI, prompts, and error messages are hardcoded in Korean with
  no i18n scaffolding. Making the interface and Lain's conversation language switchable is on
  the roadmap but not yet implemented.

## License

[MIT](LICENSE). Third-party components (bundled fonts, assets, etc.) are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The self-improvement/journaling architecture was inspired by the **Hermes** agent (MIT) and
independently reimplemented (no code copied).

---

For full documentation (features, configuration, experimental local model, development), see the
[Korean README](README.md) — it's the primary and most up-to-date reference.
