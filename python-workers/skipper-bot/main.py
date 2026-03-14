import os
import asyncio
import logging
from playwright.async_api import async_playwright
from supabase import create_client, Client
from fake_useragent import UserAgent
from dotenv import load_dotenv

load_dotenv()

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# Environment Variables
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
PROXY_SERVER = os.getenv("PROXY_SERVER")       # e.g. http://us.smartproxy.com:10000
PROXY_USERNAME = os.getenv("PROXY_USERNAME")
PROXY_PASSWORD = os.getenv("PROXY_PASSWORD")

# Initialize Supabase
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

async def check_for_challenges(page):
    """Detects if we are being blocked by DataDome, Akamai, or other bot detection."""
    content = await page.content()
    detection_strings = ["captcha-container", "datadome", "bot-detection", "Access Denied"]
    for s in detection_strings:
        if s.lower() in content.lower():
            logger.error(f"BOT DETECTION DETECTED: Found string '{s}'. Killing session to save proxy data.")
            return True
    return False

async def execute_registration(account, email, display_name, user_agent, proxy_config):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=user_agent,
            proxy=proxy_config,
            viewport={'width': 1920, 'height': 1080}
        )
        page = await context.new_page()

        try:
            logger.info(f"Navigating to Disney Registration...")
            await page.goto("https://disneyworld.disney.go.com/login/", wait_until="networkidle", timeout=60000)
            
            # Phase 10: Evasion/Challenge Check
            if await check_for_challenges(page):
                supabase.table("proxy_logs").insert({
                    "proxy": PROXY_SERVER,
                    "event": "CHALLENGE_DETECTED",
                    "url": page.url
                }).execute()
                return False

            # Disney Account Registration Flow
            await page.click("text='Create an Account'")
            
            # Phase 10: Post-click challenge check
            await asyncio.sleep(2) 
            if await check_for_challenges(page): return False

            logger.info(f"Filling out registration form...")
            await page.fill("input[name='create-email']", email)
            await page.fill("input[name='password']", "StrongCastleP@ss1!")
            await page.fill("input[name='firstName']", display_name.split(' ')[0])
            await page.fill("input[name='lastName']", display_name.split(' ')[-1])
            await page.fill("input[name='dateOfBirth']", "01/01/1990")
            
            await page.click("button[type='submit']")
            logger.info("Registration submitted. Waiting for verification code...")
            supabase.table("skipper_accounts").update({"status": "VERIFICATION_SENT"}).eq("id", account["id"]).execute()
            
            verified = False
            for _ in range(12): # Poll for 1 minute
                code_resp = supabase.table("verification_codes").select("*").eq("email", email).eq("used", False).execute()
                if code_resp.data:
                    code = code_resp.data[0]['code']
                    logger.info(f"Verification code received: {code}")
                    await page.fill("input[name='verification-code']", code)
                    await page.click("button[type='submit']")
                    supabase.table("verification_codes").update({"used": True}).eq("id", code_resp.data[0]['id']).execute()
                    verified = True
                    break
                await asyncio.sleep(5)
                
            if verified:
                supabase.table("skipper_accounts").update({"status": "VERIFIED"}).eq("id", account["id"]).execute()
                logger.info(f"Account {email} successfully Verified!")
                return True
            return False

        except Exception as e:
            logger.error(f"Error during Playwright execution: {e}")
            return False
        finally:
            await browser.close()

async def run_registration_pipeline():
    logger.info("Checking for PENDING Skipper accounts...")
    response = supabase.table("skipper_accounts").select("*").eq("status", "PENDING").limit(1).execute()
    
    if not response.data:
        return

    account = response.data[0]
    email = account['email']
    display_name = account.get('display_name', 'Disney Guest')
    ua = UserAgent()
    user_agent = ua.random
    
    proxy_config = None
    if PROXY_SERVER:
        proxy_config = {"server": PROXY_SERVER, "username": PROXY_USERNAME, "password": PROXY_PASSWORD}

    # Phase 10: Hard TTL (120 seconds) to prevent "Zombie" Proxy drain
    try:
        await asyncio.wait_for(
            execute_registration(account, email, display_name, user_agent, proxy_config),
            timeout=120.0
        )
    except asyncio.TimeoutError:
        logger.error(f"CRITICAL: Bot session for {email} exceeded 120s TTL. Hard-killing to save proxy data.")
        supabase.table("skipper_accounts").update({"status": "SUSPENDED"}).eq("id", account["id"]).execute()

if __name__ == "__main__":
    asyncio.run(run_registration_pipeline())
