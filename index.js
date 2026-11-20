/**
 * 随读 Reading Companion — Host half.
 * Registers the /reading JSON-RPC route (client <-> host) and the agent tools.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCore } from './core.js'

export const name = 'dsh-readmate'
export const inject = ['connection', 'tools', 'webServer']

const CHANNEL = '/reading'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const VERSION = '0.4.0'

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const outputSchema = { type: 'object', additionalProperties: true }

function tool(name, description, parameters, execute, render) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: parameters, additionalProperties: false },
    output: {
      schema: outputSchema,
      render(_args, value) { return [{ type: 'text', text: render(value) }] },
    },
    async execute(args, exec) { return execute(args || {}, exec) },
  }
}

function listRelated(related) {
  if (!Array.isArray(related) || related.length === 0) return '（没有找到已有的相关笔记）'
  return related.map((entry) => `- ${entry.id}｜${entry.title}${entry.book ? `｜${entry.book}` : ''}${entry.score !== undefined ? `｜相似度 ${entry.score}` : ''}`).join('\n')
}

function formatMaterials(materials) {
  if (materials === undefined || materials === null) return '没有找到这本书的阅读素材。'
  const lines = []
  lines.push(`《${materials.bookTitle || '未命名'}》的阅读素材：共 ${materials.count || 0} 条知识卡片`)
  if (materials.progress !== null && materials.progress !== undefined) {
    const progress = materials.progress
    lines.push(`阅读进度：第 ${(Number(progress.chapterIndex) || 0) + 1} 章${progress.chapterTitle ? ' · ' + progress.chapterTitle : ''}${progress.readingMinutes ? ` · 累计阅读 ${progress.readingMinutes} 分钟` : ''}`)
  }
  if ((materials.count || 0) === 0) lines.push('（这本书还没有收录任何笔记。先和用户聊聊他读到的内容，等他表达观点时再收录。）')
  for (const group of (materials.chapters || [])) {
    lines.push('', `## ${group.chapter}`)
    for (const note of group.notes) {
      lines.push(`【${note.type}】${note.title}`)
      if (note.original) lines.push(`  用户原话：${String(note.original).replace(/\n/g, ' ')}`)
      if (note.core) lines.push(`  核心：${String(note.core).replace(/\n/g, ' ')}`)
      if (note.quote) lines.push(`  原文引用：${String(note.quote).replace(/\n/g, ' ')}`)
    }
  }
  if ((materials.openQuestions || []).length > 0) {
    lines.push('', '## 待探索问题')
    for (const question of materials.openQuestions) lines.push(`- ${question.title}${question.chapter ? `（${question.chapter}）` : ''}`)
  }
  if ((materials.crossBook || []).length > 0) {
    lines.push('', '## 跨书关联')
    for (const entry of materials.crossBook) lines.push(`- 《${entry.book || '未标注'}》${entry.title}${entry.core ? ' — ' + entry.core : ''}`)
  }
  if ((materials.quotes || []).length > 0) {
    lines.push('', '## 原文引用摘录')
    for (const entry of materials.quotes) lines.push(`> ${entry.quote}\n—— ${entry.book || ''}${entry.chapter ? ' · ' + entry.chapter : ''}`)
  }
  return lines.join('\n')
}

function serveCover(core, req, res, bookId) {
  const book = core.findBook(bookId)
  if (book === undefined) { res.writeHead(404); res.end(); return }
  const cover = core.coverFor(book)
  if (cover === undefined) { res.writeHead(404); res.end(); return }
  const headers = {
    'Content-Type': cover.mime || 'image/jpeg',
    'Cache-Control': 'public, max-age=86400',
  }
  if (cover.bytes !== undefined) {
    headers['Content-Length'] = String(cover.bytes.length)
    res.writeHead(200, headers)
    if (req.method === 'HEAD') res.end()
    else res.end(cover.bytes)
    return
  }
  let stat
  try { stat = fs.statSync(cover.file) } catch { res.writeHead(404); res.end(); return }
  headers['Content-Length'] = String(stat.size)
  res.writeHead(200, headers)
  if (req.method === 'HEAD') { res.end(); return }
  fs.createReadStream(cover.file)
    .on('error', () => { try { res.end() } catch { /* ignore */ } })
    .pipe(res)
}

