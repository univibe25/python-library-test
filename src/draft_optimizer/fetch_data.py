"""Fetch player rankings, projections, and ADP; merge into JSON files for the web app.

Sources (all free, no auth):
  - FantasyPros expert consensus rankings (ECR) draft cheatsheets — overall rank,
    position rank, tier, bye week. The consensus aggregates 100+ experts including
    the Yahoo rankers, so it tracks the "Yahoo list" closely while smoothing out
    any single site's quirks.
  - Sleeper season projections — projected fantasy points per scoring format,
    format-specific ADP, and injury status.
  - FantasyFootballCalculator ADP API — average draft position from live mock
    drafts, per scoring format and league size.

Output: one JSON file per scoring format in web/data/, e.g. players-half.json.
Uses only the Python standard library so it runs anywhere.
"""

from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).parent / "web" / "data"
IMG_PLAYERS_DIR = Path(__file__).parent / "web" / "img" / "players"
IMG_TEAMS_DIR = Path(__file__).parent / "web" / "img" / "teams"
HEADSHOT_URL = "https://sleepercdn.com/content/nfl/players/thumb/{sid}.jpg"
TEAM_LOGO_URL = "https://sleepercdn.com/images/team_logos/nfl/{team}.png"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36"
)

SCORING_FORMATS = ("std", "half", "ppr")
LEAGUE_SIZES = (8, 10, 12, 14)

ECR_URLS = {
    "std": "https://www.fantasypros.com/nfl/rankings/consensus-cheatsheets.php",
    "half": "https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php",
    "ppr": "https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php",
}
FFC_SCORING = {"std": "standard", "half": "half-ppr", "ppr": "ppr"}
SLEEPER_PTS = {"std": "pts_std", "half": "pts_half_ppr", "ppr": "pts_ppr"}
SLEEPER_ADP = {"std": "adp_std", "half": "adp_half_ppr", "ppr": "adp_ppr"}

NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}

# NFL team name -> abbreviation, for matching team defenses across sources.
TEAM_ABBR = {
    "arizona cardinals": "ARI", "atlanta falcons": "ATL", "baltimore ravens": "BAL",
    "buffalo bills": "BUF", "carolina panthers": "CAR", "chicago bears": "CHI",
    "cincinnati bengals": "CIN", "cleveland browns": "CLE", "dallas cowboys": "DAL",
    "denver broncos": "DEN", "detroit lions": "DET", "green bay packers": "GB",
    "houston texans": "HOU", "indianapolis colts": "IND", "jacksonville jaguars": "JAC",
    "kansas city chiefs": "KC", "las vegas raiders": "LV", "los angeles chargers": "LAC",
    "los angeles rams": "LAR", "miami dolphins": "MIA", "minnesota vikings": "MIN",
    "new england patriots": "NE", "new orleans saints": "NO", "new york giants": "NYG",
    "new york jets": "NYJ", "philadelphia eagles": "PHI", "pittsburgh steelers": "PIT",
    "san francisco 49ers": "SF", "seattle seahawks": "SEA", "tampa bay buccaneers": "TB",
    "tennessee titans": "TEN", "washington commanders": "WAS",
}
# Alternate abbreviations used by some sources.
ABBR_ALIASES = {"JAX": "JAC", "WSH": "WAS", "LVR": "LV", "SFO": "SF", "TBB": "TB",
                "NOR": "NO", "GBP": "GB", "KCC": "KC", "NEP": "NE"}


def _get(url: str, retries: int = 3) -> str:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=45) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as err:  # noqa: BLE001 - retry any transient failure
            last_err = err
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last_err}")


def normalize_name(name: str) -> str:
    """Normalize a player name for cross-source matching."""
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = re.sub(r"[^a-zA-Z\s]", "", name).lower()
    words = [w for w in name.split() if w not in NAME_SUFFIXES]
    return " ".join(words)


def canon_team(abbr: str) -> str:
    abbr = (abbr or "").upper().strip()
    return ABBR_ALIASES.get(abbr, abbr)


