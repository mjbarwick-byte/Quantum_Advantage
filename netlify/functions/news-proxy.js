// ══════════════════════════════════════════════════════════
// news-proxy.js — Netlify Serverless Function
// Quantum Leap Strategic Intelligence Platform
// Fetches GDELT + Google News + NewsAPI, deduplicates,
// translates non-English titles, returns one unified feed.
// ══════════════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

const NEWS_API_KEY = '5120ae1753ea4e658e5741ea10c5f6f9';

// ── HTTP helper ────────────────────────────────────────────
function fetchUrl(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QuantumLeapIntel/1.0)',
        'Accept': 'application/json, application/xml, text/xml, */*',
      }
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Language codes (GDELT returns full English names) ──────
const LANG_CODES = {
  'Russian':'ru','Chinese':'zh','Arabic':'ar','French':'fr','German':'de',
  'Spanish':'es','Japanese':'ja','Korean':'ko','Portuguese':'pt','Italian':'it',
  'Dutch':'nl','Swedish':'sv','Danish':'da','Finnish':'fi','Hindi':'hi',
  'Malayalam':'ml','Tamil':'ta','Bengali':'bn','Urdu':'ur','Persian':'fa',
  'Turkish':'tr','Vietnamese':'vi','Thai':'th','Indonesian':'id','Malay':'ms',
  'Polish':'pl','Czech':'cs','Romanian':'ro','Ukrainian':'uk','Greek':'el',
  'Hebrew':'he','Norwegian':'no','Hungarian':'hu','Slovak':'sk','Catalan':'ca',
};

// ── Translate one title via MyMemory (free) ─────────────────
async function translateTitle(text, langName) {
  if (!text || text.length > 250) return null;
  const code = LANG_CODES[langName];
  if (!code) return null;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${code}|en&de=quantum.leap.intel@gmail.com`;
  try {
    const res  = await fetchUrl(url, 6000);
    const data = JSON.parse(res.body);
    if (data.quotaFinished) return null;
    const t = data?.responseData?.translatedText;
    if (t && t !== text &&
        !t.toUpperCase().includes('MYMEMORY') &&
        !t.toUpperCase().includes('QUERY LENGTH')) return t;
  } catch(_) {}
  return null;
}

// ── Translate non-English titles sequentially ───────────────
async function translateArticles(articles) {
  const MAX = 10;
  let count = 0;
  const result = [];
  for (const a of articles) {
    const nonEn = a.lang && a.lang !== 'English' && a.lang !== 'en';
    if (nonEn && count < MAX) {
      const t = await translateTitle(a.title, a.lang);
      result.push(t ? { ...a, translated_title: t } : a);
      if (t) count++;
      await sleep(350);
    } else {
      result.push(a);
    }
  }
  return result;
}

// ── Deduplication ───────────────────────────────────────────
function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function similar(t1, t2) {
  const n1 = normalizeTitle(t1);
  const n2 = normalizeTitle(t2);
  if (n1 === n2) return true;
  const w1 = new Set(n1.split(' ').filter(w => w.length > 4));
  const w2 = new Set(n2.split(' ').filter(w => w.length > 4));
  if (w1.size < 3 || w2.size < 3) return false;
  const shared = [...w1].filter(w => w2.has(w)).length;
  return shared / Math.min(w1.size, w2.size) > 0.65;
}

function deduplicate(articles) {
  const seenUrls   = new Set();
  const seenTitles = [];
  const out = [];
  for (const a of articles) {
    const baseUrl = a.url.replace(/[?#].*$/, '').replace(/\/$/, '');
    if (seenUrls.has(baseUrl)) continue;
    if (seenTitles.some(t => similar(t, a.title))) continue;
    seenUrls.add(baseUrl);
    seenTitles.push(a.title);
    out.push(a);
  }
  return out;
}

// ── Source parsers ──────────────────────────────────────────
function decodeEnt(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&#39;/g,"'").replace(/&quot;/g,'"')
          .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n));
}

async function fetchGDELT() {
  const terms = [
    '"quantum sensing"','"quantum radar"','"quantum gravimetry"',
    '"quantum navigation"','"quantum magnetometry"','"quantum inertial navigation"',
    '"Rydberg atom"','"Rydberg receiver"'
  ].join(' OR ');
  const q   = encodeURIComponent(`(${terms})`);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=25&format=json&timespan=14d&sort=datedesc`;
  const res = await fetchUrl(url);
  if (!res.body.trim().startsWith('{')) return []; // rate-limited — return empty, don't fail
  const data = JSON.parse(res.body);
  return (data.articles || []).map(a => ({
    title:   a.title || '(No title)',
    url:     a.url   || '#',
    source:  a.domain || 'Unknown',
    country: a.sourcecountry || '',
    lang:    a.language || 'English',
    feed:    'GDELT',
    date:    a.seendate
      ? a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,'$1-$2-$3T$4:$5:$6Z')
      : new Date().toISOString()
  }));
}

