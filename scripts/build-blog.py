"""Build web/blog.html from docs/blog.md in the landing page's style.

Run: python3 scripts/build-blog.py
"""
import html
import math
import re
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
RAW = "https://raw.githubusercontent.com/not-a-vibe-coder/Tide/main/"

src = (ROOT / "docs/blog.md").read_text()
title = re.search(r"^# (.+)$", src, re.M).group(1)
body_md = src.split("\n---\n", 1)[1]  # the hero above the first rule is drawn by the template
body_md = body_md.replace(RAW + "docs/img/", "/assets/blog/").replace(RAW + "web/assets/", "/assets/")
words = len(re.findall(r"\w+", body_md))
minutes = max(1, math.ceil(words / 230))

body = markdown.markdown(body_md, extensions=["tables", "fenced_code", "sane_lists"])
# Images become figures with lazy loading; the alt text doubles as a small caption.
body = re.sub(
    r'<p><img alt="([^"]*)" src="([^"]+)" ?/?></p>',
    lambda m: f'<figure><img src="{m.group(2)}" alt="{html.escape(m.group(1))}" loading="lazy"></figure>',
    body,
)
body = re.sub(r'<img alt="([^"]*)" src="([^"]+)" ?/?>', r'<img src="\2" alt="\1" loading="lazy">', body)
body = body.replace("<table>", '<div class="tw"><table>').replace("</table>", "</table></div>")
body = re.sub(r'<a href="(https?://[^"]+)"', r'<a href="\1" target="_blank" rel="noopener"', body)

page = (ROOT / "scripts/blog-template.html").read_text()
page = page.replace("{{TITLE}}", html.escape(title)).replace("{{MINUTES}}", str(minutes)).replace("{{BODY}}", body)
(ROOT / "web/blog.html").write_text(page)
print(f"web/blog.html: {words} words, {minutes} min read")
