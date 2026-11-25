import express from 'express'
import { dbAll, dbGet } from '../db/db.ts'
import { renderNotFoundHtml } from '../seo.ts'

export const articlesRouter = express.Router()

export interface ArticleRow {
  id: string
  slug: string
  title: string
  description: string
  tag: string
  reading_time_min: number
  body_html: string
  og_image_url: string | null
  status: string
  position: number
  published_at: string | null
  created_at: string
  updated_at: string
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatDate(d?: string | null): string {
  if (!d) return ''
  const t = new Date(d)
  if (isNaN(t.getTime())) return d
  return t.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function renderHubHtml(articles: ArticleRow[]): string {
  const posts = articles
    .map(
      (a, i) => `
    <a class="post" href="/articles/${escapeHtml(a.slug)}/">
      <span class="idx">${String(i + 1).padStart(2, '0')}</span>
      <div>
        <h3>${escapeHtml(a.title)}</h3>
        <p>${escapeHtml(a.description)}</p>
        <span class="kw">${escapeHtml(a.tag)} · ${a.reading_time_min} min read</span>
      </div>
      <span class="go">→</span>
    </a>`
    )
    .join('')

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'Safecoi Field Guides',
    description: 'COI and endorsement guides for general contractors',
    url: 'https://safecoi.com/articles/',
  })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>COI and Endorsement Guides for General Contractors | Safecoi</title>
<meta name="description" content="Practical guides to certificates of insurance, additional insured endorsements, waivers of subrogation, and workers comp audits — written for the field.">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="https://safecoi.com/articles/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Safecoi">
<meta property="og:title" content="COI and Endorsement Guides for General Contractors | Safecoi">
<meta property="og:description" content="Practical guides to certificates of insurance, additional insured endorsements, waivers of subrogation, and workers comp audits — written for the field.">
<meta property="og:url" content="https://safecoi.com/articles/">
<meta property="og:image" content="https://safecoi.com/articles/assets/og/blog.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="COI and Endorsement Guides for General Contractors | Safecoi">
<meta name="twitter:description" content="Practical guides to certificates of insurance, additional insured endorsements, waivers of subrogation, and workers comp audits — written for the field.">
<meta name="twitter:image" content="https://safecoi.com/articles/assets/og/blog.png">
<link rel="icon" href="/articles/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/articles/styles.css">
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="https://safecoi.com/" aria-label="Safecoi home"><span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg></span><span>safe<b>coi</b></span></a>
    <nav class="nav" aria-label="Main"><a href="/solutions/subcontractor-coi-tracking">Solutions</a><a href="/industries/remodeling-contractor-compliance">Industries</a><a href="/features/acord-25-endorsement-verification">Features</a><a href="/tools/insurance-clause-generator">Clause tool</a><a href="/articles/">Articles</a><a class="btn" href="https://safecoi.com/login?mode=register">Start free</a></nav>
  </div>
</header>
<main id="main">
<section class="hero"><div class="wrap">
  <span class="eyebrow">Articles</span>
  <h1>Certificates, endorsements, and the gaps between them.</h1>
  <p class="lede">Field guides for general contractors who have to read the paperwork themselves. What the form says, what it misses, and what to ask a sub's broker for.</p>
</div></section>
<section class="section">
  <div class="wrap"><div class="post-list">${posts || '<p class="empty">No published articles yet.</p>'}</div></div>
</section>
<section class="band">
  <div class="wrap"><div class="band-card">
    <h2>Verify every COI your subs send — automatically.</h2>
    <p>Read-and-check verification for ACORD 25 certificates and endorsements, expiration tracking, and client-safe compliance reports.</p>
    <div class="btn-row"><a class="btn" href="https://safecoi.com/login?mode=register">Start free</a></div>
    <p class="band-note">Free for your first six months. No credit card.</p>
  </div></div>
</section>
</main>
<footer class="site-footer">
  <div class="wrap">
    <div>
      <div class="brandline">safecoi</div>
      <p style="margin:0;max-width:34ch">Certificate of insurance tracking and endorsement review for general contractors, remodelers, and repair contractors.</p>
    </div>
    <div>
      <h3>Product</h3>
      <a href="https://safecoi.com/solutions/subcontractor-coi-tracking">Subcontractor COI tracking</a>
      <a href="https://safecoi.com/features/acord-25-endorsement-verification">Endorsement verification</a>
      <a href="https://safecoi.com/tools/insurance-clause-generator">Insurance clause generator</a>
    </div>
    <div>
      <h3>Read</h3>
      <a href="/articles/">All articles</a>
    </div>
    <div>
      <h3>Company</h3>
      <a href="https://safecoi.com/">Home</a>
      <a href="https://safecoi.com/login">Sign in</a>
    </div>
  </div>
  <div class="wrap foot">
    <div class="disclaimer">Safecoi is not affiliated with Safeco Insurance. Information on this site is not legal or insurance advice — always consult a licensed broker or attorney for coverage decisions.</div>
    <div class="copy">© ${new Date().getFullYear()} safecoi.com</div>
  </div>
</footer>
</body></html>`
}

function renderArticleHtml(article: ArticleRow): string {
  const ogImg = article.og_image_url || 'https://safecoi.com/articles/assets/og/blog.png'
  const pubDate = formatDate(article.published_at || article.updated_at)
  const safeTitle = escapeHtml(article.title)
  const safeDesc = escapeHtml(article.description)
  const safeTag = escapeHtml(article.tag)
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.description,
    image: ogImg,
    datePublished: article.published_at || article.created_at,
    dateModified: article.updated_at,
    author: { '@type': 'Organization', name: 'Safecoi' },
    publisher: { '@type': 'Organization', name: 'Safecoi', url: 'https://safecoi.com/' },
    mainEntityOfPage: { '@type': 'WebPage', '@id': `https://safecoi.com/articles/${article.slug}/` },
  })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} | Safecoi</title>
