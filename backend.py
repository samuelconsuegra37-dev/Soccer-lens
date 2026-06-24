"""
Soccer Lens Backend

FastAPI server powering the Soccer Lens Chrome extension. Identifies
soccer players from paused video frames and returns their stats and
an AI-generated bio.

Pipeline:
    1. Frame received -> AWS Rekognition celebrity recognition
    2. Result validated as a real soccer player (SportsAPI Pro)
    3. Stats fetched (SportsAPI Pro) + photo fetched (TheSportsDB)
    4. AI narrative generated on demand (IBM Granite / watsonx.ai)

Caching strategy:
    Three independent in-memory caches (face recognition results,
    player profiles, generated narratives) avoid redundant calls to
    rate-limited external APIs. `player_cache` is additionally
    persisted to disk (see CACHE_FILE) so it survives server restarts,
    since `uvicorn --reload` clears in-memory state on every code change.
"""

from typing import Optional

import asyncio
import hashlib
import json
import os

import boto3
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from ibm_watsonx_ai import Credentials, APIClient
from ibm_watsonx_ai.foundation_models import ModelInference

load_dotenv()

app = FastAPI()

# Permits requests from any origin, since the extension's content
# script runs on whatever site the user is browsing (e.g. YouTube),
# not from a fixed, known origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_private_network_header(request, call_next):
    """
    Adds the header Chrome requires to allow an HTTPS page (e.g.
    YouTube) to call an HTTP localhost server, per Chrome's Private
    Network Access policy. Works together with the user-granted
    'local network access' permission set per-site in
    chrome://settings/content/localNetworkDevices.
    """
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


# ---------------------------------------------------------------------
# Clients & caches
# ---------------------------------------------------------------------

rekognition = boto3.client(
    "rekognition",
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
    region_name="us-east-1",
)

CACHE_FILE = "player_cache.json"


