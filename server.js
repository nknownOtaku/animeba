/**
 * AnimePahe Scraper API Server
 * Deployed on Render with Cloudflare bypass
 * 
 * Features:
 * - Cloudflare IUAM bypass via cloudscraper
 * - TTL-based caching with memory limits
 * - Health check endpoint for Render
 * - Graceful shutdown handling
 * - Error handling middleware
 * - Rate limiting ready
 */

require("dotenv").config();
const express = require("express");
const cloudscraper = require("cloudscraper");
const cheerio = require("cheerio");
const { VM } = require("vm2");
const cors = require("cors");
const path = require("path");

// ============================
// Configuration
// ============================
const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://animepahe.si"; // Current working domain
const NODE_ENV = process.env.NODE_ENV || "development";

// Logging helper
const log = (level, msg) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${msg}`);
};

// ============================
// Middleware
// ============================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Request logging (production only)
if (NODE_ENV === "production") {
  app.use((req, res, next) => {
    const start = Date.now();    res.on("finish", () => {
      const duration = Date.now() - start;
      log("info", `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });
}

// ============================
// Cloudflare-Bypass HTTP Client
// ============================
async function cfGet(url, options = {}) {
  return cloudscraper({
    uri: url,
    headers: {
      "User-Agent": process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": BASE + "/",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      ...options.headers
    },
    challengeTimeout: 20000,
    timeout: 30000,
    gzip: true,
    ...options
  });
}

// ============================
// Cache with TTL and Memory Limits
// ============================
const CACHE = {};
const TTL = {
  latest: 2 * 60 * 1000,      // 2 minutes
  episodes: 30 * 60 * 1000,   // 30 minutes
  downloads: 15 * 60 * 1000,  // 15 minutes
  video: 5 * 60 * 1000        // 5 minutes (video links expire fast)
};

const MAX_CACHE_SIZE = 1000; // Max entries to prevent memory issues
const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // Clean every 5 minutes

function cached(key, type, fn) {
  const now = Date.now();
  const item = CACHE[key];
  if (item && now - item.ts < TTL[type]) {
    log("debug", `Cache hit: ${key} (${type})`);    return Promise.resolve(item.data);
  }
  log("debug", `Cache miss: ${key} (${type})`);
  return fn().then(data => {
    CACHE[key] = { data, ts: now };
    return data;
  });
}

function cleanupCache() {
  const now = Date.now();
  let deleted = 0;
  
  // Remove expired entries
  Object.keys(CACHE).forEach(key => {
    const item = CACHE[key];
    // Find the TTL type for this cache entry
    const ttlType = Object.keys(TTL).find(t => 
      (t === 'latest' && key.startsWith('latest_')) ||
      (t === 'episodes' && key.startsWith('ep_')) ||
      (t === 'downloads' && key.startsWith('dl_')) ||
      (t === 'video' && key.startsWith('vid_'))
    );
    
    if (ttlType && now - item.ts >= TTL[ttlType]) {
      delete CACHE[key];
      deleted++;
    }
  });
  
  // Hard limit - remove oldest if over max size
  const keys = Object.keys(CACHE);
  if (keys.length > MAX_CACHE_SIZE) {
    const sorted = keys.sort((a, b) => CACHE[a].ts - CACHE[b].ts);
    const toDelete = sorted.slice(0, keys.length - MAX_CACHE_SIZE);
    toDelete.forEach(key => {
      delete CACHE[key];
      deleted++;
    });
  }
  
  if (deleted > 0) {
    log("info", `Cache cleanup: removed ${deleted} entries`);
  }
}

