# CCS Scheduler Bot

Operational steering and behavior rules for this project are defined in:

- [STEERING.md](./STEERING.md)

When making changes, review `STEERING.md` first and keep command behavior/message formats consistent unless explicitly requested.

## Result Feed Automation

Use `/post_result` (admin only) to generate and post match-result images for an entire league week from `RawSchedule` + Ballchasing:

- Looks up `league + week` in `RawSchedule`
- Processes each match row in that week with a valid Ballchasing group link
- Computes series score + MVP totals
- Resolves local logos from `LOGO_DIR_<LEAGUE>`
- Posts both images + optional website button to configured feed channel

Renderer backend switch:

- `RENDER_BACKEND=html` uses current HTML/CSS + Playwright templates (default)
- `RENDER_BACKEND=canvas` uses `@napi-rs/canvas` font/stroke renderer in `src/render`

## Dev vs Prod Bot Setup

Use separate env files so local testing never collides with live bot runtime:

- `.env.dev` for your local/test Discord bot application
- `.env.prod` for your live Discord bot application

NPM scripts:

- `npm run start:dev` uses `.env.dev`
- `npm run start:prod` uses `.env.prod`
- `npm start` uses default `.env`

Recommended:

- Use a different `DISCORD_TOKEN` + `CLIENT_ID` in `.env.dev`
- Set `.env.dev` `GUILD_ID` to your test server for instant slash command updates
- Keep `.env.prod` only on your production host when possible
