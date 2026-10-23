# Lantern

**Mood:** a quiet gallery at dusk. The photo glows and everything else steps back.

Lantern is dark and photo-first. On Grandma's frame the room is a warm near-black and the photo is the only bright thing in it. A portrait sent from a phone is shown whole, as a print lit on a blurred, darkened fill of itself, and a landscape fills the screen. Everything else (the clock, what's new, the buttons) sits on near-opaque frosted plates along the right edge and in one dock across the bottom, so the chrome is always in the same two places. The family app uses the same dark room, the same honey accent and the same serif for the words people write, so a relative's phone and Grandma's frame clearly belong to the same family.

## Why it suits Grandma

- **Calm at a glance.** One bright thing (the photo), one accent (honey), nothing that flashes or counts. "New" is one honey word on a softly glowing card, never a badge or a number.
- **Home never moves.** It is a 136 x 120 px button at 24 px from the left and bottom edges on every frame screen. On Home it is lit with a honey ring ("you're here"); everywhere else it is a plain raised button in the same spot.
- **Big and plain.** Every main action is 120 px tall. Reactions are 164 x 120 px with 16 px between them (a little more room for a shaky finger) and the presets 290 x 188 px. Buttons say what they do in words ("Previous", "Next", "Send a message", "Back to the photo", "See the photos now").
- **Kind to the eyes at night and in a dim room.** A dark room means the frame isn't a lightbox on the wall at 10 pm, and night mode goes further (see below).
- **Words that sound like people.** Captions and preset messages are set in Literata, a book serif, so what Sarah wrote reads as a note from Sarah. Interface text is Lexend, which was designed for reading ease and has wide, open letterforms.
- **The whole photo, never a cropped head.** Portraits are never cropped to fill the frame. The open photo is always shown whole (contain), on its own blurred fill.

## Files

| File | What |
|---|---|
| `home.html` | Home, 1280 x 800. `?state=offline`, `?state=night` |
| `photo.html` | An open photo, 1280 x 800. `?state=presets`, `?state=sent`, `?state=video` |
| `family.html` | The family PWA, 390 x 844. `?tab=grandma`, `?tab=mine` |
| `tokens.css` | Palette, type scale, spacing, radii, frame geometry, `@font-face` |
| `grandma.css` | Shared frame chrome (dock, Home button, plates, the blurred fill) so Home is identical on every screen |
| `fonts/` | Lexend and Literata (variable woff2, latin subset) with their OFL licences |

## Palette

Ratios are WCAG 2.x, measured against the background each colour normally sits on. The frame needs 7:1 for text (4.5:1 at 24 px and up); the phone needs 4.5:1.

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--bg` | `#101215` | The room: frame and app background | — |
| `--surface` | `#1B1F24` | Placard, cards, phone cards | — |
| `--raised` | `#262B31` | Buttons, reaction tiles, presets | — |
| `--text` | `#F4EFE6` | Warm ivory text | 16.4 on bg · 14.5 on surface · 12.5 on raised |
| `--muted` | `#CFC7BA` | Second-line text (when, who) | 11.2 on bg · 9.9 on surface · 8.5 on raised |
| `--honey` | `#F2B544` | The one accent: primary buttons, "New", active tab | 10.3 on bg · 9.0 on surface · 7.8 on raised |
| `--honey-ink` | `#1A1406` | Text and icons on honey | 10.0 on honey |
| `--honey-deep` | `#3A2E14` | Home's "you're here" fill, Sarah's avatar | text 11.6 · honey 7.3 |
| `--rose` | `#F2A7B0` | Love only: the ring and tick on a sent Love | 8.6 on surface · 7.5 on rose-deep |
| `--rose-deep` | `#3B2328` | The fill behind a chosen Love | text 12.6 |
| `--plate` | `rgba(20,23,27,.90)` | Frosted plates over photos (clock, dock, offline line) | worst case over pure white (= `#2B2E32`): text 11.9 · muted 8.1 |
| `--n-bg` | `#0B0907` | Night: warm black | — |
| `--n-raised` | `#1E1810` | Night: buttons | — |
| `--n-text` | `#EBD2A8` | Night: amber cream | 13.6 on n-bg · 12.0 on n-raised |
| `--n-muted` | `#C9AD84` | Night: the quiet line | 9.3 on n-bg · 8.2 on n-raised |
| `--n-honey` | `#C9932F` | Night: the Home ring (decorative, never text) | — |