// Start cache cleanup interval
setInterval(cleanupCache, CACHE_CLEANUP_INTERVAL);
log("info", `Cache cleanup scheduled every ${CACHE_CLEANUP_INTERVAL / 1000}s`);
// ============================
// API: Health Check (Required for Render)
// ============================
app.get("/api/health", (req, res) => {
  const cacheSize = Object.keys(CACHE).length;
  const memoryUsage = process.memoryUsage();
  
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: {
      heapUsed: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2) + " MB",
      heapTotal: (memoryUsage.heapTotal / 1024 / 1024).toFixed(2) + " MB",
      rss: (memoryUsage.rss / 1024 / 1024).toFixed(2) + " MB"
    },
    cache: {
      size: cacheSize,
      maxSize: MAX_CACHE_SIZE
    },
    environment: NODE_ENV
  });
});

// ============================
// API: Get Latest Releases (uses official API)
// ============================
app.get("/api/latest", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    if (page < 1 || page > 100) {
      return res.status(400).json({ 
        success: false, 
        error: "Page must be between 1 and 100" 
      });
    }
    
    const data = await cached(`latest_${page}`, "latest", async () => {
      log("info", `Fetching latest releases page ${page}`);
      const body = await cfGet(`${BASE}/api?m=release&sort=episode_desc&page=${page}`);
      const json = JSON.parse(body);
      
      if (!json.data || !Array.isArray(json.data)) {
        return [];
      }
      
      return json.data.slice(0, limit).map(item => ({
        id: item.id,        title: item.title,
        episode: item.episode,
        session: item.session,
        anime_session: item.anime_session,
        thumbnail: item.snapshot,
        duration: item.duration,
        created_at: item.created_at,
        anime_url: `${BASE}/anime/${item.anime_session}`,
        episode_url: `${BASE}/play/${item.anime_session}/${item.session}`
      }));
    });
    
    res.json({ 
      success: true, 
      data, 
      page, 
      total: data.length 
    });
  } catch (err) {
    log("error", `Latest releases error: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch latest releases",
      details: NODE_ENV === "development" ? err.message : undefined
    });
  }
});

// ============================
// API: Get Episodes for Anime
// ============================
app.get("/api/episodes/:animeSession", async (req, res) => {
  try {
    const { animeSession } = req.params;
    const page = parseInt(req.query.page) || 1;
    const sort = req.query.sort || "episode_desc";
    
    if (!animeSession || animeSession.length > 100) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid anime session ID" 
      });
    }
    
    const data = await cached(`ep_${animeSession}_${sort}_${page}`, "episodes", async () => {
      log("info", `Fetching episodes for ${animeSession} page ${page}`);
      const body = await cfGet(`${BASE}/api?m=release&sort=${sort}&page=${page}&id=${animeSession}`);
      const json = JSON.parse(body);
      
      if (!json.data || !Array.isArray(json.data)) {        return [];
      }
      
      return json.data.map(ep => ({
        id: ep.id,
        episode: ep.episode,
        title: ep.title || `Episode ${ep.episode}`,
        session: ep.session,
        thumbnail: ep.snapshot,
        duration: ep.duration,
        created_at: ep.created_at,
        episode_url: `${BASE}/play/${animeSession}/${ep.session}`,
        sources_api: `${BASE}/api?m=episode&id=${ep.session}`
      }));
    });
    
    res.json({ 
      success: true, 
      data, 
      animeSession, 
      page,
      total: data.length 
    });
  } catch (err) {
    log("error", `Episodes error for ${req.params.animeSession}: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch episodes",
      details: NODE_ENV === "development" ? err.message : undefined
    });
  }
});

