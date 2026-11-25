import { useEffect } from 'react'

interface SEOProps {
  title: string
  description?: string
  canonical?: string
  noindex?: boolean
  ogImage?: string
  ogUrl?: string
  ogType?: string
  twitterCard?: string
}

function setMeta(attr: 'name' | 'property', key: string, content: string | undefined, removeIfEmpty = false) {
  let el = document.querySelector(`meta[${attr}="${key}"]`)
  if (content) {
    if (!el) {
      el = document.createElement('meta')
      el.setAttribute(attr, key)
      document.head.appendChild(el)
    }
    el.setAttribute('content', content)
  } else if (removeIfEmpty && el) {
    el.remove()
  }
}

/**
 * Updates document <title>, meta description, canonical link, Open Graph,
 * Twitter tags, and robots per route. Safe no-op outside the browser (SSR).
 */
export function SEO({
  title,
  description,
  canonical,
  noindex,
  ogImage,
  ogUrl,
  ogType = 'website',
  twitterCard = 'summary_large_image',
}: SEOProps) {
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
    setMeta('property', 'og:type', ogType)
    setMeta('property', 'og:site_name', 'Safecoi')
    setMeta('property', 'og:title', title)
    setMeta('property', 'og:description', description)
    setMeta('property', 'og:url', ogUrl ?? canonical)
    setMeta('property', 'og:image', ogImage)
    setMeta('property', 'og:image:width', ogImage ? '1200' : undefined, true)
    setMeta('property', 'og:image:height', ogImage ? '630' : undefined, true)
    setMeta('name', 'twitter:card', twitterCard)
    setMeta('name', 'twitter:title', title)
    setMeta('name', 'twitter:description', description)
    setMeta('name', 'twitter:image', ogImage)
  }, [title, description, canonical, noindex, ogImage, ogUrl, ogType, twitterCard])
  return null
}