Avatar initials on the phone (Mike `#9ED9CF` on `#17322F` 8.7, Carol `#C3C2F5` on `#2A2A44` 8.2, Jake `#B9DC9C` on `#22321C` 8.9, Lily rose on rose-deep 7.5, Sarah honey on honey-deep 7.3) all pass 7:1.

Plates are near-opaque on purpose: at 0.9 alpha, even a pure-white photo underneath leaves 8:1 for the muted text, so the audit's "over image" items (the clock, the offline line, the dock caption) are safe on any photo.

## Type scale

Two families: **Lexend** (UI, variable 300 to 700) and **Literata** (words people wrote, variable 400 to 600, plus italic).

### Grandma's frame (1280 x 800)

| Role | Family | Size px | Weight | Line height |
|---|---|---|---|---|
| Night clock | Lexend | 184 (pm 60) | 300 | 1.0 |
| Day clock | Lexend | 52 (am 34) | 500 | 1.05 |
| Sent title ("Sent to Sarah") | Lexend | 48 | 700 | 1.1 |
| Screen title ("Send a message to Sarah") | Lexend | 44 | 700 | 1.12 |
| Sender name ("Sarah") | Lexend | 40 | 700 | 1.08 |
| Name on a new card ("Sarah") | Lexend | 34 | 700 | 1.12 |
| Preset message | Literata | 34 | 500 | 1.2 |
| Caption | Literata | 30 | 400 | 1.42 |
| Body, dock caption, night line | Literata / Lexend | 28 | 400 | 1.3 to 1.4 |
| Button label | Lexend | 26 (Send a message 28) | 600 to 700 | 1.15 |
| Reaction word ("Love", "Thankful") | Lexend | 26 | 600 | 1.1 |
| Meta ("This morning", "Tell Sarah how you feel", date) | Lexend | 24 | 500 to 600 | 1.25 to 1.3 |
| Small ("New", "From Aunt Carol · Sunday") | Lexend | 22 | 600 | 1.2 |

Nothing on the frame is below 22 px.

### Family PWA (390 x 844)

| Role | Family | Size px | Weight | Line height |
|---|---|---|---|---|
| Page title | Lexend | 30 | 700 | 1.1 |
| Preset quote in Grandma's Feed | Literata | 18 | 500 | 1.3 |
| Name | Lexend | 17 | 600 | 1.25 |
| Caption | Literata | 17 | 400 | 1.4 to 1.5 |
| Body, "Grandma loved this", button | Lexend | 15 to 16 | 500 to 600 | 1.3 to 1.45 |
| Meta (times, "on Sarah's video") | Lexend | 14 | 500 | 1.35 |
| Tab label, "To Sarah" chip | Lexend | 13 | 600 | 1.2 |

## The screens

