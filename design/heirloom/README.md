# Heirloom

**Mood:** the family photo album lying open on Grandma's kitchen table: warm paper, printed photos with white borders, little notes tucked beside them.

## Why it suits Grandma

- **She already knows how it works.** A photo is a print on a table, and who sent it is written beside it the way you write on the back of a print. Nothing needs explaining, and nothing looks like "an app".
- **Warm paper instead of glaring white.** Brown ink on cream paper is 13.6:1, easy on tired eyes, and doesn't flare on a cheap 10" panel at arm's length.
- **Two jobs, two typefaces.** Names, headings and captions use Fraunces, a soft, warm serif that feels like a family album. Every label you tap uses Atkinson Hyperlegible Next, made by the Braille Institute for low vision. There are no script or handwriting fonts.
- **Calm and still.** The big print is never tilted. Only the small decorative stacks lean, and only by a few degrees. The slideshow crossfades once every 40 seconds, like a print developing (with reduced motion it just swaps). Nothing else moves.
- **Everything is a word.** Every icon has a label next to it: Home, Previous, Next, Love, Funny, Wow, Thankful, Send a message, Play video.
- **The same frame every time.** Home is always top-left (184x96). The day and time are always top-right, in large serif type. A clock you can read across the kitchen is a real help for an older person.

## Files

