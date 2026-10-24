"""Make one contact sheet per direction: design/<direction>/shots/sheet.png

    /Users/edsmac/edward/backend/.venv/bin/python -I design/tools/sheet.py heirloom front-porch lantern

Run shoot.py first. Grandma screens on top, the family phone screens below.
"""
import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
GRANDMA = ["home", "photo", "photo-presets", "photo-sent", "photo-video", "home-offline", "home-night"]
FAMILY = ["family", "family-grandma", "family-mine"]


def page_html(direction: str, title: str) -> str:
    shots = ROOT / direction / "shots"
    g = "".join(
        f'<figure><img src="{(shots / f"{n}.png").as_uri()}"><figcaption>{n}</figcaption></figure>'
        for n in GRANDMA if (shots / f"{n}.png").exists()
    )
    f = "".join(
        f'<figure class="ph"><img src="{(shots / f"{n}.png").as_uri()}"><figcaption>{n}</figcaption></figure>'
        for n in FAMILY if (shots / f"{n}.png").exists()
    )
    return f"""<!doctype html><html><head><style>
    body{{margin:0;padding:32px;background:#1b1b1d;color:#eee;font:20px -apple-system,Helvetica,sans-serif;width:2496px}}
    h1{{margin:0 0 20px;font-size:40px}}
    .g{{display:grid;grid-template-columns:repeat(3,800px);gap:24px}}
    .f{{display:grid;grid-template-columns:repeat(3,300px);gap:24px;margin-top:24px}}
    figure{{margin:0}} img{{width:100%;display:block;border-radius:6px;box-shadow:0 2px 12px #0008}}
    figcaption{{margin-top:6px;color:#aaa;font-size:18px}}
    .row{{display:flex;gap:24px;align-items:flex-start}}
    </style></head><body><h1>{title}</h1><div class="g">{g}</div><div class="f">{f}</div></body></html>"""


async def main(dirs: list[str]) -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 2560, "height": 1000})
        for d in dirs:
            html = ROOT / d / "shots" / "_sheet.html"
            html.write_text(page_html(d, d.replace("-", " ").title()))
            await page.goto(html.as_uri())
            await page.wait_for_load_state("networkidle")
            out = ROOT / d / "shots" / "sheet.png"
            await page.screenshot(path=str(out), full_page=True)
            html.unlink()
            print(out)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:] or ["heirloom", "front-porch", "lantern"]))
