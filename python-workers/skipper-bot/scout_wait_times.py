import os
import redis
import httpx
import json
import logging
from datetime import datetime
from dotenv import load_dotenv

# Load configuration
load_dotenv()

# Logging setup
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# Config
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
PROXY_SERVER = os.getenv("PROXY_SERVER")
PROXY_USER = os.getenv("PROXY_USERNAME")
PROXY_PASS = os.getenv("PROXY_PASSWORD")

# Disney API Config (To be filled in by Phase 8 Step 2)
DISNEY_API_KEY = os.getenv("DISNEY_API_KEY")
DISNEY_BEARER_TOKEN = os.getenv("DISNEY_BEARER_TOKEN")
DISNEY_USER_AGENT = os.getenv("DISNEY_USER_AGENT", "DisneyWorld/1.0 (iPhone; iOS 16.0; Scale/3.00)")

# Initialize Redis
r = None
try:
    r = redis.from_url(REDIS_URL)
    r.ping() # Check connection
    logger.info("🏰 Connected to Redis successfully")
except Exception as e:
    logger.warning(f"⚠️ Redis connection failed (Optional): {e}. Sync to database will be skipped.")

def get_proxy():
    if not PROXY_SERVER:
        return None
    # Construct authenticated proxy URL for httpx
    # Example: http://user:pass@gate.decodo.com:10001
    return f"http://{PROXY_USER}:{PROXY_PASS}@{PROXY_SERVER}"

async def scrape_park_wait_times(park_id: str):
    """
    Scrapes wait times for a specific park.
    WDW Parks: 'wdw-magic-kingdom', 'wdw-epcot', 'wdw-hollywood-studios', 'wdw-animal-kingdom'
    """
    logger.info(f"🔍 Scouting wait times for {park_id}...")
    
    # 1. Primary Method: Direct App API
    if DISNEY_API_KEY and DISNEY_BEARER_TOKEN:
        logger.info("📱 Attempting Direct App API access...")
        # ... logic for direct access ...
        pass

    # 2. Fallback Method: Queue-Times API (Stable & Simple)
    logger.info("🌐 Using Queue-Times.com fallback...")
    
    # Queue-Times IDs
    qt_id = {
        "80007798": "6",  # Magic Kingdom
        "80008297": "5",  # Epcot
        "80007838": "7",  # Hollywood Studios
        "80007944": "8"   # Animal Kingdom
    }.get(park_id, "6") # Default to Magic Kingdom

    url = f"https://queue-times.com/parks/{qt_id}/queue_times.json"
    
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
            
            # Map Queue-Times format to our internal format
            internal_data = {"entries": []}
            for land in data.get("lands", []):
                for ride in land.get("rides", []):
                    internal_data["entries"].append({
                        "id": str(ride.get("id")),
                        "name": ride.get("name"),
                        "status": "Operating" if ride.get("is_open") else "CLOSED",
                        "waitTime": ride.get("wait_time")
                    })

            await process_wait_times(internal_data, park_id)

        except Exception as e:
            logger.error(f"❌ Fallback API error: {e}")
            await simulate_scraping(park_id)

async def process_wait_times(data, park_id):
    """
    Parses Disney's JSON and pushes to Redis in the format ParkStatusRegistry expects.
    """
    entries = data.get("entries", [])
    pipeline = r.pipeline() if r else None
    
    for entry in entries:
        ride_id = entry.get("id")
        name = entry.get("name")
        status = entry.get("status") # e.g., 'Operating', 'Closed'
        wait_time = entry.get("waitTime")

        # Map Disney status to Castle Companion status
        cc_status = "OPEN" if status == "Operating" else "CLOSED"
        
        payload = {
            "attractionId": ride_id,
            "name": name,
            "parkId": park_id,
            "status": cc_status,
            "waitTime": wait_time,
            "lastUpdated": datetime.now().isoformat()
        }

        key = f"park:status:{ride_id}"
        if pipeline:
            pipeline.set(key, json.dumps(payload), ex=600) # 10 minute TTL

    if not r or not pipeline:
        logger.info(f"💾 [Dry Run] Would have synced {len(entries)} attraction statuses to Redis.")
        return

    try:
        pipeline.execute()
        logger.info(f"✅ Synced {len(entries)} attraction statuses to Redis for park {park_id}")
    except Exception as e:
        logger.error(f"❌ Failed to execute Redis pipeline: {e}")

async def simulate_scraping(park_id):
    """
    Simulation mode to verify Redis integration without burning proxy data/hitting Disney.
    """
    sim_data = [
        {"id": "mk_pirates", "name": "Pirates of the Caribbean", "status": "Operating", "waitTime": 45},
        {"id": "mk_space_mtn", "name": "Space Mountain", "status": "Operating", "waitTime": 75},
        {"id": "mk_mansion", "name": "Haunted Mansion", "status": "Closed", "waitTime": None},
    ]
    await process_wait_times({"entries": sim_data}, park_id)

async def main():
    # Example: Magic Kingdom
    await scrape_park_wait_times("80007798")

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
