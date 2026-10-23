"""Screenshot and audit one design direction's mocks.

    /Users/edsmac/edward/backend/.venv/bin/python -I design/tools/shoot.py <direction> [--only home]

Writes design/<direction>/shots/*.png and design/<direction>/shots/audit.json,
prints a summary. Uses Playwright's bundled headless shell only (never Google
Chrome). Checks, per page and state:

  grandma pages (1280x800): no scrolling; every button/link/[role=button]/[data-tap]
  >= 80x80 px; a visible [data-home] >= 80 px; text >= 20 px; text contrast >= 7:1
  (>= 4.5:1 for large text: >= 24 px, or >= 18.66 px bold); no autoplay media;
  photo default state has exactly 4 [data-reaction].
  family pages (390x844): targets >= 44x44; text >= 13 px; contrast >= 4.5:1 (3:1 large).
  every page: no request leaves file:// (fonts and images are self-hosted).

Text sitting on a photo or gradient can't be measured from CSS; it is listed
under "over_image" for a human (or a critic agent) to judge from the screenshot.
"""
import asyncio
import json
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent  # design/

PAGES = [
    # (shot name, file?query, surface)
    ("home", "home.html", "grandma"),
    ("home-offline", "home.html?state=offline", "grandma"),
    ("home-night", "home.html?state=night", "grandma"),
    ("photo", "photo.html", "grandma"),
    ("photo-presets", "photo.html?state=presets", "grandma"),
    ("photo-sent", "photo.html?state=sent", "grandma"),
    ("photo-video", "photo.html?state=video", "grandma"),
    ("family", "family.html", "family"),
    ("family-grandma", "family.html?tab=grandma", "family"),
    ("family-mine", "family.html?tab=mine", "family"),
]

VIEWPORT = {"grandma": {"width": 1280, "height": 800}, "family": {"width": 390, "height": 844}}

AUDIT_JS = r"""
(surface) => {
  const G = surface === 'grandma';
  const MIN_TAP = G ? 80 : 44, MIN_FONT = G ? 20 : 13;
  const NORMAL = G ? 7 : 4.5, LARGE = G ? 4.5 : 3;
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top, bot) => { const a = top[3]; return [0,1,2].map(i => top[i]*a + bot[i]*(1-a)).concat([1]); };
  const lum = (c) => { const f = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); };
  const visible = (el) => {
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false; }
    return true;
  };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.tagName).trim().replace(/\s+/g,' ').slice(0, 50);
  const issues = [], overImage = [];
  // scrolling
  const se = document.scrollingElement;
  if (G && (se.scrollHeight > innerHeight + 1 || se.scrollWidth > innerWidth + 1))
    issues.push({ kind: 'scroll', msg: `page scrolls: ${se.scrollWidth}x${se.scrollHeight} > viewport` });
  // tap targets
  const taps = [...document.querySelectorAll('button, a[href], [role=button], [data-tap], input, select, textarea')].filter(visible);
  for (const el of taps) { const r = el.getBoundingClientRect();
    if (r.width < MIN_TAP - 0.5 || r.height < MIN_TAP - 0.5)
      issues.push({ kind: 'tap', msg: `"${label(el)}" is ${Math.round(r.width)}x${Math.round(r.height)} (< ${MIN_TAP})` }); }
  // home button
  if (G) { const h = [...document.querySelectorAll('[data-home]')].filter(visible);
    if (!h.length) issues.push({ kind: 'home', msg: 'no visible [data-home] button' });
    for (const el of h) { const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 80) issues.push({ kind: 'home', msg: `home button ${Math.round(r.width)}x${Math.round(r.height)}` }); } }
  // autoplay
  for (const m of document.querySelectorAll('video, audio'))
    if (m.autoplay || m.hasAttribute('autoplay')) issues.push({ kind: 'autoplay', msg: `${m.tagName} has autoplay` });
  // text: size + contrast
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set(); let n; let measured = 0;
  while ((n = tw.nextNode())) {
    if (!n.nodeValue.trim()) continue; const el = n.parentElement;
    if (!el || seen.has(el) || !visible(el)) continue; seen.add(el);
    if (el.closest('[aria-hidden=true]') && !el.closest('[data-audit]')) { /* decorative */ }
    const s = getComputedStyle(el); const fs = parseFloat(s.fontSize); const bold = parseInt(s.fontWeight) >= 700;
    const txt = n.nodeValue.trim().slice(0, 40);
    if (fs < MIN_FONT - 0.1) issues.push({ kind: 'font', msg: `"${txt}" is ${fs}px (< ${MIN_FONT})` });
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width/2, 0), innerWidth-1), y = Math.min(Math.max(r.top + r.height/2, 0), innerHeight-1);
    const stack = document.elementsFromPoint(x, y);
    let layers = [], img = null;
    for (const e of stack) { const es = getComputedStyle(e);
      if (['IMG','VIDEO','CANVAS','PICTURE','IFRAME'].includes(e.tagName)) { img = e.tagName.toLowerCase(); break; }
      if (es.backgroundImage && es.backgroundImage !== 'none') { img = es.backgroundImage.startsWith('url') ? 'background-image' : 'gradient'; break; }
      const bg = rgba(es.backgroundColor); if (bg[3] > 0) { layers.push(bg); if (bg[3] >= 0.999) break; } }
    const fg = rgba(s.color); const large = fs >= 24 || (bold && fs >= 18.66); const need = large ? LARGE : NORMAL;
    if (img) { overImage.push({ text: txt, size: fs, over: img, scrimLayers: layers.length, shadow: s.textShadow !== 'none' }); continue; }
    let bg = [255,255,255,1]; for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    const c = ratio(over(fg, bg), bg); measured++;
    if (c < need) issues.push({ kind: 'contrast', msg: `"${txt}" ${c.toFixed(2)}:1 (< ${need}) fg ${s.color} on ${bg.slice(0,3).join(',')}` });
  }
  return { issues, overImage, measured, taps: taps.length };
}
"""