// ============================
// API: Get Download/Stream Options for Episode
// ============================
app.get("/api/downloads/:animeSession/:episodeSession", async (req, res) => {
  try {
    const { animeSession, episodeSession } = req.params;
    const url = `${BASE}/play/${animeSession}/${episodeSession}`;
    
    if (!animeSession || !episodeSession || animeSession.length > 100 || episodeSession.length > 100) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid session IDs" 
      });
    }
    
    const data = await cached(`dl_${url}`, "downloads", async () => {
      log("info", `Fetching downloads for ${animeSession}/${episodeSession}`);      const html = await cfGet(url);
      const $ = cheerio.load(html);
      const downloads = {};
      
      // Parse download options from data attributes
      $('a[data-src], a[data-resolution]').each((i, el) => {
        const $el = $(el);
        const quality = $el.data('resolution') || 
                       $el.text().match(/(\d{3,4})p/i)?.[1] + 'p' || 
                       'unknown';
        const provider = $el.data('src') || $el.attr('href');
        
        if (provider && !downloads[quality]) {
          downloads[quality] = {
            url: provider,
            audio: $el.data('audio') || 'jpn',
            type: provider.includes('kwik') ? 'kwik' : 'direct',
            provider: provider.includes('kwik') ? 'Kwik' : 'Other'
          };
        }
      });
      
      // Fallback: look for pickDownload section
      if (Object.keys(downloads).length === 0) {
        $('#pickDownload a').each((i, el) => {
          const $el = $(el);
          const text = $el.text().trim();
          const href = $el.attr('href');
          
          if (href && text.includes('p')) {
            const quality = text.match(/(\d{3,4})p/i)?.[1] + 'p' || 'unknown';
            downloads[quality] = { 
              url: href, 
              audio: 'jpn', 
              type: 'redirect',
              provider: 'Direct'
            };
          }
        });
      }
      
      log("info", `Found ${Object.keys(downloads).length} download options`);
      return downloads;
    });
    
    res.json({ 
      success: true, 
      data, 
      animeSession, 
      episodeSession,      total: Object.keys(data).length 
    });
  } catch (err) {
    log("error", `Downloads error: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch download options",
      details: NODE_ENV === "development" ? err.message : undefined
    });
  }
});

// ============================
// API: Extract Video URL from Kwik/External Player
// ============================
app.get("/api/video", async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: "Missing 'url' parameter" 
      });
    }
    
    if (typeof url !== 'string' || url.length > 2000) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid URL parameter" 
      });
    }
    
    const result = await cached(`vid_${url}`, "video", async () => {
      log("info", `Extracting video URL from: ${url.substring(0, 50)}...`);
      
      // If already direct video file, return it
      if (/\.(mp4|mkv|webm)($|\?|#)/i.test(url)) {
        log("info", "Direct video URL detected");
        return { 
          url, 
          type: 'direct', 
          format: url.match(/\.(\w+)($|\?|#)/i)?.[1] || 'unknown',
          note: 'Direct video file'
        };
      }
      
      const html = await cfGet(url, { 
        headers: { 
          Referer: BASE + "/",          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        } 
      });
      
      // Attempt 1: Find .m3u8 HLS stream (most common)
      const m3u8Matches = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi);
      if (m3u8Matches && m3u8Matches.length > 0) {
        log("info", "HLS stream (.m3u8) found");
        return { 
          url: m3u8Matches[0], 
          type: 'hls', 
          format: '.m3u8', 
          note: 'HLS stream - use VLC or hls.js to play',
          alternatives: m3u8Matches.slice(1, 4) // Include backup streams
        };
      }
      
      // Attempt 2: Look for direct video files in HTML
      const directMatches = html.match(/https?:\/\/[^\s"'<>]+\.(mp4|mkv|webm)[^\s"'<>]*/gi);
      if (directMatches && directMatches.length > 0) {
        log("info", "Direct video file found in HTML");
        const videoUrl = directMatches[0];
        return { 
          url: videoUrl, 
          type: 'direct', 
          format: videoUrl.match(/\.(\w+)($|\?|#)/i)?.[1] || 'unknown',
          note: 'Direct video file extracted from page'
        };
      }
      
      // Attempt 3: Extract from obfuscated JS using vm2 (experimental)
      const scriptMatches = html.match(/<script[^>]*>([\s\S]*?eval[\s\S]*?)<\/script>/i);
      if (scriptMatches) {
        try {
          log("info", "Attempting JS deobfuscation...");
          const vm = new VM({ 
            timeout: 5000, 
            sandbox: { 
              document: { 
                createElement: () => ({ 
                  setAttribute: () => {},
                  addEventListener: () => {}
                }),
                getElementById: () => null
              }, 
              window: { 
                location: { href: url },
                navigator: { userAgent: HEADERS["User-Agent"] }
              },
              navigator: {},              localStorage: {},
              setTimeout: () => {},
              setInterval: () => {},
              console: { log: () => {} }
            } 
          });
          
          vm.run(`(function() { ${scriptMatches[1]} })()`);
          
          // Check sandbox for video URLs (fragile, depends on obfuscation)
          const sandboxVars = Object.values(vm.sandbox);
          const direct = sandboxVars.find(v => 
            typeof v === 'string' && /\.(mp4|mkv|webm|m3u8)($|\?|#)/i.test(v)
          );
          
          if (direct) {
            log("info", "Video URL extracted from obfuscated JS");
            return { 
              url: direct, 
              type: direct.includes('m3u8') ? 'hls' : 'direct', 
              format: direct.match(/\.(\w+)($|\?|#)/i)?.[1] || 'unknown',
              note: 'Extracted from obfuscated JavaScript'
            };
          }
        } catch (e) {
          log("debug", `VM execution failed: ${e.message}`);
          // Continue to next attempt
        }
      }
      
      // Attempt 4: Look for iframe redirect
      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframeMatch?.[1]?.startsWith('http')) {
        log("info", "Found iframe redirect, following...");
        const iframeUrl = iframeMatch[1];
        
        try {
          const innerHtml = await cfGet(iframeUrl, {
            headers: { Referer: url }
          });
          
          const m3u8Inner = innerHtml.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
          if (m3u8Inner) {
            log("info", "HLS stream found in iframe");
            return { 
              url: m3u8Inner[0], 
              type: 'hls', 
              format: '.m3u8',
              note: 'Extracted from iframe redirect'
            };          }
        } catch (e) {
          log("debug", `Iframe fetch failed: ${e.message}`);
        }
        
        return { 
          url: iframeUrl, 
          type: 'iframe', 
          note: 'Further redirect needed - open in browser' 
        };
      }
      
      // Fallback: Return the original provider URL with instructions
      log("warn", "Could not extract direct video URL");
      return { 
        url, 
        type: 'player_page', 
        note: 'Direct video URL not extractable via HTTP. This URL opens a video player page. Use a headless browser (Puppeteer/Playwright) to execute JS and extract the real video source, or open this URL directly in your browser.'
      };
    });
    
    res.json({ 
      success: true, 
      data: result,
      extractedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL.video).toISOString()
    });
  } catch (err) {
    log("error", `Video extraction error: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: "Failed to extract video URL",
      details: NODE_ENV === "development" ? err.message : undefined
    });
  }
});