def fetch_ecr(scoring: str) -> list[dict]:
    """Parse the ecrData JSON blob embedded in a FantasyPros cheatsheet page."""
    html = _get(ECR_URLS[scoring])
    match = re.search(r"var ecrData = (\{.*?\});", html)
    if not match:
        raise RuntimeError(f"ecrData blob not found on {ECR_URLS[scoring]}")
    data = json.loads(match.group(1))
    players = []
    for p in data.get("players", []):
        pos = p.get("player_position_id", "")
        if pos not in {"QB", "RB", "WR", "TE", "K", "DST"}:
            continue
        team = canon_team(p.get("player_team_id", ""))
        name = p.get("player_name", "")
        key_name = team.lower() + " dst" if pos == "DST" else normalize_name(name)
        players.append({
            "key": (key_name, pos),
            "name": name,
            "team": team,
            "pos": pos,
            "bye": int(p["player_bye_week"]) if p.get("player_bye_week") else None,
            "rank": p.get("rank_ecr"),
            "pos_rank": p.get("pos_rank"),
            "tier": p.get("tier"),
            "best_rank": int(p["rank_min"]) if p.get("rank_min") else None,
            "worst_rank": int(p["rank_max"]) if p.get("rank_max") else None,
            "rank_std": float(p["rank_std"]) if p.get("rank_std") else None,
        })
    return players


def fetch_sleeper_projections(year: int) -> dict[tuple[str, str], dict]:
    """Fetch Sleeper full-season projections for all fantasy positions.

    Returns {(normalized name, POS): {points per scoring, adp per scoring, injury}}.
    """
    url = (
        f"https://api.sleeper.app/projections/nfl/{year}?season_type=regular"
        "&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
        "&position[]=K&position[]=DEF&order_by=adp_half_ppr"
    )
    rows = json.loads(_get(url))
    out: dict[tuple[str, str], dict] = {}
    for row in rows:
        player = row.get("player") or {}
        stats = row.get("stats") or {}
        pos = player.get("position", "")
        if pos not in {"QB", "RB", "WR", "TE", "K", "DEF"}:
            continue
        team = canon_team(player.get("team") or "")
        if pos == "DEF":
            if not team:
                continue
            key = (team.lower() + " dst", "DST")
        else:
            name = f"{player.get('first_name', '')} {player.get('last_name', '')}"
            key = (normalize_name(name), pos)
        entry = {
            "points": {s: stats.get(SLEEPER_PTS[s]) for s in SCORING_FORMATS},
            "adp": {s: stats.get(SLEEPER_ADP[s]) for s in SCORING_FORMATS},
            "injury": player.get("injury_status") or None,
            # Sleeper player id — headshots live at
            # sleepercdn.com/content/nfl/players/thumb/{sid}.jpg
            "sid": row.get("player_id"),
            # Projected passing TDs, kept so leagues that score them at 6
            # (instead of the standard 4) can re-value QBs client-side.
            "pass_td": stats.get("pass_td") if pos == "QB" else None,
        }
        prev = out.get(key)
        # On duplicate names at a position keep the higher-projected player.
        if prev is None or (entry["points"]["half"] or 0) > (prev["points"]["half"] or 0):
            out[key] = entry
    return out


def fetch_adp(scoring: str, teams: int, year: int) -> dict[tuple[str, str], dict]:
    """Fetch ADP from FantasyFootballCalculator for one scoring format and league size."""
    url = (
        f"https://fantasyfootballcalculator.com/api/v1/adp/{FFC_SCORING[scoring]}"
        f"?teams={teams}&year={year}"
    )
    data = json.loads(_get(url))
    out: dict[tuple[str, str], dict] = {}
    for p in data.get("players", []):
        pos = p.get("position", "")
        if pos == "PK":
            pos = "K"
        if pos not in {"QB", "RB", "WR", "TE", "K", "DEF"}:
            continue
        team = canon_team(p.get("team", ""))
        if pos == "DEF":
            key = (team.lower() + " dst", "DST")
        else:
            key = (normalize_name(p.get("name", "")), pos)
        out[key] = {"adp": p.get("adp"), "high": p.get("high"), "low": p.get("low"),
                    "stdev": p.get("stdev"), "bye": p.get("bye")}
    return out


def _download_binary(url: str, dest: Path) -> str:
    """Download url to dest unless already cached. Returns cached/ok/fail."""
    if dest.exists() and dest.stat().st_size > 0:
        return "cached"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        dest.write_bytes(data)
        return "ok"
    except Exception:  # noqa: BLE001 - a missing photo is not fatal
        return "fail"


