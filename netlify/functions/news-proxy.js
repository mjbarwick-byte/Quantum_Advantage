// ══════════════════════════════════════════════════════════
// news-proxy.js — Netlify Serverless Function
// Quantum Leap Strategic Intelligence Platform
// Fetches news server-side, avoiding browser CORS/CSP blocks
// ══════════════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

// API key stored server-side — never exposed to browser
const NEWS_API_KEY = '5120ae1753ea4e658e5741ea10c5f6f9';

const QUANTUM_QUERY = '"quantum sensing" OR "quantum radar" OR "quantum gravimetry" OR "quantum navigation" OR "Rydberg" OR "quantum magnetometry" OR "quantum inertial navigation"';

// ── HTTP fetch helper (Node built-ins only, no dependencies) ──
function fetchUrl(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QuantumLeapIntel/1.0)',
        'Accept': 'application/json, application/xml, text/xml, text/html, */*',
      }
    }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        contentType: res.headers['content-type'] || '',
        body
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ── Parsers — normalize each source into { title, url, source, country, lang, date } ──

function parseGDELT(body) {
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

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

function parseGoogleNewsRSS(body) {
  const items = [];
  const blocks = body.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const block of blocks.slice(0, 30)) {
    // Title (may be CDATA or plain)
    const rawTitle =
      (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
       block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';

    // Link
    const link =
      (block.match(/<link>([\s\S]*?)<\/link>/) ||
       block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || '#';

    // Published date
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';

    // Source (embedded in <source> tag or at end of title after " - ")
    const sourceEl = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    const source = sourceEl ||
      (rawTitle.includes(' - ') ? rawTitle.split(' - ').pop().trim() : 'Google News');
    const cleanTitle = rawTitle.includes(' - ')
      ? rawTitle.split(' - ').slice(0, -1).join(' - ').trim()
      : rawTitle;

    items.push({
      title:   decodeEntities(cleanTitle),
      url:     link.trim(),
      source:  decodeEntities(source),
      country: '',
      lang:    'en',
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
      title:   a.title,
      url:     a.url || '#',
      source:  a.source?.name || 'Unknown',
      country: '',
      lang:    'en',
      date:    a.publishedAt || new Date().toISOString()
    }));
}

// ── Language code map (GDELT returns full names) ────────────
const LANG_CODES = {
  'Russian':'ru','Chinese':'zh','Arabic':'ar','French':'fr','German':'de',
  'Spanish':'es','Japanese':'ja','Korean':'ko','Portuguese':'pt','Italian':'it',
  'Dutch':'nl','Swedish':'sv','Danish':'da','Finnish':'fi','Hindi':'hi',
  'Malayalam':'ml','Tamil':'ta','Bengali':'bn','Urdu':'ur','Persian':'fa',
  'Turkish':'tr','Vietnamese':'vi','Thai':'th','Indonesian':'id','Malay':'ms',
  'Polish':'pl','Czech':'cs','Romanian':'ro','Ukrainian':'uk','Greek':'el',
  'Hebrew':'he','Norwegian':'no','Catalan':'ca','Hungarian':'hu','Slovak':'sk',
};

async function translateTitle(text, langName) {
  if (!text || text.length > 300) return null; // skip very long titles
  const code = LANG_CODES[langName] || 'auto';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${code}|en`;
  try {
    const res = await fetchUrl(url, 6000);
    const data = JSON.parse(res.body);
    const translated = data?.responseData?.translatedText;
    // Discard if identical to input (already English) or error string
    if (translated && translated !== text && !translated.toLowerCase().includes('mymemory')) {
      return translated;
    }
  } catch(_) {}
  return null;
}

async function translateArticles(articles) {
  const nonEnglish = articles.filter(
    a => a.lang && a.lang !== 'English' && a.lang !== 'en'
  );
  if (nonEnglish.length === 0) return articles;

  // Translate all non-English titles in parallel
  const translations = await Promise.allSettled(
    nonEnglish.map(a => translateTitle(a.title, a.lang))
  );

  let idx = 0;
  return articles.map(a => {
    if (a.lang && a.lang !== 'English' && a.lang !== 'en') {
      const result = translations[idx++];
      const translated = result.status === 'fulfilled' ? result.value : null;
      return translated ? { ...a, translated_title: translated } : a;
    }
    return a;
  });
}
exports.handler = async (event) => {
  const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=300'  // cache 5 min
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  const source = (event.queryStringParameters?.source || 'gdelt').toLowerCase();
  let url, result, articles;

  try {
    if (source === 'gdelt') {
      const terms = [
        '"quantum sensing"', '"quantum radar"', '"quantum gravimetry"',
        '"quantum navigation"', '"Rydberg"', '"quantum magnetometry"',
        '"quantum inertial navigation"', '"quantum technology"'
      ].join(' OR ');
      const q = encodeURIComponent(`(${terms})`);
      url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=30&format=json&timespan=14d&sort=datedesc`;
      result = await fetchUrl(url);
      articles = parseGDELT(result.body);
      articles = await translateArticles(articles); // translate non-English titles

    } else if (source === 'gnews') {
      const q = encodeURIComponent(
        'quantum sensing OR "quantum radar" OR "quantum gravimetry" OR "quantum navigation" OR Rydberg OR "quantum magnetometry"'
      );
      url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
      result = await fetchUrl(url);
      articles = parseGoogleNewsRSS(result.body);

    } else if (source === 'newsapi') {
      const q = encodeURIComponent(QUANTUM_QUERY);
      url = `https://newsapi.org/v2/everything?q=${q}&sortBy=publishedAt&pageSize=30&language=en&apiKey=${NEWS_API_KEY}`;
      result = await fetchUrl(url);
      articles = parseNewsAPI(result.body);

    } else {
      return {
        statusCode: 400, headers: HEADERS,
        body: JSON.stringify({ error: `Unknown source: ${source}. Use gdelt, gnews, or newsapi.` })
      };
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        articles,
        source,
        count: articles.length,
        fetchedAt: new Date().toISOString()
      })
    };

  } catch (err) {
    console.error(`[news-proxy] ${source} error:`, err.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message, source })
    };
  }
};