<meta name="description" content="${safeDesc}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="https://safecoi.com/articles/${escapeHtml(article.slug)}/">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Safecoi">
<meta property="og:title" content="${safeTitle} | Safecoi">
<meta property="og:description" content="${safeDesc}">
<meta property="og:url" content="https://safecoi.com/articles/${escapeHtml(article.slug)}/">
<meta property="og:image" content="${escapeHtml(ogImg)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safeTitle} | Safecoi">
<meta name="twitter:description" content="${safeDesc}">
<meta name="twitter:image" content="${escapeHtml(ogImg)}">
<link rel="icon" href="/articles/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/articles/styles.css">
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="https://safecoi.com/" aria-label="Safecoi home"><span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg></span><span>safe<b>coi</b></span></a>
    <nav class="nav" aria-label="Main"><a href="/solutions/subcontractor-coi-tracking">Solutions</a><a href="/industries/remodeling-contractor-compliance">Industries</a><a href="/features/acord-25-endorsement-verification">Features</a><a href="/tools/insurance-clause-generator">Clause tool</a><a href="/articles/">Articles</a><a class="btn" href="https://safecoi.com/login?mode=register">Start free</a></nav>
  </div>
</header>
<main id="main">
<div class="wrap"><nav class="crumbs" aria-label="Breadcrumb"><a href="https://safecoi.com/">Home</a><span>/</span><a href="/articles/">Articles</a><span>/</span>${safeTitle}</nav></div>
<div class="wrap" style="max-width:820px;padding-bottom:72px">
  <div class="article-head"><article>
    <span class="kicker">${safeTag}</span>
    <h1>${safeTitle}</h1>
    <p class="meta">${pubDate ? `<span>${pubDate}</span><span class="dot"></span>` : ''}<span>${article.reading_time_min} min read</span></p>
    <div class="prose">${article.body_html}</div>
  </article></div>
</div>
<section class="band">
  <div class="wrap"><div class="band-card">
    <h2>Validate every COI your subs send you — automatically.</h2>
    <p>Read-and-check verification for ACORD 25 certificates and endorsements, expiration tracking, and client-safe compliance reports.</p>
    <div class="btn-row"><a class="btn" href="https://safecoi.com/login?mode=register">Start free</a></div>
    <p class="band-note">Free for your first six months. No credit card.</p>
  </div></div>
