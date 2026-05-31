#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "openai>=1.50.0",
#     "python-dotenv>=1.0.0",
# ]
# ///
"""
Generate a spec section image using OpenAI's gpt-image-2 (ChatGPT Images 2.0).

This is a self-contained generator bundled with the `htmlspec` skill. It is a
trimmed copy of a general image-gen script: gpt-image-2 only, defaulting to
high quality and a wide 2048x1152 frame, which is what spec diagrams want.

Usage:
    generate_image.py "prompt" output.png [options]

Examples:
    generate_image.py "Architecture diagram ..." specs/cache/01-architecture.png
    generate_image.py "Hero overview ..." specs/cache/00-hero.png --size 2048x1152 --quality high
    generate_image.py "Square data model ..." specs/cache/03-model.png --size 1024x1024

Environment:
    OPENAI_API_KEY - Required. Read from the environment or a .env file in the
                     current working directory.
"""

import argparse
import base64
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

# Load .env from the current working directory (where the agent runs).
load_dotenv(Path.cwd() / ".env")

MODEL = "gpt-image-2"
VALID_QUALITY = ["auto", "low", "medium", "high"]

# Defaults tuned for spec diagrams: wide 16:9 frame, highest quality.
DEFAULT_SIZE = "2048x1152"
DEFAULT_QUALITY = "high"

# gpt-image-2 also accepts any custom size meeting: max edge <= 3840, both edges
# multiples of 16, aspect <= 3:1, 655360-8294400 total px.
POPULAR_SIZES = [
    "2048x1152",  # wide 16:9 (default)
    "1152x2048",  # tall 9:16
    "1024x1024",  # square
    "1536x1024",
    "1024x1536",
    "2048x2048",
]


def generate_image(
    prompt: str,
    output_path: str,
    size: str = DEFAULT_SIZE,
    quality: str = DEFAULT_QUALITY,
) -> None:
    """Generate a single image with gpt-image-2 and write it to output_path."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise EnvironmentError("OPENAI_API_KEY environment variable not set")

    client = OpenAI(api_key=api_key)

    print(f"Model:    {MODEL}")
    print(f"Size:     {size}")
    print(f"Quality:  {quality}")
    print(f"Output:   {output_path}")
    print(f"Prompt:   {prompt[:120]}{'...' if len(prompt) > 120 else ''}")
    print()
    print("Generating image...")

    result = client.images.generate(
        model=MODEL,
        prompt=prompt,
        size=size,
        quality=quality,
        n=1,
        output_format="png",
    )

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(base64.b64decode(result.data[0].b64_json))
    print(f"Saved: {out}")

    if getattr(result, "usage", None):
        print(f"Usage: {result.usage}")


def main():
    parser = argparse.ArgumentParser(
        description="Generate a spec image using OpenAI gpt-image-2",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("prompt", help="Text prompt describing the image")
    parser.add_argument("output", help="Output PNG path (e.g., specs/cache/01-architecture.png)")
    parser.add_argument(
        "--size",
        "-s",
        default=DEFAULT_SIZE,
        help=(
            f"Image size WxH (default: {DEFAULT_SIZE}). Popular: "
            + ", ".join(POPULAR_SIZES)
            + ". Custom sizes allowed: max edge <=3840, multiples of 16, aspect <=3:1."
        ),
    )
    parser.add_argument(
        "--quality",
        "-q",
        default=DEFAULT_QUALITY,
        choices=VALID_QUALITY,
        help=f"Quality tier (default: {DEFAULT_QUALITY})",
    )

    args = parser.parse_args()

    try:
        generate_image(
            prompt=args.prompt,
            output_path=args.output,
            size=args.size,
            quality=args.quality,
        )
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
