# Front Porch

**Big, bright and unmistakable, like a good TV remote, not a gadget.**

Front Porch is a fixed frame: on every Grandma screen the photo fills the left two-thirds, a rail of big solid keys sits on the right, Home sits top-left (house + the word "Home") and the clock sits top-right. Nothing moves between screens, so she only has to learn one layout. Everything she can press looks like a key on a remote: a thick ink outline sitting on a solid ink base (the "lip"). Nothing that can't be pressed has a lip.

## Why it suits Grandma

- **One layout, learned once.** Home, the clock, the photo and the rail are on the same pixels on every screen (`frame.css` owns them). The button she just pressed is where the way back appears: "Send a message" turns into "Back to the photo" in the same slot.
- **Keys you can see are keys.** 4 px ink outlines and a 6 px base make every target read as pressable at arm's length, even with cataracts or glare. On Home, the Home key is held down in its own base with its house filled in, exactly as the Love tile stays down after she taps it: same place, same white, same word. Down means "this is the one that's on": you're here.
- **Colour means one thing.** Blue is the only action colour (send, play, message the family; upload on the phones). Each reaction is its own solid tile with its word: Love red, Funny yellow, Wow purple, Thankful teal, the way a remote's colour keys are learned by colour as much as by label. Red is only ever Love, never an alert.
- **The largest type of the three directions**, all in Atkinson Hyperlegible Next (made by the Braille Institute for low vision): captions at 32 px, the clock at 46 px, nothing under 24 px on her screen. Contrast is at least 7:1 for every text colour on its surface.
- **Words on photos always sit on a solid plate** (the caption strip under the photo, the keys, the "Sent" card), so no photo, light or dark, can make them unreadable.
- **Calm.** No counts, badges or dots. "New for you" is the only "new". Nothing autoplays: a video is a poster and a huge Play key. The slideshow changes one photo every 20 seconds with a 2-second cross-fade (a cut under reduced motion) and rests at night.

## Files

| File | What |
|---|---|
| `home.html` | 1280x800. `?state=offline`, `?state=night` |
| `photo.html` | 1280x800. `?state=presets`, `?state=sent`, `?state=video`; add `night=1` to any state to see night mode on this screen (e.g. `photo.html?state=sent&night=1`) |
| `family.html` | 390x844 phone PWA. `?tab=grandma`, `?tab=mine` |
| `tokens.css` | palette (day and night), both type scales, spacing, radii, outline and lip widths; the `@font-face` rules |
| `frame.css` | the shared Grandma frame: top bar, Home key, clock, stage, rail, keys, the photo card, portrait handling, night mode |
| `fonts/` | Atkinson Hyperlegible Next, variable 200–800, latin + latin-ext woff2, `OFL.txt` |

Photos and emoji are referenced from `../assets/`. Nothing loads from the network.

## Palette