async function fetchGNews() {
  const q   = encodeURIComponent('"quantum sensing" OR "quantum radar" OR "quantum gravimetry" OR "quantum navigation" OR "Rydberg"');
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetchUrl(url);
  const blocks = res.body.match(/<item>([\s\S]*?)<\/item>/g) || [];
  return blocks.slice(0,20).map(block => {
    const raw    = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link   = (block.match(/<link>([\s\S]*?)<\/link>/) || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || '#';
    const pub    = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const srcEl  = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    const source = decodeEnt(srcEl || (raw.includes(' - ') ? raw.split(' - ').pop().trim() : 'Google News'));
    const title  = decodeEnt(raw.includes(' - ') ? raw.split(' - ').slice(0,-1).join(' - ').trim() : raw);
    return { title, url: link.trim(), source, country:'', lang:'en', feed:'Google News',
             date: pub ? new Date(pub).toISOString() : new Date().toISOString() };
  });
}

async function fetchNewsAPI() {
  const q   = encodeURIComponent('"quantum sensing" OR "quantum radar" OR "quantum gravimetry" OR "quantum navigation" OR "Rydberg" OR "quantum magnetometry"');
  const url = `https://newsapi.org/v2/everything?q=${q}&sortBy=publishedAt&pageSize=25&language=en&apiKey=${NEWS_API_KEY}`;
  const res = await fetchUrl(url);
  const data = JSON.parse(res.body);
  if (data.status === 'error') return [];
  return (data.articles || [])
    .filter(a => a.title && !a.title.includes('[Removed]'))
    .map(a => ({
      title:   a.title, url: a.url || '#',
      source:  a.source?.name || 'Unknown',
      country: '', lang: 'en', feed: 'NewsAPI',
      date:    a.publishedAt || new Date().toISOString()
    }));
}

// ── Main handler ────────────────────────────────────────────
exports.handler = async (event) => {
  const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=300'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  try {
    // Fetch all three sources in parallel
    const [gdelt, gnews, newsapi] = await Promise.allSettled([
      fetchGDELT(), fetchGNews(), fetchNewsAPI()
    ]);

    // Combine — all articles regardless of language
    const combined = [
      ...(gdelt.status   === 'fulfilled' ? gdelt.value   : []),
      ...(gnews.status   === 'fulfilled' ? gnews.value   : []),
      ...(newsapi.status === 'fulfilled' ? newsapi.value : []),
    ];

    // Deduplicate by URL and similar title
    let articles = deduplicate(combined);

    // Sort newest first
    articles.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Translate non-English titles inline — English articles unchanged
    articles = await translateArticles(articles);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        articles,
        count: articles.length,
        sources: {
          gdelt:   gdelt.status   === 'fulfilled' ? gdelt.value.length   : 'error',
          gnews:   gnews.status   === 'fulfilled' ? gnews.value.length   : 'error',
          newsapi: newsapi.status === 'fulfilled' ? newsapi.value.length : 'error',
        },
        fetchedAt: new Date().toISOString()
      })
    };
  } catch (err) {
    console.error('[news-proxy] error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