def download_images(all_formats: list[dict], max_rank: int = 300) -> None:
    """Cache headshots (top players) and team logos locally so the app's
    photos work offline on draft day. Skips files already downloaded."""
    IMG_PLAYERS_DIR.mkdir(parents=True, exist_ok=True)
    IMG_TEAMS_DIR.mkdir(parents=True, exist_ok=True)
    jobs: list[tuple[str, Path]] = []
    seen_sids: set = set()
    seen_teams: set = set()
    for data in all_formats:
        for p in data["players"]:
            team = (p.get("team") or "").lower()
            if team and team not in seen_teams:
                seen_teams.add(team)
                jobs.append((TEAM_LOGO_URL.format(team=team), IMG_TEAMS_DIR / f"{team}.png"))
            sid = p.get("sid")
            if sid and p["pos"] != "DST" and p["rank"] <= max_rank and sid not in seen_sids:
                seen_sids.add(sid)
                jobs.append((HEADSHOT_URL.format(sid=sid), IMG_PLAYERS_DIR / f"{sid}.jpg"))
    print(f"caching {len(jobs)} images (players ranked top {max_rank} + team logos)...")
    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(lambda j: _download_binary(*j), jobs))
    print(f"  {results.count('ok')} downloaded, {results.count('cached')} already cached, "
          f"{results.count('fail')} unavailable")


def season_year(today: date | None = None) -> int:
    """The NFL season a draft happening today belongs to (season starts in September)."""
    today = today or date.today()
    return today.year if today.month >= 3 else today.year - 1


def build_format(scoring: str, year: int, projections: dict[tuple[str, str], dict]) -> dict:
    print(f"[{scoring}] fetching expert consensus rankings...")
    ecr = fetch_ecr(scoring)

    print(f"[{scoring}] fetching ADP for league sizes {LEAGUE_SIZES}...")
    adp_by_size: dict[int, dict] = {}
    for teams in LEAGUE_SIZES:
        try:
            adp_by_size[teams] = fetch_adp(scoring, teams, year)
        except RuntimeError as err:
            print(f"  warning: ADP fetch failed for {teams} teams: {err}")
            adp_by_size[teams] = {}

    players = []
    matched_proj = 0
    for idx, p in enumerate(ecr):
        key = p.pop("key")
        entry = dict(p)
        entry["id"] = f"{scoring}-{idx}"
        sleeper = projections.get(key)
        entry["points"] = None
        entry["sleeper_adp"] = None
        entry["injury"] = None
        entry["pass_td"] = None
        entry["sid"] = None
        if sleeper:
            entry["sid"] = sleeper.get("sid")
            pts = sleeper["points"].get(scoring)
            entry["points"] = round(pts, 1) if pts is not None else None
            entry["sleeper_adp"] = sleeper["adp"].get(scoring)
            entry["injury"] = sleeper["injury"]
            if sleeper.get("pass_td") is not None:
                entry["pass_td"] = round(sleeper["pass_td"], 1)
            if pts is not None:
                matched_proj += 1
        entry["adp"] = {}
        for teams, table in adp_by_size.items():
            rec = table.get(key)
            if rec and rec.get("adp"):
                entry["adp"][str(teams)] = rec["adp"]
                if entry.get("bye") is None and rec.get("bye"):
                    entry["bye"] = rec["bye"]
        players.append(entry)

    print(f"[{scoring}] {len(players)} ranked players, "
          f"{matched_proj} with projections, "
          f"{sum(1 for pl in players if pl['adp'])} with ADP")
    return {
        "scoring": scoring,
        "season": year,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": {
            "rankings": "FantasyPros expert consensus (draft cheatsheet)",
            "projections": "Sleeper season projections",
            "adp": "FantasyFootballCalculator live mock drafts; Sleeper ADP fallback",
        },
        "players": players,
    }


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    formats = [a for a in args if a in SCORING_FORMATS] or list(SCORING_FORMATS)
    year = season_year()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"fetching Sleeper {year} season projections...")
    projections = fetch_sleeper_projections(year)
    print(f"  {len(projections)} players with projections")
    built = []
    for scoring in formats:
        data = build_format(scoring, year, projections)
        out_path = DATA_DIR / f"players-{scoring}.json"
        out_path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
        print(f"[{scoring}] wrote {out_path}")
        built.append(data)
    download_images(built)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
