import { useEffect } from 'react'

type JsonLd = Record<string, unknown>

interface SeoProps {
  title: string
  description: string
  canonicalPath: string
  ogType?: 'website' | 'article'
  jsonLd?: JsonLd | JsonLd[]
}

function upsertMetaByName(name: string, content: string) {
  let el = document.head.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute('name', name)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function upsertMetaByProperty(property: string, content: string) {
  let el = document.head.querySelector(`meta[property="${property}"]`) as HTMLMetaElement | null
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute('property', property)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function upsertCanonical(href: string) {
  let el = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', 'canonical')
    document.head.appendChild(el)
  }
  el.setAttribute('href', href)
}

function replaceJsonLd(blocks: JsonLd[]) {
  document.head
    .querySelectorAll('script[type="application/ld+json"][data-bmr-seo="true"]')
    .forEach((el) => el.remove())

  for (const block of blocks) {
    const script = document.createElement('script')
    script.setAttribute('type', 'application/ld+json')
    script.setAttribute('data-bmr-seo', 'true')
    script.text = JSON.stringify(block)
    document.head.appendChild(script)
  }
}

export function Seo({ title, description, canonicalPath, ogType = 'website', jsonLd }: SeoProps) {
  useEffect(() => {
    const origin = window.location.origin
    const canonicalUrl = `${origin}${canonicalPath}`

    document.title = title
    upsertMetaByName('description', description)
    upsertMetaByProperty('og:type', ogType)
    upsertMetaByProperty('og:title', title)
    upsertMetaByProperty('og:description', description)
    upsertMetaByProperty('og:url', canonicalUrl)
    upsertMetaByName('twitter:title', title)
    upsertMetaByName('twitter:description', description)
    upsertCanonical(canonicalUrl)

    const blocks = Array.isArray(jsonLd) ? jsonLd : jsonLd ? [jsonLd] : []
    replaceJsonLd(blocks)

    return () => {
      document.head
        .querySelectorAll('script[type="application/ld+json"][data-bmr-seo="true"]')
        .forEach((el) => el.remove())
    }
  }, [title, description, canonicalPath, ogType, jsonLd])

  return null
}
