import { useState } from 'react'

/** Isolated reader: provider HTML cannot execute scripts, submit forms or contact arbitrary hosts. */
export function ArticlePreview({ html, label = '文章预览' }: { html: string; label?: string }) {
  const [width, setWidth] = useState(375)
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https://mmbiz.qpic.cn; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">`
  return <div className="md2-preview-area">
    <div className="md2-preview-width" aria-label="预览宽度">
      {[320, 375, 390].map(size => <button key={size} type="button" aria-pressed={size === width} onClick={() => setWidth(size)}>{size}px</button>)}
    </div>
    <div className="md2-phone" style={{ width, maxWidth: '100%' }}>
      <iframe title={label} sandbox="" referrerPolicy="no-referrer" srcDoc={csp + html} />
    </div>
  </div>
}
