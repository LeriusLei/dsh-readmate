/**
 * 随读 Reading Companion — host core (pure Node, no Cordis).
 * EPUB scanning/parsing, Markdown knowledge base, reading progress, RPC dispatcher.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import os from 'node:os'
import { execFile } from 'node:child_process'

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function readJson(file, fallback) {
  try {
    // Tolerate a UTF-8 BOM: config files written by other tools sometimes carry
    // one, and JSON.parse would otherwise reject the whole document silently.
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function hashId(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 12)
}

export function nowIso() {
  return new Date().toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '')
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·' }
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0) {
        try { return String.fromCodePoint(code) } catch { return m }
      }
      return m
    }
    const v = named[body.toLowerCase()]
    return v === undefined ? m : v
  })
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, '')
}

function parseAttrs(source) {
  const out = {}
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(source)) !== null) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? ''
  return out
}

function posixJoin(...parts) {
  return path.posix.normalize(path.posix.join(...parts.map((p) => String(p).replace(/\\/g, '/'))))
}

function stripFragment(href) {
  return String(href || '').split('#')[0]
}

// ---------------------------------------------------------------------------
// ZIP reader (central directory based, efficient for large EPUBs)
// ---------------------------------------------------------------------------
export class ZipReader {
  constructor(file) {
    this.file = file
    this.fd = fs.openSync(file, 'r')
    this.size = fs.fstatSync(this.fd).size
    this.entries = new Map()
    this.loadCentralDirectory()
  }

  loadCentralDirectory() {
    const tailLen = Math.min(this.size, 22 + 0xffff)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(this.fd, tail, 0, tailLen, this.size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) throw new Error('不是有效的 EPUB/ZIP 文件（未找到中央目录）')
    const count = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      // ZIP64 locator
      const loc = Buffer.alloc(20)
      fs.readSync(this.fd, loc, 0, 20, this.size - tailLen + eocd - 20)
      if (loc.readUInt32LE(0) === 0x07064b50) {
        const z64Off = Number(loc.readBigUInt64LE(8))
        const z64 = Buffer.alloc(56)
        fs.readSync(this.fd, z64, 0, 56, z64Off)
        if (z64.readUInt32LE(0) === 0x06064b50) {
          const n = Number(z64.readBigUInt64LE(32))
          cdSize = Number(z64.readBigUInt64LE(40))
          cdOffset = Number(z64.readBigUInt64LE(48))
          if (count === 0xffff) { /* use n */ }
        }
      }
    }
    const cd = Buffer.alloc(cdSize)
    fs.readSync(this.fd, cd, 0, cdSize, cdOffset)
    let p = 0
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const method = cd.readUInt16LE(p + 10)
      const csize = cd.readUInt32LE(p + 20)
      const usize = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const offset = cd.readUInt32LE(p + 42)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
      this.entries.set(name, { name, method, csize, usize, offset })
      p += 46 + nameLen + extraLen + commentLen
    }
    this.lower = new Map()
    for (const key of this.entries.keys()) this.lower.set(key.toLowerCase(), key)
  }

  find(name) {
    if (this.entries.has(name)) return this.entries.get(name)
    const key = this.lower.get(String(name).toLowerCase())
    return key === undefined ? undefined : this.entries.get(key)
  }

  readBuffer(name) {
    const entry = this.find(name)
    if (entry === undefined) return undefined
    const local = Buffer.alloc(30)
    fs.readSync(this.fd, local, 0, 30, entry.offset)
    const nameLen = local.readUInt16LE(26)
    const extraLen = local.readUInt16LE(28)
    const start = entry.offset + 30 + nameLen + extraLen
    const raw = Buffer.alloc(entry.csize)
    if (entry.csize > 0) fs.readSync(this.fd, raw, 0, entry.csize, start)
    if (entry.method === 0) return raw
    if (entry.method === 8) return zlib.inflateRawSync(raw)
    throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}`)
  }

  readText(name) {
    const buf = this.readBuffer(name)
    return buf === undefined ? undefined : buf.toString('utf8')
  }

  close() {
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd) } catch { /* ignore */ }
      this.fd = undefined
    }
  }
}

// ---------------------------------------------------------------------------
// EPUB parsing
// ---------------------------------------------------------------------------
export function openEpub(file) {
  const zip = new ZipReader(file)
  try {
    const container = zip.readText('META-INF/container.xml')
    if (container === undefined) throw new Error('EPUB 缺少 META-INF/container.xml')
    const rootMatch = /<rootfile\b[^>]*>/i.exec(container)
    const rootAttrs = rootMatch === null ? {} : parseAttrs(rootMatch[0])
    const opfPath = rootAttrs['full-path'] || rootAttrs.fullpath
    if (!opfPath) throw new Error('EPUB 缺少 OPF 路径')
    const opf = zip.readText(opfPath)
    if (opf === undefined) throw new Error(`EPUB 缺少 OPF 文件 ${opfPath}`)
    const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath)
    const title = decodeEntities(stripTags((/<(?:dc:)?title[^>]*>([\s\S]*?)<\/(?:dc:)?title>/i.exec(opf) || [])[1] || '')).trim()
    const author = decodeEntities(stripTags((/<(?:dc:)?creator[^>]*>([\s\S]*?)<\/(?:dc:)?creator>/i.exec(opf) || [])[1] || '')).trim()
    const language = decodeEntities(stripTags((/<(?:dc:)?language[^>]*>([\s\S]*?)<\/(?:dc:)?language>/i.exec(opf) || [])[1] || '')).trim()
    const manifest = new Map()
    const manifestRe = /<(?:opf:)?item\b([^>]*)\/?>/gi
    let m
    while ((m = manifestRe.exec(opf)) !== null) {
      const attrs = parseAttrs(m[1])
      if (attrs.id === undefined || attrs.href === undefined) continue
      manifest.set(attrs.id, {
        id: attrs.id,
        href: posixJoin(opfDir, stripFragment(attrs.href)),
        mediaType: (attrs['media-type'] || '').toLowerCase(),
        properties: attrs.properties || '',
      })
    }
    const spine = []
    const spineRe = /<(?:opf:)?itemref\b([^>]*)\/?>/gi
    while ((m = spineRe.exec(opf)) !== null) {
      const attrs = parseAttrs(m[1])
      if (attrs.idref === undefined) continue
      spine.push({ idref: attrs.idref, linear: attrs.linear !== 'no' })
    }
    // table of contents: nav document first, then NCX
    let tocMap = new Map()
    let tocOrder = []
    const navItem = [...manifest.values()].find((item) => /(^|\s)nav(\s|$)/.test(item.properties))
    if (navItem !== undefined) {
      const navHtml = zip.readText(navItem.href)
      if (navHtml !== undefined) {
        const navBlock = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*toc[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(navHtml)
          || /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(navHtml)
        if (navBlock !== null) {
          const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
          let a
          while ((a = linkRe.exec(navBlock[1])) !== null) {
            const attrs = parseAttrs(a[1])
            if (attrs.href === undefined) continue
            const text = decodeEntities(stripTags(a[2])).replace(/\s+/g, ' ').trim()
            if (text.length === 0) continue
            const target = posixJoin(opfDir, stripFragment(attrs.href))
            if (!tocMap.has(target)) tocMap.set(target, text)
            tocOrder.push(target)
          }
        }
      }
    }
    if (tocMap.size === 0) {
      const ncxId = /<spine\b([^>]*)>/i.exec(opf)
      const ncxItem = [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml')
        || (ncxId !== null ? manifest.get(parseAttrs(ncxId[1]).toc) : undefined)
      if (ncxItem !== undefined) {
        const ncx = zip.readText(ncxItem.href)
        if (ncx !== undefined) {
          const pointRe = /<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi
          let p
          while ((p = pointRe.exec(ncx)) !== null) {
            const label = decodeEntities(stripTags((/<text[^>]*>([\s\S]*?)<\/text>/i.exec(p[1]) || [])[1] || '')).replace(/\s+/g, ' ').trim()
            const src = (/<content[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(p[1]) || [])[1]
            if (label.length === 0 || src === undefined) continue
            const target = posixJoin(opfDir, stripFragment(src))
            if (!tocMap.has(target)) tocMap.set(target, label)
            tocOrder.push(target)
          }
        }
      }
    }
    const chapters = []
    for (const item of spine) {
      const info = manifest.get(item.idref)
      if (info === undefined) continue
      if (!/x?html/.test(info.mediaType) && info.mediaType !== '') continue
      if (info.mediaType === '') continue
      if (item.linear === false && spine.length > 4) continue
      chapters.push({
        href: info.href,
        title: tocMap.get(info.href) || '',
        mediaType: info.mediaType,
      })
    }
    if (chapters.length === 0) throw new Error('EPUB 没有可阅读的正文章节')
    chapters.forEach((chapter, index) => {
      if (!chapter.title) chapter.title = `第 ${index + 1} 节`
    })
    // cover image: EPUB3 properties, EPUB2 meta name="cover", or a cover-named image
    let coverItem = [...manifest.values()].find((item) => /(^|\s)cover-image(\s|$)/.test(item.properties))
    if (coverItem === undefined) {
      const metaCover = /<meta\b([^>]*\bname\s*=\s*["']cover["'][^>]*)>/i.exec(opf)
      if (metaCover !== null) {
        const content = parseAttrs(metaCover[1]).content
        if (content !== undefined) coverItem = manifest.get(content)
      }
    }
    if (coverItem === undefined) {
      coverItem = [...manifest.values()].find((item) => /^image\//.test(item.mediaType) && /cover/i.test(item.href))
    }
    return {
      zip,
      meta: {
        title: title || path.basename(file, path.extname(file)),
        author: author || '未知作者',
        language,
        refines: [],
        coverHref: coverItem === undefined ? '' : coverItem.href,
        coverMediaType: coverItem === undefined ? '' : coverItem.mediaType,
      },
      chapters,
      toc: tocOrder.map((href) => ({ href, title: tocMap.get(href) || '' })).filter((entry) => entry.title !== ''),
    }
  } catch (error) {
    zip.close()
    throw error
  }
}

export function readEpubMetadata(file) {
  const epub = openEpub(file)
  try {
    return {
      title: epub.meta.title,
      author: epub.meta.author,
      language: epub.meta.language,
      chapterCount: epub.chapters.length,
      coverHref: epub.meta.coverHref,
      coverMediaType: epub.meta.coverMediaType,
    }
  } finally {
    epub.zip.close()
  }
}

export function htmlToBlocks(html) {
  if (html === undefined) return []
  let source = String(html)
  source = source.replace(/<!--[\s\S]*?-->/g, '')
  source = source.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
  source = source.replace(/<body\b[^>]*>/gi, '')
  source = source.replace(/<br\s*\/?>/gi, '\n')
  source = source.replace(/<h([1-6])\b[^>]*>/gi, '\n\n@@H$1@@')
  source = source.replace(/<\/(h[1-6]|p|div|li|blockquote|pre|section|article|tr|td)\s*>/gi, '\n\n')
  source = source.replace(/<[^>]*>/g, '')
  source = decodeEntities(source)
  const blocks = []
  const segments = source.split(/@@H([1-6])@@/)
  // segments: [text, level, text, level, text ...]
  const pushText = (text, heading) => {
    const parts = String(text).split(/\n\s*\n/)
    for (const part of parts) {
      const cleaned = part.replace(/[ \t\u00a0]+/g, ' ').replace(/\n+/g, ' ').trim()
      if (cleaned.length === 0) continue
      if (heading > 0) {
        blocks.push({ type: `h${heading}`, text: cleaned.slice(0, 400) })
      } else {
        if (cleaned.length > 6000) {
          for (let i = 0; i < cleaned.length; i += 4000) blocks.push({ type: 'p', text: cleaned.slice(i, i + 4000) })
        } else {
          blocks.push({ type: 'p', text: cleaned })
        }
      }
    }
  }
  pushText(segments[0] || '', 0)
  for (let i = 1; i + 1 < segments.length; i += 2) pushText(segments[i + 1] || '', Number(segments[i]))
  return blocks.filter((block) => block.text.length > 0)
}

export function readChapter(epub, index) {
  const chapter = epub.chapters[index]
  if (chapter === undefined) throw new Error(`章节 ${index} 不存在`)
  const html = epub.zip.readText(chapter.href)
  const blocks = htmlToBlocks(html)
  return { index, title: chapter.title, blocks }
}

// ---------------------------------------------------------------------------
// multi-format reading
//
// The reader itself only understands "chapters + text blocks". EPUB is parsed
// straight from the zip. Plain text / Markdown / HTML are turned into chapters
// in memory. Everything else (PDF, AZW3, MOBI, DOCX, FB2, RTF) is converted to
// EPUB on demand with Calibre's `ebook-convert` and cached, so the original
// file is never touched and reading/quoting/progress all reuse one pipeline.
// ---------------------------------------------------------------------------
export const FORMAT_BY_EXT = {
  '.epub': 'epub', '.pdf': 'pdf', '.azw3': 'azw3', '.azw': 'azw', '.mobi': 'mobi',
  '.txt': 'txt', '.md': 'md', '.markdown': 'md', '.html': 'html', '.htm': 'html',
  '.docx': 'docx', '.fb2': 'fb2', '.rtf': 'rtf',
}
export const TEXT_FORMATS = new Set(['txt', 'md', 'html'])
export const CONVERT_FORMATS = new Set(['pdf', 'azw3', 'azw', 'mobi', 'docx', 'fb2', 'rtf'])
export const FORMAT_LABEL = { epub: 'EPUB', pdf: 'PDF', azw3: 'AZW3', azw: 'AZW', mobi: 'MOBI', txt: 'TXT', md: 'MD', html: 'HTML', docx: 'DOCX', fb2: 'FB2', rtf: 'RTF' }

// Calibre libraries are full of GBK/GB18030 text files; Node's ICU can decode
// them, so try UTF-8 first and fall back when it produces replacement chars.
export function decodeTextBytes(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  let text = ''
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  } catch {
    text = buffer.toString('utf8')
  }
  const broken = (text.match(/\uFFFD/g) || []).length
  if (broken > 2) {
    try {
      const legacy = new TextDecoder('gb18030').decode(buffer)
      if ((legacy.match(/\uFFFD/g) || []).length <= broken) text = legacy
    } catch { /* keep utf-8 */ }
  }
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

// `<书名> - <作者>.pdf` is the Calibre file naming; raw exports often have no
// author in the name, in which case they end with a parenthesised author and/or
// download-site tags such as "(Z-Library)". Strip the noise, lift the author
// out of the last group, and leave the rest of the title readable.
const SOURCE_NOISE = /z-?librar|z-?lib\b|1lib|annas?[-\s]?archive|libgen|epubee|bookzz|b-ok|sobooks|jx\.la|kindle|pdfdrive|magazinelib/i

export function stripSourceNoise(text) {
  let out = String(text || '')
  for (let round = 0; round < 4; round += 1) {
    const next = out
      .replace(/[（(]\s*([^()（）]*?)\s*[)）]/g, (whole, inner) => (SOURCE_NOISE.test(inner) || inner.trim().length === 0 ? '' : whole))
      .replace(/[【\[]\s*([^【】\[\]]*?)\s*[】\]]/g, (whole, inner) => (SOURCE_NOISE.test(inner) ? '' : whole))
    if (next === out) break
    out = next
  }
  return out.replace(/\s{2,}/g, ' ').trim()
}

// Dedupe key for titles: bracketed editions/author groups are ignored so a raw
// export and its Calibre copy land in the same bucket.
export function dedupeTitleKey(text) {
  let out = String(text || '')
  for (let round = 0; round < 4; round += 1) {
    const next = out.replace(/[（(][^()（）]*[)）]/g, '').replace(/[【\[][^【】\[\]]*[】\]]/g, '')
    if (next === out) break
    out = next
  }
  return out
    .toLowerCase()
    .replace(/z-?librar\S*/g, '')
    .replace(/[\s\u3000·•:：,，.。!！?？'"“”‘’《》「」『』【】()（）\[\]_-]/g, '')
}

export function parseFileName(file, fallbackAuthor = '未知作者') {
  const base = stripSourceNoise(path.basename(file, path.extname(file)))
  const cleaned = base.length > 0 ? base : path.basename(file, path.extname(file)).trim()
  const dashed = /^(.*\S)\s+-\s+(.*\S)$/.exec(cleaned)
  if (dashed !== null) return { title: dashed[1].trim(), author: dashed[2].trim() }
  const trailing = /^(.*\S)\s*[（(]\s*([^()（）]{2,40})\s*[)）]\s*$/.exec(cleaned)
  if (trailing !== null && !SOURCE_NOISE.test(trailing[2])) {
    return { title: trailing[1].trim(), author: trailing[2].trim() }
  }
  return { title: cleaned, author: fallbackAuthor }
}

function collapseSpaces(text) {
  return String(text || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\n+/g, ' ').trim()
}

function pushParagraphBlocks(blocks, text) {
  const cleaned = collapseSpaces(text)
  if (cleaned.length === 0) return
  if (cleaned.length > 6000) {
    for (let i = 0; i < cleaned.length; i += 4000) blocks.push({ type: 'p', text: cleaned.slice(i, i + 4000) })
  } else {
    blocks.push({ type: 'p', text: cleaned })
  }
}

export function paragraphsToBlocks(text) {
  const blocks = []
  const source = String(text || '')
  let groups = source.split(/\n[ \t]*\n+/).map((part) => part.trim()).filter((part) => part.length > 0)
  // Chinese .txt files usually have one paragraph per line with no blank lines.
  if (groups.length < 4) {
    const lines = source.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    if (lines.length > groups.length * 2) groups = lines
  }
  for (const group of groups) {
    // Keep hard-wrapped prose together, but a run of poetry/short lines stays
    // separate: join only when a line clearly continues the previous one.
    const joined = group.replace(/\n(?=[^\n])/g, '')
    pushParagraphBlocks(blocks, joined)
  }
  return blocks
}

function chapterTitleFrom(blocks, index, fallback) {
  const heading = blocks.find((block) => /^h[1-3]$/.test(block.type) && block.text.length > 0)
  if (heading !== undefined) return heading.text.slice(0, 120)
  const first = blocks.find((block) => block.text.length > 0)
  if (first !== undefined && fallback === true) return first.text.slice(0, 24)
  return '第 ' + (index + 1) + ' 节'
}

const PLAIN_HEADING = /^[ \t\u3000]*(?:第[零一二三四五六七八九十百千0-9]+[章节回卷篇部集]|chapter\s+\d+|CHAPTER\s+[IVXLC0-9]+|序章|楔子|引子|前言|后记|尾声|番外)/i

export function plainTextChapters(text) {
  const lines = String(text || '').split('\n')
  const starts = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line.length === 0 || line.length > 60) continue
    if (PLAIN_HEADING.test(line)) starts.push({ line: i, title: line })
  }
  const chapters = []
  if (starts.length >= 2) {
    if (starts[0].line > 0) {
      const preface = lines.slice(0, starts[0].line).join('\n')
      const blocks = paragraphsToBlocks(preface)
      if (blocks.length > 0) chapters.push({ title: '前言', blocks })
    }
    for (let i = 0; i < starts.length; i += 1) {
      const end = i + 1 < starts.length ? starts[i + 1].line : lines.length
      const blocks = paragraphsToBlocks(lines.slice(starts[i].line + 1, end).join('\n'))
      chapters.push({ title: starts[i].title, blocks })
    }
  }
  if (chapters.length === 0) {
    const blocks = paragraphsToBlocks(String(text || ''))
    if (blocks.length === 0) chapters.push({ title: '正文', blocks: [] })
    else {
      let current = []
      let size = 0
      let index = 0
      for (const block of blocks) {
        current.push(block)
        size += block.text.length
        if (size >= 2200) {
          chapters.push({ title: '第 ' + (index + 1) + ' 节', blocks: current })
          index += 1
          current = []
          size = 0
        }
      }
      if (current.length > 0) chapters.push({ title: '第 ' + (index + 1) + ' 节', blocks: current })
    }
  }
  return chapters
}

function stripMarkdownInline(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '· ')
}

export function markdownChapters(text) {
  const source = String(text || '')
  const headingRe = /^[ \t]{0,3}(#{1,3})[ \t]+(.+)$/gm
  const marks = []
  let match = headingRe.exec(source)
  while (match !== null) {
    marks.push({ start: match.index, end: match.index + match[0].length, level: match[1].length, title: match[2].trim() })
    match = headingRe.exec(source)
  }
  // Ignore the document H1 as a chapter boundary when it is just the book title.
  const chapters = []
  if (marks.length >= 2) {
    const offset = marks[0].start
    const intro = stripMarkdownInline(source.slice(0, offset))
    const introBlocks = paragraphsToBlocks(intro)
    if (introBlocks.length > 0) chapters.push({ title: chapterTitleFrom(introBlocks, 0, true), blocks: introBlocks })
    for (let i = 1; i < marks.length; i += 1) {
      const end = i + 1 < marks.length ? marks[i + 1].start : source.length
      const blocks = htmlToBlocks('<h' + Math.min(marks[i].level + 1, 6) + '>' + marks[i].title + '</h' + Math.min(marks[i].level + 1, 6) + '>' + stripMarkdownInline(source.slice(marks[i].end, end)))
      chapters.push({ title: marks[i].title.slice(0, 120), blocks })
    }
  }
  if (chapters.length === 0) {
    const blocks = paragraphsToBlocks(stripMarkdownInline(source))
    chapters.push({ title: '正文', blocks })
  }
  return chapters
}

export function htmlChapters(html) {
  const source = String(html || '')
  const headingRe = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  const marks = []
  let match = headingRe.exec(source)
  while (match !== null) {
    marks.push({ start: match.index, end: match.index + match[0].length, title: collapseSpaces(decodeEntities(stripTags(match[2]))) })
    match = headingRe.exec(source)
  }
  const chapters = []
  if (marks.length >= 2) {
    const intro = htmlToBlocks(source.slice(0, marks[0].start))
    if (intro.length > 0) chapters.push({ title: chapterTitleFrom(intro, 0, true), blocks: intro })
    for (let i = 0; i < marks.length; i += 1) {
      const end = i + 1 < marks.length ? marks[i + 1].start : source.length
      const blocks = htmlToBlocks('<h2>' + marks[i].title + '</h2>' + source.slice(marks[i].end, end))
      chapters.push({ title: marks[i].title.slice(0, 120) || '第 ' + (i + 1) + ' 节', blocks })
    }
  }
  if (chapters.length === 0) {
    const blocks = htmlToBlocks(source)
    chapters.push({ title: '正文', blocks })
  }
  return chapters
}

// Build an epub-shaped, in-memory book so the RPC layer treats every format
// the same way. `meta` mirrors openEpub()'s meta shape.
export function buildTextBook(file, format, fallbackTitle) {
  const raw = decodeTextBytes(fs.readFileSync(file))
  let chapters
  if (format === 'html') chapters = htmlChapters(raw)
  else if (format === 'md') chapters = markdownChapters(raw)
  else chapters = plainTextChapters(raw)
  chapters = chapters.filter((chapter) => chapter !== undefined && Array.isArray(chapter.blocks))
  let title = fallbackTitle || path.basename(file, path.extname(file))
  if (format === 'md' || format === 'html') {
    // A leading H1 often carries the real title.
    const first = chapters[0]
    if (first !== undefined && first.title && first.title.length > 1 && first.title.length < 80 && fallbackTitle === undefined) title = first.title
  }
  return {
    textMode: true,
    meta: { title, author: '', language: '', coverHref: '', coverMediaType: '' },
    chapters: chapters.map((chapter, index) => ({
      index,
      title: chapter.title || '第 ' + (index + 1) + ' 节',
      blocks: chapter.blocks,
    })),
    toc: chapters.map((chapter, index) => ({ index, title: chapter.title || '第 ' + (index + 1) + ' 节', level: 1, href: '' })),
    zip: { close() {} },
  }
}

// ---------------------------------------------------------------------------
// Markdown knowledge base
// ---------------------------------------------------------------------------
const TYPE_LABELS = { concept: '概念', opinion: '观点', question: '问题', application: '应用', '概念': '概念', '观点': '观点', '问题': '问题', '应用': '应用' }
const TYPE_ORDER = ['概念', '观点', '问题', '应用']

function bookLabel(title) {
  const value = String(title || '').trim()
  if (value.length === 0) return ''
  return /^《.*》$/.test(value) ? value : `《${value}》`
}

function normalizeType(value) {
  const label = TYPE_LABELS[String(value || '').trim()] || TYPE_LABELS[String(value || '').trim().toLowerCase()]
  return label || '观点'
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { data: {}, body: text }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][-A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1]
    let raw = kv[2].trim()
    if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = raw.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter((s) => s.length > 0)
    } else if (/^".*"$/.test(raw)) {
      // JSON-quoted scalar: unescape so JSON payloads (e.g. quote anchors) survive.
      try { data[key] = JSON.parse(raw) } catch { data[key] = raw.slice(1, -1) }
    } else if (/^'.*'$/.test(raw)) {
      data[key] = raw.slice(1, -1)
    } else {
      data[key] = raw
    }
  }
  return { data, body: text.slice(match[0].length) }
}

function yamlValue(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => String(entry).replace(/[,\]]/g, ' ')).join(', ')}]`
  const text = String(value ?? '')
  if (/^[-+]?[0-9.]+$/.test(text) || text === '' || /^[^\s"'`#\[\]{}:&*!|>%@`].*$/.test(text)) {
    if (/[:#]/.test(text) || /\s$/.test(text)) return JSON.stringify(text)
    return text
  }
  return JSON.stringify(text)
}

function renderFrontmatter(data) {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    lines.push(`${key}: ${yamlValue(value)}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

function replaceSection(body, heading, content) {
  const marker = `## ${heading}`
  const start = body.indexOf(marker)
  const block = content === undefined || content === '' ? '' : `${marker}\n\n${content}\n`
  if (start < 0) return body.replace(/\s+$/, '') + '\n\n' + block
  const next = body.indexOf('\n## ', start + marker.length)
  const before = body.slice(0, start).replace(/\s+$/, '')
  const after = next < 0 ? '' : body.slice(next + 1)
  return `${before}\n\n${block}${after.length > 0 ? '\n' + after : ''}`.replace(/\n{3,}/g, '\n\n')
}

// Split a note body into its `## heading` sections so the original expression,
// core idea and quoted passage stay queryable after a note round-trips to disk.
function sectionsFromBody(body) {
  const sections = {}
  const text = String(body || '')
  const parts = text.split(/^##\s+/m)
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index]
    const nl = part.indexOf('\n')
    const title = (nl < 0 ? part : part.slice(0, nl)).trim()
    const content = (nl < 0 ? '' : part.slice(nl + 1)).trim()
    if (title.length > 0) sections[title] = content
  }
  return sections
}

function unquoteBlock(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.replace(/^>\s?/, '')).join('\n').trim()
}

export function tokenize(text) {
  const source = String(text || '').toLowerCase()
  const tokens = new Set()
  const latinRe = /[a-z][a-z0-9'-]{1,}/g
  let m
  while ((m = latinRe.exec(source)) !== null) tokens.add(m[0])
  const cjk = source.replace(/[^\u4e00-\u9fff]/g, ' ')
  for (const run of cjk.split(/\s+/)) {
    if (run.length < 2) continue
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2))
    if (run.length <= 8) tokens.add(run)
  }
  const stop = new Set(['认为', '一个', '这个', '什么', '可以', '我们', '他们', '自己', '就是', '不是', '以及', '因为', '所以', '如果', '没有', '已经', '还是', '这样', '那样', '这些', '那些', '我的', '你的', '他的'])
  for (const token of stop) tokens.delete(token)
  return tokens
}

