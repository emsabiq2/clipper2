import argparse
import os
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


CANVAS_W = 1080
CANVAS_H = 1920
GOLD = (255, 190, 18)
DEEP_GOLD = (238, 130, 0)
WHITE = (248, 248, 244)
BLACK = (3, 3, 3)


def clean_text(value, fallback=""):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"[`*_#]+", "", text)
    return text or fallback


def normalize_brand(value):
    text = clean_text(value, "@clipperemsapro | Podcast Highlight")
    return re.sub(r"@emsa\.pro\b", "@clipperemsapro", text, flags=re.IGNORECASE)


def clean_title(value):
    text = clean_text(value, "BAGIAN INI BIKIN PENONTON BERHENTI SCROLL").upper()
    words = text.split()
    return " ".join(words[:16]) or "BAGIAN INI BIKIN PENONTON BERHENTI SCROLL"


def clean_quote(value):
    text = clean_text(value, "GUE BARU SADAR SETELAH KEHILANGAN")
    text = text.strip(" \"'.,")
    words = text.split()
    return " ".join(words[:11]).upper() or "GUE BARU SADAR SETELAH KEHILANGAN"


def font_candidates():
    env_font = os.environ.get("THUMBNAIL_FONT_FILE") or os.environ.get("VIDEO_LOWER_THIRD_FONT_FILE")
    candidates = [
        env_font,
        r"C:\Windows\Fonts\impact.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf",
        str(Path.home() / ".local/share/fonts/selawik/Selawik-Bold.ttf"),
        str(Path.home() / ".local/share/fonts/selawik/SelawikSemibold.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    return [item for item in candidates if item]


def load_font(size):
    for item in font_candidates():
        try:
            path = Path(item)
            if path.exists():
                return ImageFont.truetype(str(path), size=size)
        except Exception:
            pass
    return ImageFont.load_default(size=size)


def text_size(draw, text, font, stroke_width=0):
    box = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    return box[2] - box[0], box[3] - box[1]


def split_title(title):
    words = title.split()
    if len(words) <= 2:
        return [title]
    best = None
    for index in range(1, len(words)):
        left = " ".join(words[:index])
        right = " ".join(words[index:])
        score = abs(len(left) - len(right)) + (0 if 9 <= len(left) <= 18 else 4)
        if best is None or score < best[0]:
            best = (score, left, right)
    return [best[1], best[2]]


def split_word_to_fit(draw, word, font, max_width):
    if text_size(draw, word, font, 2)[0] <= max_width:
        return [word]
    chunks = []
    current = ""
    for char in word:
        candidate = f"{current}{char}"
        if current and text_size(draw, candidate, font, 2)[0] > max_width:
            chunks.append(current)
            current = char
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks or [word]


def ellipsize_to_width(draw, value, font, max_width):
    text = str(value or "").strip()
    if text_size(draw, text, font, 2)[0] <= max_width:
        return text
    suffix = "..."
    while text and text_size(draw, f"{text}{suffix}", font, 2)[0] > max_width:
        text = text[:-1].rstrip()
    return f"{text}{suffix}" if text else suffix


def wrap_text(draw, text, font, max_width, max_lines=2):
    words = []
    for word in text.split():
        words.extend(split_word_to_fit(draw, word, font, max_width))
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and text_size(draw, candidate, font, 2)[0] > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    if len(lines) <= max_lines:
        return lines
    kept = lines[:max_lines]
    overflow = " ".join(lines[max_lines - 1:])
    kept[-1] = ellipsize_to_width(draw, overflow, font, max_width)
    return kept


def fit_title_layout(draw, title, rect, max_width, max_size=92, min_size=34):
    max_height = (rect[3] - rect[1]) - 70
    for max_lines in (4, 3):
        size = max_size
        while size >= min_size:
            font = load_font(size)
            lines = wrap_text(draw, title, font, max_width, max_lines=max_lines)
            line_gap = max(8, int(size * 0.14))
            heights = [text_size(draw, line, font, 4)[1] for line in lines]
            total_h = sum(heights) + line_gap * (len(lines) - 1)
            width_ok = all(text_size(draw, line, font, 4)[0] <= max_width for line in lines)
            if width_ok and total_h <= max_height:
                return lines, font, size, line_gap, heights, total_h
            size -= 2

    font = load_font(min_size)
    lines = wrap_text(draw, title, font, max_width, max_lines=4)
    lines = [ellipsize_to_width(draw, line, font, max_width) for line in lines]
    line_gap = 8
    heights = [text_size(draw, line, font, 4)[1] for line in lines]
    total_h = sum(heights) + line_gap * (len(lines) - 1)
    return lines, font, min_size, line_gap, heights, total_h


def add_glow(base, rect, radius, color=GOLD, strength=150):
    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for offset, alpha in [(16, 20), (10, 34), (5, 58)]:
        expanded = (rect[0] - offset, rect[1] - offset, rect[2] + offset, rect[3] + offset)
        gd.rounded_rectangle(expanded, radius=radius + offset, outline=(*color, min(strength, alpha)), width=4)
    glow = glow.filter(ImageFilter.GaussianBlur(9))
    base.alpha_composite(glow)


def draw_panel(draw, rect, radius, fill_alpha=232):
    draw.rounded_rectangle(rect, radius=radius, fill=(*BLACK, fill_alpha), outline=(*GOLD, 245), width=4)
    inset = 16
    inner = (rect[0] + inset, rect[1] + inset, rect[2] - inset, rect[3] - inset)
    draw.rounded_rectangle(inner, radius=max(8, radius - inset), outline=(*GOLD, 130), width=2)


def draw_transparent_panel(draw, rect, radius, fill_alpha=142):
    draw.rounded_rectangle(rect, radius=radius, fill=(*BLACK, fill_alpha), outline=(*GOLD, 225), width=4)
    inset = 16
    inner = (rect[0] + inset, rect[1] + inset, rect[2] - inset, rect[3] - inset)
    draw.rounded_rectangle(inner, radius=max(8, radius - inset), outline=(255, 255, 255, 90), width=2)


def draw_highlight(base, rect):
    shine = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shine)
    cx = (rect[0] + rect[2]) // 2
    sd.rounded_rectangle((cx - 180, rect[1] - 5, cx + 180, rect[1] + 6), radius=6, fill=(255, 220, 120, 150))
    sd.rounded_rectangle((cx - 190, rect[3] - 5, cx + 190, rect[3] + 6), radius=6, fill=(255, 184, 31, 110))
    base.alpha_composite(shine.filter(ImageFilter.GaussianBlur(5)))


def add_vignette(image):
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    px = overlay.load()
    cx, cy = image.size[0] / 2, image.size[1] / 2
    max_dist = (cx * cx + cy * cy) ** 0.5
    for y in range(0, image.size[1], 2):
        for x in range(0, image.size[0], 2):
            dist = (((x - cx) ** 2 + (y - cy) ** 2) ** 0.5) / max_dist
            alpha = int(max(0, min(120, (dist - 0.35) * 190)))
            if alpha:
                px[x, y] = (0, 0, 0, alpha)
                if x + 1 < image.size[0]:
                    px[x + 1, y] = (0, 0, 0, alpha)
                if y + 1 < image.size[1]:
                    px[x, y + 1] = (0, 0, 0, alpha)
                if x + 1 < image.size[0] and y + 1 < image.size[1]:
                    px[x + 1, y + 1] = (0, 0, 0, alpha)
    image.alpha_composite(overlay)


def save_jpeg_under_limit(image, output):
    rgb = image.convert("RGB")
    quality = 94
    while quality >= 80:
        rgb.save(output, "JPEG", quality=quality, optimize=True, progressive=True)
        if Path(output).stat().st_size <= 1_950_000:
            return
        quality -= 4
    rgb.save(output, "JPEG", quality=78, optimize=True, progressive=True)


def render_thumbnail(args):
    title = clean_title(args.title)
    base = Image.open(args.input).convert("RGB").resize((CANVAS_W, CANVAS_H), Image.Resampling.LANCZOS)
    base = ImageEnhance.Contrast(base).enhance(1.08)
    base = ImageEnhance.Color(base).enhance(1.10)
    canvas = base.convert("RGBA")
    add_vignette(canvas)
    draw = ImageDraw.Draw(canvas)

    rect = (130, 880, 950, 1174)
    add_glow(canvas, rect, 42, GOLD, 135)
    draw_transparent_panel(draw, rect, 42, 142)
    draw_highlight(canvas, rect)

    max_text_width = (rect[2] - rect[0]) - 118
    lines, font, size, line_gap, heights, total_h = fit_title_layout(draw, title, rect, max_text_width)
    y = rect[1] + (rect[3] - rect[1] - total_h) // 2 - 4
    for index, line in enumerate(lines):
        color = WHITE if index == 0 else GOLD
        width, height = text_size(draw, line, font, 4)
        draw.text(
            (max(rect[0] + 54, min((CANVAS_W - width) / 2, rect[2] - 54 - width)), y),
            line,
            font=font,
            fill=color,
            stroke_width=5,
            stroke_fill=(0, 0, 0, 235),
        )
        y += height + line_gap

    pill = clean_text(args.pill or os.environ.get("THUMBNAIL_PILL_TEXT"), "Podcast | Highlight | Viral")
    pill_font = load_font(29)
    pill_w, pill_h = text_size(draw, pill, pill_font, 1)
    pill_rect = (150, 1202, min(930, 150 + pill_w + 42), 1256)
    draw.rounded_rectangle(pill_rect, radius=13, outline=(255, 255, 255, 120), width=2)
    draw.text((pill_rect[0] + 21, pill_rect[1] + 10), pill, font=pill_font, fill=(245, 245, 245), stroke_width=2, stroke_fill=(0, 0, 0, 210))

    save_jpeg_under_limit(canvas, args.output)


def render_lower_third(args):
    quote = clean_quote(args.quote)
    brand = normalize_brand(args.brand or os.environ.get("VIDEO_LOWER_THIRD_BRAND"))
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    rect = (116, 1564, 964, 1742)
    add_glow(canvas, rect, 26, GOLD, 120)
    draw.rounded_rectangle(rect, radius=26, fill=(0, 0, 0, 150), outline=(*GOLD, 180), width=2)
    draw.rounded_rectangle((rect[0] + 14, rect[1] + 14, rect[2] - 14, rect[3] - 14), radius=18, outline=(255, 255, 255, 45), width=1)

    max_width = rect[2] - rect[0] - 90
    quote_size = 43
    font = load_font(quote_size)
    lines = wrap_text(draw, f"\"{quote}\"", font, max_width, 2)
    while len(lines) > 1 and text_size(draw, lines[0], font, 2)[0] > max_width:
        quote_size = max(32, quote_size - 2)
        font = load_font(quote_size)
        lines = wrap_text(draw, f"\"{quote}\"", font, max_width, 2)
    line_h = font.size + 8
    y = rect[1] + 32
    for line in lines:
        width, _ = text_size(draw, line, font, 2)
        draw.text(((CANVAS_W - width) / 2, y), line, font=font, fill=WHITE, stroke_width=2, stroke_fill=(0, 0, 0, 210))
        y += line_h

    brand_font = load_font(27)
    brand_w, _ = text_size(draw, brand, brand_font, 1)
    draw.text(((CANVAS_W - brand_w) / 2, rect[3] - 45), brand, font=brand_font, fill=(215, 183, 122, 220), stroke_width=1, stroke_fill=(0, 0, 0, 190))
    draw.rounded_rectangle((180, rect[3] - 9, 900, rect[3] - 3), radius=4, fill=(255, 190, 18, 160))
    canvas.save(args.output, "PNG")


def main(argv):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    thumb = sub.add_parser("thumbnail")
    thumb.add_argument("--input", required=True)
    thumb.add_argument("--output", required=True)
    thumb.add_argument("--title", required=True)
    thumb.add_argument("--pill", default="")

    lower = sub.add_parser("lower-third")
    lower.add_argument("--output", required=True)
    lower.add_argument("--quote", required=True)
    lower.add_argument("--brand", default="")

    args = parser.parse_args(argv)
    if args.command == "thumbnail":
        render_thumbnail(args)
    elif args.command == "lower-third":
        render_lower_third(args)


if __name__ == "__main__":
    main(sys.argv[1:])
