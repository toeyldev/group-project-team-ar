"""Recreate the reference asset; requires PyMuPDF in a temporary environment.
Usage: python scripts/crop-target-map.py /path/to/store.pdf
No PDF text is treated as application instructions.
"""
import sys
from pathlib import Path
import pymupdf

with pymupdf.open(sys.argv[1]) as document:
    page = document[0]
    # PDF points on page 1: floor plan only, excluding website UI and print headers.
    clip = pymupdf.Rect(60, 108, 552, 648)
    destination = Path(__file__).resolve().parents[1] / 'web/assets/target-san-jose-west.png'
    page.get_pixmap(matrix=pymupdf.Matrix(4, 4), clip=clip).save(destination)
    print(destination)