| File | What |
|---|---|
| `home.html` | 1280x800. The slideshow print on the left, "New for you" print-cards on the right, then "Message to the whole family". `?state=offline`, `?state=night` |
| `photo.html` | 1280x800. The open photo with Sarah's note, 4 labelled reactions, Send a message, and Previous/Next. `?state=presets`, `?state=sent` (after Love; `&r=funny` and the others work too; `&said=Love%20you` shows a sent preset), `?state=video` |
| `family.html` | 390x844 phone PWA. `?tab=grandma`, `?tab=mine`, with a bottom tab bar (Family, Grandma's Feed, Mine) |
| `tokens.css` | Fonts, palette (day and night), type scale, spacing, radii and shadows. Also the shared pieces: paper, print, photo corners, header and Home button |
| `fonts/` | Fraunces (roman and italic, variable, with the opsz/wght/SOFT axes) and Atkinson Hyperlegible Next (variable), latin subset woff2, plus their OFL licence texts |

No framework, no build step, no network. Each page has one tiny inline script that reads the query string into `document.documentElement.dataset.state`.

## Signature pieces

- **The print.** Each photo has a cream mat (18 px on the big print, 6 to 10 px on small ones), a 3 px corner radius and a warm three-layer shadow, like a print lying on a table under a kitchen lamp.
- **Photo corners.** Four small antique-gold album corners hold the big print on Home and on the photo screen. They are decorative only.
- **Note cards.** The sender's words sit on a card held down by a strip of paper tape. The same card appears on Home (beside a portrait print) and on the photo screen. Each preset message is an index card with a terracotta rule.
- **Print-cards** for new items: "Video from Sarah" has a poster with a solid play badge, "3 photos from Mike" a little fanned stack of three prints, and "Photo from Lily" quotes her caption.
- **Portrait photos** (phones shoot portrait) use a split layout. The print stands full height (404x596) with its note card beside it, so nothing is cropped to fill the frame and nothing is stretched. Landscape photos become one wide print, with the name and caption written on the mat below the photo. The default Home shows the portrait case with a face in it (Mike's photo of Sarah holding chamomile, p64): her whole head and the flowers stay in the print, with only about 1% trimmed from the sides. Aunt Carol's fawn (p1003) is the next portrait in the rotation; offline and night show the landscape case.
- **No text on a photo** without a solid plate under it: the play-button pill, "3 photos", "Video · 1:02". Captions always sit on the mat or on a card.

## Palette

Hex values are in `tokens.css`. Ratios are WCAG contrast ratios against each colour's usual background.

### Day

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--paper` | `#F5EEE2` | Page background, the tabletop | n/a |
| `--card` / `--mat` | `#FFFDF8` | Note cards, print mats, reaction buttons | n/a |
| `--paper-deep` | `#EADFCD` | Tab-bar rule, pressed paper | n/a |
| `--ink` | `#2B2119` | Main text | 13.65:1 on paper, 15.48:1 on card |
| `--ink-muted` | `#57473A` | Secondary text ("This morning", the date) | 7.69:1 on paper, 8.72:1 on card |
| `--terracotta` | `#8A3517` | Primary actions (Send a message, Message to the whole family, Play, Share photos), the active tab | cream on it 7.64:1; as text 7.94:1 on card, 7.00:1 on paper |
| `--terracotta-press` | `#6E2A12` | Pressed primary, "To everyone" pill text | cream 9.93:1; 8.09:1 on its tint |
| `--terracotta-tint` | `#F3DED3` | Active-tab pill, "To everyone" pill, sent-badge ring | n/a |
| `--sage` | `#3A5236` | Home, OK, Back to the photo, the "To you" pill | cream on it 8.15:1; as text 8.47:1 on card, 7.46:1 on paper, 6.89:1 on sage-tint (phone, 14 px bold) |
| `--cream` | `#FFF8EC` | Text on terracotta and sage | see above |
| `--gold` | `#B8862B` | **Decorative only**: photo corners, the night moon, the eyebrow mark | 2.81:1 on paper (never used for text) |
| `--gold-soft` | `#D9B877` | **Decorative only**: rules and tape | 1.64:1 (never used for text) |
| `--ochre` | `#6B4F1D` | Avatar (Lily) | cream on it 7.20:1 |
| `--slate` | `#3D4A55` | Avatar (Aunt Carol) | cream on it 8.61:1 |

Starting values were tuned so text clears 7:1. Terracotta went from `#9E3D1C` (6.34:1 with cream) to `#8A3517` (7.64:1). Sage went from `#3F5A3B` to `#3A5236` so it also passes 7:1 as text on paper. Muted ink went from `#4A3B2F` to `#57473A`: it still passes, and sits further from the main ink so the hierarchy shows.

### Night (`:root[data-state="night"]`)

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--paper` | `#1E1712` | Warm dark brown table | n/a |
| `--card` | `#2A211A` | Cards, status pill | n/a |
| `--mat` | `#3A2E24` | Print mats (no glowing white borders at night) | n/a |
| `--ink` | `#F3E8D6` | Text | 14.60:1 on paper, 13.02:1 on card, 10.85:1 on mat |
| `--ink-muted` | `#D9C8B0` | Secondary text | 10.82:1 on paper, 9.65:1 on card, 8.04:1 on mat |
| voice card | `#4A200F` | Message to the whole family, stepped back at night; its words in night ink `#F3E8D6`, its mic disc `#D9C8B0` | night ink on it 11.51:1 |
| play badge | `#6E2A12` | The small play disc on "Video from Sarah", dimmed | icon only |
| Home ring | `#7E9A72` | The "you're here" outline on Home | decorative |

## Type scale

Two families: **Fraunces** (variable; `SOFT` 60 for rounder, warmer terminals; optical size automatic) and **Atkinson Hyperlegible Next** (variable).

### Grandma (1280x800)

| Role | Family | Size px | Weight | Line height |
|---|---|---|---|---|
| "Sent to Sarah" | Fraunces | 66 | 600 | 1.02 |
| Clock time ("10:42 am") | Fraunces | 56 | 600 | 1.0 |
| Sender name on the open photo ("Sarah") | Fraunces | 54 | 600 | 1.0 |
| Title (sender on a Home note, "Send Sarah a message") | Fraunces | 46 | 600 | 1.05 |
| Name on a landscape print's mat | Fraunces | 40 | 600 | 1.25 |
| "New for you" | Fraunces | 38 | 600 | 1.0 |
| Preset message card | Fraunces | 38 | 550 | 1.1 |
| Sent line ("She'll know you loved it.") | Fraunces | 32 | 400 | 1.3 |
| Print-card title ("Video from Sarah") | Fraunces | 30 | 600 | 1.08 |
| Caption | Fraunces | 30 | 400 | 1.3 |
| Button label (Home, Send a message, Back, the family voice button, Play video) | Atkinson Next | 28 | 700 | 1.15 |
| Clock date | Fraunces | 26 | 450 | 1.1 |
| Sent badge ("Love" beside its emoji, on the sent print) | Atkinson Next | 34 | 700 | 1.2 |
| Reaction label (Love, Funny, Wow, Thankful) | Atkinson Next | 26 | 700 | 1.2 |
| Meta ("From", "This morning"), status line; Lily's quote is the same size in upright Fraunces 450 | Atkinson Next | 24 | 600 | 1.2 |
| Previous / Next label | Atkinson Next | 22 | 700 | 1.2 |

The smallest text on her screen is 22 px. Body and captions are 30 px.

### Family (390x844)

| Role | Family | Size px | Weight | Line height |
|---|---|---|---|---|
| Tab title ("Family", "Grandma's Feed", "Mine") | Fraunces | 30 | 600 | 1.1 |
| Day heading ("Today") / preset note | Fraunces | 20 | 600 | 1.2 |
| Name on a print | Fraunces | 19 | 600 | 1.15 |
| Caption | Fraunces | 18 | 400 | 1.4 |
| Body, subtitle | Atkinson Next | 17 | 400 | 1.4 |
| Reaction chip ("Love 10:42 am") | Atkinson Next | 16 | 700 | 1.2 |
| Button ("Share photos or a video") | Atkinson Next | 17 | 700 | 1.2 |
| Meta (time), "From Grandma" (Fraunces italic 16) | Atkinson Next | 15 | 600 | 1.35 |
| Pills and plates ("To you", "3 photos") | Atkinson Next | 14 | 700 | 1.2 |
| Tab label | Atkinson Next | 14 | 700 | 1.2 |

## States

- **Offline.** A card-coloured pill sits in the header between Home and the clock, with a crossed-out cloud in muted ink: "No internet right now. Your saved photos keep showing." No red, no icon badge, no counts. The slideshow carries on from saved photos, and "New for you" keeps what already arrived.
- **Night.** The layout is identical, so nothing moves under her finger. The palette switches to a warm dark brown. Mats go from white to `#3A2E24` so prints stop glowing. Photos get `brightness(.62) saturate(.85) sepia(.12)`. Corners and tape dim. The slideshow **stops** on one print (no timer runs). A pill with a gold moon says "Good evening. The slideshow rests until morning." The family voice card steps back to a deeper rust (`#4A200F`) with a softer mic disc, and the little play badge dims, so nothing on the right glows brighter than the print. Home is still top-left: on Home its ring turns a lighter sage and the word goes cream. The mock shows 9:30 pm instead of 10:42 am, because night mode at 10:42 am would read as a bug. In production a schedule (for example 8:30 pm to 7 am) sets the state, and the Pi can also lower the backlight from outside the page.
- **Presets.** The photo screen gives way to a full-screen grid of eight index cards (4x2, 289x168 each). A small print of the photo sits next to the title "Send Sarah a message", with a sage person mark and "It goes to **Sarah only**. One tap sends it." underneath, in full ink (not muted), with "Sarah only" in bold sage. The line says both who gets it and that there is no second step. "Back to the photo" is a 104 px sage-outlined button at the bottom left.
- **Sent.** A short confirmation on plain paper: the photo she answered, as a print with what she sent tucked on its corner (a pill with the emoji and its word, "Love", so the emoji never stands alone; or the index card she picked), a sage check with "Done", "Sent to Sarah", "She'll know you loved it." and one OK button. In production it returns to the photo by itself after about 5 seconds. OK is there for anyone who wants to tap.
- **Video.** The poster, with one 176 px terracotta play disc ringed in cream and a solid "Play video · 1 minute" plate. Nothing plays until she taps it. The real build would use `<video preload="none" poster>`, which never autoplays.

## Family PWA

- The same paper, ink and prints. Each post is a print with its byline and caption written on the mat. Mike's three photos share one mat laid out like a contact sheet (the fjord large, the balloons and the bench beside it), so the family sees all three without a carousel. Video posts get the same terracotta play disc.
- **Share photos or a video** is the first thing on Family and Mine: a full-width terracotta button, 60 px tall.
- **Grandma's Feed** shows what Grandma sent you and the whole family, newest first, grouped under Today, Yesterday and Sunday (5 entries: Love on Sarah's video, a voice message to the whole family, "Made my day" and Thankful on the bedtime photo, Wow on the petunias; the same reactions Mine shows on each post). Every entry has a small print of the photo it was about (for the voice message, the photo on her whole-family button, so the family recognises what she tapped), what she sent (a labelled emoji, an index-card preset, or a voice message with a waveform and play button) and a pill saying who it went to ("To you" in sage, "To everyone" in terracotta). A footnote states the privacy rule: you only see what she sent to you and to everyone, and her notes to others stay between them. This matches the presets screen's promise of "Sarah only".
- **Mine** shows the viewer's (Sarah's) uploads, each with a dashed rule and "From Grandma" chips: Love with its time, Thankful plus "Made my day", Wow.
- Bottom tab bar: three tabs, each 60 px tall, with an icon and a label. The active tab is terracotta with a tinted pill behind its icon.

