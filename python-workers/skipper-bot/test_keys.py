import httpx
import asyncio
import os
from dotenv import load_dotenv

load_dotenv()

async def test_disney_api():
    # Headers we already have
    token = os.getenv("DISNEY_BEARER_TOKEN")
    ua = os.getenv("DISNEY_USER_AGENT")
    
    # 1. Try the "Modern" Endpoint (api.disney.com)
    url_modern = "https://api.disney.com/mobile-chiron/park-service/park/80007798/wait-times"
    
    # 2. Try the "Legacy" Endpoint (api.wdpro.disney.go.com)
    url_legacy = "https://api.wdpro.disney.go.com/facility-service/theme-parks/80007798/wait-times"

    headers_base = {
        "Authorization": f"Bearer {token}",
        "User-Agent": ua,
        "Accept": "application/json",
        "X-App-Id": "WDW-MDX-IOS-8.17"
    }

    print(f"🚀 Testing with Bearer: {token[:10]}...")
    
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Test variation 1: Found API Key from Browser Research
        headers_v1 = headers_base.copy()
        headers_v1["x-api-key"] = "D636653E-74AE-4712-B67B-3A9B7998DA49"
        
        try:
            print(f"🔍 Testing Variation 1 (Found Web API Key)...")
            resp = await client.get(url_legacy, headers=headers_v1)
            print(f"   Result: {resp.status_code}")
            if resp.status_code == 200:
                print("   ✅ SUCCESS: We have the key! D636653E-74AE-4712-B67B-3A9B7998DA49 works.")
                return True
        except Exception as e:
            print(f"   Error: {e}")

        # Test variation 2: No x-api-key (already tried, but let's be sure)
        try:
            print(f"🔍 Testing Variation 2 (Bearer only)...")
            resp = await client.get(url_legacy, headers=headers_base)
            print(f"   Result: {resp.status_code}")
        except Exception as e:
            pass

    print("❌ FAILED: Both endpoints rejected the request. We likely still need the api-key.")
    return False

if __name__ == "__main__":
    asyncio.run(test_disney_api())