export function apply(ctx) {
  const core = createCore({ dataDir: path.join(os.homedir(), '.dsh-reading-companion') })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      let url
      try {
        const connection = ctx.get('connection')
        const rejection = connection !== undefined && typeof connection.requestRejection === 'function'
          ? connection.requestRejection(req)
          : undefined
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        url = new URL(req.url || CHANNEL, 'http://localhost')
        const pathname = url.pathname
        // Cover images are plain same-origin GETs so the browser can cache them.
        if (req.method === 'GET' || req.method === 'HEAD') {
          const match = /^\/reading\/cover\/([^/]+)\/?$/.exec(pathname)
          if (match === null) { res.writeHead(404); res.end(); return }
          let bookId = match[1]
          try { bookId = decodeURIComponent(bookId) } catch { /* keep raw */ }
          serveCover(core, req, res, bookId)
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'GET, HEAD, POST')
          res.writeHead(405)
          res.end()
          return
        }
        const raw = await readBody(req)
        let parsed
        try { parsed = JSON.parse(raw) } catch { parsed = {} }
        const pathname2 = url.pathname
        let endpoint = pathname2.startsWith(`${CHANNEL}/`) ? pathname2.slice(CHANNEL.length + 1) : pathname2.replace(/^\/+|\/+$/g, '')
        endpoint = decodeURIComponent(endpoint)
        let result
        try {
          const value = await core.rpc(endpoint, parsed && parsed.payload ? parsed.payload : {})
          result = { ok: true, value }
        } catch (error) {
          result = { ok: false, error: { code: 'reading-error', message: String(error && error.message ? error.message : error) } }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: parsed ? parsed.rpcId : undefined, result }))
      } catch (error) {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(String(error && error.message ? error.message : error))
        } catch { /* ignore */ }
      }
    },
  }), 'reading-companion: /reading rpc route')

  const tools = [
    tool(
      'kb_save',
      '把用户这轮值得保留的内容收录进个人知识库（Markdown 卡片，自动归类与双向关联）。用户表达观点、灵感、反思、联想或提出值得保留的问题时调用。original 保留用户原话，core 是一两句提炼；quote 必须是书中真实原文；type：概念/观点/问题/应用。成功后只在回复里说「已收录」，不展示细节。',
      {
        type: { type: 'string', enum: ['概念', '观点', '问题', '应用'], description: '知识类型' },
        title: { type: 'string', description: '一句话标题（不超过 30 字）' },
        original: { type: 'string', description: '用户的原始表达，尽量保留原话' },
        core: { type: 'string', description: '你提炼的核心观点，一到两句话' },
        quote: { type: 'string', description: '可选的书中原文引用（必须真实存在）' },
        book: { type: 'string', description: '书名' },
        author: { type: 'string', description: '作者' },
        chapter: { type: 'string', description: '章节名' },
        location: { type: 'string', description: '可定位的位置，例如「第 3 章 第 42 段」' },
        tags: { type: 'array', items: { type: 'string' }, description: '2-4 个主题标签' },
        openQuestion: { type: 'boolean', description: '问题是否仍未解决' },
      },
      async (args) => {
        const saved = core.saveNote({
          type: args.type, title: args.title, original: args.original, core: args.core, quote: args.quote,
          book: args.book, author: args.author, chapter: args.chapter, location: args.location, tags: args.tags,
          status: args.openQuestion === undefined ? undefined : (args.openQuestion ? 'open' : 'resolved'),
        })
        return saved
      },
      (value) => `已收录（${value.type}）：${value.title}（${value.id}）` +
        (Array.isArray(value.related) && value.related.length > 0 ? `\n关联：${value.related.map((entry) => entry.title).join('；')}` : ''),
    ),
    tool(
      'kb_search',
      '按自然语言或关键词跨书检索个人知识库。用户问「我以前想过什么」「有没有类似观点」时先搜再答，不凭印象。返回的 id 可传给 kb_note 看全文。',
      {
        query: { type: 'string', description: '自然语言查询或关键词' },
        book: { type: 'string', description: '可选：只搜某本书' },
        type: { type: 'string', enum: ['概念', '观点', '问题', '应用'], description: '可选：只搜某一类' },
        limit: { type: 'number', description: '最多返回多少条，默认 12' },
      },
      async (args) => ({ notes: core.searchNotes(args.query, args) }),
      (value) => (value.notes.length === 0 ? '知识库里没有找到相关笔记。' : value.notes.map((note) => `【${note.type}】${note.title}（${note.id}）${note.book ? ` — ${note.book}` : ''}${note.chapter ? ` · ${note.chapter}` : ''}\n  核心：${note.core || ''}\n  原话：${note.snippet || ''}`).join('\n\n')),
    ),
    tool(
      'kb_note',
      '读取一条知识卡片的全文（原话、核心观点、引用、来源与关联）。',
      { id: { type: 'string', description: '卡片编号' } },
      async (args) => {
        const result = await core.rpc('kb/note', { id: args.id })
        return { note: result.note }
      },
      (value) => value.note === undefined ? '没有找到这条卡片。' : `【${value.note.type}】${value.note.title}\n编号：${value.note.id}\n创建：${value.note.created || ''}\n标签：${(value.note.tags || []).join('、')}\n\n${value.note.body || ''}`,
    ),
    tool(
      'kb_list',
      '列出知识卡片（可按书/类型/标签筛选，默认最近收录）。',
      {
        book: { type: 'string' }, type: { type: 'string', enum: ['概念', '观点', '问题', '应用'] }, tag: { type: 'string' }, limit: { type: 'number' },
      },
      async (args) => ({ notes: core.listNotes(args) }),
      (value) => (value.notes.length === 0 ? '知识库还是空的。' : value.notes.map((note) => `【${note.type}】${note.title}${note.book ? ` — ${note.book}` : ''}（${note.created || ''}）`).join('\n')),
    ),
    tool(
      'kb_books',
      '列出 EPUB 书架和每本书的阅读进度，并显示当前正在阅读的书。',
      {},
      async () => ({ books: core.scanBooks(false).map((book) => ({ id: book.id, title: book.title, author: book.author, chapterCount: book.chapterCount, progress: book.progress || null, error: book.error || null })), current: core.currentContext() || null }),
      (value) => {
        const current = value.current === undefined || value.current === null ? '（当前没有打开的书）' : `《${value.current.bookTitle}》· ${value.current.chapterTitle || ''}`
        const lines = value.books.slice(0, 80).map((book) => `- 《${book.title}》${book.author ? ` · ${book.author}` : ''}${book.progress ? ` — 读到 ${book.progress.chapterTitle || `第 ${book.progress.chapterIndex + 1} 章`}` : ' — 未开始'}`)
        return `当前阅读：${current}\n书架共 ${value.books.length} 本：\n${lines.join('\n')}`
      },
    ),
    tool(
      'book_context',
      '读取当前书的上下文：书名、作者、章节、选中原文和本章正文节选。回答阅读理解问题、引用原文前先用它，确保引用真实存在，不要凭空猜测书里的内容。',
      { maxChars: { type: 'number', description: '正文节选最大字符数，默认 4000' } },
      async (args, exec) => {
        const sessionId = exec && (exec.sessionId || (exec.session && exec.session.id))
        const context = core.currentContext(sessionId)
        if (context === undefined) return { context: null, chapterText: '' }
        let chapterText = ''
        let chapters = []
        try {
          const book = core.findBook(context.bookId)
          if (book !== undefined) {
            const epub = core.openEpubFile(book.file)
            try {
              chapters = epub.chapters.map((item, index) => ({ index, title: item.title }))
              const chapter = core.readChapter(epub, Math.max(0, Math.min(context.chapterIndex, epub.chapters.length - 1)))
              chapterText = chapter.blocks.map((block) => (block.type.startsWith('h') ? `\n## ${block.text}` : block.text)).join('\n')
              const max = Math.max(800, Math.min(Number(args.maxChars) || 4000, 20000))
              if (chapterText.length > max) {
                const anchor = chapterText.indexOf(context.selection)
                if (anchor > 0) {
                  const start = Math.max(0, anchor - Math.floor(max / 2))
                  chapterText = chapterText.slice(start, start + max)
                } else {
                  chapterText = chapterText.slice(0, max)
                }
              }
            } finally { epub.zip.close() }
          }
        } catch { /* ignore excerpt failures */ }
        return { context, chapters, chapterText }
      },
      (value) => {
        if (value.context === null || value.context === undefined) return '用户当前没有在阅读工作台里打开任何书。'
        const c = value.context
        return `当前阅读：${c.bookTitle ? `《${c.bookTitle}》` : ''}${c.author ? ` · ${c.author}` : ''}\n章节：${c.chapterTitle || `第 ${c.chapterIndex + 1} 章`}${c.totalChapters ? `（全书共 ${c.totalChapters} 章）` : ''}\n${c.selection ? `用户选中原文：\n> ${String(c.selection).replace(/\n/g, '\n> ')}\n` : ''}\n本章正文节选：\n${value.chapterText || '（无法读取正文）'}`
      },
    ),
    tool(
      'kb_materials',
      '整理用户在一本书里的阅读素材：按章节分组的笔记、待探索问题、原文引用和跨书关联。用户想回顾一本书或想写心得时调用（默认当前书）。心得正文由用户自己写，不代写。',
      {
        book: { type: 'string', description: '书名（可选，默认当前阅读的书）' },
        bookId: { type: 'string', description: '书籍编号（可选）' },
      },
      async (args, exec) => {
        let book = String(args.book || '').trim()
        let bookId = String(args.bookId || '').trim()
        if (book.length === 0) {
          const sessionId = exec && (exec.sessionId || (exec.session && exec.session.id))
          const context = core.currentContext(sessionId)
          if (context !== undefined) {
            book = String(context.bookTitle || '')
            if (bookId.length === 0) bookId = String(context.bookId || '')
          }
        }
        const result = await core.rpc('report/materials', { book, bookId })
        return { materials: result.materials }
      },
      (value) => formatMaterials(value.materials),
    ),
    tool(
      'kb_report_save',
      '把读书心得或读后整理文章保存成 Markdown 报告（存 reports/ 并进入全局索引）。用户写的心得原文照录、不改写；用户读完一本书时，可以把这次阅读中他的思考与你的关键回应整理成文章后保存（必须引用用户原话，不编造观点）。',
      {
        title: { type: 'string', description: '心得标题' },
        content: { type: 'string', description: '文章正文：用户写的原文照录；读后整理文章由你写，引用用户原话、不编造' },
        book: { type: 'string', description: '书名' },
        bookId: { type: 'string', description: '书籍编号（可选）' },
      },
      async (args) => {
        if (String(args.content || '').trim().length === 0) throw new Error('心得正文不能为空')
        return core.rpc('report/save', { title: args.title, content: args.content, book: args.book, bookId: args.bookId })
      },
      (value) => `已保存读书心得：${value.title}${value.book ? `（${value.book}）` : ''}\n文件：${value.file}\n字数：${value.words}`,
    ),
    tool(
      'kb_reports',
      '列出用户已保存的读书心得（可按书筛选）。用户问「我以前写过哪些读书报告」时使用。',
      {
        book: { type: 'string', description: '可选：只列某本书的心得' },
        limit: { type: 'number', description: '最多返回多少篇，默认 20' },
      },
      async (args) => ({ reports: core.listReports({ book: args.book, limit: args.limit || 20 }) }),
      (value) => (value.reports.length === 0 ? '还没有保存过读书心得。' : value.reports.map((report) => `- ${report.title}${report.book ? ` — 《${report.book}》` : ''} · ${String(report.updated || report.created || '').slice(0, 10)}${report.words ? ` · ${report.words} 字` : ''}`).join('\n')),
    ),
  ]

  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition), `reading-companion: tool ${definition.name}`)
  }

  // ------------------------------------------------------------------
  // Reading context prompt section (only when the workbench has a book open)
  // ------------------------------------------------------------------
  function firstId(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return String(value)
    }
    return ''
  }

  function sessionIdFromAssembly(assembly) {
    if (assembly === undefined || assembly === null || typeof assembly !== 'object') return ''
    const session = assembly.session
    const agent = assembly.agent
    const agentSession = agent !== undefined && agent !== null && typeof agent === 'object' ? agent.session : undefined
    const header = (session !== undefined && session !== null && session.header) || (agentSession !== undefined && agentSession !== null && agentSession.header) || undefined
    return firstId(
      assembly.sessionId,
      assembly.session && session.id,
      session && session.sessionId,
      header && header.id,
      header && header.sessionId,
      agent && agent.sessionId,
      agentSession && agentSession.id,
      agentSession && agentSession.sessionId,
    )
  }

  const pickKeys = (value) => (value !== undefined && value !== null && typeof value === 'object' ? Object.keys(value).slice(0, 24) : undefined)
  let lastProbeSignature = ''

  function probePromptAssembly(assembly) {
    try {
      const session = assembly && typeof assembly === 'object' ? assembly.session : undefined
      const agent = assembly && typeof assembly === 'object' ? assembly.agent : undefined
      const agentSession = agent !== undefined && agent !== null && typeof agent === 'object' ? agent.session : undefined
      const signature = JSON.stringify([
        pickKeys(assembly),
        pickKeys(agent),
        pickKeys(session),
        pickKeys(session && session.header),
        pickKeys(agentSession),
        pickKeys(agentSession && agentSession.header),
      ])
      if (signature === lastProbeSignature) return
      lastProbeSignature = signature
      core.recordAssemblyProbe({
        keys: pickKeys(assembly),
        agentKeys: pickKeys(agent),
        sessionKeys: pickKeys(session),
        headerKeys: pickKeys(session && session.header),
        agentSessionKeys: pickKeys(agentSession),
        resolvedSessionId: sessionIdFromAssembly(assembly),
      })
      core.report('prompt-assembly-probe', core.getAssemblyProbe())
    } catch (error) {
      core.report('prompt-assembly-probe-error', { message: String((error && error.message) || error) })
    }
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    ctx.effect(() => systemPrompt.section({
      name: 'reading-companion-context',
      order: 30,
      text: (assembly) => {
        probePromptAssembly(assembly)
        const sessionId = sessionIdFromAssembly(assembly)
        let context
        if (sessionId !== '') {
          // Strict: only this session's own reading context, never another session's.
          context = core.sessionContext(sessionId)
        } else {
          // Unknown session identity: keep the workbench usable, but only within a short
          // freshness window so idle reading context cannot leak into unrelated chats.
          const latest = core.currentContext()
          if (latest !== undefined && latest !== null) {
            const updated = Date.parse(latest.updated || '')
            if (Number.isFinite(updated) && Date.now() - updated <= 2 * 60 * 1000) context = latest
          }
        }
        if (context === undefined || context === null) return ''
        const lines = ['【随读上下文】']
        lines.push(`《${context.bookTitle || '（未标注书名）'}》${context.author ? ` · ${context.author}` : ''}｜${context.chapterTitle || `第 ${(Number(context.chapterIndex) || 0) + 1} 章`}${context.totalChapters ? `（全书 ${context.totalChapters} 章）` : ''}`)
        const selection = String(context.selection || '').trim()
        if (selection.length > 0) lines.push(`用户选中：\n> ${selection.replace(/\n/g, '\n> ')}`)
        lines.push('对话历史可能含其他书的内容，以当前书为准（除非用户提到别的书）；回答简短，引用给章节，不编造；需要正文再调 book_context。')
        return lines.join('\n')
      },
    }), 'reading-companion: reading prompt section')
  }

  const savedConfig = core.state && core.state.config ? core.state.config : {}
  if (!savedConfig.epubDir && fs.existsSync(core.configFile)) {
    core.report('config-unreadable', { file: core.configFile })
  }
  core.report('host-ready', {
    dataDir: core.dataDir,
    pid: process.pid,
    version: VERSION,
    configured: Boolean(savedConfig.epubDir && savedConfig.kbDir),
    epubDir: savedConfig.epubDir || '',
  })
}
