export interface RouteMeta {
  title: string
  description: string
  canonical: string
  ogImage?: string
  ogType?: 'website' | 'article'
}

/**
 * Route metadata registry for server-rendered <head> tags on marketing routes.
 * Must match the client-side <SEO> props on each page so initial HTML equals
 * the client-hydrated DOM (webdev-seo: keep client-side navigation's title and
 * metadata consistent with the initial response for the same URL).
 */
/**
 * Routes that have a build-time pre-rendered HTML file under client/dist/prerendered.
 * Those files carry the full page markup so crawlers that do not run JavaScript
 * still see the copy, headings, pricing and FAQ.
 */
export const PRERENDERED_PAGES: Record<string, string> = {
  '/': 'home.html',
  '/pricing': 'pricing.html',
  '/solutions/subcontractor-coi-tracking': 'solutions/subcontractor-coi-tracking.html',
  '/industries/remodeling-contractor-compliance': 'industries/remodeling-contractor-compliance.html',
  '/features/acord-25-endorsement-verification': 'features/acord-25-endorsement-verification.html',
  '/tools/insurance-clause-generator': 'tools/insurance-clause-generator.html',
}

export const MARKETING_META: Record<string, RouteMeta> = {
  '/': {
    title: 'COI Tracking & Validation Software for Contractors | Safecoi',
    description:
      'Safecoi is B2B software that helps general contractors collect, organize, and verify subcontractor COIs and endorsements — so your records are audit-ready before anyone steps on site.',
    canonical: 'https://safecoi.com/',
    ogImage: 'https://safecoi.com/articles/assets/og/home.png',
  },
  '/pricing': {
    title: 'SafeCOI Pricing \u2014 Free for Your First Six Months',
    description:
      'Collect, verify, and monitor subcontractor COIs. Free for your first six months, no credit card required \u2014 then $10/month. Subcontractors never pay.',
    canonical: 'https://safecoi.com/pricing',
    ogImage: 'https://safecoi.com/articles/assets/og/home.png',
  },
  '/solutions/subcontractor-coi-tracking': {
    title: 'Subcontractor COI Tracking Software for General Contractors | Safecoi',
    description:
      'Stop chasing subcontractor insurance in spreadsheets. Safecoi automates COI collection, expiration alerts, and endorsement checks — so every sub is covered on every job site.',
    canonical: 'https://safecoi.com/solutions/subcontractor-coi-tracking',
    ogImage: 'https://safecoi.com/articles/assets/og/solutions.png',
  },
  '/industries/remodeling-contractor-compliance': {
    title: 'Insurance Compliance Software for Remodelers & Home Repair | Safecoi',
    description:
      'Protect your residential remodeling business: collect and verify COIs from plumbers, electricians, roofers, and HVAC trades with one link — no sub accounts needed.',
    canonical: 'https://safecoi.com/industries/remodeling-contractor-compliance',
    ogImage: 'https://safecoi.com/articles/assets/og/remodeling.png',
  },
  '/features/acord-25-endorsement-verification': {
    title: 'ACORD 25 & Endorsement Verification Software | Safecoi',
    description:
      'AI-powered ACORD 25 review with checks for Additional Insured CG 20 10/CG 20 37, Waiver of Subrogation, Primary & Non-Contributory wording, and expiration alerts.',
    canonical: 'https://safecoi.com/features/acord-25-endorsement-verification',
    ogImage: 'https://safecoi.com/articles/assets/og/verification.png',
  },
  '/tools/insurance-clause-generator': {
    title: 'Free Subcontractor Insurance Clause & Requirement Generator | Safecoi',
    description:
      'Generate copy-paste insurance requirement clauses for subcontractor agreements. Pick your trade and project size — free, no signup.',
    canonical: 'https://safecoi.com/tools/insurance-clause-generator',
    ogImage: 'https://safecoi.com/articles/assets/og/tool.png',
  },
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Injects route-specific <title>, <meta description>, <link rel="canonical">,
 * and Open Graph / Twitter tags into the built client/index.html string.
 * Tags must already exist in index.html (as default homepage values) to be replaced.
 */
export function injectMarketingMeta(indexHtml: string, meta: RouteMeta): string {
  const safeTitle = escapeHtml(meta.title)
  const safeDesc = escapeHtml(meta.description)
  const safeCanon = escapeHtml(meta.canonical)
  const ogImg = meta.ogImage ?? 'https://safecoi.com/articles/assets/og/home.png'
  let out = indexHtml
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`)
  out = out.replace(
    /<meta name="description" content="[^"]*"/,
    `<meta name="description" content="${safeDesc}"`,
  )
  out = out.replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${safeCanon}"`)
  out = out.replace(
    /<meta property="og:title" content="[^"]*"/,
    `<meta property="og:title" content="${safeTitle}"`,
  )
  out = out.replace(
    /<meta property="og:description" content="[^"]*"/,
    `<meta property="og:description" content="${safeDesc}"`,
  )
  out = out.replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${safeCanon}"`)
  out = out.replace(
    /<meta property="og:image" content="[^"]*"/,
    `<meta property="og:image" content="${escapeHtml(ogImg)}"`,
  )
  out = out.replace(
    /<meta name="twitter:title" content="[^"]*"/,
    `<meta name="twitter:title" content="${safeTitle}"`,
  )
  out = out.replace(
    /<meta name="twitter:description" content="[^"]*"/,
    `<meta name="twitter:description" content="${safeDesc}"`,
  )
  out = out.replace(
    /<meta name="twitter:image" content="[^"]*"/,
    `<meta name="twitter:image" content="${escapeHtml(ogImg)}"`,
  )
  return out
}