</section>
</main>
<footer class="site-footer">
  <div class="wrap">
    <div>
      <div class="brandline">safecoi</div>
      <p style="margin:0;max-width:34ch">Certificate of insurance tracking and endorsement review for general contractors, remodelers, and repair contractors.</p>
    </div>
    <div>
      <h3>Product</h3>
      <a href="https://safecoi.com/solutions/subcontractor-coi-tracking">Subcontractor COI tracking</a>
      <a href="https://safecoi.com/features/acord-25-endorsement-verification">Endorsement verification</a>
      <a href="https://safecoi.com/tools/insurance-clause-generator">Insurance clause generator</a>
    </div>
    <div>
      <h3>Read</h3>
      <a href="/articles/">All articles</a>
    </div>
    <div>
      <h3>Company</h3>
      <a href="https://safecoi.com/">Home</a>
      <a href="https://safecoi.com/login">Sign in</a>
    </div>
  </div>
  <div class="wrap foot">
    <div class="disclaimer">Safecoi is not affiliated with Safeco Insurance. Information on this site is not legal or insurance advice — always consult a licensed broker or attorney for coverage decisions.</div>
    <div class="copy">© ${new Date().getFullYear()} safecoi.com</div>
  </div>
</footer>
</body></html>`
}

function renderSitemap(articles: ArticleRow[]): string {
  const staticPages = [
    { loc: 'https://safecoi.com/', changefreq: 'weekly', priority: '1.0' },
    { loc: 'https://safecoi.com/solutions/subcontractor-coi-tracking', changefreq: 'weekly', priority: '0.9' },
    { loc: 'https://safecoi.com/features/acord-25-endorsement-verification', changefreq: 'weekly', priority: '0.9' },
    { loc: 'https://safecoi.com/industries/remodeling-contractor-compliance', changefreq: 'weekly', priority: '0.9' },
    { loc: 'https://safecoi.com/pricing', changefreq: 'weekly', priority: '0.8' },
    { loc: 'https://safecoi.com/tools/insurance-clause-generator', changefreq: 'weekly', priority: '0.8' },
    { loc: 'https://safecoi.com/articles/', changefreq: 'daily', priority: '0.8' },
  ]
  const entries = [
    ...staticPages.map(
      (p) => `<url><loc>${p.loc}</loc><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`
    ),
    ...articles.map(
      (a) => `<url><loc>https://safecoi.com/articles/${escapeHtml(a.slug)}/</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`
    ),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>`
}

articlesRouter.get('/sitemap.xml', async (_req, res, next) => {
  try {
    const articles = await dbAll<ArticleRow>(
      `SELECT * FROM articles WHERE status = 'published' ORDER BY position ASC, updated_at DESC`
    )
    res.type('application/xml').send(renderSitemap(articles))
  } catch (e) {
    next(e)
  }
})

articlesRouter.get(/^\/articles\/?$/, async (req, res, next) => {
  const norm = req.originalUrl.split('?')[0]
  if (norm === '/articles') return res.redirect(301, '/articles/')
  try {
    const articles = await dbAll<ArticleRow>(
      `SELECT * FROM articles WHERE status = 'published' ORDER BY position ASC, updated_at DESC`
    )
    res.type('html').send(renderHubHtml(articles))
  } catch (e) {
    next(e)
  }
})

articlesRouter.get(/^\/articles\/([^/]+)\/?$/, async (req, res, next) => {
  try {
    const slug = req.params[0]
    if (/\.(css|js|svg|png|jpg|ico|xml|txt|map|webp|woff2?)$/i.test(slug)) return next()
    const pathPart = req.originalUrl.split('?')[0]
    if (!pathPart.endsWith('/')) return res.redirect(301, `${pathPart}/`)
    const article = await dbGet<ArticleRow>(
      `SELECT * FROM articles WHERE slug = ? AND status = 'published'`,
      [slug]
    )
    if (!article) return res.status(404).type('html').send(renderNotFoundHtml(req.originalUrl.split('?')[0]))
    res.type('html').send(renderArticleHtml(article))
  } catch (e) {
    next(e)
  }
})
