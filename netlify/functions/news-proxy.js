// ══════════════════════════════════════════════════════════
// news-proxy.js — Netlify Serverless Function
// Quantum Leap Strategic Intelligence Platform
// ══════════════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

const NEWS_API_KEY = '5120ae1753ea4e658e5741ea10c5f6f9';

// ── HTTP fetch (Node built-ins only) ───────────────────────
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

// ── Language code map (GDELT returns full names) ───────────
const LANG_CODES = {
  'Russian':'ru','Chinese':'zh','Arabic':'ar','French':'fr','German':'de',
  'Spanish':'es','Japanese':'ja','Korean':'ko','Portuguese':'pt','Italian':'it',
  'Dutch':'nl','Swedish':'sv','Danish':'da','Finnish':'fi','Hindi':'hi',
  'Malayalam':'ml','Tamil':'ta','Bengali':'bn','Urdu':'ur','Persian':'fa',
  'Turkish':'tr','Vietnamese':'vi','Thai':'th','Indonesian':'id','Malay':'ms',
  'Polish':'pl','Czech':'cs','Romanian':'ro','Ukrainian':'uk','Greek':'el',
  'Hebrew':'he','Norwegian':'no','Hungarian':'hu','Slovak':'sk','Catalan':'ca',
};

// ── Translate a single title via MyMemory (free, no key) ───
async function translateTitle(text, langName) {
  if (!text || text.length > 250) return null;
  const code = LANG_CODES[langName];
  if (!code) return null; // unknown language — skip
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${code}|en&de=quantum.leap.intel@gmail.com`;
  try {
    const res  = await fetchUrl(url, 6000);
    const data = JSON.parse(res.body);
    // Bail out if daily quota is exhausted
    if (data.quotaFinished) return null;
    const translated = data?.responseData?.translatedText;
    if (translated && translated !== text &&
        !translated.toUpperCase().includes('MYMEMORY') &&
        !translated.toUpperCase().includes('QUERY LENGTH')) {
      return translated;
    }
  } catch(_) {}
  return null;
}

// ── Translate non-English articles sequentially ────────────
// Sequential (not parallel) to avoid rate-limiting MyMemory
async function translateArticles(articles) {
  const MAX_TO_TRANSLATE = 8; // cap to save quota
  let translated = 0;
  const result = [];

  for (const article of articles) {
    const isNonEnglish = article.lang && article.lang !== 'English' && article.lang !== 'en';
    if (isNonEnglish && translated < MAX_TO_TRANSLATE) {
      const t = await translateTitle(article.title, article.lang);
      if (t) {
        result.push({ ...article, translated_title: t });
        translated++;
        await sleep(300); // 300ms between requests to respect MyMemory rate limits
      } else {
        result.push(article);
      }
    } else {
      result.push(article);
    }
  }
  return result;
}

// ── Parsers ────────────────────────────────────────────────
function parseGDELT(body) {
  // Handle rate-limit plain-text response
  if (!body.trim().startsWith('{')) {
    throw new Error('GDELT rate limit — try again in a few seconds');
  }
  const data = JSON.parse(body);
  return (data.articles || []).map(a => ({
    title:   a.title || '(No title)',
    url:     a.url   || '#',
    source:  a.domain || 'Unknown',
    country: a.sourcecountry || '',
    lang:    a.language || 'English',
    date:    a.seendate
      ? a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')
      : new Date().toISOString()
  }));
}

function decodeEntities(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&apos;/g,"'")
          .replace(/&#(\d+);/g, (_,n) => String.fromCharCode(n));
}

function parseGoogleNewsRSS(body) {
  const items = [];
  const blocks = body.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const block of blocks.slice(0, 30)) {
    const rawTitle = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                      block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link     = (block.match(/<link>([\s\S]*?)<\/link>/) ||
                      block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || '#';
    const pubDate  = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const sourceEl = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    const source   = sourceEl || (rawTitle.includes(' - ') ? rawTitle.split(' - ').pop().trim() : 'Google News');
    const title    = rawTitle.includes(' - ') ? rawTitle.split(' - ').slice(0,-1).join(' - ').trim() : rawTitle;
    items.push({
      title:   decodeEntities(title),
      url:     link.trim(),
      source:  decodeEntities(source),
      country: '', lang: 'en',
      date:    pubDate ? new Date(pubDate).toISOString() : new Date().toISOString()
    });
  }
  return items;
}

function parseNewsAPI(body) {
  const data = JSON.parse(body);
  if (data.status === 'error') throw new Error(data.message || 'NewsAPI error');
  return (data.articles || [])
    .filter(a => a.title && !a.title.includes('[Removed]'))
    .map(a => ({
      title:   a.title, url: a.url || '#',
      source:  a.source?.name || 'Unknown',
      country: '', lang: 'en',
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

  const source = (event.queryStringParameters?.source || 'gdelt').toLowerCase();
  let url, result, articles;

  try {
    if (source === 'gdelt') {
      // Tighter query — require "quantum" near sensing/radar/etc to reduce false positives
      // Also exclude irrelevant domains by using sourcelang filter
      const terms = [
        '"quantum sensing"','"quantum radar"','"quantum gravimetry"',
        '"quantum navigation"','"quantum magnetometry"','"quantum inertial navigation"',
        '"Rydberg atom"','"Rydberg receiver"'
      ].join(' OR ');
      const q = encodeURIComponent(`(${terms})`);
      url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=30&format=json&timespan=14d&sort=datedesc`;
      result   = await fetchUrl(url);
      articles = parseGDELT(result.body);
      articles = await translateArticles(articles);

    } else if (source === 'gnews') {
      const q = encodeURIComponent('"quantum sensing" OR "quantum radar" OR "quantum gravimetry" OR "quantum navigation" OR "Rydberg"');
      url      = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
      result   = await fetchUrl(url);
      articles = parseGoogleNewsRSS(result.body);

    } else if (source === 'newsapi') {
      const q = encodeURIComponent('"quantum sensing" OR "quantum radar" OR "quantum gravimetry" OR "quantum navigation" OR "Rydberg" OR "quantum magnetometry"');
      url      = `https://newsapi.org/v2/everything?q=${q}&sortBy=publishedAt&pageSize=30&language=en&apiKey=${NEWS_API_KEY}`;
      result   = await fetchUrl(url);
      articles = parseNewsAPI(result.body);

    } else {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Unknown source: ${source}` }) };
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ articles, source, count: articles.length, fetchedAt: new Date().toISOString() })
    };

  } catch (err) {
    console.error(`[news-proxy] ${source} error:`, err.message);
    return {
      statusCode: 500, headers: HEADERS,
      body: JSON.stringify({ error: err.message, source })
    };
  }
};