Day (Grandma's screen and the family app):

| Hex | Role | Contrast (on its usual background) |
|---|---|---|
| `#FFFFFF` | page background; text on colour tiles | ink on it 18.51:1 |
| `#F1F3F6` | surface: the right rail, quiet plates, the Home key on Home | ink 16.65:1, ink-2 8.60:1 |
| `#E3E7ED` | surface-2: dividers on surface (reserved) | ink 14.91:1 |
| `#0F1419` | ink: all text and every outline and lip | 18.51:1 on white, 16.65:1 on surface |
| `#3D4652` | ink-2: secondary text (date, "This morning", "Video") | 9.56:1 on white, 8.60:1 on surface |
| `#0A47C2` | primary: the one action colour (send, play, message the family, upload, active tab) | white text 7.80:1; as text on white 7.80:1 |
| `#E7EEFC` | primary-soft: the plate behind Grandma's voice message (family) | ink 15.90:1, ink-2 8.21:1 |
| `#A8102A` | Love tile | white 7.57:1 |
| `#F5B400` | Funny tile | ink 10.06:1 |
| `#5E3593` | Wow tile | white 8.73:1 |
| `#0A6150` | Thankful tile | white 7.40:1 |

Night (Grandma's screen after dark):

| Hex | Role | Contrast |
|---|---|---|
| `#000000` | background (true black: the panel emits almost nothing) | white 21:1 |
| `#14171C` | rail, "Sent" card | white 17.96:1 |
| `#FFFFFF` | text | 21:1 on black |
| `#B8BEC8` | secondary text | 11.24:1 on black, 9.61:1 on the rail |
| `#8A93A1` | outlines and lips (non-text) | 6.77:1 against black |
| `#123E8C` | night blue (Send a message, family message) | white 10.03:1 |
| `#7A0C1F` | night Love | white 11.05:1 |
| `#B88A00` | night Funny (amber, not lemon) | black 6.67:1 (34 px bold label; large text needs 4.5:1) |
| `#3F2466` | night Wow | white 12.68:1 |
| `#074A3D` | night Thankful | white 10.21:1 |

## Type scale

One family everywhere: **Atkinson Hyperlegible Next** (SIL OFL), self-hosted variable font.

Grandma's screen (1280x800 at arm's length):

| Role | Size px | Weight | Line height | Used for |
|---|---|---|---|---|
| Hero | 48 | 800 | 1.05 | "Sent to Sarah", the Play key |
| Display | 46 | 800 | 1.0 | the clock |
| Title | 42 | 800 | 1.05 | the top-bar line: "Good morning", "From Sarah", "A message for Sarah" |
| Preset | 36 | 800 | 1.25 | the eight preset messages |
| Reaction / rail heading | 34 | 800 | 1.0 / 1.1 | Love, Funny, Wow, Thankful; "Tell Sarah", "New for you", "Goes to Sarah only" |
| Label | 32 | 800 | 1.25 | Home, Send a message |
| Body | 32 | 650 | 1.22 | captions: the family's own words |
| Item | 32 | 800 | 1.1 | "from Sarah" in the rail; "No internet right now" |
| Key, two lines | 28 | 800 (600 on plates) | 1.1 | "Message to the whole family", "Back to the photo", "She'll know you loved it." |
| Small | 26 | 600–700 | 1.2 | the date, "This morning", "Video", "From Jake · Sunday" |
| Tiny | 24 | 800 | 1.25 | Previous / Next under their arrows (the floor is 20) |

Family app (390x844):

| Role | Size px | Weight | Line height | Used for |
|---|---|---|---|---|
| Title | 32 | 800 | 1.05 | Family, Grandma's Feed, Mine |
| Heading | 20 | 800 | 1.1 | names on cards |
| Button / bubble | 19 | 800 | 1.15 | "Share a photo or video", Grandma's preset messages |
| Body | 17 | 500–700 | 1.35 | captions, "to Sarah", the words of Grandma's voice message (600) |
| Meta | 15 | 600–800 | 1.2–1.35 | times, "Video · 9:58 am", reaction chips, day labels, the voice message's 0:42 |
| Avatar initial | 18 | 800 | 1 | "S" in the 44 px circles (the signed-in relative, top right; posters on cards) |
| Tab | 14 | 800 | 1.1 | tab labels under icons |

## Grandma's screens

- **Home**: the slideshow in a framed card (tap to open the photo), its sender and words on a solid strip beneath; the rail lists what's new as keys with a thumbnail ("Video / from Sarah", "3 photos / from Mike", "Photo / from Lily") and ends with the blue "Message to the whole family" key on the family photo. The first slide is a portrait from a phone (the fawn): shown whole and upright, its own colours blurred behind it, never cropped through heads.
- **Photo**: the photo with Sarah's words under it; Previous and Next as solid keys in the photo's bottom corners (they cover grass and floor rather than faces, and stay clear of the Play key); the rail says "Tell Sarah" over four reaction tiles (emoji in a white disc, word underneath) and the blue "Send a message".
- **Presets**: the eight messages fill the stage as one 2x4 grid of keys; the rail says "Goes to Sarah only. Not the whole family." over the photo she is answering; "Back to the photo" sits where "Send a message" was. (It deliberately doesn't promise "nobody else will see it": the family app's Grandma's Feed shows what she sent and to whom.)
- **Sent**: a solid card over the photo, "Sent to Sarah / She'll know you loved it.", and the Love tile stays held down with a tick. Previous/Next step aside for the moment it shows.
- **Video**: the poster, one huge blue Play key centred on it, "1 minute long" in the top bar; Previous/Next stay in their corners; nothing plays until she taps.
- **Offline**: the top-bar line becomes a quiet grey plate, "No internet right now / Your saved photos keep showing". No red, no warning icon, nothing else changes; the slideshow keeps going from what's saved.

The photo card's bottom edge and the rail's bottom edge are the same line (784 px) on every screen, and Home's top-left corner never moves (on Home it is pressed 6 px into its own base, so its footprint is identical).

## How night mode works

Night is a mode the whole frame shares (`html[data-night]`, styled in `frame.css`), not a different layout: every key stays exactly where it was.

- Background goes true black (`#000`), text white, secondary text `#B8BEC8`.
- Outlines and lips drop from ink to mid-grey `#8A93A1`, so keys stay findable without glowing.
- Photos sit under a 45 % black veil (a veil, not a CSS filter, so the portrait blur survives); thumbnails are dimmed to 55 %.
- Colour tiles switch to their night tones: deep red, amber, aubergine, dark teal. They're darker, but each is still its own colour with its word.
- The slideshow stops on one picture ("The pictures rest until morning"); the greeting becomes "Good night" with a moon, and the clock shows the evening time (the mock uses 9:42 pm; the day mock is 10:42 am).

## Family app

Bright white, chunky 3 px outlined cards, a bold bottom tab bar (icon + word, the active tab a solid blue key), the signed-in relative's initial top right, and one big blue "Share a photo or video" button. Grandma's reactions appear on the family side as the same coloured tiles she taps, in miniature, so the two surfaces look related; her preset messages are blue speech bubbles, the colour of her "Send a message" key. **Family** is everyone's uploads, newest first, with Grandma's answer (or "Grandma hasn't reacted yet") on each. **Grandma's Feed** lists what she sent, newest first, each entry showing the photo it was about (thumbnail plus "On Sarah's video: …") and who it went to ("→ to Sarah"); her voice message to everyone carries the family photo she said it on, her words as text, and a plain audio player (play key, waveform, 0:42) so it never reads as a video and never autoplays. **Mine** shows your uploads with Grandma's answers on each.

The fake data agrees across surfaces: what is still "New for you" on Grandma's Home (Sarah's video, Mike's 3 photos, Lily's Biscuit) has no answer yet in the family app, except Sarah's video, which gets the Love she sends in the `sent` state at 10:42 am; the Funny on Sarah's Pickle photo shows in both Grandma's Feed and Sarah's Mine.

## Risks

- **Toy-like to some eyes.** Thick outlines and lips are what make targets obvious to Grandma, but relatives may read the phone app as playful or "neo-brutalist". The phone uses thinner (3 px) lines and keeps lips only on buttons.
- **Previous/Next cover the photo's bottom corners** (136 x 116 px each). That is usually ground, floor or a table, rarely a face, but a photo with a child sitting in a corner would be partly hidden. The fallback is a control row under the photo, which costs about 120 px of photo height.
- **The Home key on Home is "held down".** It's the same white key pressed into its base with a filled house, the same language as the Love tile after she taps it. Watch in a session with Grandma whether she reads it as "you're here" or simply as a key; if needed, add a small "You're here" under the clock rather than greying the key (grey read as "switched off").
- **Fixed layout means fixed text room.** The caption strip holds two lines at 32 px (about 90 characters); longer captions need truncating with a "Read more" key, or a step down to 28 px. Long names ("Great-aunt Josephine") will wrap in the rail and the top bar.
- **The portrait blur is a CSS filter.** It's fine in desktop Chromium; on a Raspberry Pi 4 a 32 px blur over a large image may cost frame rate during cross-fades. Pre-render the blurred fill on the server for production.
- **Yellow at night.** Even as amber, Funny is the brightest tile after dark. If it glares in a dark room, drop it further and switch to white text.
- **The clock offline.** A Pi 4 has no real-time clock; if it reboots without internet, the time can be wrong. Hide the clock when time hasn't synced rather than show a wrong one.
- **Audit blind spot (family).** The tab bar is fixed over scrolling content and the audit measures text hidden under it against the bar's colours, so the static mocks are arranged so no card text sits under the solid-blue active tab at load (day labels are sized to their words). A real build should check contrast while scrolling.
- **Who sees Grandma's Feed.** The brief has it show who each message went to, so every relative can see that Grandma sent Aunt Carol "Made my day". That's why the presets screen says "Not the whole family" rather than "Nobody else will see it". If presets should be truly private, Grandma's Feed should show each relative only what was sent to them or to everyone.
- **Offline voice messages.** "Message to the whole family" stays on Home when the internet is down; the build should queue the recording and send it later, quietly, rather than show an error.
- **The voice message's words** in Grandma's Feed assume the app transcribes her recording. Drop the quote if it doesn't; the card still works with the photo, "to everyone" and the player.
