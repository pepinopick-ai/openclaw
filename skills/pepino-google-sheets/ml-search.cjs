#!/usr/bin/env node
/**
 * ml-search.cjs — Поиск на Mercado Libre через Google (обход 403)
 *
 * ML API блокирует VPS IP. Этот скрипт ищет через Google Site Search.
 *
 * Usage: node ml-search.cjs "sustrato hongos 25kg"
 */
"use strict";

const https = require("https");

function googleSearch(query) {
  return new Promise((resolve, reject) => {
    // Search ML via Google
    const url = `https://www.google.com/search?q=site:mercadolibre.com.ar+${encodeURIComponent(query)}&num=10`;
    const opts = {
      hostname: "www.google.com",
      path: `/search?q=site:mercadolibre.com.ar+${encodeURIComponent(query)}&num=10`,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        Accept: "text/html",
        "Accept-Language": "es-AR,es;q=0.9",
      },
    };

    https
      .get(opts, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

function extractResults(html) {
  const results = [];
  // Extract titles and URLs from Google results
  const linkRegex = /href="\/url\?q=(https?:\/\/[^"&]+)/g;
  const titleRegex = /<h3[^>]*>([^<]+)<\/h3>/g;

  let match;
  const urls = [];
  while ((match = linkRegex.exec(html)) !== null) {
    const url = decodeURIComponent(match[1]);
    if (url.includes("mercadolibre.com.ar")) {
      urls.push(url);
    }
  }

  const titles = [];
  while ((match = titleRegex.exec(html)) !== null) {
    titles.push(match[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'"));
  }

  for (let i = 0; i < Math.min(urls.length, titles.length, 10); i++) {
    // Try to extract price from title
    const priceMatch = titles[i].match(/\$\s*([\d.,]+)/);
    results.push({
      title: titles[i],
      url: urls[i],
      price: priceMatch ? priceMatch[1] : null,
    });
  }

  // Also try DuckDuckGo as fallback
  return results;
}

async function ddgSearch(query) {
  return new Promise((resolve, reject) => {
    const url = `https://html.duckduckgo.com/html/?q=site:mercadolibre.com.ar+${encodeURIComponent(query)}`;
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
          },
        },
        (res) => {
          let body = "";
          if (res.statusCode === 301 || res.statusCode === 302) {
            return resolve([]);
          }
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            const results = [];
            const regex = /class="result__a"[^>]*href="([^"]*mercadolibre[^"]*)"[^>]*>([^<]*)/g;
            let m;
            while ((m = regex.exec(body)) !== null) {
              results.push({
                title: m[2].replace(/&amp;/g, "&").replace(/&#39;/g, "'"),
                url: decodeURIComponent(m[1].replace(/\/\/duckduckgo.com\/l\/\?uddg=/, "")),
                price: null,
              });
            }
            resolve(results);
          });
        },
      )
      .on("error", () => resolve([]));
  });
}

async function mlItemDetails(itemId) {
  return new Promise((resolve) => {
    https
      .get(
        `https://api.mercadolibre.com/items/${itemId}`,
        {
          headers: { "User-Agent": "Mozilla/5.0" },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const item = JSON.parse(body);
              resolve({
                title: item.title,
                price: item.price,
                currency: item.currency_id,
                condition: item.condition,
                permalink: item.permalink,
                seller: item.seller_id,
                available: item.available_quantity,
              });
            } catch {
              resolve(null);
            }
          });
        },
      )
      .on("error", () => resolve(null));
  });
}

async function main() {
  const query = process.argv.slice(2).join(" ");
  if (!query) {
    console.error('Usage: node ml-search.cjs "sustrato hongos 25kg"');
    process.exit(1);
  }

  console.log(`🔍 Buscando en MercadoLibre: "${query}"\n`);

  // Try Google first
  let results = [];
  try {
    const html = await googleSearch(query);
    results = extractResults(html);
  } catch (e) {
    console.error(`Google search error: ${e.message}`);
  }

  // Fallback to DDG
  if (results.length === 0) {
    console.error("Google blocked, trying DuckDuckGo...");
    results = await ddgSearch(query);
  }

  if (results.length === 0) {
    console.log("No se encontraron resultados. Intenta con otro término de búsqueda.");
    console.log("\nTambién puedes buscar directamente en: https://www.mercadolibre.com.ar/");
    return;
  }

  // Try to get ML item details for each result
  console.log(`📦 Encontrados ${results.length} resultados:\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    // Extract ML item ID from URL
    const idMatch = r.url.match(/MLA-?(\d+)/i);

    if (idMatch) {
      const details = await mlItemDetails(`MLA${idMatch[1]}`);
      if (details && details.price) {
        console.log(`${i + 1}. ${details.title}`);
        console.log(`   💰 ${details.currency} ${details.price.toLocaleString()}`);
        console.log(`   📦 Stock: ${details.available || "?"} | ${details.condition || ""}`);
        console.log(`   🔗 ${details.permalink || r.url}`);
        console.log();
        continue;
      }
    }

    console.log(`${i + 1}. ${r.title}`);
    if (r.price) console.log(`   💰 ARS ${r.price}`);
    console.log(`   🔗 ${r.url}`);
    console.log();
  }
}

main().catch(console.error);