function noteSearchText(note) {
  return [note.title, note.core, note.original, note.quote, note.book, note.author, note.chapter, ...(note.tags || [])].join('\n')
}

function similarity(note, tokens) {
  const noteTokens = tokenize(noteSearchText(note))
  if (noteTokens.size === 0) return 0
  let shared = 0
  for (const token of tokens) if (noteTokens.has(token)) shared += 1
  return shared / Math.sqrt(tokens.size * noteTokens.size)
}

export class KnowledgeBase {
  constructor(kbDir) {
    this.dir = kbDir
    this.notesDir = path.join(kbDir, 'notes')
    this.booksDir = path.join(kbDir, 'books')
    this.reportsDir = path.join(kbDir, 'reports')
    this.indexFile = path.join(kbDir, 'index.md')
  }

  ensure() {
    ensureDir(this.notesDir)
    ensureDir(this.booksDir)
    ensureDir(this.reportsDir)
    if (!fs.existsSync(this.indexFile)) this.writeIndex()
  }

  noteFile(id) { return path.join(this.notesDir, `${id}.md`) }
  bookFile(bookId) { return path.join(this.booksDir, `${bookId}.md`) }

  listNoteFiles() {
    try {
      return fs.readdirSync(this.notesDir).filter((name) => name.endsWith('.md'))
    } catch { return [] }
  }

