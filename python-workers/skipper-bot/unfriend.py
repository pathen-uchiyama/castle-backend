import os
import asyncio
import logging
from playwright.async_api import async_playwright
from supabase import create_client, Client
from fake_useragent import UserAgent
from dotenv import load_dotenv
from datetime import datetime, timezone

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

async def run_unfriend_pipeline():
    """
    Main pipeline:
    1. Fetch users from Supabase whose trip end date has passed.
    2. Identify which Skipper accounts are linked (friended) to these users.
    3. Route traffic through residential proxy and login to Disney.
    4. Navigate to Friends & Family list and remove the guest.
    5. Update Supabase friend_links to mark as REMOVED to free up Skipper slots.
    """
    logger.info("Checking for expired trips requiring unfriend automation...")
    
    # Ideally, we find friend_links where the associated user's trip is complete
    # For demonstration, we assume a table `friend_links` exists and we check for status 'TO_REMOVE'
    response = supabase.table("friend_links").select("*, skipper:skipper_id(*), user:user_id(*)").eq("status", "TO_REMOVE").limit(5).execute()
    
    if not response.data:
        logger.info("No guests pending unfriend. Exiting.")
        return

    ua = UserAgent()

    async with async_playwright() as p:
        # Launch browser with residential proxy
        proxy_config = None
        if PROXY_SERVER:
            proxy_config = {
                "server": PROXY_SERVER,
                "username": PROXY_USERNAME,
                "password": PROXY_PASSWORD
            }
            logger.info("Using Residential Proxy for this session.")
        else:
            logger.warning("No proxy configured. Running on local IP (High risk of detection).")

        browser = await p.chromium.launch(headless=True)
        
        for link in response.data:
            skipper = link['skipper']
            user = link['user']
            guest_name = user.get('name', 'Disney Guest')
            email = skipper['email']
            password = "StrongCastleP@ss1!" # Ideally fetched from Secrets Manager
            
            logger.info(f"Skipper {email} is attempting to unfriend {guest_name}...")
            
            context = await browser.new_context(
                user_agent=ua.random,
                proxy=proxy_config,
                viewport={'width': 1920, 'height': 1080}
            )
            page = await context.new_page()

            try:
                # 1. Login to Disney Account
                logger.info(f"Navigating to Disney Login...")
                await page.goto("https://disneyworld.disney.go.com/login/")
                
                # Input Credentials
                await page.fill("input[name='username']", email)
                await page.click("button[type='submit']")
                # Password screen
                await page.fill("input[name='password']", password)
                await page.click("button[type='submit']")
                
                logger.info("Waiting for login to complete...")
                await page.wait_for_timeout(5000) # Wait for redirects
                
                # 2. Navigate to Friends & Family
                logger.info(f"Navigating to Friends & Family List...")
                await page.goto("https://disneyworld.disney.go.com/profile/friends-family/")
                
                # 3. Locate the Guest and Remove
                # Note: DOM selectors must match current Disney markup
                logger.info(f"Searching for {guest_name} inside Friends List...")
                guest_element = page.locator(f"text='{guest_name}'")
                
                if await guest_element.count() > 0:
                    # Click the "Settings" or "Update" text near the guest
                    await guest_element.locator("..").locator("text='Settings'").first.click()
                    await page.wait_for_timeout(1000)
                    
                    # Click "Remove from My List"
                    await page.click("text='Remove from My List'")
                    
                    # Confirm Removal Modal
                    await page.click("button:has-text('Yes, Remove')")
                    
                    logger.info(f"Successfully unfriended {guest_name} from Skipper {email}.")
                    
                    # Update Supabase status
                    supabase.table("friend_links").update({"status": "REMOVED", "removed_at": datetime.now(timezone.utc).isoformat()}).eq("id", link["id"]).execute()
                    
                    # Free up the friend cap count on the Skipper account
                    current_count = skipper.get("active_friends", 1)
                    new_count = max(0, current_count - 1)
                    supabase.table("skipper_accounts").update({"active_friends": new_count}).eq("id", skipper["id"]).execute()

                else:
                    logger.warning(f"Guest {guest_name} not found on Skipper {email}'s list. Maybe already removed?")
                    supabase.table("friend_links").update({"status": "ERROR_NOT_FOUND"}).eq("id", link["id"]).execute()

            except Exception as e:
                logger.error(f"Error during Playwright execution for {email}: {e}")
                supabase.table("friend_links").update({"status": "ERROR"}).eq("id", link["id"]).execute()
            
            finally:
                await context.close()

if __name__ == "__main__":
    asyncio.run(run_unfriend_pipeline())
