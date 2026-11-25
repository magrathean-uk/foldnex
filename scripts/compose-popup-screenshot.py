#!/usr/bin/env python3
"""Place two popup captures side by side on a 2560x1600 store canvas.

Requires Pillow in the caller's Python environment. Artwork helper only: the
captures are pasted unscaled at their device-scale-2 size inside a plain frame,
with no edits to their content.
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = (2560, 1600)
CANVAS = (230, 233, 238)
BORDER = (207, 212, 219)
RADIUS = 28
GAP = 160


def framed(image):
    """The capture with rounded corners, a hairline border and a soft shadow, on a transparent layer."""
    w, h = image.size
    pad = 60
    layer = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    shadow = Image.new("L", layer.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + 12, pad + w, pad + h + 12), RADIUS, fill=70)
    layer.putalpha(shadow.filter(ImageFilter.GaussianBlur(24)))
    layer = Image.composite(Image.new("RGBA", layer.size, (20, 24, 31, 255)), Image.new("RGBA", layer.size, (0, 0, 0, 0)), layer.getchannel("A"))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), RADIUS, fill=255)
    layer.paste(image.convert("RGBA"), (pad, pad), mask)
    ImageDraw.Draw(layer).rounded_rectangle((pad, pad, pad + w - 1, pad + h - 1), RADIUS, outline=BORDER, width=2)
    return layer, pad


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("left", type=Path, help="popup capture shown on the left")
    parser.add_argument("right", type=Path, help="popup capture shown on the right")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    canvas = Image.new("RGBA", SIZE, CANVAS + (255,))
    shots = [Image.open(path) for path in (args.left, args.right)]
    max_h = SIZE[1] - 160
    shots = [shot if shot.height <= max_h else shot.crop((0, 0, shot.width, max_h)) for shot in shots]
    total = sum(shot.width for shot in shots) + GAP
    x = (SIZE[0] - total) // 2
    top = (SIZE[1] - max(shot.height for shot in shots)) // 2
    for shot in shots:
        layer, pad = framed(shot)
        canvas.alpha_composite(layer, (x - pad, top - pad))
        x += shot.width + GAP
    args.output.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(args.output, optimize=True)
    print(f"Created {args.output} ({SIZE[0]}x{SIZE[1]} RGB)")


if __name__ == "__main__":
    main()
