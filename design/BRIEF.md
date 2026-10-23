# Design brief: gma.4mn.org mocks (Phase 1)

Three visual directions share this brief. They should differ in look and feel, not in content or features, so Ben can compare them like for like. `../VISION.md` (once the repo exists) is the source of truth; the parts that drive these mocks are quoted here.

## The people

- **Grandma**: older; uses a 10" 1280x800 touchscreen (Raspberry Pi 4, Chromium kiosk, no browser chrome) at arm's length. She never manages anything: no settings, no menus, no logins. Assume reduced vision, a less precise finger and little patience for anything that moves unexpectedly.
- **Family**: about 40 relatives on their phones, with the PWA installed to the home screen.

## Principles the mocks must show

1. Every screen is one tap from Home. A big **Home** button is always visible, in the same place on every Grandma screen (on Home itself it reads as "you're here": present, not hidden).
2. Nothing autoplays. Video and audio play only on a tap. A video shows a poster plus a huge play button. The slideshow itself may change slowly; that is the frame's purpose.
3. Big targets, big text: every tappable thing is at least 80x80 px (aim for 96 to 140 px on main actions), text at least 20 px (body 28 px or more, names and headings bigger), contrast at least 7:1 for text on solid surfaces. Few choices per screen.
4. Emoji never stand alone: each of the four reactions carries a word label.
5. Text that sits on a photo needs a scrim or a solid plate so it reads on any photo, light or dark.
6. Private and calm: no counts, badges, streaks or red "unread" dots on Grandma's side. "New" is fine, said gently.

## Shared assets (do not copy them into your folder; reference them)

- Photos: `../assets/photos/*.jpg` (see `ATTRIBUTION.md`). Landscape: p129 (couple on a bench), p837 (bulldog), p659 (husky), p1062 (pug in bed), p815 (hands making a heart), p646 (girl in a sunlit field), p838, p1010 (reading in bed), p835 (baking), p152 (garden flowers), p696 (tulips), p174 (balloons, very wide), p1015 (kayak), p237 (black puppy), p292 (kitchen), p822 (friends). Portrait: p660 (sparkler), p1012, p64, p1003 (fawn). Phones shoot portrait: show at least one portrait photo handled well in the 1280x800 landscape frame (blurred fill, a mat, or a split layout; never a stretched crop that cuts heads).
- Reactions: `../assets/emoji/emoji_u2764.svg` (heart), `emoji_u1f602.svg` (laughing), `emoji_u1f62e.svg` (surprised), `emoji_u1f64f.svg` (folded hands). Noto Emoji, Apache 2.0. Use these images, not system emoji, so the Pi (which has no colour emoji font by default) and phones look the same.
- Fonts: self-host in `fonts/` inside your direction folder (woff2, SIL OFL; Google Fonts is a fine source: fetch the CSS with a modern User-Agent and download the woff2 files it names). No runtime request may leave `file://`: the kiosk must work offline and the app is private. Good candidates for older readers: Atkinson Hyperlegible Next (made by the Braille Institute for low vision), Lexend, Literata, Fraunces, Source Serif 4, Figtree, Nunito. Pick two families at most.
- Icons: inline SVG, drawn by you, simple and thick-stroked. No icon fonts, no CDNs, no frameworks.

## The fake family (use these names and items so the mocks match)

- Sarah (granddaughter), Mike (son), Lily (great-granddaughter, 8), Jake (grandson), Aunt Carol, Ben (runs the app).
- Today: **Tuesday, October 21**, it's **10:42 am**. Write times as "10:42 am" (lower-case am/pm, no Intl "AM").
- New items on Home: "Video from Sarah" (poster p646), "3 photos from Mike" (p1015, p174, p129), "Photo from Lily" (p837, caption "Meet Biscuit! He snores.").
- The open photo: from Sarah, poster or photo p646, caption "Lily at the farm today. She wanted you to see her new boots!", sent "This morning".
- Reactions, in this order: heart "Love", laughing "Funny", surprised "Wow", folded hands "Thankful".
- Preset messages (8): "Love you", "Call me", "Thank you", "Miss you all", "So beautiful", "Made my day", "Come visit soon", "Proud of you".
- The whole-family voice button: "Message to the whole family", on a family photo (p129 or p815 work).

## Files to produce in `design/<your-direction>/`

All plain HTML and CSS, an inline `<script>` only to switch states. No frameworks, no build step.

| File | Viewport | States (read from the query string, set `document.documentElement.dataset.state`) |
|---|---|---|
| `home.html` | 1280x800, no scrolling | default; `?state=offline` (Wi-Fi is down: the slideshow keeps going from saved photos, one calm line says so, nothing alarming, no red); `?state=night` (night mode: dimmed, slideshow paused or slowed, still readable, Home still there) |
| `photo.html` | 1280x800, no scrolling | default (photo open: sender, when, caption, the 4 labelled reactions, a "Send a message" button, Home, previous/next); `?state=presets` (the 8 presets open as one big grid, and it says plainly the message goes to Sarah only; a way back); `?state=sent` (after tapping Love: "Sent to Sarah" confirmation, warm and brief); `?state=video` (a video item from Sarah: poster, one huge play button, nothing playing) |
| `family.html` | 390x844 (phone) | default = **Family** tab (everyone's uploads, newest first; an upload button); `?tab=grandma` = **Grandma's Feed** (her reactions, preset messages and a voice note "to everyone", in time order, each showing which photo it was about and who it went to); `?tab=mine` = **Mine** (your uploads with Grandma's reactions on each). Bottom tab bar with the three tabs. |
| `tokens.css` | | the palette, type scale, spacing and radii as CSS custom properties (hex or rgb values, so contrast can be checked) |
| `README.md` | | the direction: name, one-line mood, why it suits Grandma, palette table (hex, role, contrast ratio against its usual background), type scale table (role, family, size px, weight, line height) for both surfaces, how night mode works, and its risks |

Mark elements for the audit: every tappable thing is a `<button>` or `<a href>` (or has `data-tap`); the Home button has `data-home`; each reaction has `data-reaction`. Respect `prefers-reduced-motion` (the audit screenshots with reduced motion on).

## Check your work

Run, from `~/gma`:

    /Users/edsmac/edward/backend/.venv/bin/python -I design/tools/shoot.py <direction>

It writes `design/<direction>/shots/*.png` and `audit.json`, and prints every failure: tap targets under 80 px, text under 20 px, contrast under 7:1 (4.5:1 for 24 px and up), scrolling, autoplay, a missing Home button, the reaction count, any request leaving `file://`. Iterate until it prints ALL PASS, then look at every screenshot yourself (Read the PNGs): the audit can't judge text over photos, crowding, hierarchy or whether it feels calm. Never open Google Chrome; the script uses Playwright's headless shell.
