#!/usr/bin/env python3
"""Prepare full-bleed store images from owner-supplied screenshots.

Requires Pillow in the caller's Python environment. This is an artwork helper,
not an extension runtime dependency. Originals remain available for inspection.
"""

import argparse
from pathlib import Path

from PIL import Image, ImageOps


NAMES = (
    "01-grouping-engines.png",
    "02-provider-usage.png",
    "03-behaviour.png",
    "04-rules-and-memory.png",
    "05-on-device-memory.png",
)
SIZE = (1280, 800)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("captures", type=Path, nargs=5,
                        help="engine chooser, usage, behaviour, rules, Nano memory")
    parser.add_argument("--output-dir", type=Path,
                        default=Path("store-assets/screenshots"))
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for source, name in zip(args.captures, NAMES):
        with Image.open(source) as image:
            # Full bleed, proportional resampling; show the start of each screen.
            image = ImageOps.exif_transpose(image).convert("RGB")
            image = ImageOps.fit(image, SIZE, method=Image.Resampling.LANCZOS,
                                 centering=(0.5, 0.0))
            destination = args.output_dir / name
            image.save(destination, optimize=True)
        with Image.open(destination) as saved:
            assert saved.size == SIZE and saved.mode == "RGB"
            saved.verify()
        print(f"Created {destination} (1280x800 RGB)")


if __name__ == "__main__":
    main()
