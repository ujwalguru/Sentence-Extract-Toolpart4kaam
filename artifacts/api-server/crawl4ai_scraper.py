#!/usr/bin/env python3
"""
Crawl4AI page renderer for chat extraction.
Usage: python3 crawl4ai_scraper.py <url> [platform]
Output: JSON to stdout — { "title": "...", "html": "..." } or { "error": "..." }
"""

import asyncio
import json
import sys

PLATFORM_WAIT: dict[str, str] = {
    "chatgpt": "css:[data-message-author-role]",
    "claude":  "css:[data-testid='human-turn'],[data-testid='ai-turn'],.font-claude-message",
    "gemini":  "css:user-query,model-response,.user-query-container",
    "perplexity": "css:[data-testid='query-text']",
    "deepseek":   "css:[data-role='user'],[data-role='assistant']",
    "grok":       "css:article,[class*='message']",
    "mistral":    "css:[class*='UserBubble'],[class*='BotBubble']",
    "copilot":    "css:[data-testid*='message']",
}


async def main(url: str, platform: str) -> None:
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig

    browser_cfg = BrowserConfig(
        browser_type="firefox",
        headless=True,
        verbose=False,
        text_mode=False,
    )

    wait_for = PLATFORM_WAIT.get(platform)

    run_cfg = CrawlerRunConfig(
        page_timeout=45000,
        wait_for=wait_for,
        simulate_user=True,
        magic=True,
        verbose=False,
        scroll_delay=0.5,
        process_iframes=False,
    )

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        result = await crawler.arun(url=url, config=run_cfg)

        if not result.success:
            err = getattr(result, "error_message", None) or "crawl failed"
            print(json.dumps({"error": str(err)}))
            return

        title = ""
        meta = getattr(result, "metadata", None)
        if isinstance(meta, dict):
            title = meta.get("title", "") or ""

        print(json.dumps({"title": title, "html": result.html or ""}))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "URL argument required"}))
        sys.exit(1)

    target_url = sys.argv[1]
    target_platform = sys.argv[2] if len(sys.argv) >= 3 else "generic"

    try:
        asyncio.run(main(target_url, target_platform))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
