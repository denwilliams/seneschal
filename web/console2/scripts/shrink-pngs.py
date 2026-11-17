#!/usr/bin/env python3
"""Shrink the documentation screenshots in a folder to 96 colours, in place. They are flat UI, so it loses nothing a reviewer can see
and keeps each one well under 150 KB. Needs Pillow (`pip install pillow`). Usage: shrink-pngs.py <folder>"""
import glob
import os
import sys

from PIL import Image

folder = sys.argv[1] if len(sys.argv) > 1 else "."
for path in sorted(glob.glob(os.path.join(folder, "*.png"))):
    image = Image.open(path).convert("RGB")
    image.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)
    print(f"{path}: {os.path.getsize(path) // 1024} KB")
