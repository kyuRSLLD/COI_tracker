import type { ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { Navbar } from './components/Navbar'
import { LandingPage } from './pages/LandingPage'
import { PricingPage } from './pages/PricingPage'
import { SubcontractorCoiTrackingPage } from './pages/solutions/SubcontractorCoiTrackingPage'
import { RemodelingContractorCompliancePage } from './pages/industries/RemodelingContractorCompliancePage'
import { Acord25EndorsementVerificationPage } from './pages/features/Acord25EndorsementVerificationPage'
import { InsuranceClauseGeneratorPage } from './pages/tools/InsuranceClauseGeneratorPage'
import { LANDING_FAQS } from './pages/LandingPage'
import { PRICING_FAQS } from './pages/PricingPage'

/**
 * Marketing routes that are pre-rendered to static HTML at build time.
 * Keep in sync with MARKETING_META / PRERENDERED_PAGES in server/src/seo.ts.
 */
const PAGES: Record<string, () => ReactElement> = {
  '/': () => <LandingPage onLogin={() => {}} />,
  '/pricing': () => <PricingPage />,
  '/solutions/subcontractor-coi-tracking': () => <SubcontractorCoiTrackingPage />,
  '/industries/remodeling-contractor-compliance': () => <RemodelingContractorCompliancePage />,
  '/features/acord-25-endorsement-verification': () => <Acord25EndorsementVerificationPage />,
  '/tools/insurance-clause-generator': () => <InsuranceClauseGeneratorPage />,
}

export const PRERENDER_ROUTES = Object.keys(PAGES)

/**
 * Renders a marketing route to the exact markup the anonymous client renders:
 * the shell div, the public navbar, and the page inside <main>.
 */
export function render(pathname: string): string {
  const Page = PAGES[pathname]
  if (!Page) throw new Error(`No pre-render entry for ${pathname}`)
  return renderToString(
    <StaticRouter location={pathname}>
      <div className="min-h-screen flex flex-col">
        <Navbar user={null} onLogout={() => {}} />
        <main className="flex-1">
          <Page />
        </main>
      </div>
    </StaticRouter>,
  )
}

function faqPage(faqs: Array<{ q: string; a: string }>, url: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${url}#faq`,
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  }
}

/**
 * Route-specific JSON-LD built from the same FAQ arrays the page renders, so the
 * markup can never drift from the visible copy.
 */
export function structuredData(pathname: string): string {
  const url = pathname === '/' ? 'https://safecoi.com/' : `https://safecoi.com${pathname}`
  if (pathname === '/') {
    return JSON.stringify(faqPage(LANDING_FAQS, url))
  }
  if (pathname === '/pricing') {
    return JSON.stringify(faqPage(PRICING_FAQS, url))
  }
  return ''
}