const EXACT_ROUTES = new Set([
  '/',
  '/login',
  '/demo',
  '/dashboard',
  '/subcontractors',
  '/projects',
  '/emails',
  '/settings',
  '/subcontractor',
  '/sub',
  '/sub/my',
  '/staff',
  '/admin',
  '/connect-sub',
  '/pricing',
  '/solutions/subcontractor-coi-tracking',
  '/industries/remodeling-contractor-compliance',
  '/features/acord-25-endorsement-verification',
  '/tools/insurance-clause-generator',
])

const PREFIX_ROUTES = ['/staff/coi/', '/join/', '/share/company/', '/share/', '/upload/']

/**
 * Returns true if a path is a known application route that the SPA should serve
 * with HTTP 200. Unknown paths must receive a real 404 (kill soft-404s).
 */
export function isKnownRoute(pathname: string): boolean {
  const norm = pathname.replace(/\/+$/, '') || '/'
  if (EXACT_ROUTES.has(norm)) return true
  for (const prefix of PREFIX_ROUTES) {
    if (norm.startsWith(prefix) && norm.length > prefix.length) return true
  }
  return false
}

/**
 * Server-rendered 404 page for unknown full-page HTML requests.
 * Uses noindex robots meta so crawlers do not index error responses, and returns
 * the human visitor to the homepage with a helpful message.
 */
export function renderNotFoundHtml(pathname: string): string {
  const safePath = escapeHtml(pathname)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found | Safecoi</title>
<meta name="robots" content="noindex, follow">
<link rel="icon" href="/articles/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/articles/styles.css">
</head>
<body>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="https://safecoi.com/" aria-label="Safecoi home"><span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg></span><span>safe<b>coi</b></span></a>
    <nav class="nav" aria-label="Main"><a href="/solutions/subcontractor-coi-tracking">Solutions</a><a href="/pricing">Pricing</a><a href="/features/acord-25-endorsement-verification">Features</a><a href="/articles/">Articles</a><a class="btn" href="https://safecoi.com/login?mode=register">Start free</a></nav>
  </div>
</header>
<main id="main">
<section class="hero"><div class="wrap">
  <span class="eyebrow">404</span>
  <h1>This page doesn't exist.</h1>
  <p class="lede">The address <code>${safePath}</code> was not found. Try the links below, or head back to the homepage.</p>
</div></section>
<section class="section">
  <div class="wrap">
    <div class="prose" style="max-width:680px">
      <h2>Popular pages</h2>
      <ul>
        <li><a href="/">Safecoi homepage — COI tracking for general contractors</a></li>
        <li><a href="/pricing">Pricing — plans for subcontractors and GCs</a></li>
        <li><a href="/solutions/subcontractor-coi-tracking">Subcontractor COI tracking</a></li>
        <li><a href="/features/acord-25-endorsement-verification">ACORD 25 &amp; endorsement verification</a></li>
        <li><a href="/articles/">Field guides and articles</a></li>
      </ul>
      <p style="margin-top:32px"><a href="/" class="btn" style="background:#14181d;color:#fff;padding:11px 20px;border-radius:7px;text-decoration:none;font-weight:600">Back to homepage</a></p>
    </div>
  </div>
</section>
</main>
<footer class="site-footer">
  <div class="wrap foot">
    <div class="disclaimer">Safecoi is not affiliated with Safeco Insurance.</div>
    <div class="copy">© ${new Date().getFullYear()} safecoi.com</div>
  </div>
</footer>
</body></html>`
}
