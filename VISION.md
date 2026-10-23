# gma.4mn.org: Vision

A private family window for Grandma. Around 40 relatives send photos, videos and messages in. Grandma sees one calm stream on a touchscreen with nothing to manage, and can answer back with a tap or her voice.

## Principles

- Grandma never manages anything. No settings, no menus, no logins on her device.
- Every screen is one tap from home. A big Home button is always visible.
- Nothing autoplays. Videos and audio play only when she taps.
- Big targets, big text. Few choices per screen; four reactions, not ten.
- It just keeps working. Recovers on its own after a power cut or Wi-Fi drop. Ben manages it remotely.
- Private by default. Invite-only family; nothing is public.

## Two surfaces

| | Family PWA | Grandma's Pi |
|---|---|---|
| Who | ~40 kids, grandkids, great-grandkids | Grandma |
| Hardware | Their phones (installed to home screen) | Raspberry Pi 4, 10" touchscreen, mic array |
| Sign-in | Invite link, then magic link by email. No passwords | None. Device is paired once by Ben |
| Main job | Send photos/videos, see the family feed, hear Grandma | See what the family sends, react, send messages |

## Family PWA

### Sending

- Upload a photo or video, with an optional caption or voice note.
- Sent to Grandma's device and to the shared family feed.

### Three tabs

| Tab | What it shows |
|---|---|
| Family | Everyone's uploads, newest first |
| Grandma's Feed | Grandma's reactions, preset messages and voice notes in time order. Each item shows which photo it was about and who it went to |
| Mine | What you uploaded, with Grandma's reactions on each |

### Notifications (web push)

- When Grandma reacts or sends a preset message about your photo, you get a push.
- When Grandma sends a voice note, everyone gets a push.
- iPhone users must add the PWA to their home screen for push to work, so install is part of onboarding.

## Grandma's Pi

### Home (default): photo frame

- Ambient slideshow of the newest photos.
- New items appear as big cards, like "Video from Sarah". Tap to open; video plays only on tap.

### On a photo or video

- Four large reactions: ❤️ 😂 😮 🙏
- A "Send a message" button with 6 to 8 big presets: "Love you", "Call me", "Thank you", "Miss you all", and so on.
- Reactions and presets go only to the person who sent that photo, and also appear in Grandma's Feed.

### Voice notes

- From Home, one big "Message to the whole family" button, shown with a family photo behind it.
- Tap the big red button to record, tap again to stop. She hears it back, then taps "Send to everyone".
- Capped at about a minute so a forgotten tap stops on its own.
- Voice notes always go to the whole family. The screen makes that clear.

## Who gets what

| Grandma does | Push goes to | Shows in Grandma's Feed |
|---|---|---|
| Reacts to a photo | The person who sent it | Yes |
| Sends a preset message from a photo | The person who sent it | Yes |
| Records a voice note | Everyone | Yes |

## Open questions

- Hosting: which part runs on the homelab and how media is stored and backed up.
- Pi software: kiosk browser running the PWA vs a native app; how it updates.
- Admin: how Ben invites people, removes them, and moderates uploads.
- Preset messages: final list, and whether family can suggest new ones.
- Video size limits and transcoding for phones and the Pi.
- What the Pi shows when it's offline.
- Night mode: dim the screen or pause the slideshow at night.
