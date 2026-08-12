"""Command-line entry point: `draft-optimizer serve|update-data`."""

from __future__ import annotations

import argparse

from . import fetch_data, server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="draft-optimizer",
        description="Fantasy football live-draft assistant.",
    )
    sub = parser.add_subparsers(dest="command")

    serve_p = sub.add_parser("serve", help="start the web app (default)")
    serve_p.add_argument("--port", type=int, default=8787)
    serve_p.add_argument("--no-browser", action="store_true", help="don't open a browser tab")

    update_p = sub.add_parser("update-data", help="refresh rankings/projections/ADP")
    update_p.add_argument(
        "formats", nargs="*", choices=fetch_data.SCORING_FORMATS,
        help="scoring formats to refresh (default: all)",
    )

    args = parser.parse_args(argv)
    if args.command == "update-data":
        return fetch_data.main(args.formats)
    port = getattr(args, "port", 8787)
    no_browser = getattr(args, "no_browser", False)
    server.serve(port=port, open_browser=not no_browser)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
