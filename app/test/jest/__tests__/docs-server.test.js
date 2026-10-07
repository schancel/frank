const fs = require('fs')
const path = require('path')

describe('Documentation embedding and serving', () => {
  const docsDir = path.resolve(__dirname, '../../../public/docs')

  it('contains built VitePress static HTML in app/public/docs', () => {
    const indexPath = path.join(docsDir, 'index.html')
    expect(fs.existsSync(indexPath)).toBe(true)

    const content = fs.readFileSync(indexPath, 'utf8')
    expect(content).toContain('VitePress')
    expect(content).toContain('Frank &amp; Cashweb')
    expect(content).toContain('href="/docs/assets/')
    expect(content).toContain('src="/docs/frank-logo.svg"')
    expect(content).toContain('href="/docs/guide/introduction"')
  })

  it('contains 404 fallback page to avoid SPA history fallback', () => {
    const notFoundPath = path.join(docsDir, '404.html')
    expect(fs.existsSync(notFoundPath)).toBe(true)

    const content = fs.readFileSync(notFoundPath, 'utf8')
    expect(content).toContain('404')
  })

  it('correctly maps docs URLs to static files avoiding SPA index fallback', () => {
    function resolveDocsUrl(url) {
      const [pathname] = url.split('?')
      if (!pathname.startsWith('/docs')) return null

      if (pathname === '/docs') {
        return { redirect: '/docs/' }
      }

      const subPath = pathname.slice('/docs/'.length)
      const candidate = path.join(docsDir, subPath)

      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { file: pathname }
      }

      if (fs.existsSync(path.join(candidate, 'index.html'))) {
        const suffix = pathname.endsWith('/') ? 'index.html' : '/index.html'
        return { file: pathname + suffix }
      }

      if (fs.existsSync(candidate + '.html')) {
        return { file: pathname + '.html' }
      }

      if (fs.existsSync(path.join(docsDir, '404.html'))) {
        return { file: '/docs/404.html' }
      }

      return null
    }

    expect(resolveDocsUrl('/docs')).toEqual({ redirect: '/docs/' })
    expect(resolveDocsUrl('/docs/')).toEqual({ file: '/docs/index.html' })
    expect(resolveDocsUrl('/docs/guide/introduction')).toEqual({
      file: '/docs/guide/introduction.html',
    })
    expect(resolveDocsUrl('/docs/cbor/spec')).toEqual({
      file: '/docs/cbor/spec.html',
    })
    expect(resolveDocsUrl('/docs/protocol/dns-routing')).toEqual({
      file: '/docs/protocol/dns-routing.html',
    })
    expect(resolveDocsUrl('/docs/nonexistent-route')).toEqual({
      file: '/docs/404.html',
    })
  })
})
