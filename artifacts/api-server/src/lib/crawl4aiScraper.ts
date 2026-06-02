import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import * as cheerio from "cheerio";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

// process.cwd() = artifacts/api-server/ when the server runs from its own dir
const PYTHON_BIN = path.join(process.cwd(), ".venv/bin/python");
const SCRIPT_PATH = path.join(process.cwd(), "crawl4ai_scraper.py");

// ─── Platform detection ───────────────────────────────────────────────────────
export type Platform =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "perplexity"
  | "deepseek"
  | "grok"
  | "mistral"
  | "copilot"
  | "generic";

export function detectPlatform(url: string): Platform {
  if (url.includes("chatgpt.com") || url.includes("chat.openai.com")) return "chatgpt";
  if (url.includes("claude.ai")) return "claude";
  if (url.includes("gemini.google.com") || url.includes("aistudio.google.com")) return "gemini";
  if (url.includes("perplexity.ai")) return "perplexity";
  if (url.includes("deepseek.com")) return "deepseek";
  if (url.includes("grok.com") || url.includes("x.com/i/grok")) return "grok";
  if (url.includes("mistral.ai") || url.includes("chat.mistral.ai")) return "mistral";
  if (url.includes("copilot.microsoft.com") || url.includes("bing.com/chat")) return "copilot";
  return "generic";
}

// ─── Shared types ─────────────────────────────────────────────────────────────
interface RawMessage {
  role: "user" | "assistant";
  content: string;
  content_html: string;
}

export interface ScrapedResult {
  title: string;
  messages: RawMessage[];
  platform: Platform;
}

// ─── Dead-state detection ─────────────────────────────────────────────────────
function checkDeadState(html: string): void {
  if (
    html.includes("Can't load shared conversation") ||
    html.includes("This conversation may have been deleted") ||
    html.includes("The conversation you requested could not be found") ||
    html.includes("Conversation has been deleted") ||
    html.includes("conversation has been deleted") ||
    html.includes("This chat has been deleted") ||
    html.includes("404 Not Found") ||
    html.includes("Page not found")
  ) {
    throw new Error("CHAT_DELETED");
  }
  if (
    html.includes("Just a moment") ||
    html.includes("cf-browser-verification") ||
    html.includes("Enable JavaScript and cookies to continue") ||
    html.includes("Checking if the site connection is secure")
  ) {
    throw new Error("CLOUDFLARE_BLOCKED");
  }
}

// ─── Deduplication ────────────────────────────────────────────────────────────
function dedup(msgs: RawMessage[]): RawMessage[] {
  const result: RawMessage[] = [];
  for (const m of msgs) {
    const prev = result[result.length - 1];
    if (prev && prev.role === m.role && prev.content.slice(0, 80) === m.content.slice(0, 80)) continue;
    result.push(m);
  }
  while (result.length > 0 && result[0].role !== "user") result.shift();
  return result;
}

