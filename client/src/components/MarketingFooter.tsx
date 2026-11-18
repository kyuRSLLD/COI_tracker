import { Link } from 'react-router-dom'

interface MarketingFooterLink {
  to: string
  label: string
  /** Static documents under /articles are served outside the SPA, so they need a real navigation. */
  external?: boolean
}

interface MarketingFooterProps {
  links?: MarketingFooterLink[]
}

const defaultLinks: MarketingFooterLink[] = [
  { to: '/solutions/subcontractor-coi-tracking', label: 'Sub tracking' },
  { to: '/industries/remodeling-contractor-compliance', label: 'Remodeling' },
  { to: '/features/acord-25-endorsement-verification', label: 'ACORD 25 verification' },
  { to: '/tools/insurance-clause-generator', label: 'Clause generator' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/articles/', label: 'Articles', external: true },
]

export function MarketingFooter({ links = defaultLinks }: MarketingFooterProps) {
  return (
    <footer className="border-t border-slate-200 mt-8 py-6 text-xs text-slate-500 max-w-4xl mx-auto px-5 flex flex-wrap items-center justify-between gap-3">
      <span>
        Safecoi is independent B2B compliance software.{' '}
        <strong>Not affiliated with Safeco Insurance.</strong>
      </span>
      <div className="flex flex-wrap gap-4">
        {links.map((l) =>
          l.external ? (
            <a key={l.to} href={l.to} className="hover:underline">
              {l.label}
            </a>
          ) : (
            <Link key={l.to} to={l.to} className="hover:underline">
              {l.label}
            </Link>
          ),
        )}
      </div>
    </footer>
  )
}