// ============================
// API: Combined Endpoint - Get Episode with Video
// ============================
app.get("/api/episode/:animeSession/:episodeSession", async (req, res) => {
  try {
    const { animeSession, episodeSession } = req.params;
    
    log("info", `Fetching full episode data for ${animeSession}/${episodeSession}`);
    
    // Get download options
    const dlUrl = `${BASE}/play/${animeSession}/${episodeSession}`;
    const downloads = await cached(`dl_${dlUrl}`, "downloads", async () => {
      const html = await cfGet(dlUrl);      const $ = cheerio.load(html);
      const downloads = {};
      
      $('a[data-src], a[data-resolution]').each((i, el) => {
        const $el = $(el);
        const quality = $el.data('resolution') || 
                       $el.text().match(/(\d{3,4})p/i)?.[1] + 'p' || 
                       'unknown';
        const provider = $el.data('src') || $el.attr('href');
        
        if (provider && !downloads[quality]) {
          downloads[quality] = {
            url: provider,
            audio: $el.data('audio') || 'jpn',
            type: provider.includes('kwik') ? 'kwik' : 'direct'
          };
        }
      });
      
      return downloads;
    });
    
    // Try to get video URL for the highest quality available
    const qualities = ['1080p', '720p', '480p', '360p'];
    let videoResult = null;
    
    for (const q of qualities) {
      if (downloads[q]?.url) {
        const videoUrl = downloads[q].url;
        videoResult = await cached(`vid_${videoUrl}`, "video", async () => {
          if (/\.(mp4|mkv|webm)($|\?|#)/i.test(videoUrl)) {
            return { url: videoUrl, type: 'direct' };
          }
          
          const html = await cfGet(videoUrl);
          const m3u8 = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
          if (m3u8) {
            return { url: m3u8[0], type: 'hls', format: '.m3u8' };
          }
          
          return { url: videoUrl, type: 'player_page' };
        });
        
        if (videoResult?.type !== 'player_page') break;
      }
    }
    
    res.json({
      success: true,
      data: {        animeSession,
        episodeSession,
        downloads,
        video: videoResult,
        fetchedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    log("error", `Combined episode endpoint error: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch episode data",
      details: NODE_ENV === "development" ? err.message : undefined
    });
  }
});

// ============================
// Serve Frontend
// ============================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================
// Error Handling Middleware
// ============================
app.use((err, req, res, next) => {
  log("error", `Unhandled error: ${err.message}`);
  log("error", err.stack);
  
  res.status(500).json({
    success: false,
    error: NODE_ENV === "production" ? "Internal server error" : err.message,
    path: req.path,
    method: req.method
  });
});

// ============================
// 404 Handler
// ============================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    path: req.path,
    availableEndpoints: [
      "GET /api/health",
      "GET /api/latest",      "GET /api/episodes/:animeSession",
      "GET /api/downloads/:animeSession/:episodeSession",
      "GET /api/video?url={providerUrl}",
      "GET /api/episode/:animeSession/:episodeSession",
      "GET /"
    ]
  });
});

// ============================
// Start Server
// ============================
const server = app.listen(PORT, "0.0.0.0", () => {
  log("info", "========================================");
  log("info", "🚀 AnimePahe Scraper Server Started");
  log("info", "========================================");
  log("info", `📍 Environment: ${NODE_ENV}`);
  log("info", `🌐 Server: http://localhost:${PORT}`);
  log("info", `📺 Frontend: http://localhost:${PORT}`);
  log("info", `🔌 Health: http://localhost:${PORT}/api/health`);
  log("info", `📚 API Docs: http://localhost:${PORT}/api/latest`);
  log("info", `💾 Cache Max Size: ${MAX_CACHE_SIZE}`);
  log("info", `🧹 Cache Cleanup: Every ${CACHE_CLEANUP_INTERVAL / 1000}s`);
  log("info", "========================================");
});

// ============================
// Graceful Shutdown (Render Best Practice)
// ============================
function gracefulShutdown(signal) {
  log("info", `${signal} received. Starting graceful shutdown...`);
  
  server.close(() => {
    log("info", "HTTP server closed.");
    
    // Clear cache
    Object.keys(CACHE).forEach(key => delete CACHE[key]);
    log("info", "Cache cleared.");
    
    log("info", "Graceful shutdown completed.");
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    log("error", "Forced shutdown after timeout.");
    process.exit(1);
  }, 10000);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  log("error", `Uncaught Exception: ${err.message}`);
  log("error", err.stack);
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason, promise) => {
  log("error", `Unhandled Rejection at: ${promise}`);
  log("error", `Reason: ${reason}`);
  // Don't exit on unhandled rejections in production
  if (NODE_ENV === "development") {
    gracefulShutdown("UNHANDLED_REJECTION");
  }
});

// Export for testing
module.exports = { app, server, CACHE, log };