POSTCHECK_JS = r"""
() => ({ reactions: document.querySelectorAll('[data-reaction]').length,
         state: document.documentElement.dataset.state || null })
"""


async def run(direction: str, only: str | None) -> int:
    ddir = ROOT / direction
    if not ddir.is_dir():
        print(f"no such direction: {ddir}")
        return 2
    shots = ddir / "shots"
    shots.mkdir(exist_ok=True)
    results = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch()  # Playwright's headless shell
        for name, rel, surface in PAGES:
            if only and not name.startswith(only):
                continue
            file = ddir / rel.split("?")[0]
            if not file.exists():
                results[name] = {"issues": [{"kind": "missing", "msg": f"{rel.split('?')[0]} not found"}]}
                continue
            ctx = await browser.new_context(viewport=VIEWPORT[surface], device_scale_factor=1, reduced_motion="reduce")
            page = await ctx.new_page()
            external, errors = [], []
            page.on("request", lambda r: external.append(r.url) if not r.url.startswith(("file:", "data:", "blob:")) else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            url = file.as_uri() + ("?" + rel.split("?", 1)[1] if "?" in rel else "")
            await page.goto(url)
            await page.wait_for_load_state("networkidle")
            await page.evaluate("document.fonts.ready.then(() => true)")
            await page.wait_for_timeout(400)
            await page.screenshot(path=str(shots / f"{name}.png"))
            audit = await page.evaluate(AUDIT_JS, surface)
            post = await page.evaluate(POSTCHECK_JS)
            if name == "photo" and post["reactions"] != 4:
                audit["issues"].append({"kind": "reactions", "msg": f"{post['reactions']} [data-reaction] (want 4)"})
            for u in sorted(set(external)):
                audit["issues"].append({"kind": "external", "msg": f"request leaves file://: {u[:100]}"})
            for e in errors[:5]:
                audit["issues"].append({"kind": "js", "msg": e[:160]})
            results[name] = audit
            await ctx.close()
        await browser.close()
    (shots / "audit.json").write_text(json.dumps(results, indent=2))
    total = 0
    for name, r in results.items():
        iss = r.get("issues", [])
        total += len(iss)
        oi = r.get("overImage", [])
        print(f"{'PASS' if not iss else 'FAIL'} {name}: {len(iss)} issues, {r.get('measured', 0)} text checked, {len(oi)} over image/gradient")
        for i in iss[:12]:
            print(f"    [{i['kind']}] {i['msg']}")
        if len(iss) > 12:
            print(f"    ... {len(iss) - 12} more in shots/audit.json")
    print(f"\n{direction}: {'ALL PASS' if total == 0 else f'{total} issues'} -> {shots}")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    only = None
    if "--only" in args:
        i = args.index("--only")
        only = args[i + 1]
        del args[i:i + 2]
    if not args:
        print(__doc__)
        sys.exit(2)
    sys.exit(asyncio.run(run(args[0], only)))
