#!/usr/bin/env node
/**
 * Submits every URL in the live sitemap to IndexNow (Bing, Yandex, Seznam, Naver).
 *
 * The key file lives at client/public/<KEY>.txt and is served from the site root,
 * so IndexNow can verify ownership. Run after a deploy that changes public pages:
 *
 *   node scripts/indexnow.mjs
 *   node scripts/indexnow.mjs https://safecoi.com/pricing   # submit specific URLs
 */
import fs from 'node:fs'
import path from 'node:path'

const ORIGIN = 'https://safecoi.com'
const PUBLIC_DIR = path.join(process.cwd(), 'client', 'public')

const keyFile = fs.readdirSync(PUBLIC_DIR).find((f) => /^[0-9a-f]{32}\.txt$/.test(f))
if (!keyFile) {
  console.error('No IndexNow key file found in client/public (expected a 32-char hex name).')
  process.exit(1)
}
const key = keyFile.replace(/\.txt$/, '')

async function sitemapUrls() {
  const res = await fetch(`${ORIGIN}/sitemap.xml`)
  if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status}`)
  const xml = await res.text()
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
}

const urls = process.argv.slice(2).length ? process.argv.slice(2) : await sitemapUrls()
if (!urls.length) throw new Error('No URLs to submit')

const body = {
  host: new URL(ORIGIN).host,
  key,
  keyLocation: `${ORIGIN}/${key}.txt`,
  urlList: urls,
}

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
})

// 200 = accepted, 202 = accepted but key still being validated.
console.log(`IndexNow ${res.status} ${res.statusText} — ${urls.length} URLs submitted`)
if (![200, 202].includes(res.status)) {
  console.error(await res.text())
  process.exit(1)
}
for (const u of urls) console.log('  ', u)
