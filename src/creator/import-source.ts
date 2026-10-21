import { randomUUID } from 'node:crypto'
import type { ArtifactStore } from '../workspace/artifact-store.ts'
import { discoverMarkdownImageDestinations } from '../tools/preview.ts'
import type { ArticleImportRequest } from './types.ts'

/** Names are display-only; storage and all permissions remain owned by ArtifactStore. */
export async function importMarkdown(store: ArtifactStore, input: ArticleImportRequest, signal: AbortSignal): Promise<string> {
 signal.throwIfAborted()
 if (typeof input.markdown !== 'string' || !input.markdown.isWellFormed() || !input.markdown.trim() || Buffer.byteLength(input.markdown) > 2*1024*1024) throw new Error('[md2wechat:IMPORT_INVALID]')
 const bytes = new TextEncoder().encode(input.markdown.replace(/^\uFEFF/u, ''))
 if (discoverMarkdownImageDestinations(bytes).some(path => !/^https?:\/\//u.test(path))) throw new Error('[md2wechat:IMPORT_IMAGES]')
 const path = `imports/${randomUUID()}/article.md`
 await store.createExclusive(path, bytes, signal)
 signal.throwIfAborted()
 return store.resolve(path)
}

import { validateImageBytes } from '../workspace/images.ts'
import type { SupportedImageMime } from '../workspace/images.ts'
import type { ImageBytesRequest } from './types.ts'
export async function importImageBytes(store: ArtifactStore, input: ImageBytesRequest, signal: AbortSignal): Promise<string> {
 signal.throwIfAborted()
 const formats: Record<string, string> = { 'image/png':'png', 'image/jpeg':'jpg', 'image/gif':'gif', 'image/webp':'webp' }
 if (!Object.hasOwn(formats, input.contentType) || !Array.isArray(input.data) || !input.data.length || input.data.length > 8*1024*1024 || input.data.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('[md2wechat:IMAGE_INVALID]')
 const bytes = Uint8Array.from(input.data)
 try { validateImageBytes(input.contentType as SupportedImageMime, bytes) } catch { throw new Error('[md2wechat:IMAGE_INVALID]') }
 const path = `imports/${randomUUID()}/image.${formats[input.contentType]}`
 await store.createExclusive(path, bytes, signal)
 signal.throwIfAborted()
 return store.resolve(path)
}
