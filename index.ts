/**
 * Cron Scheduler Extension
 * 
 * Manages scheduled tasks and generates AI Morning Reports.
 * Sends messages via msg-gateway Daemon (Discord/Telegram).
 * 
 * Features:
 * - /cron list, add, remove, enable, disable
 * - Morning Report daily at 7 AM (configurable)
 * - AI Trend-Report with live web search:
 *   - Top 5 Trending AI GitHub Repositories
 *   - New AI Models (Last 24h)
 *   - Cheap Providers/Subscriptions/Free Models
 *   - Top 5 Hype & Trends (Last 24h)
 * 
 * Uses keyless web search (Brave/DuckDuckGo) for live data.
 * Uses msg-gateway Daemon for Discord/Telegram.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = __dirname;
const CONFIG_DIR = join(EXTENSION_DIR, "..", ".pi", "cron-scheduler");
const CONFIG_FILE = join(CONFIG_DIR, "jobs.json");
const CACHE_FILE = join(CONFIG_DIR, "report-cache.json");
const LOG_FILE = join(CONFIG_DIR, "scheduler.log");

// ── Logger ────────────────────────────────────────────────────────────
function log(msg: string): void {
  const ts = new Date().toISOString();
  try {
    ensureConfigDir();
    appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  } catch {
    // Best-effort logging — fail silently if disk write fails
  }
}

const DAEMON_URL = "http://127.0.0.1:3034";

// ── Types ────────────────────────────────────────────────────────────
interface CronJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  action: "morning-report" | "custom" | "search";
  params?: Record<string, string>;
  lastRun?: number;
  nextRun?: number;
  lastResult?: string;
}

interface ReportCache {
  githubRepos?: GitHubRepo[];
  aiModels?: SearchResult[];
  cheapProviders?: SearchResult[];
  trends?: SearchResult[];
  lastUpdated?: number;
}

interface GitHubRepo {
  rank: number;
  name: string;
  description: string;
  stars: number;
  language: string;
  url: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

// ── Config Management ───────────────────────────────────────────────
function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadJobs(): CronJob[] {
  try {
    ensureConfigDir();
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveJobs(jobs: CronJob[]): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(jobs, null, 2));
}

function loadCache(): ReportCache {
  try {
    if (existsSync(CACHE_FILE)) {
      return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveCache(cache: ReportCache): void {
  ensureConfigDir();
  cache.lastUpdated = Date.now();
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── Cron Parser ─────────────────────────────────────────────────────
function parseCronNext(schedule: string, from: Date = new Date()): Date | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return null;
  
  const [min, hour] = parts;
  const now = new Date(from);
  
  const targetMin = parseInt(min);
  const targetHour = parseInt(hour);
  
  const next = new Date(now);
  next.setHours(targetHour, targetMin, 0, 0);
  
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  
  return next;
}

function formatNextRun(date: Date): string {
  return date.toLocaleString("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// ── Daemon Communication ─────────────────────────────────────────────
async function sendToDaemon(platform: string, message: string, retries = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${DAEMON_URL}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, message }),
        signal: AbortSignal.timeout(30000),
      });
      
      const result = await res.json();
      
      if (result.success === true) return true;
      if (platform === "discord" && result.discord === true) return true;
      if (platform === "telegram" && result.telegram === true) return true;
      
      // If failed with 500, retry
      if (res.status >= 500 && attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      
      return false;
    } catch (err: any) {
      log(`[cron-scheduler] sendToDaemon error: ${err.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
    }
  }
  
  return false;
}

async function isDaemonRunning(): Promise<boolean> {
  try {
    await fetch(`${DAEMON_URL}/status`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

// ── Keyless Web Search (DuckDuckGo) ────────────────────────────────
const MAX_SEARCH_RESULTS = 5;
const MAX_SNIPPET_CHARS = 200;

async function webSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const results = await duckDuckGoSearch(query, signal);
    if (results.length > 0) {
      return results;
    }
    log(`[cron-scheduler] DDG empty results for: ${query}`);
  } catch (err) {
    log(`[cron-scheduler] DDG search failed: ${err}`);
  }
  return [];
}

async function duckDuckGoSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  url.searchParams.set("df", "d"); // Past 24 hours
  
  const response = await fetch(url.toString(), {
    method: "GET",
    redirect: "follow",
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "text/html",
    }
  });
  
  if (!response.ok) {
    throw new Error(`DDG failed: ${response.status}`);
  }
  
  const html = await response.text();
  return parseDDGResults(html);
}

function parseDDGResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  
  // Get all titles with URLs
  const titleMatches = [...html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi)];
  
  // Get all snippets (they are <a class="result__snippet"> tags)
  const snippetRE = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [...html.matchAll(snippetRE)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim());
  
  for (let i = 0; i < titleMatches.length && results.length < MAX_SEARCH_RESULTS; i++) {
    let rawUrl = titleMatches[i][1];
    const title = decodeHTMLEntities(titleMatches[i][2].trim());
    
    // Extract real URL from DDG redirect (uddg=ENCODED_URL)
    let url = rawUrl;
    if (url.includes('uddg=')) {
      const match = url.match(/uddg=([^&]+)/);
      if (match) {
        url = decodeURIComponent(match[1]);
      }
    }
    
    if (!url.startsWith("https://") && !url.startsWith("http://")) continue;
    if (seen.has(url)) continue;
    
    seen.add(url);
    results.push({
      title,
      url,
      snippet: snippets[i] ? decodeHTMLEntities(snippets[i].trim()) : ""
    });
  }
  
  return results;
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ── GitHub API ─────────────────────────────────────────────────────────
async function fetchGitHubTrending(): Promise<GitHubRepo[]> {
  try {
    // Filter repositories pushed in last 2 days
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 2);
    const pushedDate = yesterday.toISOString().split('T')[0];
    const query = encodeURIComponent(`stars:>1000 pushed:>=${pushedDate}`);
    const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&per_page=5&cache-bust=${Date.now()}`;
    
    const res = await fetch(url, {
      headers: {
        "User-Agent": "pi-cron-scheduler/1.0",
        "Accept": "application/vnd.github.v3+json"
      },
      signal: AbortSignal.timeout(10000)
    });
    
    if (!res.ok) {
      log(`[cron-scheduler] GitHub API error: ${res.status}`);
      return getCachedGitHubRepos();
    }
    
    const data = await res.json();
    const repos: GitHubRepo[] = (data.items || []).slice(0, 5).map((item: any, idx: number) => ({
      rank: idx + 1,
      name: item.full_name,
      description: item.description || "No description",
      stars: item.stargazers_count,
      language: item.language || "Unknown",
      url: item.html_url
    }));
    
    return repos;
  } catch (err) {
    log(`[cron-scheduler] GitHub fetch failed: ${err}`);
    return getCachedGitHubRepos();
  }
}

function getCachedGitHubRepos(): GitHubRepo[] {
  const cache = loadCache();
  return cache.githubRepos || [
    { rank: 1, name: "ggerganov/llama.cpp", description: "LLM inference in pure C/C++", stars: 78200, language: "C++", url: "https://github.com/ggerganov/llama.cpp" },
    { rank: 2, name: "openai/openai-python", description: "Python SDK for OpenAI API", stars: 64000, language: "Python", url: "https://github.com/openai/openai-python" },
    { rank: 3, name: "ollama/ollama", description: "Get up and running with Llama 3", stars: 89000, language: "Go", url: "https://github.com/ollama/ollama" },
    { rank: 4, name: "huggingface/transformers", description: "State-of-the-art ML", stars: 126000, language: "Python", url: "https://github.com/huggingface/transformers" },
    { rank: 5, name: "anthropics/anthropic-sdk-python", description: "Anthropic's AI models SDK", stars: 12500, language: "Python", url: "https://github.com/anthropics/anthropic-sdk-python" },
    { rank: 6, name: "meta-llama/llama3", description: "Meta's Llama 3 models", stars: 45000, language: "Python", url: "https://github.com/meta-llama/llama3" },
    { rank: 7, name: "mistralai/mistral-finetune", description: "Mistral model fine-tuning", stars: 5200, language: "Python", url: "https://github.com/mistralai/mistral-finetune" },
    { rank: 8, name: "gradio-app/gradio", description: "Build ML demos fast", stars: 32000, language: "Python", url: "https://github.com/gradio-app/gradio" },
    { rank: 9, name: "EleutherAI/gpt-neox", description: "GPT-NeoX implementations", stars: 9800, language: "Python", url: "https://github.com/EleutherAI/gpt-neox" },
    { rank: 10, name: "stanford-oval/llama-microscope", description: "Analyze LLM internals", stars: 3100, language: "Python", url: "https://github.com/stanford-oval/llama-microscope" },
  ];
}

// ── Build Full Morning Report ─────────────────────────────────────────
async function buildMorningReport(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  
  const timeStr = now.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit"
  });
  
  const divider = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
  const thinLine = "──────────────────────────────";
  
  log("[cron-scheduler] Fetching GitHub trending...");
  const githubRepos = await fetchGitHubTrending();
  
  log("[cron-scheduler] Searching for AI models...");
  const aiModels = await webSearch("new AI model released yesterday");
  
  log("[cron-scheduler] Searching for cheap providers...");
  const cheapProviders = await webSearch("new cheap AI API free tier announced yesterday");
  
  log("[cron-scheduler] Searching for AI trends...");
  const trends = await webSearch("AI news trends yesterday");
  
  // Build report
  let report = `🤖 *AI Morning Report*\n`;
  report += `${divider}\n`;
  report += `📅 ${dateStr} | ⏰ ${timeStr}\n`;
  report += `${divider}\n\n`;
  
  // Section 1: GitHub Trending
  report += `*🚀 Top 5 Trending AI Repositories*\n`;
  report += `${thinLine}\n`;
  for (const repo of githubRepos) {
    const desc = repo.description.length > 60 
      ? repo.description.substring(0, 57) + "..." 
      : repo.description;
    report += `\`${repo.rank}.\` **${repo.name.split('/')[1]}**\n`;
    report += `   📊 ⭐ ${formatStars(repo.stars)} | ${repo.language} | [Link](${repo.url})\n`;
    report += `   ${desc}\n\n`;
  }
  report += `\n`;
  
  // Section 2: AI Models
  report += `*🧠 New AI Models (Last 24h)*\n`;
  report += `${thinLine}\n`;
  if (aiModels.length > 0) {
    for (const model of aiModels.slice(0, 5)) {
      const snippet = model.snippet ? model.snippet.slice(0, MAX_SNIPPET_CHARS) : "";
      report += `▸ **${model.title}**\n`;
      if (snippet) report += `   ${snippet}...\n`;
      report += `   [Link](${model.url})\n\n`;
    }
  } else {
    report += `_No recent data available_\n\n`;
  }
  
  // Section 3: Cheap Providers
  report += `*💰 Cheap Providers & Free Models (Last 24h)*\n`;
  report += `${thinLine}\n`;
  if (cheapProviders.length > 0) {
    for (const p of cheapProviders.slice(0, 5)) {
      const snippet = p.snippet ? p.snippet.slice(0, MAX_SNIPPET_CHARS) : "";
      report += `▸ **${p.title}**\n`;
      if (snippet) report += `   ${snippet}...\n`;
      report += `   [Link](${p.url})\n\n`;
    }
  } else {
    report += `_No recent data available_\n\n`;
  }
  
  // Section 4: Trends
  report += `*🔥 Top 5 Hype & Trends (Last 24h)*\n`;
  report += `${thinLine}\n`;
  if (trends.length > 0) {
    for (let i = 0; i < Math.min(trends.length, 5); i++) {
      const t = trends[i];
      const snippet = t.snippet ? t.snippet.slice(0, MAX_SNIPPET_CHARS) : "";
      report += `\`${i + 1}.\` **${t.title}**\n`;
      if (snippet) report += `   ${snippet}...\n`;
      report += `   [Link](${t.url})\n\n`;
    }
  } else {
    report += `_No recent data available_\n\n`;
  }
  
  report += `\n${divider}\n`;
  report += `_Report generated by pi cron-scheduler | ${now.toLocaleTimeString("de-DE")}_`;
  
  // Save to cache
  saveCache({ githubRepos, aiModels, cheapProviders, trends });
  
  log("[cron-scheduler] Report built successfully");
  return report;
}

function formatStars(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k ⭐`;
  }
  return `${count} ⭐`;
}

function splitMessage(text: string, maxLen: number): string[] {
  const parts: string[] = [];
  const lines = text.split('\n');
  let current = '';
  
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) parts.push(current.trimEnd());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  
  if (current) parts.push(current.trimEnd());
  return parts.length > 0 ? parts : [text];
}

// ── Main Extension ───────────────────────────────────────────────────
export default function cronSchedulerExtension(pi: ExtensionAPI) {
  let schedulerInterval: NodeJS.Timeout | null = null;
  let statusInterval: NodeJS.Timeout | null = null;
  
  function updateStatusUI(ctx: ExtensionContext, text: string | undefined): void {
    try {
      ctx.ui.setStatus("cron-scheduler", text);
    } catch {
      // ctx may be stale after session reload — silently ignore
    }
  }
  
  async function runMorningReport(job: CronJob, ctx?: ExtensionContext): Promise<void> {
    try {
      const daemonOk = await isDaemonRunning();
      log(`[cron-scheduler] Daemon running: ${daemonOk}`);
      
      if (!daemonOk) {
        log("[cron-scheduler] Daemon offline, skipping report");
        job.lastResult = "failed: daemon offline";
        if (ctx) updateStatusUI(ctx, "🔴 Daemon offline");
        return;
      }
      
      log("[cron-scheduler] Calling sendToDaemon...");
      const started = await sendToDaemon("discord", 
        `🤖 *Morning Report being generated...*\n\n📡 Scraping latest AI trends...\n\n_This may take a moment..._`
      );
      log(`[cron-scheduler] Initial message sent: ${started}`);
      log(`[cron-scheduler] Type of started: ${typeof started}`);
      
      if (!started) {
        log("[cron-scheduler] Failed to send initial message");
        job.lastResult = "failed: could not send initial message";
        if (ctx) updateStatusUI(ctx, "🔴 Send failed");
        return;
      }
      
      if (ctx) updateStatusUI(ctx, "🔄 Searching...");
      
      log("[cron-scheduler] Building report...");
      const reportContent = await buildMorningReport();
      log(`[cron-scheduler] Report built, length: ${reportContent.length}`);
      
      // Discord limit is 2000 chars - split if needed
      if (reportContent.length > 1900) {
        const parts = splitMessage(reportContent, 1900);
        log(`[cron-scheduler] Splitting report into ${parts.length} parts`);
        
        for (let i = 0; i < parts.length; i++) {
          log(`[cron-scheduler] Sending part ${i+1}/${parts.length} (${parts[i].length} chars)...`);
          
          // Wait 3s between parts to avoid rate limiting
          if (i > 0) await new Promise(r => setTimeout(r, 3000));
          
          const partSent = await sendToDaemon("discord", parts[i]);
          log(`[cron-scheduler] Part ${i+1} sent: ${partSent}`);
          
          if (!partSent) {
            job.lastResult = `failed: send error part ${i+1}`;
            return;
          }
        }
        
        job.lastResult = "success";
        return;
      }
      
      log("[cron-scheduler] Sending final report...");
      log(`[cron-scheduler] Report preview: ${reportContent.slice(0, 100)}...`);
      
      // Add delay to avoid rate limiting
      log("[cron-scheduler] Waiting 5s to avoid Discord rate limiting...");
      await new Promise(r => setTimeout(r, 5000));
      
      log(`[cron-scheduler] Starting second daemon call...`);
      const sent = await sendToDaemon("discord", reportContent);
      log(`[cron-scheduler] Final report sent result: ${sent}`);
      
      if (sent) {
        job.lastResult = "success";
        job.lastRun = Date.now();
        log("[cron-scheduler] Morning report sent successfully");
        if (ctx) updateStatusUI(ctx, "✅ Report sent");
      } else {
        job.lastResult = "failed: send error";
        if (ctx) updateStatusUI(ctx, "🔴 Send error");
      }
    } catch (err: any) {
      job.lastResult = `error: ${err.message}`;
      log(`[cron-scheduler] Report failed: ${err.message}`);
      if (ctx) updateStatusUI(ctx, `🔴 ${err.message}`);
    }
    
    saveJobs(loadJobs());
  }
  
  async function checkAndRunJobs(ctx?: ExtensionContext): Promise<void> {
    const jobs = loadJobs();
    const now = Date.now();
    
    for (const job of jobs) {
      if (!job.enabled) continue;
      
      const nextRun = parseCronNext(job.schedule);
      if (!nextRun) continue;
      
      if (Math.abs(now - nextRun.getTime()) < 60000) {
        log(`[cron-scheduler] Running job: ${job.name}`);
        
        if (job.action === "morning-report") {
          await runMorningReport(job, ctx);
        }
        
        job.lastRun = now;
        job.nextRun = parseCronNext(job.schedule)?.getTime();
        saveJobs(jobs);
      }
    }
  }
  
  pi.on("session_start", async (_event, ctx) => {
    // Always clear old intervals on session start — the old ctx is stale after reload
    if (schedulerInterval) {
      clearInterval(schedulerInterval);
      schedulerInterval = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }

    const jobs = loadJobs();
    if (jobs.length === 0) {
      const defaultJob: CronJob = {
        id: "morning-report",
        name: "Morning AI Report",
        schedule: "0 7 * * *",
        enabled: true,
        action: "morning-report",
        nextRun: parseCronNext("0 7 * * *")?.getTime(),
      };
      saveJobs([defaultJob]);
    }
    
    schedulerInterval = setInterval(() => checkAndRunJobs(ctx), 60000);
    checkAndRunJobs(ctx);
    
    const enabledJobs = loadJobs().filter(j => j.enabled);
    if (enabledJobs.length === 0) {
      updateStatusUI(ctx, "⚫ No Cron Jobs");
    } else {
      const next = enabledJobs
        .map(j => ({ name: j.name, next: parseCronNext(j.schedule) }))
        .filter(j => j.next && j.next.getTime() > Date.now())
        .sort((a, b) => a.next!.getTime() - b.next!.getTime())[0];
      
      if (next) {
        updateStatusUI(ctx, `⏰ ${next.name} ${formatNextRun(next.next)}`);
      }
    }
    
    statusInterval = setInterval(() => {
      try {
        const jobs = loadJobs();
        const enabled = jobs.filter(j => j.enabled);
        if (enabled.length > 0) {
          const next = enabled
            .map(j => ({ name: j.name, next: parseCronNext(j.schedule) }))
            .filter(j => j.next && j.next.getTime() > Date.now())
            .sort((a, b) => a.next!.getTime() - b.next!.getTime())[0];
          if (next) {
            ctx.ui.setStatus("cron-scheduler", `⏰ ${next.name} ${formatNextRun(next.next)}`);
          }
        }
      } catch {
        // ctx may have become stale between session reloads — interval will be
        // replaced on next session_start; silently ignore stale-access errors.
      }
    }, 300000);
  });
  
  pi.registerTool({
    name: "generate-morning-report",
    label: "Morning Report",
    description: "Daily AI Morning Report with Top 5 GitHub repos, new AI models, cheap providers, trends",
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const jobs = loadJobs();
      const reportJob = jobs.find(j => j.id === "morning-report");
      
      if (!reportJob) {
        return {
          content: [{ type: "text", text: "Morning Report job not found." }],
          details: {},
        };
      }
      
      if (!(await isDaemonRunning())) {
        return {
          content: [{ type: "text", text: "❌ msg-gateway Daemon not reachable." }],
          details: {},
        };
      }
      
      ctx.ui.notify("🤖 Morning Report being generated...", "info");
      await runMorningReport(reportJob, ctx);
      
      return {
        content: [{ type: "text", text: reportJob.lastResult === "success" 
          ? "✅ Morning Report sent to Discord!" 
          : `❌ Error: ${reportJob.lastResult}` }],
        details: { result: reportJob.lastResult },
      };
    },
  });
  
  pi.registerCommand("cron", {
    description: "Cron Scheduler - manage scheduled tasks",
    getArgumentCompletions: (prefix) => {
      const subs = ["list", "add", "remove", "enable", "disable", "test", "config", "status", "now"];
      return subs.filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      const jobs = loadJobs();
      
      if (!sub || sub === "list") {
        if (jobs.length === 0) {
          ctx.ui.notify("No Cron jobs configured.", "info");
          return;
        }
        
        const lines = ["**📋 Cron Jobs:**", ""];
        for (const job of jobs) {
          const status = job.enabled ? "🟢" : "🔴";
          const next = job.nextRun ? new Date(job.nextRun).toLocaleString("de-DE", { 
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" 
          }) : "N/A";
          const last = job.lastRun ? new Date(job.lastRun).toLocaleString("de-DE", { 
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" 
          }) : "Never";
          
          lines.push(`${status} **${job.name}** (${job.id})`);
          lines.push(`   Schedule: ${job.schedule}`);
          lines.push(`   Next: ${next} | Last: ${last}`);
          if (job.lastResult) lines.push(`   Result: ${job.lastResult}`);
          lines.push("");
        }
        
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      
      if (sub === "status") {
        const running = jobs.filter(j => j.enabled).length;
        const daemonRunning = await isDaemonRunning();
        ctx.ui.notify(
          `📊 Status:\n` +
          `• ${running}/${jobs.length} jobs active\n` +
          `• Daemon: ${daemonRunning ? "🟢 Online" : "🔴 Offline"}\n` +
          `• Config: ${CONFIG_FILE}`,
          "info"
        );
        return;
      }
      
      if (sub === "now") {
        const reportJob = jobs.find(j => j.id === "morning-report");
        if (!reportJob) {
          ctx.ui.notify("Morning Report job not found.", "error");
          return;
        }
        
        ctx.ui.notify("🔄 Morning Report being generated...", "info");
        await runMorningReport(reportJob, ctx);
        ctx.ui.notify(reportJob.lastResult === "success" ? "✅ Report sent!" : `❌ ${reportJob.lastResult}`, 
          reportJob.lastResult === "success" ? "success" : "error");
        return;
      }
      
      if (sub === "add") {
        const name = parts.slice(1, -3).join(" ") || "New Job";
        const schedule = parts[parts.length - 3];
        const action = parts[parts.length - 2] as "morning-report" | "search";
        
        if (!schedule || !action) {
          ctx.ui.notify("Usage: /cron add <name> <schedule> <action>\nExample: /cron add \"Report\" \"0 7 * * *\" morning-report", "warning");
          return;
        }
        
        const newJob: CronJob = {
          id: `job-${Date.now()}`,
          name,
          schedule,
          enabled: true,
          action,
          nextRun: parseCronNext(schedule)?.getTime(),
        };
        
        jobs.push(newJob);
        saveJobs(jobs);
        const next = parseCronNext(schedule);
        ctx.ui.notify(`✅ Job created: "${name}"\nNext: ${next ? formatNextRun(next) : "N/A"}`, "success");
        return;
      }
      
      if (sub === "remove") {
        const idOrName = parts[1];
        if (!idOrName) {
          ctx.ui.notify("Usage: /cron remove <id|name>", "warning");
          return;
        }
        
        const idx = jobs.findIndex(j => j.id === idOrName || j.name === idOrName);
        if (idx === -1) {
          ctx.ui.notify(`Job "${idOrName}" not found.`, "warning");
          return;
        }
        
        const removed = jobs.splice(idx, 1)[0];
        saveJobs(jobs);
        ctx.ui.notify(`🗑️ Job removed: "${removed.name}"`, "info");
        return;
      }
      
      if (sub === "enable" || sub === "disable") {
        const idOrName = parts[1];
        if (!idOrName) {
          ctx.ui.notify(`Usage: /cron ${sub} <id|name>`, "warning");
          return;
        }
        
        const job = jobs.find(j => j.id === idOrName || j.name === idOrName);
        if (!job) {
          ctx.ui.notify(`Job "${idOrName}" not found.`, "warning");
          return;
        }
        
        job.enabled = sub === "enable";
        job.nextRun = job.enabled ? parseCronNext(job.schedule)?.getTime() : undefined;
        saveJobs(jobs);
        ctx.ui.notify(`${job.enabled ? "🟢" : "🔴"} Job ${sub}d: "${job.name}"`, "info");
        return;
      }
      
      if (sub === "test") {
        const targetJob = parts[1];
        
        let jobsToTest = loadJobs().filter(j => j.enabled);
        
        if (targetJob) {
          const job = jobsToTest.find(j => j.id === targetJob || j.name === targetJob);
          if (!job) {
            ctx.ui.notify(`Job "${targetJob}" not found or disabled.`, "warning");
            return;
          }
          jobsToTest = [job];
          ctx.ui.notify(`🧪 Testing job: "${job.name}"...`, "info");
        } else {
          ctx.ui.notify(`🧪 Testing ${jobsToTest.length} active job(s)...`, "info");
        }
        
        for (const job of jobsToTest) {
          log(`[cron-scheduler] Testing job: ${job.name}`);
          
          if (job.action === "morning-report") {
            await runMorningReport(job, ctx);
          }
          
          // Small delay between jobs
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        const results = jobsToTest.map(j => 
          `${j.name}: ${j.lastResult || "no result"}`
        ).join("\n");
        ctx.ui.notify(`Test complete:\n${results}`, "info");
        return;
      }
      
      if (sub === "config") {
        const subCmd = parts[1];
        
        if (subCmd === "time") {
          const time = parts[2];
          const job = jobs.find(j => j.id === "morning-report");
          if (!job) {
            ctx.ui.notify("Morning Report job not found.", "error");
            return;
          }
          
          const match = time.match(/^(\d{1,2}):(\d{2})$/);
          if (!match) {
            ctx.ui.notify("Format: HH:MM (e.g. 7:30)", "warning");
            return;
          }
          
          job.schedule = `0 ${match[1]} * * *`;
          job.nextRun = parseCronNext(job.schedule)?.getTime();
          saveJobs(jobs);
          const next = parseCronNext(job.schedule);
          ctx.ui.notify(`⏰ Time changed to ${time} (Next: ${next ? formatNextRun(next) : "N/A"})`, "success");
          return;
        }
        
        ctx.ui.notify("Config: /cron config time <HH:MM>", "info");
        return;
      }
      
      ctx.ui.notify(
        "Commands:\n" +
        "• /cron list - Show all jobs\n" +
        "• /cron now - Send report immediately\n" +
        "• /cron add <name> <schedule> <action>\n" +
        "• /cron remove/enable/disable <name>\n" +
        "• /cron config time <HH:MM>\n" +
        "• /cron status",
        "info"
      );
    },
  });
  
  pi.registerCommand("morning-report", {
    description: "Generates and sends AI Morning Report to Discord",
    handler: async (_args, ctx) => {
      ctx.ui.notify("🔄 Generating Morning Report...", "info");
      
      const jobs = loadJobs();
      const reportJob = jobs.find(j => j.id === "morning-report");
      
      if (reportJob) {
        await runMorningReport(reportJob, ctx);
        ctx.ui.notify(reportJob.lastResult === "success" ? "✅ Report sent!" : `❌ ${reportJob.lastResult}`,
          reportJob.lastResult === "success" ? "success" : "error");
      } else {
        ctx.ui.notify("Morning Report job not found", "error");
      }
    },
  });
  
  pi.on("session_shutdown", () => {
    if (schedulerInterval) {
      clearInterval(schedulerInterval);
      schedulerInterval = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
  });
}