# CLAUDE.md

Notes for any Claude working in this repo. Read this first, every session.

## Who you might be working with

Two people work on gma:

- **Ben** owns the project, runs the server and reviews every change. He knows git and this codebase.
- **Ben's dad** helps build it. He is new to git and new to building software with Claude, and he does not have a GitHub account.

If `.local/dad` exists in this folder, it's Dad. If `git config user.email` matches the author of most commits in `git log`, it's Ben. If you still can't tell, ask: "Are you Ben, or Ben's dad?" If it's Ben's dad (or anyone new), stop here and follow [docs/helping/START-HERE.md](docs/helping/START-HERE.md) before anything else. It covers setup, the coaching style he needs, and how his work gets back to Ben without GitHub.

## The project in one breath

A private family window for Grandma: a family photo/video web app (PWA) plus a touchscreen frame in Grandma's kitchen. Start with [VISION.md](VISION.md) (what and why), then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (the contract the code is built against) and [docs/DECISIONS.md](docs/DECISIONS.md). [README.md](README.md) has run, test and deploy commands.

- `server/`: Node 22+ (Fastify 5, SQLite). `npm install`, `npm start`, `npm run worker`, `npm test`.
- `web/`: plain JS modules and CSS, no build step. `npm test`, `npm run e2e`.
- `design/heirloom/`: the visual reference. Grandma's screens follow VISION.md's principles strictly: big targets, nothing autoplays, one tap from home.
- `pi/`, `deploy/`: Ben's hardware and server. Don't change these unless Ben asked.

## Rules for every change

- Work on a branch, never directly on `draft/mvp` or `main`.
- Run the tests for the part you touched (`cd server && npm test`, `cd web && npm test`) and say honestly if anything fails.
- If the code and `docs/ARCHITECTURE.md` disagree, fix one of them in the same change.
- Never commit secrets: `.env` and keys stay out of git (see `.gitignore`).
- Keep commits small, with plain-English messages that say what changed for the family or for Grandma.