- **Home:** the slide that is showing (default: Aunt Carol's portrait of a deer, shown as a whole print on its own blurred fill). The right rail holds the clock and three glowing "New" cards: Video from Sarah (poster p646 with a play mark), 3 photos from Mike (a small fanned stack of p1015, p174 and p129) and Photo from Lily (p837). The dock holds Home, who sent the slide and what they wrote, and **Message to the whole family**, a button that carries the family photo (p129) with a honey microphone on it. Tapping the slide or its caption opens it.
- **Offline:** the slideshow carries on from saved photos (here Jake's pug, full bleed). One calm plate at the top left says "No Wi-Fi right now. Showing your saved photos." It uses a Wi-Fi mark with two faded arcs, with no red, no slash and no exclamation mark. Everything else works as normal.
- **Photo:** the photo is shown whole and glowing on its own blurred fill. The placard on the right shows the sender, when it came, the caption in Literata, one quiet line that says who a reaction goes to ("Tell **Sarah** how you feel"), the four labelled reactions in a 2 x 2 grid, and a honey **Send a message** button level with the dock. The dock holds Home, Previous and Next.
- **Presets:** one big 4 x 2 grid of the eight messages in Literata, set in honey quotation marks (each on one line, except "Come visit / soon", which breaks where a person would say it). The header shows a thumbnail of the photo, lit by a soft glow of its own colours, and says "Send a message to Sarah. It goes to **Sarah only**." The dock offers Home and **Back to the photo**.
- **Sent:** the Love tile turns rose with a tick, and a brief plate over the photo says "Sent to Sarah" under a large heart, with "Your love is on its way."
- **Video:** the poster, slightly dimmed, with one 188 px honey play button and a "Play video" label. The placard adds "A video, about 1 minute". Nothing plays until it is tapped, and there is no `<video autoplay>`.
- **Family (phone):** a photo-first feed, newest first, grouped by day. Each post shows the person, the time, the photo or video (poster and play button, never autoplay), the caption in Literata, and Grandma's response if she gave one. Posts she hasn't responded to yet read "New on Grandma's frame". **Add photos** (honey) sits in the top bar.
- **Grandma's Feed:** her reactions, preset messages and a voice note, newest first. Each item shows what she sent, which photo it was about (as a thumbnail, with a small play mark when it was a video, and in words) and a "To Sarah" / "To everyone" chip. The voice note gets its own warm card with a tap-to-play bar.
- **Mine (you are Sarah):** a compact list of your uploads, each with "From Grandma" chips (reactions with their emoji and word, and quoted messages).

## Night mode

`?state=night` is Home after dark, at **10:42 pm**: the same digits as the day mock, so the two screens can be compared side by side.

- The slideshow pauses on one photo. The photo is dimmed to about a third of its brightness, desaturated, warmed with sepia and an amber wash, then darkened further where the words sit.
- A large, light-weight clock (184 px Lexend 300) sits in the empty half of the photo, left-aligned like a film title, with the date and "Good night. The photos will be back in the morning." in amber cream (`--n-text`, `--n-muted`) and no pure white anywhere.
- The rail, the new cards and the voice button step away. The dock keeps **Home** in its usual place (lit with a dim amber ring) and adds one way back to the photos, **See the photos now** (the line above says they come back on their own in the morning).
- In production the Pi's backlight should drop too (most Pi touch panels take a brightness value); CSS can only dim the pixels, and a dark UI on a full-brightness backlight still glows in a dark bedroom.
- Worst-case check (a pure-white pixel in the photo): the night filter caps it at about 108/255, and the amber wash plus the scrim bring it down to about 35/255 behind the clock and about 50/255 behind the quiet line. That leaves about 11:1 for the clock and date, and about 6:1 for the 28 px line, where the bar is 4.5:1. The audit lists these as "over image", so they were also checked by eye.

## Motion

Nothing moves on its own except that the slideshow would change slowly (the mock is static). Buttons scale to 0.97 under a finger. Under `prefers-reduced-motion` every transition drops to 1 ms. The "New" glow is static light, never a pulse.

## Risks

- **GPU cost on a Raspberry Pi 4.** `filter: blur(44px)` on a full-screen image, plus `backdrop-filter` on the plates, is the expensive part of this direction. In production the blurred fill should be pre-rendered on the server as a tiny blurred JPEG (or set as a CSS background at about 1/16 size), and `backdrop-filter` can be dropped, because the plates are 90 % opaque and look nearly the same without it.
- **Dark rooms and bright rooms.** Dark UI is calm at night but can look murky in a sunny room, and some older eyes find light text on dark harder to read (halation, especially with cataracts). The type is heavy enough (600 to 700 for labels, 400 Literata at 28 to 30 px) to help. A "day" variant with a lighter room might still be wanted, and that should be tested with Grandma.
- **Honey is the only accent.** The primary buttons, "New" and the active tab all share it. That keeps things calm, but "New" relies on the word and the glow, not on a second colour.
- **Over-image text depends on the plates.** The audit can't measure text on a photo. Lantern keeps every word on a 0.9-opaque plate except the night clock, so the plates must not be made more transparent "for the look".
- **Night time is fixed in the mock.** The real frame needs a sunset or schedule rule for when night mode starts, and the slide it pauses on should be a calm one with a dark half for the clock (this mock picks p129 for that reason).
- **The voice button is a photo, a microphone and words in one tap target.** That is clear, but the recording flow behind it (start, stop, send to everyone, offline queue) still needs its own screens.
