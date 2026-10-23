
/** Isolated reader: provider HTML cannot execute scripts, submit forms or contact arbitrary hosts. */
export function ArticlePreview({ html, label = '文章预览' }: { html: string; label?: string }) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https://mmbiz.qpic.cn; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">`
  return <div className="md2-preview-area">
    <div className="md2-phone" >
      <iframe title={label} sandbox="" referrerPolicy="no-referrer" srcDoc={csp + html} />
    </div>
  </div>
}