// ─── Cheerio-based platform extractors ───────────────────────────────────────
// These mirror the page.evaluate() functions in the old Playwright scraper,
// now running on Crawl4AI's fully-rendered HTML output via cheerio.
function extractWithCheerio($: cheerio.CheerioAPI, platform: Platform): RawMessage[] {
  const cleanup = ($el: cheerio.Cheerio<any>): void => {
    $el.find("button, svg, [aria-hidden], .sr-only, mat-icon, .copy-btn").remove();
  };

  switch (platform) {
    case "chatgpt": {
      const msgs: RawMessage[] = [];
      $("[data-message-author-role]").each((_, el) => {
        const $el = $(el);
        const role = $el.attr("data-message-author-role") === "user" ? "user" : "assistant";
        const $inner = $el.find(".markdown, .prose").first();
        const $target = $inner.length ? $inner : $el;
        cleanup($target);
        const content = $target.text().trim();
        if (content.length > 1) msgs.push({ role, content, content_html: $target.html() || "" });
      });
      return msgs;
    }

    case "claude": {
      const msgs: RawMessage[] = [];
      const seen = new WeakSet();
      const selectors = [
        "[data-testid='human-turn']",
        "[data-testid='ai-turn']",
        ".font-user-message",
        ".font-claude-message",
        ".human-turn",
        ".ai-turn",
      ];
      for (const sel of selectors) {
        $(sel).each((_, el) => {
          if (seen.has(el)) return;
          seen.add(el);
          const $el = $(el);
          const cls = ($el.attr("class") || "").toLowerCase();
          const testId = $el.attr("data-testid") || "";
          const role: "user" | "assistant" =
            cls.includes("font-user-message") || testId.includes("human") || cls.includes("human-turn")
              ? "user"
              : "assistant";
          cleanup($el);
          const content = $el.text().trim();
          if (content.length > 1) msgs.push({ role, content, content_html: $el.html() || "" });
        });
      }
      return msgs;
    }

    case "gemini": {
      const entries: Array<{ role: "user" | "assistant"; $el: cheerio.Cheerio<any>; order: number }> = [];
      let i = 0;
      $("user-query, .user-query-container, .query-text").each((_, el) => {
        entries.push({ role: "user", $el: $(el), order: i++ });
      });
      $("model-response, .response-container, .model-response").each((_, el) => {
        entries.push({ role: "assistant", $el: $(el), order: i++ });
      });
      entries.sort((a, b) => a.order - b.order);
      return entries.map(({ role, $el }) => {
        const $inner = $el.find("p, .response-content, markdown-viewer, .formatted-text").first();
        const $target = $inner.length ? $inner : $el;
        cleanup($target);
        return { role, content: $target.text().trim(), content_html: $target.html() || "" };
      }).filter((m) => m.content.length > 1);
    }

    case "perplexity": {
      const msgs: RawMessage[] = [];
      $("[data-testid='query-text'], [class*='UserMessage'], [class*='user-message']").each((_, el) => {
        const $el = $(el);
        if ($el.closest("nav, header, footer, aside").length) return;
        cleanup($el);
        const content = $el.text().trim();
        if (content.length > 1) msgs.push({ role: "user", content, content_html: $el.html() || "" });
      });
      $("[class*='AnswerLayout'], [class*='AnswerSection'], [class*='answer-content'], .prose").each((_, el) => {
        const $el = $(el);
        if ($el.closest("nav, header, footer, aside").length) return;
        cleanup($el);
        const content = $el.text().trim();
        if (content.length > 1) msgs.push({ role: "assistant", content, content_html: $el.html() || "" });
      });
      return msgs;
    }

    case "deepseek": {
      const msgs: RawMessage[] = [];
      let $els = $("[data-role='user'], [data-role='assistant']");
      if (!$els.length) {
        $els = $("[class*='messageItem'], [class*='message-item'], [class*='chat-message']");
      }
      $els.each((_, el) => {
        const $el = $(el);
        const dataRole = $el.attr("data-role");
        const cls = ($el.attr("class") || "").toLowerCase();
        let role: "user" | "assistant" = "assistant";
        if (dataRole === "user" || cls.includes("user") || cls.includes("human")) role = "user";
        const $inner = $el.find(".ds-markdown, .markdown, .prose").first();
        const $target = $inner.length ? $inner : $el;
        cleanup($target);
        const content = $target.text().trim();
        if (content.length > 1) msgs.push({ role, content, content_html: $target.html() || "" });
      });
      return msgs;
    }

    case "grok": {
      const msgs: RawMessage[] = [];
      $("[class*='UserMessage'], [class*='BotMessage'], [class*='HumanMessage'], [class*='AssistantMessage'], article").each((_, el) => {
        const $el = $(el);
        const cls = ($el.attr("class") || "").toLowerCase();
        const role: "user" | "assistant" = cls.includes("user") || cls.includes("human") ? "user" : "assistant";
        cleanup($el);
        const content = $el.text().trim();
        if (content.length > 1) msgs.push({ role, content, content_html: $el.html() || "" });
      });
      return msgs;
    }

    case "mistral": {
      const msgs: RawMessage[] = [];
      $("[class*='UserBubble'], [class*='BotBubble'], [class*='human'], [class*='assistant'], [class*='user-message'], [class*='bot-message']").each((_, el) => {
        const $el = $(el);
        const cls = ($el.attr("class") || "").toLowerCase();
        const role: "user" | "assistant" = cls.includes("user") || cls.includes("human") ? "user" : "assistant";
        cleanup($el);
        const content = $el.text().trim();
        if (content.length > 1) msgs.push({ role, content, content_html: $el.html() || "" });
      });
      return msgs;
    }

    case "copilot": {
      const msgs: RawMessage[] = [];
      $("[data-testid*='user-message'], [data-testid*='assistant-message'], [class*='UserMessage'], [class*='BotMessage']").each((_, el) => {
        const $el = $(el);
        const testId = $el.attr("data-testid") || "";
        const cls = ($el.attr("class") || "").toLowerCase();
        const role: "user" | "assistant" = testId.includes("user") || cls.includes("user") ? "user" : "assistant";
        cleanup($el);
        const content = $el.text().trim();
        if (content.length > 1) msgs.push({ role, content, content_html: $el.html() || "" });
      });
      return msgs;
    }

    default: {
      const genericSelectors = [
        "[data-message-author-role]",
        "[data-role='user'], [data-role='assistant']",
        ".human-turn, .ai-turn",
        ".font-user-message, .font-claude-message",
        "user-query, model-response",
        "[class*='UserMessage'], [class*='AssistantMessage']",
        "[class*='HumanTurn'], [class*='AssistantTurn']",
        "article",
        ".message",
      ];
      const seen = new WeakSet();
      const msgs: RawMessage[] = [];
      for (const sel of genericSelectors) {
        $(sel).each((_, el) => {
          if (seen.has(el) || $(el).closest("nav, header, footer, aside").length) return;
          seen.add(el);
          const $el = $(el);
          const dataRole = $el.attr("data-message-author-role") || $el.attr("data-role") || "";
          const cls = ($el.attr("class") || "").toLowerCase();
          const role: "user" | "assistant" =
            dataRole === "user" || cls.includes("user") || cls.includes("human") ? "user" : "assistant";
          cleanup($el);
          const content = $el.text().trim();
          if (content.length > 1) msgs.push({ role, content, content_html: $el.html() || "" });
        });
        if (msgs.length > 0) break;
      }
      return msgs;
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function scrapeWithCrawl4AI(
  url: string,
  timeoutMs = 55000
): Promise<ScrapedResult> {
  const platform = detectPlatform(url);
  logger.info({ url, platform }, "Crawl4AI: starting scrape");

  let stdout = "";
  try {
    const result = await execFileAsync(
      PYTHON_BIN,
      [SCRIPT_PATH, url, platform],
      {
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env },
      }
    );
    stdout = result.stdout.trim();
  } catch (err: any) {
    if (err.code === "ETIMEDOUT" || err.signal === "SIGTERM") {
      throw new Error("EXTRACTION_TIMEOUT");
    }
    stdout = (err.stdout || "").trim();
    if (!stdout) {
      logger.error({ err: err.message, stderr: (err.stderr || "").slice(0, 500) }, "Crawl4AI: process error");
      throw new Error(`Crawl4AI process failed: ${err.message}`);
    }
  }

  let parsed: { title?: string; html?: string; error?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Crawl4AI: invalid JSON — ${stdout.slice(0, 200)}`);
  }

  if (parsed.error) {
    const msg = parsed.error;
    logger.warn({ msg, url }, "Crawl4AI: python script returned error");
    if (msg.includes("ERR_NAME_NOT_RESOLVED") || msg.includes("ERR_CONNECTION_REFUSED") || msg.includes("404")) {
      throw new Error("CHAT_DELETED");
    }
    if (msg.toLowerCase().includes("timeout") || msg.includes("TimeoutError")) {
      throw new Error("EXTRACTION_TIMEOUT");
    }
    throw new Error(`Crawl4AI: ${msg}`);
  }

  const html = parsed.html || "";
  if (html.length < 300) {
    throw new Error("PARSING_FAILED: page returned empty content");
  }

  checkDeadState(html);

  const $ = cheerio.load(html);
  const pageTitle = parsed.title || $("title").first().text().trim() || "Extracted Chat";

  let messages = extractWithCheerio($, platform);
  if (messages.length === 0 && platform !== "generic") {
    logger.warn({ platform, url }, "Crawl4AI: platform extractor empty — trying generic");
    messages = extractWithCheerio($, "generic");
  }

  logger.info({ platform, msgCount: messages.length, title: pageTitle }, "Crawl4AI: extraction complete");
  return { title: pageTitle, messages: dedup(messages), platform };
}