def load_player_cache() -> dict:
    """Loads cached player data from disk so it survives server restarts."""
    try:
        with open(CACHE_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_player_cache() -> None:
    """Persists the current player cache to disk."""
    with open(CACHE_FILE, "w") as f:
        json.dump(player_cache, f)


# image MD5 hash -> player name (str) OR list of candidate dicts (multi-face)
rekognition_cache: dict = {}

# player name -> profile dict; the only cache persisted to disk
player_cache: dict = load_player_cache()

# player name -> generated narrative text
granite_cache: dict = {}


# ---------------------------------------------------------------------
# IBM Granite (watsonx.ai)
# ---------------------------------------------------------------------

def get_granite_model() -> ModelInference:
    """
    Builds an IBM watsonx.ai ModelInference client configured to use
    ibm/granite-4-h-small. Constructed fresh per call since the
    object itself is lightweight; credentials are read from
    environment variables on each invocation.
    """
    credentials = Credentials(
        url="https://us-south.ml.cloud.ibm.com",
        api_key=os.getenv("IBM_API_KEY"),
    )
    client = APIClient(credentials, project_id=os.getenv("IBM_PROJECT_ID"))
    return ModelInference(
        api_client=client,
        model_id="ibm/granite-4-h-small",
    )


async def generate_narrative(player_name: str, player_data: dict) -> str:
    """
    Generates a short, fan-facing biography for a player using IBM
    Granite. The prompt deliberately excludes height/weight to reduce
    hallucination risk, and focuses on playing style, origin, and
    achievements instead.

    Args:
        player_name: The player's full name, used for both the prompt
            and as the narrative cache key.
        player_data: Profile dict from get_player_data(), used to give
            Granite factual grounding (nationality, position, team).

    Returns:
        The generated narrative, or a fallback message if the
        watsonx.ai call fails (e.g. a 429 from the free tier's
        10-concurrent-request limit).
    """
    if player_name in granite_cache:
        print(f"Granite cache hit: {player_name}")
        return granite_cache[player_name]

    model = get_granite_model()

    prompt = f"""<|system|>
    You are an enthusiastic but professional soccer commentator introducing players to new fans.
    <|user|>
    Generate a 80-100 word fan profile for {player_name}.

    Focus on:
    - Their playing style and what makes them unique on the pitch
    - Their origin and what they mean to their country
    - Their biggest career achievement or defining moment
    - What a new fan should know about watching them

    Data available:
    - Nationality: {player_data['nationality']}
    - Position: {player_data['position']}
    - Team: {player_data['team']}

    Rules:
    - No height, weight, or physical measurements
    - No emojis
    - Only include facts you are highly confident about
    - Write like a professional commentator introducing a player to a new fan
    - Keep it under 100 words
    <|assistant|>
    """

    try:
        from ibm_watsonx_ai.foundation_models.schema import TextGenParameters

        params = TextGenParameters(max_new_tokens=300, temperature=0.7)
        # model.generate_text is synchronous; run in a thread so it
        # doesn't block the FastAPI event loop.
        narrative = await asyncio.to_thread(model.generate_text, prompt, params)
        granite_cache[player_name] = narrative
        return narrative
    except Exception as e:
        print(f"Granite error: {e}")
        return "Player narrative temporarily unavailable. Please try again shortly."


# ---------------------------------------------------------------------
# Player data (SportsAPI Pro + TheSportsDB)
# ---------------------------------------------------------------------

async def get_thesportsdb_data(player_name: str) -> Optional[dict]:
    """
    Fetches a player's photo from TheSportsDB's free, key-less API.
    Used because SportsAPI Pro's own player image URLs are unreliable.

    Args:
        player_name: Full name to search for.

    Returns:
        A dict with photo/bio fields, or None if no match is found.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            "https://www.thesportsdb.com/api/v1/json/3/searchplayers.php",
            params={"p": player_name},
        )
        data = response.json()
        players = data.get("player", [])
        if not players:
            return None

        p = players[0]
        return {
            "photo": p.get("strThumb") or p.get("strCutout") or p.get("strRender"),
            "height": p.get("strHeight", "Unknown"),
            "weight": p.get("strWeight", "Unknown"),
            "dob": p.get("dateBorn", "Unknown"),
            "description": p.get("strDescriptionEN", ""),
        }


async def is_soccer_player(name: str) -> bool:
    """
    Lightweight check (search only, no stats fetch) confirming a
    Rekognition match is actually a soccer player in SportsAPI Pro.
    Used to filter out commentators, crowd members, or unrelated
    public figures that Rekognition sometimes mistakenly identifies
    when multiple faces are detected in one frame.

    Args:
        name: The name returned by Rekognition's celebrity match.

    Returns:
        True if the name resolves to a player-type result in
        SportsAPI Pro; False otherwise, including on request failure.
    """
    headers = {"x-api-key": os.getenv("SPORTS_API_PRO_KEY")}
    base_url = "https://v2.football.sportsapipro.com/api"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                f"{base_url}/search", headers=headers, params={"q": name}
            )
            data = response.json()
            results = data.get("data", {}).get("results", [])
            return any(r["type"] == "player" for r in results)
    except Exception:
        return False


async def get_player_data(player_name: str) -> Optional[dict]:
    """
    Fetches a player's profile and season-by-season statistics.

    Resolves the player's ID via SportsAPI Pro search, fetches their
    full statistics history, filters it down to the most recent
    season per league (minor competitions excluded), and attaches a
    photo from TheSportsDB. Successful results are cached both in
    memory and on disk.

    Args:
        player_name: Full name to look up, typically the name
            returned by AWS Rekognition.

    Returns:
        A profile dict (name, nationality, position, photo, number,
        team, stats), or None if no matching player is found.
    """
    if player_name in player_cache:
        print(f"Cache hit: {player_name}")
        return player_cache[player_name]

    headers = {"x-api-key": os.getenv("SPORTS_API_PRO_KEY")}
    base_url = "https://v2.football.sportsapipro.com/api"

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Step 1 - resolve a player ID from the name
        search_response = await client.get(
            f"{base_url}/search", headers=headers, params={"q": player_name}
        )
        search_data = search_response.json()
        print(f"Search response: {search_data}")

        results = search_data.get("data", {}).get("results", [])
        player_result = next((r for r in results if r["type"] == "player"), None)

        if not player_result:
            print(f"Player not found: {player_name}")
            return None

        player = player_result["entity"]
        player_id = player["id"]
        print(f"Found: {player['name']} ID: {player_id}")

        # Step 2 - fetch full statistics history for that ID
        stats_response = await client.get(
            f"{base_url}/players/{player_id}/statistics", headers=headers
        )
        stats_data = stats_response.json()

    all_stats = []
    seasons = stats_data.get("data", {}).get("seasons", [])

    # Competitions that clutter the overlay without adding much value
    skip_competitions = [
        "International Friendly Games",
        "Supercopa de España",
        "Trophée des Champions",
        "US Open Cup",
        "World Cup Qual. CONMEBOL",
    ]

    # Seasons are returned most-recent-first, so the first occurrence
    # of a league name is guaranteed to be that player's latest season
    # in it.
    seen_leagues = set()

    for season in seasons:
        league_name = season.get("uniqueTournament", {}).get("name", "Unknown")

        if league_name in skip_competitions or league_name in seen_leagues:
            continue

        seen_leagues.add(league_name)
        stats = season.get("statistics", {})
        print(f"Raw stats keys for {league_name}: {list(stats.keys())}")  # TEMPORARY

        all_stats.append({
            "league": league_name,
            "season": season.get("year", "Unknown"),
            "team": season.get("team", {}).get("name", "Unknown"),
            "goals": stats.get("goals", 0) or 0,
            "assists": stats.get("assists", 0) or 0,
            "appearances": stats.get("appearances", 0) or 0,
            "minutes_played": stats.get("minutesPlayed", 0) or 0,
            "yellow_cards": stats.get("yellowCards", 0) or 0,
            "red_cards": stats.get("redCards", 0) or 0,
        })

    sportsdb = await get_thesportsdb_data(player_name)

    result = {
        "name": player["name"],
        "nationality": player.get("country", {}).get("name", "Unknown"),
        "position": player.get("position", "Unknown"),
        "photo": sportsdb.get("photo") if sportsdb else None,
        "number": player.get("jerseyNumber", "Unknown"),
        "team": player.get("team", {}).get("name", "Unknown"),
        "stats": all_stats,
    }

    player_cache[player_name] = result
    save_player_cache()
    return result


# ---------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------

@app.post("/identify")
async def identify_player(file: UploadFile = File(...)):
    """
    Identifies player(s) in a paused video frame.

    A single recognized face returns that player's full profile
    immediately. Multiple recognized faces return their names and
    bounding boxes instead, so the frontend can render a selection UI
    before spending an API call on a player the user doesn't pick.
    Results are keyed by an MD5 hash of the image bytes, so re-pausing
    on the same frame never re-runs Rekognition.
    """
    image_bytes = await file.read()
    image_hash = hashlib.md5(image_bytes).hexdigest()

    if image_hash in rekognition_cache:
        cached = rekognition_cache[image_hash]
        if isinstance(cached, list):
            if len(cached) == 1:
                player_data = await get_player_data(cached[0]["name"])
                return {"name": cached[0]["name"], "player": player_data}
            return {"multiple": True, "candidates": cached}
        player_data = await get_player_data(cached)
        return {"name": cached, "player": player_data}

    response = rekognition.recognize_celebrities(Image={"Bytes": image_bytes})
    celebrities = response.get("CelebrityFaces", [])

    if not celebrities:
        return {"name": None, "player": None}

    if len(celebrities) == 1:
        player_name = celebrities[0]["Name"]
        rekognition_cache[image_hash] = player_name
        player_data = await get_player_data(player_name)
        return {"name": player_name, "player": player_data}

    # Multiple faces — validate each before offering it as a selectable
    # candidate, to filter out non-players Rekognition occasionally
    # misidentifies (commentators, crowd members, unrelated celebrities)
    checks = await asyncio.gather(
        *[is_soccer_player(c["Name"]) for c in celebrities]
    )
    valid_celebrities = [c for c, is_player in zip(celebrities, checks) if is_player]

    if not valid_celebrities:
        return {"name": None, "player": None}

    if len(valid_celebrities) == 1:
        player_name = valid_celebrities[0]["Name"]
        rekognition_cache[image_hash] = player_name
        player_data = await get_player_data(player_name)
        return {"name": player_name, "player": player_data}

    candidates = [
        {"name": c["Name"], "box": c["Face"]["BoundingBox"]}
        for c in valid_celebrities
    ]
    rekognition_cache[image_hash] = candidates
    return {"multiple": True, "candidates": candidates}


@app.get("/player/{player_name}")
async def get_player(player_name: str):
    """
    Fetches full stats for one specific player by name. Called after
    the user clicks a marker in the multi-face selection UI.
    """
    player_data = await get_player_data(player_name)
    return {"name": player_name, "player": player_data}


@app.get("/profile/{player_name}")
async def get_profile(player_name: str):
    """
    Fetches the AI-generated narrative for a player. Runs as a
    separate, slower request so the stats panel can render
    immediately while the narrative loads in the background.
    """
    player_data = await get_player_data(player_name)
    if not player_data:
        return {"narrative": "Player profile not available."}
    narrative = await generate_narrative(player_name, player_data)
    return {"narrative": narrative}


@app.post("/clear-cache")
async def clear_cache():
    """
    Manually clears all in-memory caches and the on-disk player cache
    file. Useful during development when a player has been
    misidentified and you want fresh results on the next lookup.
    """
    rekognition_cache.clear()
    player_cache.clear()
    granite_cache.clear()
    save_player_cache()
    return {"message": "Cache cleared"}