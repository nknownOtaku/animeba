const express = require("express");
const cloudscraper = require("cloudscraper");
const cheerio = require("cheerio");
const { VM } = require("vm2");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://animepahe.si"; // Current working domain

// Middleware
app.use(cors());
app.use(express.static("public"));

// ============================
// Cloudflare-Bypass HTTP Client
// ============================
async function cfGet(url, options = {}) {
  return cloudscraper({
    uri: url,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": BASE + "/",
      ...options.headers
    },
    challengeTimeout: 20000,
    ...options
  });
}

// ============================
// Cache with TTL
// ============================
const CACHE = {};
const TTL = {
  latest: 2 * 60 * 1000,
  episodes: 30 * 60 * 1000,
  downloads: 15 * 60 * 1000,
  video: 5 * 60 * 1000
};

function cached(key, type, fn) {
  const now = Date.now();
  const item = CACHE[key];
  if (item && now - item.ts < TTL[type]) return Promise.resolve(item.data);
  return fn().then(data => {
    CACHE[key] = { data, ts: now };
    return data;
  });}

// ============================
// API: Get Latest Releases (uses official API)
// ============================
app.get("/api/latest", async (req, res) => {
  try {
    const page = req.query.page || 1;
    const data = await cached(`latest_${page}`, "latest", async () => {
      const body = await cfGet(`${BASE}/api?m=release&sort=episode_desc&page=${page}`);
      const json = JSON.parse(body);
      return (json.data || []).map(item => ({
        id: item.id,
        title: item.title,
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
    res.json({ success: true, data });
  } catch (err) {
    console.error("Latest error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================
// API: Get Episodes for Anime
// ============================
app.get("/api/episodes/:animeSession", async (req, res) => {
  try {
    const { animeSession } = req.params;
    const page = req.query.page || 1;
    const sort = req.query.sort || "episode_desc";
    
    const data = await cached(`ep_${animeSession}_${sort}_${page}`, "episodes", async () => {
      const body = await cfGet(`${BASE}/api?m=release&sort=${sort}&page=${page}&id=${animeSession}`);
      const json = JSON.parse(body);
      return (json.data || []).map(ep => ({
        id: ep.id,
        episode: ep.episode,
        title: ep.title || `Episode ${ep.episode}`,
        session: ep.session,
        thumbnail: ep.snapshot,
        duration: ep.duration,        created_at: ep.created_at,
        episode_url: `${BASE}/play/${animeSession}/${ep.session}`,
        sources_api: `${BASE}/api?m=episode&id=${ep.session}`
      }));
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error("Episodes error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================
// API: Get Download/Stream Options for Episode
// ============================
app.get("/api/downloads/:animeSession/:episodeSession", async (req, res) => {
  try {
    const { animeSession, episodeSession } = req.params;
    const url = `${BASE}/play/${animeSession}/${episodeSession}`;
    
    const data = await cached(`dl_${url}`, "downloads", async () => {
      const html = await cfGet(url);
      const $ = cheerio.load(html);
      const downloads = {};
      
      // Parse download options from data attributes
      $('a[data-src], a[data-resolution]').each((i, el) => {
        const $el = $(el);
        const quality = $el.data('resolution') || $el.text().match(/(\d{3,4})p/i)?.[1] + 'p' || 'unknown';
        const provider = $el.data('src') || $el.attr('href');
        if (provider && !downloads[quality]) {
          downloads[quality] = {
            url: provider,
            audio: $el.data('audio') || 'jpn',
            type: provider.includes('kwik') ? 'kwik' : 'direct'
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
            downloads[quality] = { url: href, audio: 'jpn', type: 'redirect' };
          }
        });      }
      
      return downloads;
    });
    
    res.json({ success: true, data });
  } catch (err) {
    console.error("Downloads error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================
// API: Extract Video URL from Kwik/External Player
// ============================
app.get("/api/video", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: "Missing 'url' parameter" });
    
    const result = await cached(`vid_${url}`, "video", async () => {
      // If already direct, return it
      if (/\.(mp4|mkv|webm)($|\?)/i.test(url)) {
        return { url, type: 'direct', format: url.match(/\.(\w+)($|\?)/i)?.[1] };
      }
      
      const html = await cfGet(url, { headers: { Referer: BASE + "/" } });
      
      // Attempt 1: Find .m3u8 HLS stream (most common)
      const m3u8 = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
      if (m3u8) {
        return { url: m3u8[0], type: 'hls', format: '.m3u8', note: 'Use VLC or hls.js to play' };
      }
      
      // Attempt 2: Extract direct video from obfuscated JS using vm2
      const vm = new VM({ timeout: 5000, sandbox: {} });
      const scriptMatch = html.match(/<script[^>]*>([\s\S]*?eval[\s\S]*?)<\/script>/i);
      if (scriptMatch) {
        try {
          const sandbox = { document: { createElement: () => ({}) }, window: {}, navigator: {} };
          vm.run(`(function() { ${scriptMatch[1]} })()`, { sandbox });
          // Check sandbox for video URLs (fragile, depends on obfuscation)
          const direct = Object.values(sandbox).find(v => 
            typeof v === 'string' && /\.(mp4|mkv|webm)($|\?)/i.test(v)
          );
          if (direct) return { url: direct, type: 'direct', format: direct.match(/\.(\w+)($|\?)/i)?.[1] };
        } catch (e) { /* vm execution failed, continue */ }
      }
      
      // Attempt 3: Look for iframe redirect      const iframe = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframe?.[1]?.startsWith('http')) {
        return await cached(`vid_${iframe[1]}`, "video", async () => {
          const inner = await cfGet(iframe[1]);
          const m3u8Inner = inner.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
          if (m3u8Inner) return { url: m3u8Inner[0], type: 'hls', format: '.m3u8' };
          return { url: iframe[1], type: 'iframe', note: 'Further redirect needed' };
        });
      }
      
      // Fallback
      return { 
        url, 
        type: 'player_page', 
        note: 'Direct extraction failed. Open this URL in browser or use Puppeteer for JS execution.' 
      };
    });
    
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("Video error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================
// Serve Frontend
// ============================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📺 Frontend: http://localhost:${PORT}`);
  console.log(`🔌 API Docs: http://localhost:${PORT}/api/latest`);
});
