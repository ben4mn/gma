# Tailscale on Grandma's frame

Tailscale is how Ben reaches the frame from home: SSH, the remote scripts in `pi/remote/`, and updates. The frame only ever accepts connections from Ben's devices. It never needs to start a connection to them.

## 1. Prepare the tailnet (once, in the admin console)

1. **Tag owner.** In the access controls file, let admins own `tag:gma-kiosk` (see the policy below).
2. **Auth key.** Settings → Keys → *Generate auth key*:
   - Reusable: **off** (one frame, one key)
   - Ephemeral: **off** (the frame must keep its identity across reboots)
   - Pre-approved: **on** (if device approval is on)
   - Tags: **`tag:gma-kiosk`**
   - Expiry: the shortest that covers setup day (the key is only used to join).

   Tagged devices have **node key expiry turned off automatically**, so the frame never drops off the tailnet after 180 days. Check it in Machines → the frame → "Key expiry: disabled".

## 2. Policy: let Ben in, with no re-auth prompts

Tailscale SSH's default rule is `check` mode (a browser re-auth every 12 h) and covers only your own untagged devices (`autogroup:self`). A tagged frame needs an explicit **`accept`** rule, or a remote fix stalls on a login page.

Merge this into the tailnet policy file (replace `ben@example.com` with Ben's Tailscale login):

```jsonc
{
  "tagOwners": {
    "tag:gma-kiosk": ["autogroup:admin"],
  },

  // Network access: Ben may reach the frame's SSH port. Nothing is granted
  // FROM the frame, so it cannot reach any other device on the tailnet.
  "acls": [
    { "action": "accept", "src": ["ben@example.com"], "dst": ["tag:gma-kiosk:22"] },
    // ...your existing rules...
  ],

  // Tailscale SSH: accept (no periodic re-auth) as the admin user only.
  "ssh": [
    {
      "action": "accept",
      "src":    ["ben@example.com"],
      "dst":    ["tag:gma-kiosk"],
      "users":  ["kiosk-admin"],
    },
    // ...your existing SSH rules (for example the default autogroup:self check rule)...
  ],
}
```

If the policy file still has the default "allow everything" rule, the `acls` entry above is redundant but harmless. If the tailnet uses `grants` instead of `acls`, the equivalent is `{ "src": ["ben@example.com"], "dst": ["tag:gma-kiosk"], "ip": ["22"] }`.

## 3. Install and join (on the Pi, over the LAN or a keyboard)

```bash
# Tailscale's apt repository for Debian 13 (trixie)
curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
  | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
  | sudo tee /etc/apt/sources.list.d/tailscale.list
sudo apt-get update && sudo apt-get install -y tailscale

# Join. Put the key in a root-only file so it never lands in shell history.
sudo install -m 0600 /dev/null /root/ts-key
sudo nano /root/ts-key            # paste the tskey-auth-... key, save
sudo tailscale up \
  --auth-key=file:/root/ts-key \
  --advertise-tags=tag:gma-kiosk \
  --hostname=gma-frame \
  --ssh \
  --accept-dns=false
sudo rm -f /root/ts-key

# Keep Tailscale itself up to date and SSH on.
sudo tailscale set --ssh --auto-update
```

Why `--accept-dns=false`: the frame does not need MagicDNS (Ben's machine looks up the frame, not the other way round), and leaving the Pi's own DNS alone means a Tailscale hiccup can never stop it resolving `gma.4mn.org`.

Keep `/var/lib/tailscale` on normal storage (no overlay filesystem), or the frame comes back as a new machine after every reboot.

## 4. Check from Ben's machine

```bash
tailscale status | grep gma-frame
ssh kiosk-admin@gma-frame 'hostname; uptime'
pi/remote/status.sh gma-frame
```

## Notes

- **Two ways in.** Tailscale SSH answers on the frame's tailnet address. OpenSSH (key only, from `user-data`) still answers on Grandma's LAN, which is handy on setup day and if Tailscale ever breaks while you are in the house.
- **Updates.** `tailscale set --auto-update` updates Tailscale on its own. Everything else waits for Ben (`sudo gma-update`, see the README).
- **Replacing the card.** A re-flashed card is a new machine: generate a new auth key, join again, and remove the old `gma-frame` in the admin console.
- **Raspberry Pi Connect** (`rpi-connect-lite`, off by default) is a possible second way in, but Tailscale covers it. Leave it off unless you want it.
