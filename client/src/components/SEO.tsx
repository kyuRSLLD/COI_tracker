import { useEffect } from 'react'

interface SEOProps {
  title: string
  description?: string
  canonical?: string
  noindex?: boolean
}

/**
 * Updates document <title>, meta description, canonical link, and robots tag per route.
 * Safe no-op outside the browser (SSR).
 */
export function SEO({ title, description, canonical, noindex }: SEOProps) {
  useEffect(() => {
    document.title = title

    if (description) {
      let el = document.querySelector('meta[name="description"]')
      if (!el) {
        el = document.createElement('meta')
        el.setAttribute('name', 'description')
        document.head.appendChild(el)
      }
      el.setAttribute('content', description)
    }

    if (canonical) {
      let el = document.querySelector('link[rel="canonical"]')
      if (!el) {
        el = document.createElement('link')
        el.setAttribute('rel', 'canonical')
        document.head.appendChild(el)
      }
      el.setAttribute('href', canonical)
    }

    if (noindex) {
      let el = document.querySelector('meta[name="robots"]')
      if (!el) {
        el = document.createElement('meta')
        el.setAttribute('name', 'robots')
        document.head.appendChild(el)
      }
      el.setAttribute('content', 'noindex, follow')
    } else {
      const el = document.querySelector('meta[name="robots"]')
      if (el) el.remove()
    }
  }, [title, description, canonical, noindex])

  return null
}