## Risks

- **Small photo.** Mats, the note column and the reaction row take room, so the open photo is 624x416 on the 1280x800 screen, smaller than in a full-bleed direction. The trade-off is that the context (who, when, what to tap) is always on screen with no layers. A full-screen "just the photo" mode could come later.
- **Kitsch.** Photo corners, paper tape and index-card rules could slide into scrapbook. They are kept to the hero print and the notes, are drawn flat, and never sit over a face.
- **Long names and captions.** The note column is narrow (about 270 px): "Aunt Carol" already wraps to two lines, and a caption over about 110 characters would crowd the note. Uploads need a caption length limit, or a clamp at 4 lines with the rest on a tap.
- **Italic Fraunces** is kept off Grandma's screen entirely (Lily's quote on Home is upright now) and survives only in the phone's "From Grandma" label, where it is short and never something you tap.
- **Night brightness.** The family-voice card is still the most saturated thing on screen at night. It is dimmed to `#4A200F` with night-ink words; on the real panel it may want to go further, or show only its photo.
- **Pi 4 rendering.** The page uses layered box-shadows and a fixed SVG-noise paper (rasterised once), with no `backdrop-filter` and no blur. The crossfade runs for 1.6 s every 40 s. It should be smooth, but needs a check on the real kiosk.
- **Fonts are latin-subset only** (U+0000 to 00FF plus punctuation). Names outside Latin-1 (Polish, Vietnamese and so on) would fall back to Georgia or the system sans. Add the latin-ext files if the family needs them.
- **The Home "you're here" state** is a sage outline on cream rather than a filled button. It reads as current, but someone might wonder whether it is pressable. That is harmless, because tapping it does nothing.
