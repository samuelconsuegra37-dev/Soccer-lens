from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from ibm_watsonx_ai import Credentials, APIClient
from ibm_watsonx_ai.foundation_models import ModelInference
import boto3
import httpx
import os
import hashlib
import asyncio
import unicodedata

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_private_network_header(request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response

rekognition = boto3.client(
    'rekognition',
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
    region_name='us-east-1'
)

rekognition_cache = {}
player_cache = {}
granite_cache = {}

def get_granite_model():
    credentials = Credentials(
        url="https://us-south.ml.cloud.ibm.com",
        api_key=os.getenv("IBM_API_KEY")
    )
    client = APIClient(credentials, project_id=os.getenv("IBM_PROJECT_ID"))
    return ModelInference(
        api_client=client,
        model_id="ibm/granite-4-h-small"
    )

async def get_player_data(player_name: str):
    if player_name in player_cache:
        print(f"Cache hit: {player_name}")
        return player_cache[player_name]

    headers = {"x-api-key": os.getenv("SPORTS_API_PRO_KEY")}
    base_url = "https://v2.football.sportsapipro.com/api"

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Step 1 - search by name
        search_response = await client.get(
            f"{base_url}/search",
            headers=headers,
            params={"q": player_name}
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

        # Step 2 - get stats by ID
        stats_response = await client.get(
            f"{base_url}/players/{player_id}/statistics",
            headers=headers
        )
        stats_data = stats_response.json()

    # Parse stats
    all_stats = []
    seasons = stats_data.get("data", {}).get("seasons", [])

    # Skip minor competitions
    skip_competitions = [
        "International Friendly Games",
        "Supercopa de España", 
        "Trophée des Champions",
        "US Open Cup",
        "World Cup Qual. CONMEBOL"
    ]

    # Track which leagues we've already seen — keep only most recent
    seen_leagues = set()

    for season in seasons:
        league_name = season.get("uniqueTournament", {}).get("name", "Unknown")
        
        if league_name in skip_competitions:
            continue
        
        if league_name in seen_leagues:
            continue  # already have most recent season for this league
        
        seen_leagues.add(league_name)
        year = season.get("year", "Unknown")
        team_name = season.get("team", {}).get("name", "Unknown")
        stats = season.get("statistics", {})
        
        all_stats.append({
            "league": league_name,
            "season": year,
            "team": team_name,
            "goals": stats.get("goals", 0) or 0,
            "assists": stats.get("assists", 0) or 0,
            "appearances": stats.get("appearances", 0) or 0,
            "yellow_cards": stats.get("yellowCards", 0) or 0,
            "red_cards": stats.get("redCards", 0) or 0
        })

    sportsdb = await get_thesportsdb_data(player_name)

    result = {
        "name": player["name"],
        "nationality": player.get("country", {}).get("name", "Unknown"),
        "position": player.get("position", "Unknown"),
        "photo": sportsdb.get("photo") if sportsdb else None,
        "number": player.get("jerseyNumber", "Unknown"),
        "team": player.get("team", {}).get("name", "Unknown"),
        "stats": all_stats
    }


    player_cache[player_name] = result
    return result

async def generate_narrative(player_name: str, player_data: dict):
    if player_name in granite_cache:
        print(f"Granite cache hit: {player_name}")
        return granite_cache[player_name]

    model = get_granite_model()

    stats_text = "\n".join([
        f"{s['league']}: {s['goals']} goals, {s['assists']} assists, {s['appearances']} appearances"
        for s in player_data["stats"]
    ])

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
        params = TextGenParameters(
            max_new_tokens=300,
            temperature=0.7
        )
        narrative = await asyncio.to_thread(model.generate_text, prompt, params)
        granite_cache[player_name] = narrative
        return narrative
    except Exception as e:
        print(f"Granite error: {e}")
        return "Player narrative temporarily unavailable. Please try again shortly."

@app.post("/identify")
async def identify_player(file: UploadFile = File(...)):
    image_bytes = await file.read()
    image_hash = hashlib.md5(image_bytes).hexdigest()

    if image_hash in rekognition_cache:
        player_name = rekognition_cache[image_hash]
    else:
        response = rekognition.recognize_celebrities(
            Image={'Bytes': image_bytes}
        )
        celebrities = response.get('CelebrityFaces', [])
        if not celebrities:
            return {"name": None, "player": None}

        player_name = celebrities[0]['Name']
        rekognition_cache[image_hash] = player_name

    player_data = await get_player_data(player_name)
    return {"name": player_name, "player": player_data}

@app.get("/profile/{player_name}")
async def get_profile(player_name: str):
    player_data = await get_player_data(player_name)
    if not player_data:
        return {"narrative": "Player profile not available."}
    narrative = await generate_narrative(player_name, player_data)
    return {"narrative": narrative}

@app.get("/test-search/{player_name}")
async def test_search(player_name: str):
    headers = {"x-apisports-key": os.getenv("API_FOOTBALL_KEY")}
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            "https://v3.football.api-sports.io/players/profiles",
            headers=headers,
            params={"search": player_name}
        )
        data = response.json()
        return {
            "results": data.get("results", 0),
            "players": [p["player"]["name"] for p in data.get("response", [])]
        }

@app.get("/test-stats/{player_id}")
async def test_stats(player_id: int):
    headers = {"x-api-key": os.getenv("SPORTS_API_PRO_KEY")}
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"https://v2.football.sportsapipro.com/api/players/{player_id}/statistics",
            headers=headers
        )
        return response.json()

async def get_thesportsdb_data(player_name: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"https://www.thesportsdb.com/api/v1/json/3/searchplayers.php",
            params={"p": player_name}
        )
        data = response.json()
        players = data.get("player", [])
        if players:
            p = players[0]
            return {
                "photo": p.get("strThumb") or p.get("strCutout") or p.get("strRender"),
                "height": p.get("strHeight", "Unknown"),
                "weight": p.get("strWeight", "Unknown"),
                "dob": p.get("dateBorn", "Unknown"),
                "description": p.get("strDescriptionEN", "")
            }
        return None

@app.post("/clear-cache")
async def clear_cache():
    rekognition_cache.clear()
    player_cache.clear()
    granite_cache.clear()
    return {"message": "Cache cleared"}