  readNoteByFile(name) {
    const file = path.join(this.notesDir, name)
    try {
      const text = fs.readFileSync(file, 'utf8')
      const { data, body } = parseFrontmatter(text)
      const sections = sectionsFromBody(body)
      return {
        ...data,
        id: data.id || name.replace(/\.md$/, ''),
        file,
        body,
        original: String(data.original || sections['原始表达'] || ''),
        core: String(data.core || sections['核心观点'] || ''),
        quote: String(data.quote || unquoteBlock(sections['原文引用'] || '')),
      }
    } catch { return undefined }
  }

  scanNotes() {
    const notes = []
    for (const name of this.listNoteFiles()) {
      const note = this.readNoteByFile(name)
      if (note !== undefined) notes.push(note)
    }
    notes.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
    return notes
  }

  saveNote(input = {}) {
    this.ensure()
    const type = normalizeType(input.type)
    const original = String(input.original || '').trim()
    const quoteInput = String(input.quote || '').trim()
    if (original.length === 0 && !String(input.core || '').trim() && quoteInput.length === 0) throw new Error('笔记需要原始表达、核心观点或原文引用')
    const title = String(input.title || '').trim() || (String(input.core || original || quoteInput).slice(0, 40))
    const existing = this.scanNotes()
    const newTokens = tokenize([title, input.core, original, input.quote, input.book, input.chapter, ...(input.tags || [])].join('\n'))
    const ranked = existing
      .map((note) => ({ note, score: similarity(note, newTokens) }))
      .filter((entry) => entry.score >= 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
    const id = String(input.id || '').trim() || `n${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`
    const related = ranked.map((entry) => entry.note.id).filter((value) => value !== id)
    const tags = [...new Set((input.tags || []).map((tag) => String(tag).trim().replace(/^#/, '')).filter((tag) => tag.length > 0))].slice(0, 6)
    const data = {
      id,
      type,
      title,
      created: input.created || nowIso(),
      status: input.status || (type === '问题' ? 'open' : 'kept'),
      book: input.book || '',
      bookId: input.bookId || '',
      author: input.author || '',
      chapter: input.chapter || '',
      location: input.location || '',
      tags,
      related,
      source: input.source || 'conversation',
    }
    if (input.anchor !== undefined && input.anchor !== null) {
      data.anchor = typeof input.anchor === 'string' ? input.anchor : JSON.stringify(input.anchor)
    }
    let body = `## 原始表达\n\n${original || '（无）'}\n`
    body += `\n## 核心观点\n\n${String(input.core || '').trim() || '（待整理）'}\n`
    if (String(input.quote || '').trim().length > 0) body += `\n## 原文引用\n\n> ${String(input.quote).trim().replace(/\n/g, '\n> ')}\n`
    if (data.book || data.chapter) {
      body += `\n## 出处\n\n${data.book ? bookLabel(data.book) : ''}${data.author ? ` · ${data.author}` : ''}${data.chapter ? ` · ${data.chapter}` : ''}${data.location ? ` · ${data.location}` : ''}\n`
    }
    const relatedNotes = ranked.map((entry) => entry.note)
    body += `\n## 关联\n\n${relatedNotes.length === 0 ? '（暂无关联）' : relatedNotes.map((note) => `- [[${note.id}]] ${bookLabel(note.book) || '《未标注》'}${note.title}`).join('\n')}\n`
    this.writeNoteFile(id, data, body)
    const relatedInfo = []
    for (const entry of ranked) {
      if (!entry.note.id || entry.note.id === id) continue
      relatedInfo.push({ id: entry.note.id, title: entry.note.title, book: entry.note.book || '', score: Math.round(entry.score * 100) / 100 })
      this.appendBacklink(entry.note, id, title, data.book)
    }
    this.writeIndex()
    return { id, type, title, tags, related: relatedInfo, file: this.noteFile(id) }
  }

  writeNoteFile(id, data, body) {
    const file = this.noteFile(id)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, renderFrontmatter(data) + body.replace(/\s+$/, '') + '\n', 'utf8')
    fs.renameSync(tmp, file)
  }

  appendBacklink(note, fromId, fromTitle, fromBook) {
    try {
      const text = fs.readFileSync(note.file, 'utf8')
      const { data, body } = parseFrontmatter(text)
      if (data.manual === 'true' || data.manual === true) return
      const related = Array.isArray(data.related) ? data.related : []
      if (!related.includes(fromId)) related.push(fromId)
      let nextBody = body
      if (nextBody.includes('## 关联')) {
        nextBody = nextBody.replace(/(## 关联\s*\n)([\s\S]*?)(?=\n## |\s*$)/, (m, head, tail) => {
          if (tail.includes(`[[${fromId}]]`)) return m
          const cleaned = tail.replace(/\s+$/, '')
          const line = `- [[${fromId}]] ${bookLabel(fromBook) || '《未标注》'}${fromTitle}`
          const next = cleaned === '' || cleaned.includes('（暂无关联）') ? line : `${cleaned}\n${line}`
          return `${head}\n${next}\n`
        })
        if (!nextBody.includes(`[[${fromId}]]`)) nextBody = nextBody.replace(/\s+$/, '') + `\n- [[${fromId}]] ${bookLabel(fromBook) || '《未标注》'}${fromTitle}\n`
      } else {
        nextBody = nextBody.replace(/\s+$/, '') + `\n\n## 关联\n\n- [[${fromId}]] ${bookLabel(fromBook) || '《未标注》'}${fromTitle}\n`
      }
      data.related = related
      const tmp = note.file + '.tmp'
      fs.writeFileSync(tmp, renderFrontmatter(data) + nextBody.replace(/\s+$/, '') + '\n', 'utf8')
      fs.renameSync(tmp, note.file)
    } catch { /* backlink failures must not break saving */ }
  }

  getNote(id) {
    const note = this.readNoteByFile(`${id}.md`)
    if (note === undefined) return undefined
    const related = Array.isArray(note.related) ? note.related : []
    const links = related.map((relatedId) => {
      const other = this.readNoteByFile(`${relatedId}.md`)
      return other === undefined ? { id: relatedId, title: '（缺失）' } : { id: relatedId, title: other.title, type: other.type, book: other.book }
    })
    const backlinks = this.scanNotes().filter((candidate) => candidate.id !== id && Array.isArray(candidate.related) && candidate.related.includes(id))
      .map((candidate) => ({ id: candidate.id, title: candidate.title }))
    return { ...note, body: note.body, related: links, backlinks }
  }

  listNotes(options = {}) {
    let notes = this.scanNotes()
    if (options.book) notes = notes.filter((note) => String(note.book || '').includes(String(options.book)))
    if (options.type) {
      const type = normalizeType(options.type)
      notes = notes.filter((note) => normalizeType(note.type) === type)
    }
    if (options.tag) notes = notes.filter((note) => (note.tags || []).includes(String(options.tag).replace(/^#/, '')))
    const limit = Math.max(1, Math.min(Number(options.limit) || 50, 500))
    return notes.slice(0, limit).map((note) => ({
      id: note.id, type: normalizeType(note.type), title: note.title, created: note.created,
      book: note.book || '', chapter: note.chapter || '', status: note.status || '', tags: note.tags || [], related: note.related || [],
    }))
  }

  // Quote cards keep the source anchor (chapter + character range) in their
  // frontmatter so the reader can underline the exact passage again later.
  listQuotes(options = {}) {
    const bookId = String(options.bookId || '')
    const bookTitle = String(options.book || options.bookTitle || '')
    const hasChapter = options.chapterIndex !== undefined && options.chapterIndex !== null
    const chapterIndex = hasChapter ? Math.max(0, Number(options.chapterIndex) || 0) : undefined
    const quotes = []
    for (const note of this.scanNotes()) {
      if (String(note.source || '') !== 'quote') continue
      if (bookId.length > 0 && String(note.bookId || '').length > 0 && String(note.bookId) !== bookId) continue
      if (bookId.length === 0 && bookTitle.length > 0 && !String(note.book || '').includes(bookTitle)) continue
      let anchor = note.anchor
      if (typeof anchor === 'string') { try { anchor = JSON.parse(anchor) } catch { anchor = undefined } }
      if (!anchor || typeof anchor !== 'object') continue
      const startBlock = Math.max(0, Number(anchor.startBlock) || 0)
      const endBlock = Math.max(startBlock, Number(anchor.endBlock) || startBlock)
      if (chapterIndex !== undefined && Math.max(0, Number(anchor.chapterIndex) || 0) !== chapterIndex) continue
      quotes.push({
        id: note.id,
        title: note.title || '',
        quote: String(note.quote || ''),
        type: normalizeType(note.type),
        book: note.book || '',
        chapter: note.chapter || '',
        chapterIndex: Math.max(0, Number(anchor.chapterIndex) || 0),
        startBlock,
        startOffset: Math.max(0, Number(anchor.startOffset) || 0),
        endBlock,
        endOffset: Math.max(0, Number(anchor.endOffset) || 0),
      })
    }
    quotes.sort((a, b) => a.startBlock - b.startBlock || a.startOffset - b.startOffset)
    return quotes
  }

  search(rawQuery, options = {}) {
    const query = String(rawQuery || '').trim()
    const notes = this.scanNotes()
    if (query.length === 0) return this.listNotes(options)
    const tokens = tokenize(query)
    const scored = []
    for (const note of notes) {
      if (options.book && !String(note.book || '').includes(String(options.book))) continue
      if (options.type && normalizeType(note.type) !== normalizeType(options.type)) continue
      const fields = [
        [note.title, 6],
        [note.core, 3],
        [note.original, 2],
        [note.quote, 1],
        [note.book, 2],
        [note.chapter, 1],
        [(note.tags || []).join(' '), 3],
      ]
      let score = 0
      for (const [text, weight] of fields) {
        const fieldTokens = tokenize(text)
        let hits = 0
        for (const token of tokens) if (fieldTokens.has(token)) hits += 1
        score += hits * weight
      }
      if (String(note.title || '').includes(query)) score += 10
      if (String(note.core || '').includes(query)) score += 6
      if (String(note.original || '').includes(query)) score += 4
      if (String(note.book || '').includes(query)) score += 4
      if (score > 0) scored.push({ note, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100))
    return scored.slice(0, limit).map(({ note }) => ({
      id: note.id, type: normalizeType(note.type), title: note.title, book: note.book || '',
      chapter: note.chapter || '', created: note.created, status: note.status || '', tags: note.tags || [],
      core: String(note.core || '').slice(0, 200), snippet: String(note.original || note.body || '').slice(0, 200),
    }))
  }

  writeIndex() {
    const notes = this.scanNotes()
    const books = this.listBookRecords()
    const reports = this.listReports({ limit: 200 })
    const byType = new Map(TYPE_ORDER.map((type) => [type, []]))
    for (const note of notes) {
      const type = normalizeType(note.type)
      if (!byType.has(type)) byType.set(type, [])
      byType.get(type).push(note)
    }
    const lines = ['# 随读 · 个人知识索引', '', `> 自动生成，可随时重建（不会影响 notes/ 下的原始笔记）。更新于 ${nowIso()}`, '']
    lines.push(`共 ${notes.length} 条知识卡片 · ${books.length} 本书${reports.length > 0 ? ` · ${reports.length} 篇读书心得` : ''}`, '')
    for (const [type, list] of byType) {
      if (list.length === 0) continue
      lines.push(`## ${type}（${list.length}）`, '')
      for (const note of list) {
        const source = note.book ? ` — ${bookLabel(note.book)}${note.chapter ? ' · ' + note.chapter : ''}` : ''
        lines.push(`- [[${note.id}]] ${note.title}${source}`)
      }
      lines.push('')
    }
    const open = notes.filter((note) => normalizeType(note.type) === '问题' && note.status !== 'resolved')
    lines.push('## 待探索问题', '')
    if (open.length === 0) lines.push('（暂无）')
    else for (const note of open) lines.push(`- [[${note.id}]] ${note.title}`)
    lines.push('')
    if (reports.length > 0) {
      lines.push('## 心得报告', '')
      for (const report of reports) {
        lines.push(`- ${report.title}${report.book ? ` — ${bookLabel(report.book)}` : ''} · ${String(report.updated || report.created || '').slice(0, 10)}${report.words ? ` · ${report.words} 字` : ''}`)
      }
      lines.push('')
    }
    if (books.length > 0) {
      lines.push('## 书架', '')
      for (const book of books) {
        const progress = book.chapterTitle ? `读到 ${book.chapterTitle}` : '尚未开始'
        lines.push(`- 《${book.title || book.bookId}》${book.author ? ` · ${book.author}` : ''} — ${progress}`)
      }
      lines.push('')
    }
    const body = lines.join('\n')
    try {
      const tmp = this.indexFile + '.tmp'
      ensureDir(this.dir)
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, this.indexFile)
    } catch { /* ignore index write failure */ }
    return notes.length
  }

  readBookRecord(bookId) {
    try {
      const text = fs.readFileSync(this.bookFile(bookId), 'utf8')
      const { data } = parseFrontmatter(text)
      return data
    } catch { return undefined }
  }

  listBookRecords() {
    try {
      return fs.readdirSync(this.booksDir).filter((name) => name.endsWith('.md')).map((name) => {
        const record = this.readBookRecord(name.replace(/\.md$/, ''))
        return record === undefined ? undefined : { ...record, bookId: record.bookId || name.replace(/\.md$/, '') }
      }).filter(Boolean)
    } catch { return [] }
  }

  listReportFiles() {
    try {
      return fs.readdirSync(this.reportsDir).filter((name) => name.endsWith('.md')).sort().reverse()
    } catch { return [] }
  }

  readReport(id) {
    const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '')
    if (safe.length === 0) return undefined
    const file = path.join(this.reportsDir, `${safe}.md`)
    try {
      const text = fs.readFileSync(file, 'utf8')
      const { data, body } = parseFrontmatter(text)
      const content = String(body || '').replace(/^\s*##\s*我写的心得\s*/m, '').trim()
      return { ...data, id: data.id || safe, file, body, content }
    } catch { return undefined }
  }

  listReports(options = {}) {
    const reports = []
    for (const name of this.listReportFiles()) {
      const report = this.readReport(name.replace(/\.md$/, ''))
      if (report === undefined) continue
      if (options.book && !String(report.book || '').includes(String(options.book))) continue
      reports.push({
        id: report.id,
        title: report.title || '读书心得',
        book: report.book || '',
        author: report.author || '',
        created: report.created || '',
        updated: report.updated || '',
        preview: String(report.content || '').replace(/\s+/g, ' ').slice(0, 120),
        words: String(report.content || '').replace(/\s+/g, '').length,
      })
    }
    reports.sort((a, b) => String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || '')))
    return reports.slice(0, Math.max(1, Math.min(Number(options.limit) || 50, 200)))
  }

  saveReport(input = {}) {
    this.ensure()
    const requested = String(input.id || '').trim().replace(/[^A-Za-z0-9_-]/g, '')
    const existing = requested.length > 0 ? this.readReport(requested) : undefined
    const id = requested.length > 0 ? requested : `r${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`
    const data = {
      id,
      type: '心得',
      title: String(input.title || '').trim() || '读书心得',
      book: String(input.book || (existing && existing.book) || '').trim(),
      author: String(input.author || (existing && existing.author) || '').trim(),
      bookId: String(input.bookId || (existing && existing.bookId) || '').trim(),
      created: (existing && existing.created) || nowIso(),
      updated: nowIso(),
      source: input.source || 'user',
    }
    const content = String(input.content !== undefined ? input.content : (existing && existing.content) || '').trim()
    const body = `\n## 我写的心得\n\n${content || '（待书写）'}\n`
    const file = path.join(this.reportsDir, `${id}.md`)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, renderFrontmatter(data) + body, 'utf8')
    fs.renameSync(tmp, file)
    this.writeIndex()
    return { id, title: data.title, book: data.book, created: data.created, updated: data.updated, file, words: content.replace(/\s+/g, '').length }
  }

  buildMaterials(bookTitle, bookId) {
    const title = String(bookTitle || '').trim()
    const notes = this.scanNotes()
    const matches = (note) => {
      if (title.length === 0) return true
      const noteBook = String(note.book || '').trim()
      if (noteBook.length === 0) return false
      return noteBook.includes(title) || title.includes(noteBook)
    }
    const bookNotes = notes.filter(matches)
    const chapters = new Map()
    for (const note of bookNotes) {
      const key = String(note.chapter || '').trim() || '（未标注章节）'
      if (!chapters.has(key)) chapters.set(key, [])
      chapters.get(key).push({
        id: note.id,
        type: normalizeType(note.type),
        title: note.title || '',
        original: String(note.original || '').slice(0, 300),
        core: String(note.core || '').slice(0, 300),
        quote: String(note.quote || '').slice(0, 300),
        status: note.status || '',
        tags: note.tags || [],
      })
    }
    const openQuestions = bookNotes
      .filter((note) => normalizeType(note.type) === '问题' && note.status !== 'resolved')
      .map((note) => ({ id: note.id, title: note.title || '', original: String(note.original || '').slice(0, 300), chapter: note.chapter || '' }))
    const linkedIds = new Set(bookNotes.map((note) => note.id))
    const crossBook = []
    const seen = new Set()
    for (const note of bookNotes) {
      for (const relatedId of (Array.isArray(note.related) ? note.related : [])) {
        if (linkedIds.has(relatedId) || seen.has(relatedId)) continue
        seen.add(relatedId)
        const other = this.readNoteByFile(`${relatedId}.md`)
        if (other === undefined) continue
        crossBook.push({ id: other.id, title: other.title || '', book: other.book || '', core: String(other.core || '').slice(0, 160), from: note.title || '' })
      }
    }
    const quotes = bookNotes
      .filter((note) => String(note.quote || '').trim().length > 0)
      .map((note) => ({ id: note.id, quote: String(note.quote || '').slice(0, 300), book: note.book || '', chapter: note.chapter || '', note: note.title || '' }))
    const record = bookId ? this.readBookRecord(bookId) : undefined
    return {
      bookTitle: title || (record && record.title) || '',
      bookId: bookId || (record && record.bookId) || '',
      count: bookNotes.length,
      chapters: [...chapters.entries()].map(([chapter, list]) => ({ chapter, notes: list })),
      openQuestions,
      crossBook: crossBook.slice(0, 12),
      quotes: quotes.slice(0, 20),
      progress: record === undefined ? null : {
        chapterIndex: Number(record.chapterIndex) || 0,
        chapterTitle: record.chapterTitle || '',
        lastRead: record.lastRead || '',
        readingMinutes: Math.round((Number(record.readingSeconds) || 0) / 60),
      },
    }
  }

  saveBookRecord(data) {
    this.ensure()
    const bookId = String(data.bookId || '')
    if (bookId.length === 0) throw new Error('缺少 bookId')
    const existing = this.readBookRecord(bookId) || {}
    const next = {
      bookId,
      title: data.title || existing.title || '',
      author: data.author || existing.author || '',
      file: data.file || existing.file || '',
      added: existing.added || nowIso(),
      lastRead: data.lastRead || existing.lastRead || '',
      chapterIndex: data.chapterIndex !== undefined ? data.chapterIndex : (existing.chapterIndex ?? 0),
      chapterTitle: data.chapterTitle !== undefined ? data.chapterTitle : (existing.chapterTitle || ''),
      scrollRatio: data.scrollRatio !== undefined ? data.scrollRatio : (existing.scrollRatio ?? 0),
      blockIndex: data.blockIndex !== undefined ? data.blockIndex : (existing.blockIndex ?? 0),
      readingSeconds: (Number(existing.readingSeconds) || 0) + Math.max(0, Math.min(Number(data.readingSeconds) || 0, 3600)),
      finished: data.finished !== undefined ? data.finished : (existing.finished || false),
    }
    const file = this.bookFile(bookId)
    const body = `\n## 阅读记录\n\n- 打开次数与时间线由阅读工作台自动维护。\n- 最近阅读：${next.lastRead || '尚未开始'}\n- 当前位置：第 ${Number(next.chapterIndex) + 1} 章 · ${next.chapterTitle || ''}\n- 累计阅读时长：${Math.round((Number(next.readingSeconds) || 0) / 60)} 分钟\n`
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, renderFrontmatter(next) + body, 'utf8')
    fs.renameSync(tmp, file)
    return next
  }
}

// ---------------------------------------------------------------------------
// Host API (RPC dispatcher used by index.js)
// ---------------------------------------------------------------------------
export function createCore(options = {}) {
  const dataDir = options.dataDir || path.join(os.homedir(), '.dsh-reading-companion')
  const defaultWorkspaceDir = options.workspaceDir || process.cwd()
  const configFile = path.join(dataDir, 'config.json')
  const cacheFile = path.join(dataDir, 'books-cache.json')
  const coversDir = path.join(dataDir, 'covers')
  const statsFile = path.join(dataDir, 'reading-stats.json')
  const diagFile = path.join(dataDir, 'diagnostics.jsonl')
  ensureDir(dataDir)
  const state = {
    config: readJson(configFile, {}),
    cache: readJson(cacheFile, {}),
    stats: readJson(statsFile, {}),
    contexts: new Map(),
    latestContext: undefined,
    assemblyProbe: undefined,
    lastScan: undefined,
  }
  const saveConfig = () => writeJson(configFile, state.config)
  const saveCache = () => writeJson(cacheFile, state.cache)
  const saveStats = () => writeJson(statsFile, state.stats)

  function todayKey() {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }
  function currentTodaySeconds() {
    return Number((state.stats.daily && state.stats.daily[todayKey()]) || 0)
  }
  function addReadingSeconds(bookId, seconds) {
    const delta = Math.max(0, Math.min(Math.round(Number(seconds) || 0), 600))
    if (delta <= 0) return { today: currentTodaySeconds() }
    if (state.stats.daily === undefined) state.stats.daily = {}
    if (state.stats.books === undefined) state.stats.books = {}
    state.stats.daily[todayKey()] = (Number(state.stats.daily[todayKey()]) || 0) + delta
    if (bookId) state.stats.books[bookId] = (Number(state.stats.books[bookId]) || 0) + delta
    const keys = Object.keys(state.stats.daily)
    if (keys.length > 180) {
      keys.sort()
      for (const old of keys.slice(0, keys.length - 180)) delete state.stats.daily[old]
    }
    try { saveStats() } catch { /* stats failures must not break reading */ }
    return { today: currentTodaySeconds(), bookSeconds: bookId ? Number(state.stats.books[bookId]) || 0 : 0 }
  }
  const kb = () => {
    const dir = state.config.kbDir
    if (!dir) throw new Error('知识库目录尚未设置')
    const instance = new KnowledgeBase(dir)
    instance.ensure()
    return instance
  }
  const epubDir = () => {
    const dir = state.config.epubDir
    if (!dir) throw new Error('EPUB 书籍目录尚未设置')
    if (!fs.existsSync(dir)) throw new Error(`EPUB 书籍目录不存在：${dir}`)
    return dir
  }

  // A quote card is just a knowledge note whose source is the book itself: the
  // user's reflection is optional, and the exact character range is kept so the
  // reader can underline the passage again on reopen.
  function saveQuoteNote(payload = {}) {
    const quote = String(payload.quote || '').trim()
    if (quote.length < 2) throw new Error('没有可保存的原文')
    const reflection = String(payload.reflection || '').trim().slice(0, 6000)
    let bookTitle = String(payload.book || payload.bookTitle || '').trim()
    let author = String(payload.author || '').trim()
    const bookId = String(payload.bookId || '').trim()
    if ((bookTitle.length === 0 || author.length === 0) && bookId.length > 0) {
      const book = findBook(bookId)
      if (book !== undefined) {
        if (bookTitle.length === 0) bookTitle = book.title
        if (author.length === 0) author = book.author
      }
    }
    const chapterIndex = Math.max(0, Number(payload.chapterIndex) || 0)
    const startBlock = Math.max(0, Number(payload.startBlock !== undefined ? payload.startBlock : payload.blockIndex) || 0)
    const endBlock = Math.max(startBlock, Number(payload.endBlock !== undefined ? payload.endBlock : startBlock) || startBlock)
    const anchor = {
      chapterIndex,
      startBlock,
      startOffset: Math.max(0, Number(payload.startOffset) || 0),
      endBlock,
      endOffset: Math.max(0, Number(payload.endOffset) || 0),
    }
    const title = quote.replace(/\s+/g, ' ').slice(0, 24)
    const result = kb().saveNote({
      type: reflection.length > 0 ? '观点' : '概念',
      title,
      original: reflection,
      quote,
      book: bookTitle,
      bookId,
      author,
      chapter: String(payload.chapterTitle || ''),
      location: `第 ${chapterIndex + 1} 节 · 段落 ${startBlock + 1}`,
      source: 'quote',
      anchor,
    })
    return { ok: true, note: { id: result.id, title: result.title, type: result.type, related: result.related }, anchor }
  }

  function walkBookFiles(root, depth) {
    if (depth > 3) return []
    let names = []
    try { names = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
    const out = []
    for (const entry of names) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'Reading-KB') continue
        out.push(...walkBookFiles(full, depth + 1))
      } else if (FORMAT_BY_EXT[path.extname(entry.name).toLowerCase()] !== undefined) {
        out.push(full)
        if (out.length > 3000) return out
      }
    }
    return out
  }

  const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
  const COVER_MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }
  const COVER_EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }

  function isFile(target) {
    try { return fs.statSync(target).isFile() } catch { return false }
  }

  // Calibre keeps `<title> - <author>.jpg` beside the EPUB; plain exports may use cover.jpg.
  function findSiblingCover(file) {
    const dir = path.dirname(file)
    const base = path.basename(file, path.extname(file))
    for (const ext of IMAGE_EXTS) {
      const hit = path.join(dir, base + ext)
      if (isFile(hit)) return hit
    }
    for (const name of ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'poster.jpg']) {
      const hit = path.join(dir, name)
      if (isFile(hit)) return hit
    }
    return ''
  }

  function hasSiblingOpf(file) {
    const base = path.basename(file, path.extname(file))
    return isFile(path.join(path.dirname(file), base + '.opf'))
  }

  // -------------------------------------------------------------------------
  // multi-format: PDF/AZW3/MOBI/DOCX/FB2/RTF are converted to EPUB once with
  // Calibre and cached; the original file stays untouched and read-only.
  // -------------------------------------------------------------------------
  const convertedDir = path.join(dataDir, 'converted')
  const convertJobs = new Map()

  function findEbookConvert() {
    const candidates = []
    if (process.env.CALIBRE_EBOOK_CONVERT) candidates.push(process.env.CALIBRE_EBOOK_CONVERT)
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Calibre2', 'ebook-convert.exe'))
    if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Calibre2', 'ebook-convert.exe'))
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Calibre2', 'ebook-convert.exe'))
    candidates.push('/usr/bin/ebook-convert', '/usr/local/bin/ebook-convert', '/Applications/calibre.app/Contents/MacOS/ebook-convert')
    for (const candidate of candidates) {
      if (candidate && isFile(candidate)) return candidate
    }
    const name = process.platform === 'win32' ? 'ebook-convert.exe' : 'ebook-convert'
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (dir.length === 0) continue
      const candidate = path.join(dir, name)
      if (isFile(candidate)) return candidate
      const calibre = path.join(dir, 'Calibre2', name)
      if (isFile(calibre)) return calibre
    }
    return ''
  }

  function runConverter(tool, args) {
    return new Promise((resolve, reject) => {
      execFile(tool, args, { timeout: 240000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message || '').trim().split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-4).join(' ')
          reject(new Error('转换失败：' + (detail.length > 0 ? detail.slice(0, 300) : String(error.message || error))))
          return
        }
        resolve(String(stdout || ''))
      })
    })
  }

  function convertedPathFor(book) {
    return path.join(convertedDir, book.id + '.epub')
  }

  async function convertedEpub(book) {
    const cached = convertedPathFor(book)
    if (isFile(cached)) {
      try {
        if (fs.statSync(cached).size > 1024) return cached
      } catch { /* reconvert below */ }
    }
    const running = convertJobs.get(book.id)
    if (running !== undefined) return running
    const job = (async () => {
      const tool = findEbookConvert()
      if (tool.length === 0) {
        throw new Error('阅读 ' + (FORMAT_LABEL[book.format] || String(book.format).toUpperCase())
          + ' 需要 Calibre 的 ebook-convert，但本机没有检测到 Calibre。安装 Calibre 后再打开这本书即可，或者先用 Calibre 把它转成 EPUB 放进书架。')
      }
      ensureDir(convertedDir)
      const tmp = cached + '.' + process.pid + '.tmp.epub'
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
      const args = [book.file, tmp]
      if (book.title) args.push('--title', String(book.title))
      if (book.author && book.author !== '未知作者') args.push('--authors', String(book.author))
      await runConverter(tool, args)
      if (!isFile(tmp)) throw new Error('转换没有生成文件：' + (FORMAT_LABEL[book.format] || book.format))
      fs.renameSync(tmp, cached)
      // Remember the first page so the shelf can use it as the cover next scan.
      try {
        const epub = openEpub(cached)
        try {
          const chapters = []
          for (let index = 0; index < Math.min(3, epub.chapters.length); index += 1) {
            const chapter = readChapter(epub, index)
            if (chapter.blocks.length > 0) chapters.push(chapter)
          }
          const coverText = previewFromChapters(chapters)
          const cachedMeta = state.cache[book.file]
          if (cachedMeta !== undefined) {
            state.cache[book.file] = { ...cachedMeta, v: 3, format: book.format, coverText, chapterCount: epub.chapters.length }
          }
          book.coverText = coverText
          book.chapterCount = epub.chapters.length
        } finally { epub.zip.close() }
      } catch { /* the cover preview is optional */ }
      try { saveCache() } catch { /* ignore */ }
      state.lastScan = undefined
      return cached
    })()
    convertJobs.set(book.id, job)
    try { return await job } finally { convertJobs.delete(book.id) }
  }

  // One container abstraction for every format: EPUB zip or in-memory text.
  function openReadable(book) {
    if (book.format === 'epub') {
      const epub = openEpub(book.file)
      if (book.title && (epub.meta.title === undefined || epub.meta.title.length === 0)) epub.meta.title = book.title
      if (book.author && (epub.meta.author === undefined || epub.meta.author.length === 0)) epub.meta.author = book.author
      return Promise.resolve({ kind: 'epub', container: epub })
    }
    if (TEXT_FORMATS.has(book.format)) {
      const container = buildTextBook(book.file, book.format, book.title)
      if (book.author && book.author !== '未知作者') container.meta.author = book.author
      else if (container.meta.author === '未知作者') container.meta.author = book.author || '未知作者'
      return Promise.resolve({ kind: 'text', container })
    }
    return convertedEpub(book).then((file) => {
      const epub = openEpub(file)
      if (book.title) epub.meta.title = book.title
      if (book.author && book.author !== '未知作者') epub.meta.author = book.author
      return { kind: 'epub', container: epub }
    })
  }

  function containerChapter(source, index) {
    if (source.kind === 'text') {
      const chapter = source.container.chapters[index]
      if (chapter === undefined) throw new Error('章节 ' + index + ' 不存在')
      return { index, title: chapter.title, blocks: chapter.blocks }
    }
    return readChapter(source.container, index)
  }

  function containerClose(source) {
    if (source.kind === 'text') return
    try { source.container.zip.close() } catch { /* ignore */ }
  }

  function normalizeText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\s\u3000·•:：,，.。!！?？'"“”‘’《》「」『』【】()（）\[\]_-]/g, '')
  }

  function normalizeAuthor(author) {
    const text = String(author || '')
    if (text === '未知作者') return ''
    return normalizeText(text)
  }

  function dedupeKey(title, author) {
    return dedupeTitleKey(title) + '|' + normalizeAuthor(author)
  }

  // "[美]本·霍洛维茨" and "本•霍洛维茨" are the same author; raw exports often
  // carry nationality prefixes or translator names the Calibre copy omits.
  function authorsCompatible(a, b) {
    const left = normalizeAuthor(a)
    const right = normalizeAuthor(b)
    if (left.length === 0 || right.length === 0) return true
    return left === right || left.includes(right) || right.includes(left)
  }

  function bookRank(book) {
    // Calibre-processed copies (sidecar cover + .opf) are authoritative: always
    // prefer them over raw exports, even when the raw copy has reading progress
    // (progress is migrated to the winner below).
    return (book.structured ? 8 : 0) + ((book.coverFile || book.coverHref) ? 2 : 0) + (book.progress ? 2 : 0)
  }

  function preferBook(candidate, current) {
    const left = bookRank(candidate)
    const right = bookRank(current)
    if (left !== right) return left > right
    if (candidate.size !== current.size) return candidate.size > current.size
    return (candidate.mtimeMs || 0) > (current.mtimeMs || 0)
  }

  function readOpfMetadata(file) {
    const base = path.basename(file, path.extname(file))
    const opfFile = path.join(path.dirname(file), base + '.opf')
    if (!isFile(opfFile)) return undefined
    try {
      const source = fs.readFileSync(opfFile, 'utf8')
      const title = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(source)
      const creator = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(source)
      return {
        title: title === null ? '' : decodeEntities(stripTags(title[1])).trim(),
        author: creator === null ? '' : decodeEntities(stripTags(creator[1])).trim(),
      }
    } catch { return undefined }
  }

  // "First page as the cover" for books without a cover image: the opening
  // characters of the book are shown in the cover slot like a page preview.
  function previewFromChapters(chapters) {
    for (const chapter of chapters) {
      const blocks = (chapter && chapter.blocks) || []
      const parts = []
      let size = 0
      for (const block of blocks) {
        if (block === undefined || typeof block.text !== 'string' || block.text.length === 0) continue
        if (/^h[1-3]$/.test(block.type)) continue
        parts.push(block.text)
        size += block.text.length
        if (size > 260) break
      }
      const text = parts.join(' ').replace(/\s+/g, ' ').trim()
      if (text.length > 0) return text.slice(0, 200)
    }
    return ''
  }

  function bookMetaFromCache(file) {
    const stat = fs.statSync(file)
    const key = file
    const format = FORMAT_BY_EXT[path.extname(file).toLowerCase()] || 'epub'
    const cached = state.cache[key]
    const cachedFormat = cached === undefined ? '' : (cached.format || (cached.v >= 2 ? 'epub' : ''))
    if (cached !== undefined && cached.v >= 2 && cachedFormat === format && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached
    const opf = readOpfMetadata(file)
    const nameMeta = parseFileName(file)
    const coverFile = findSiblingCover(file)
    let meta
    if (format === 'epub') {
      try {
        meta = readEpubMetadata(file)
      } catch (error) {
        meta = { title: nameMeta.title, author: nameMeta.author, chapterCount: 0, error: String(error && error.message || error) }
      }
      if (meta.title === undefined || meta.title.length === 0) meta.title = (opf && opf.title) || nameMeta.title
      if (meta.author === undefined || meta.author.length === 0) meta.author = (opf && opf.author) || nameMeta.author
    } else if (TEXT_FORMATS.has(format)) {
      let chapters = []
      try {
        chapters = buildTextBook(file, format, (opf && opf.title) || nameMeta.title).chapters
      } catch (error) {
        meta = { title: nameMeta.title, author: nameMeta.author, chapterCount: 0, error: String(error && error.message || error) }
      }
      meta = meta || {
        title: (opf && opf.title) || nameMeta.title,
        author: (opf && opf.author) || nameMeta.author,
        chapterCount: chapters.length,
        coverText: previewFromChapters(chapters),
      }
    } else {
      meta = {
        title: (opf && opf.title) || nameMeta.title,
        author: (opf && opf.author) || nameMeta.author,
        chapterCount: 0,
        coverText: cached === undefined ? '' : String(cached.coverText || ''),
      }
    }
    const record = {
      ...meta,
      v: 3,
      format,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      coverFile,
      structured: hasSiblingOpf(file) || coverFile !== '',
    }
    state.cache[key] = record
    return record
  }

  // The user's Calibre libraries are the authoritative copies: when a Calibre
  // copy of a title exists, raw exports of the same title are hidden. Raw books
  // with no Calibre twin stay on the shelf.
  function dedupeEntries(entries) {
    const byTitle = new Map()
    for (const book of entries) {
      const key = dedupeTitleKey(book.title)
      const group = byTitle.get(key)
      if (group === undefined) byTitle.set(key, [book])
      else group.push(book)
    }
    const kept = []
    for (const group of byTitle.values()) {
      const calibreCopies = group.filter((book) => book.structured)
      const pool = calibreCopies.length > 0 ? calibreCopies : group
      const byAuthor = new Map()
      for (const book of pool) {
        const key = normalizeAuthor(book.author)
        const current = byAuthor.get(key)
        if (current === undefined) {
          byAuthor.set(key, book)
          continue
        }
        if (preferBook(book, current)) {
          if (book.progress === undefined && current.progress !== undefined) book.progress = current.progress
          byAuthor.set(key, book)
        } else if (current.progress === undefined && book.progress !== undefined) {
          current.progress = book.progress
        }
      }
      kept.push(...byAuthor.values())
    }
    // A raw copy may be the only one with reading progress; carry it to its twin.
    for (const book of kept) {
      if (book.progress !== undefined) continue
      const twin = entries.find((entry) => entry !== book
        && entry.progress !== undefined
        && dedupeTitleKey(entry.title) === dedupeTitleKey(book.title)
        && authorsCompatible(entry.author, book.author))
      if (twin !== undefined) book.progress = twin.progress
    }
    return kept
  }

  function scanBooks(force) {
    if (!force && state.lastScan !== undefined && Date.now() - state.lastScan < 10000) return state.books
    const dir = epubDir()
    const files = walkBookFiles(dir, 0)
    const kbInstance = state.config.kbDir ? new KnowledgeBase(state.config.kbDir) : undefined
    const recordById = new Map()
    const recordByTitle = new Map()
    if (kbInstance !== undefined) {
      kbInstance.ensure()
      for (const record of kbInstance.listBookRecords()) {
        recordById.set(record.bookId, record)
        const key = dedupeTitleKey(record.title) + '|' + normalizeAuthor(record.author)
        if (!recordByTitle.has(key)) recordByTitle.set(key, record)
      }
    }
    const entries = []
    for (const file of files) {
      const meta = bookMetaFromCache(file)
      const id = hashId(file.toLowerCase())
      let record = kbInstance === undefined ? undefined : recordById.get(id)
      // Reading progress follows the book across library moves: if the file path
      // changed, match the old record by title + author and re-home it under the
      // new id so 继续阅读 / 自动恢复 still works.
      if (record === undefined && kbInstance !== undefined) {
        const candidate = recordByTitle.get(dedupeTitleKey(meta.title) + '|' + normalizeAuthor(meta.author))
        if (candidate !== undefined && (candidate.lastRead || candidate.readingSeconds || Number(candidate.chapterIndex) > 0)) {
          record = candidate
          try {
            const moved = kbInstance.saveBookRecord({ ...candidate, bookId: id, file })
            recordById.set(id, moved)
            record = moved
          } catch { /* keep the in-memory progress anyway */ }
        }
      }
      const book = {
        id,
        title: (record && record.title) || meta.title,
        author: (record && record.author) || meta.author,
        file,
        fileName: path.basename(file),
        dir: path.dirname(file),
        format: meta.format || 'epub',
        coverText: meta.coverText || '',
        size: meta.size,
        mtimeMs: meta.mtimeMs,
        chapterCount: meta.chapterCount || 0,
        coverFile: meta.coverFile || '',
        coverHref: meta.coverHref || '',
        coverMediaType: meta.coverMediaType || '',
        structured: meta.structured === true,
        error: meta.error,
        progress: record === undefined ? undefined : {
          chapterIndex: Number(record.chapterIndex) || 0,
          chapterTitle: record.chapterTitle || '',
          scrollRatio: Number(record.scrollRatio) || 0,
          lastRead: record.lastRead || '',
          readingSeconds: Number(record.readingSeconds) || 0,
        },
      }
      entries.push(book)
    }
    const books = dedupeEntries(entries)
    // newest read first, then title
    books.sort((a, b) => {
      const at = (a.progress && a.progress.lastRead) || ''
      const bt = (b.progress && b.progress.lastRead) || ''
      if (at !== bt) return bt.localeCompare(at)
      return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN')
    })
    saveCache()
    state.books = books
    state.lastScan = Date.now()
    return books
  }

  function findBook(bookId) {
    const books = scanBooks(false)
    return books.find((book) => book.id === bookId)
  }

  function sniffImageMime(bytes) {
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp'
    if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
    return ''
  }

  function findCachedCover(bookId) {
    try {
      const hit = fs.readdirSync(coversDir).find((name) => name.startsWith(bookId + '.'))
      if (hit === undefined) return undefined
      return { file: path.join(coversDir, hit), mime: COVER_MIME_BY_EXT[path.extname(hit).toLowerCase()] || 'image/jpeg' }
    } catch { return undefined }
  }

  // Resolve one book cover: Calibre sidecar image first, then the cover embedded
  // in the EPUB. Results are cached on disk so the shelf stays fast after restart.
  function coverFor(book) {
    if (book === undefined) return undefined
    const cached = findCachedCover(book.id)
    if (cached !== undefined) return cached
    let bytes
    let mime = ''
    const sibling = book.coverFile || findSiblingCover(book.file || '')
    if (sibling.length > 0 && isFile(sibling)) {
      try {
        bytes = fs.readFileSync(sibling)
        mime = sniffImageMime(bytes) || COVER_MIME_BY_EXT[path.extname(sibling).toLowerCase()] || ''
      } catch { bytes = undefined }
    }
    if ((bytes === undefined || bytes.length === 0) && book.file) {
      let epub
      try {
        epub = openEpub(book.file)
        const href = book.coverHref || epub.meta.coverHref
        if (href) bytes = epub.zip.readBuffer(href)
        if (bytes !== undefined && bytes.length > 0) {
          mime = sniffImageMime(bytes) || book.coverMediaType || epub.meta.coverMediaType || 'image/jpeg'
        }
      } catch { /* a book without a cover is fine */ } finally {
        if (epub !== undefined) epub.zip.close()
      }
    }
    if (bytes === undefined || bytes.length === 0 || bytes.length > 12 * 1024 * 1024) return undefined
    if (mime.length === 0 || mime === 'image/jpg') mime = 'image/jpeg'
    try {
      ensureDir(coversDir)
      const file = path.join(coversDir, book.id + (COVER_EXT_BY_MIME[mime] || '.jpg'))
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, bytes)
      fs.renameSync(tmp, file)
      return { file, mime }
    } catch {
      return { bytes, mime }
    }
  }

  function setContext(payload = {}) {
    const context = {
      sessionId: payload.sessionId || '',
      bookId: payload.bookId || '',
      bookTitle: payload.bookTitle || '',
      author: payload.author || '',
      chapterIndex: Number(payload.chapterIndex) || 0,
      chapterTitle: payload.chapterTitle || '',
      selection: String(payload.selection || '').slice(0, 8000),
      totalChapters: Number(payload.totalChapters) || 0,
      updated: nowIso(),
    }
    if (context.sessionId) state.contexts.set(context.sessionId, context)
    state.latestContext = context
    return context
  }

  function currentContext(sessionId) {
    return (sessionId !== undefined && state.contexts.get(sessionId)) || state.latestContext
  }

  // Strict per-session lookup: never falls back to another session's context.
  function sessionContext(sessionId) {
    if (!sessionId) return undefined
    return state.contexts.get(String(sessionId))
  }

  function recordAssemblyProbe(probe) {
    state.assemblyProbe = probe
    return probe
  }

  function getAssemblyProbe() {
    return state.assemblyProbe
  }

  function report(event, data) {
    try {
      ensureDir(dataDir)
      fs.appendFileSync(diagFile, JSON.stringify({ at: nowIso(), event, data }) + '\n', 'utf8')
      return { ok: true, file: diagFile }
    } catch { return { ok: false } }
  }

  async function rpc(method, payload = {}) {
    switch (method) {
      case 'config/get': {
        const configured = Boolean(state.config.epubDir && state.config.kbDir)
        let stats
        if (configured) {
          try {
            const books = scanBooks(false)
            const instance = new KnowledgeBase(state.config.kbDir)
            stats = {
              books: books.length,
              notes: instance.listNotes({ limit: 100000 }).length,
              reports: instance.listReports({ limit: 200 }).length,
              todaySeconds: currentTodaySeconds(),
            }
          } catch (error) { stats = { error: String(error && error.message || error) } }
        }
        const hint = String((payload && payload.workspaceDir) || '').trim()
        let root = defaultWorkspaceDir
        if (hint.length > 0) {
          try { if (fs.statSync(hint).isDirectory()) root = hint } catch { /* ignore */ }
        }
        return {
          configured,
          epubDir: state.config.epubDir || '',
          kbDir: state.config.kbDir || '',
          settings: state.config.settings || {},
          defaults: { epubDir: root, kbDir: path.join(root, 'Reading-KB') },
          stats,
        }
      }
      case 'config/setup': {
        const epub = String(payload.epubDir || '').trim()
        const kbDirRaw = String(payload.kbDir || '').trim()
        if (epub.length === 0 || kbDirRaw.length === 0) throw new Error('需要同时提供 EPUB 目录和知识库目录')
        if (!fs.existsSync(epub) || !fs.statSync(epub).isDirectory()) throw new Error(`EPUB 目录不存在：${epub}`)
        ensureDir(kbDirRaw)
        state.config.epubDir = epub
        state.config.kbDir = kbDirRaw
        if (payload.settings !== undefined) state.config.settings = { ...(state.config.settings || {}), ...payload.settings }
        saveConfig()
        const instance = new KnowledgeBase(kbDirRaw)
        instance.ensure()
        instance.writeIndex()
        state.lastScan = undefined
        const books = scanBooks(true)
        return {
          configured: true,
          epubDir: epub,
          kbDir: kbDirRaw,
          stats: { books: books.length, notes: instance.listNotes({ limit: 100000 }).length, reports: 0, todaySeconds: currentTodaySeconds() },
        }
      }
      case 'settings/save': {
        state.config.settings = { ...(state.config.settings || {}), ...(payload.settings || {}) }
        saveConfig()
        return state.config.settings
      }
      case 'books/list': {
        let books = []
        let warning = ''
        try {
          books = scanBooks(false)
        } catch (error) {
          warning = String(error && error.message ? error.message : error)
        }
        return { books, total: books.length, epubDir: state.config.epubDir || '', warning }
      }
      case 'book/open': {
        const book = findBook(payload.bookId)
        if (book === undefined) throw new Error('未找到这本书，请刷新书架')
        const source = await openReadable(book)
        try {
          const kbInstance = kb()
          const record = kbInstance.readBookRecord(book.id)
          const chapters = source.container.chapters
          if (chapters.length === 0) throw new Error('这本书里没有可读的正文')
          let chapterIndex = Math.min(Math.max(Number((record && record.chapterIndex) || payload.chapterIndex || 0), 0), chapters.length - 1)
          let chapter = containerChapter(source, chapterIndex)
          // 封面/版权页等空章节自动跳到下一段有正文的章节
          if (chapter.blocks.length === 0 && !payload.exact) {
            for (let step = 1; step < 8 && chapterIndex + step < chapters.length; step += 1) {
              const candidate = containerChapter(source, chapterIndex + step)
              if (candidate.blocks.length > 0) { chapterIndex = chapterIndex + step; chapter = candidate; break }
            }
          }
          return {
            book: {
              id: book.id, title: source.container.meta.title || book.title, author: source.container.meta.author || book.author,
              file: book.file, fileName: book.fileName, format: book.format,
              chapters: chapters.map((item, index) => ({ index, title: item.title })),
              toc: (source.container.toc || []).slice(0, 500),
            },
            progress: record === undefined ? { chapterIndex: 0, scrollRatio: 0 } : {
              chapterIndex, scrollRatio: Number(record.scrollRatio) || 0,
              blockIndex: Number(record.blockIndex) || 0, lastRead: record.lastRead || '',
              readingSeconds: Number(record.readingSeconds) || 0,
            },
            chapter,
          }
        } finally { containerClose(source) }
      }
      case 'book/chapter': {
        const book = findBook(payload.bookId)
        if (book === undefined) throw new Error('未找到这本书')
        const source = await openReadable(book)
        try {
          return { chapter: containerChapter(source, Number(payload.index) || 0) }
        } finally { containerClose(source) }
      }
      case 'book/progress': {
        const book = findBook(payload.bookId)
        const kbInstance = kb()
        const seconds = Math.max(0, Math.min(Number(payload.seconds) || 0, 3600))
        if (seconds > 0) addReadingSeconds(String(payload.bookId || ''), seconds)
        const record = kbInstance.saveBookRecord({
          bookId: payload.bookId,
          title: payload.bookTitle || (book && book.title),
          author: payload.author || (book && book.author),
          file: book ? book.file : '',
          lastRead: nowIso(),
          chapterIndex: Number(payload.chapterIndex) || 0,
          chapterTitle: payload.chapterTitle || '',
          scrollRatio: Number(payload.scrollRatio) || 0,
          blockIndex: Number(payload.blockIndex) || 0,
          readingSeconds: seconds,
        })
        kbInstance.writeIndex()
        state.lastScan = undefined
        return { ok: true, progress: record, today: currentTodaySeconds() }
      }
      case 'reading/tick': {
        const seconds = Math.max(0, Math.min(Number(payload.seconds) || 0, 600))
        const bookId = String(payload.bookId || '')
        if (seconds > 0) {
          addReadingSeconds(bookId, seconds)
          try { if (state.config.kbDir && bookId.length > 0) kb().saveBookRecord({ bookId, readingSeconds: seconds }) } catch { /* ignore */ }
        }
        return { today: currentTodaySeconds() }
      }
      case 'stats/get': return { today: currentTodaySeconds(), daily: state.stats.daily || {}, books: state.stats.books || {} }
      case 'kb/list': return { notes: kb().listNotes(payload) }
      case 'kb/search': return { notes: kb().search(payload.query, payload) }
      case 'kb/note': {
        const note = kb().getNote(String(payload.id || ''))
        if (note === undefined) throw new Error('未找到这条笔记')
        return { note }
      }
      case 'kb/save': return kb().saveNote(payload)
      case 'quote/save': return saveQuoteNote(payload)
      case 'quote/list': return { quotes: kb().listQuotes(payload) }
      case 'kb/rebuild': return { count: kb().writeIndex() }
      case 'report/list': return { reports: kb().listReports(payload) }
      case 'report/get': {
        const report = kb().readReport(String(payload.id || ''))
        if (report === undefined) throw new Error('未找到这篇读书心得')
        return { report }
      }
      case 'report/save': {
        let bookTitle = String(payload.book || '')
        let author = String(payload.author || '')
        if ((bookTitle.length === 0 || author.length === 0) && payload.bookId) {
          const book = findBook(payload.bookId)
          if (book !== undefined) {
            if (bookTitle.length === 0) bookTitle = book.title
            if (author.length === 0) author = book.author
          }
        }
        return kb().saveReport({ ...payload, book: bookTitle, author })
      }
      case 'report/materials': {
        let bookTitle = String(payload.book || payload.bookTitle || '')
        let bookId = String(payload.bookId || '')
        if (bookTitle.length === 0 && bookId.length > 0) {
          const book = findBook(bookId)
          if (book !== undefined) bookTitle = book.title
        }
        if (bookTitle.length > 0) {
          try {
            const found = scanBooks(false).find((book) => book.title === bookTitle || bookTitle.includes(book.title) || book.title.includes(bookTitle))
            if (found !== undefined) bookId = found.id
          } catch { /* ignore */ }
        }
        return { materials: kb().buildMaterials(bookTitle, bookId) }
      }
      case 'reading/context': return setContext(payload)
      case 'diagnostics/report': return report(payload.event || 'client', payload.data)
      case 'diagnostics/file': return { file: diagFile }
      default: throw new Error(`未知的 RPC 方法：${method}`)
    }
  }

  return {
    rpc,
    dataDir,
    configFile,
    kb,
    scanBooks,
    findBook,
    coverFor,
    openEpubFile: openEpub,
    readChapter,
    saveNote: (input) => kb().saveNote(input),
    saveQuote: (input) => saveQuoteNote(input),
    listQuotes: (options) => kb().listQuotes(options),
    searchNotes: (query, options) => kb().search(query, options),
    listNotes: (options) => kb().listNotes(options),
    listReports: (options) => kb().listReports(options),
    saveReport: (input) => kb().saveReport(input),
    materials: (bookTitle, bookId) => kb().buildMaterials(bookTitle, bookId),
    todaySeconds: currentTodaySeconds,
    addReadingSeconds,
    currentContext,
    sessionContext,
    recordAssemblyProbe,
    getAssemblyProbe,
    report,
    state,
  }
}
