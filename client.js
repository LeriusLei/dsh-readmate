/**
 * 随读 Reading Companion — Web client half.
 *
 * Hosts the reading workbench as a center "main" panel:
 *   sidebar.panellist  ->  panel icon
 *   main["reading"]    ->  the workbench frame (declares the reading.pane child slot)
 *   reading.pane       ->  left: EPUB reader / right: embedded AI conversation
 *
 * The module only requires `react`; everything else comes from slot props and the
 * Client connection service (`connection.rpc.call('/reading', ...)`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-readmate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useCallback, Component } = React

    const MODULE_ID = 'dsh-readmate'
    const RPC_CHANNEL = '/reading'
    const PANEL_KEY = 'reading'
    const TYPE_LABELS = { concept: '概念', opinion: '观点', question: '问题', application: '应用' }
    const THEME_LABELS = { auto: '跟随', paper: '米纸', dark: '夜读' }
    const FONT_FAMILIES = [
      { key: 'song', label: '宋体', stack: '"SimSun", "宋体", "Songti SC", "STSong", serif' },
      { key: 'nsong', label: '新宋体', stack: '"NSimSun", "新宋体", "SimSun", serif' },
      { key: 'stsong', label: '华文宋体', stack: '"STSong", "华文宋体", "SimSun", serif' },
      { key: 'sourcehan', label: '思源宋体', stack: '"Noto Serif SC", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", serif' },
      { key: 'jinghua', label: '京华老宋体', stack: '"KingHwa_OldSong", "京華老宋体", "京华老宋体", "STSong", "SimSun", serif' },
      { key: 'kai', label: '楷体', stack: '"KaiTi", "楷体", "STKaiti", serif' },
      { key: 'stkai', label: '华文楷体', stack: '"STKaiti", "华文楷体", "KaiTi", serif' },
      { key: 'hei', label: '黑体', stack: '"Microsoft YaHei", "微软雅黑", "SimHei", "PingFang SC", sans-serif' },
    ]
    const FONT_PROBES = {
      song: ['SimSun', '宋体'],
      nsong: ['NSimSun', '新宋体'],
      stsong: ['STSong', '华文宋体'],
      sourcehan: ['Noto Serif SC', 'Source Han Serif SC', 'Noto Serif CJK SC'],
      jinghua: ['KingHwa_OldSong', '京華老宋体', '京华老宋体'],
      kai: ['KaiTi', '楷体'],
      stkai: ['STKaiti', '华文楷体'],
      hei: ['Microsoft YaHei', '微软雅黑', 'SimHei'],
    }

    function resolveFontStack(key) {
      const wanted = key === 'serif' ? 'song' : key === 'sans' ? 'hei' : key
      const entry = FONT_FAMILIES.find((item) => item.key === wanted) || FONT_FAMILIES[0]
      return entry.stack
    }

    const fontAvailability = {}
    function fontAvailable(key) {
      if (key in fontAvailability) return fontAvailability[key]
      let available = true
      try {
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const canvas = document.createElement('canvas')
          const context = canvas.getContext && canvas.getContext('2d')
          const probes = FONT_PROBES[key] || []
          if (context && probes.length > 0) {
            context.font = '32px monospace'
            const base = context.measureText('漢A').width
            available = probes.some((probe) => {
              try {
                context.font = '32px "' + probe + '", monospace'
                return Math.abs(context.measureText('漢A').width - base) > 0.5
              } catch (error) { return false }
            })
          }
        }
      } catch (error) { available = true }
      fontAvailability[key] = available
      return available
    }

    let ctxRef = null
    const bridge = {
      sessionId: undefined,
      inputActions: undefined,
      uiWorkspace: undefined,
      layout: undefined,
      // Desktop workbench mode: the chat lives in the host's native
      // conversation column, so we only ever write drafts into it.
      workbench: false,
      sessionBound: false,
      startConversation: undefined,
      pendingDraft: '',
    }

    // ------------------------------------------------------------------
    // host bridge
    // ------------------------------------------------------------------
    function report(event, data) {
      try {
        const ctx = ctxRef
        const connection = ctx && typeof ctx.get === 'function' ? ctx.get('connection') : undefined
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') return
        const promise = connection.rpc.call(RPC_CHANNEL, 'diagnostics/report', { event: String(event || ''), data: data || {} }, undefined)
        if (promise && typeof promise.catch === 'function') promise.catch(() => {})
      } catch (error) { /* diagnostics must never break the UI */ }
    }

    function errText(error) {
      return String((error && error.message) || error || '未知错误')
    }

    async function rpc(method, payload) {
      const ctx = ctxRef
      const connection = ctx && typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
        throw new Error('无法连接随读后台服务，请重新加载页面')
      }
      let result
      try {
        result = await connection.rpc.call(RPC_CHANNEL, method, payload || {}, undefined)
      } catch (error) {
        throw new Error('随读后台请求失败：' + errText(error))
      }
      if (!result || result.ok !== true) {
        throw new Error((result && result.error && result.error.message) || '随读后台返回了错误')
      }
      return result.value
    }

    // ------------------------------------------------------------------
    // tiny ui store (module level: survives panel switches)
    // ------------------------------------------------------------------
    function createStore() {
      const state = {
        status: 'loading',
        error: '',
        config: null,
        settings: { fontSize: 18, lineHeight: 1.9, theme: 'auto', chatScope: 'book', family: 'serif' },
        books: [],
        booksLoading: false,
        booksWarning: '',
        lastScan: 0,
        view: 'shelf',
        book: null,
        chapter: null,
        pendingRestore: null,
        tocOpen: false,
        settingsOpen: false,
        selection: null,
        quoteRanges: [],
        quoteDraft: null,
        kbNotes: [],
        kbTotal: 0,
        kbDetail: null,
        kbLoading: false,
        toast: '',
        todaySeconds: 0,
        reviewBook: null,
        reviewNotes: [],
        reviewLoading: false,
        reports: [],
      }
      const listeners = new Set()
      return {
        state,
        set(patch) {
          Object.assign(state, patch)
          for (const listener of [...listeners]) {
            try { listener() } catch (error) { /* one broken subscriber must not stop the rest */ }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const store = createStore()

    function useStore() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      useEffect(() => store.subscribe(force), [])
      return store.state
    }

    // cross-effect helpers
    let settingsTimer = null
    let contextTimer = null
    let progressTimer = null
    let navigationRequest = 0
    let notesRequest = 0
    let lastActivityAt = Date.now()
    let pendingSeconds = 0
    const position = { ratio: 0, blockIndex: 0 }

    function bumpActivity() {
      lastActivityAt = Date.now()
    }

    function saveSettings(patch) {
      const settings = Object.assign({}, store.state.settings, patch || {})
      store.set({ settings })
      if (settingsTimer !== null) clearTimeout(settingsTimer)
      settingsTimer = setTimeout(() => {
        settingsTimer = null
        rpc('settings/save', { settings }).catch(() => {})
      }, 400)
    }

    function toast(text) {
      store.set({ toast: String(text || '') })
    }

    function bookLabel(title) {
      const value = String(title || '').trim()
      if (value.length === 0) return ''
      return /^《.*》$/.test(value) ? value : '《' + value + '》'
    }

    function reportContext(extra) {
      const state = store.state
      const book = state.book
      if (!book) return
      const chapter = state.chapter
      const selection = extra && typeof extra.selection === 'string'
        ? extra.selection
        : state.selection !== null
          ? state.selection.text
          : ''
      const payload = {
        sessionId: bridge.sessionId,
        bookId: book.id,
        bookTitle: book.title,
        author: book.author,
        chapterIndex: chapter ? chapter.index : 0,
        chapterTitle: chapter ? chapter.title : '',
        totalChapters: book.chapters ? book.chapters.length : 0,
        selection,
      }
      if (contextTimer !== null) clearTimeout(contextTimer)
      contextTimer = setTimeout(() => {
        contextTimer = null
        rpc('reading/context', payload).catch(() => {})
      }, 200)
    }

    // ------------------------------------------------------------------
    // data actions
    // ------------------------------------------------------------------
    async function bootstrap(workspaceDir) {
      store.set({ status: 'loading', error: '' })
      try {
        const config = await rpc('config/get', workspaceDir ? { workspaceDir } : {})
        const settings = Object.assign(
          { fontSize: 18, lineHeight: 1.9, theme: 'auto', chatScope: 'book', family: 'serif' },
          config.settings || {},
        )
        store.set({ config, settings, status: 'ready', error: '' })
        report('config-loaded', {
          configured: Boolean(config.configured),
          books: config.stats ? config.stats.books : undefined,
          notes: config.stats ? config.stats.notes : undefined,
        })
        if (config.configured) {
          await refreshBooks()
          loadStats()
          const lastBookId = String(settings.lastBookId || '') || ''
          if (lastBookId.length > 0 && store.state.view === 'shelf') {
            const found = store.state.books.some((book) => book.id === lastBookId)
            if (found) {
              report('auto-resume', { id: lastBookId })
              openBook(lastBookId)
            }
          }
        }
      } catch (error) {
        store.set({ status: 'error', error: errText(error) })
        report('config-error', { message: errText(error) })
      }
    }

    async function refreshBooks() {
      if (store.state.booksLoading) return
      store.set({ booksLoading: true })
      try {
        const result = await rpc('books/list')
        store.set({ books: result.books || [], booksLoading: false, booksWarning: result.warning || '', lastScan: Date.now(), error: '' })
      } catch (error) {
        store.set({ booksLoading: false, error: errText(error) })
        report('books-error', { message: errText(error) })
      }
    }

    async function setupDirectories(epubDir, kbDir) {
      const result = await rpc('config/setup', { epubDir, kbDir })
      const config = await rpc('config/get')
      store.set({ config: Object.assign({}, config, { configured: true, epubDir, kbDir }), status: 'ready' })
      await refreshBooks()
      report('setup-done', { stats: result.stats })
      return result
    }

    async function openBook(bookId) {
      const request = ++navigationRequest
      store.set({ error: '' })
      await flushReading()
      try {
        const result = await rpc('book/open', { bookId })
        if (request !== navigationRequest) return
        const progress = result.progress || {}
        store.set({
          book: result.book,
          chapter: result.chapter,
          view: 'read',
          tocOpen: false,
          settingsOpen: false,
          selection: null,
          pendingRestore: {
            token: Date.now(),
            ratio: Number(progress.scrollRatio) || 0,
            blockIndex: Number(progress.blockIndex) || 0,
          },
        })
        bumpActivity()
        saveSettings({ lastBookId: bookId })
        loadQuoteRanges()
        report('book-open', { id: bookId, chapter: result.chapter ? result.chapter.index : 0, blocks: result.chapter ? result.chapter.blocks.length : 0 })
        reportContext({})
      } catch (error) {
        if (request !== navigationRequest) return
        store.set({ error: errText(error) })
        toast('打开失败：' + errText(error))
        report('book-open-error', { message: errText(error) })
      }
    }

    async function gotoChapter(index) {
      const request = ++navigationRequest
      const state = store.state
      if (!state.book) return
      const total = state.book.chapters ? state.book.chapters.length : 0
      const next = Math.max(0, Math.min(total - 1, Number(index) || 0))
      await saveProgressNow()
      try {
        const result = await rpc('book/chapter', { bookId: state.book.id, index: next })
        if (request !== navigationRequest) return
        store.set({
          chapter: result.chapter,
          pendingRestore: { token: Date.now(), ratio: 0, blockIndex: 0 },
          tocOpen: false,
          selection: null,
        })
        loadQuoteRanges()
        reportContext({ selection: '' })
      } catch (error) {
        if (request !== navigationRequest) return
        toast('切换章节失败：' + errText(error))
      }
    }

    async function saveProgressNow() {
      const state = store.state
      const book = state.book
      const chapter = state.chapter
      if (!book || !chapter) return
      const seconds = Math.min(pendingSeconds, 3600)
      pendingSeconds = 0
      try {
        const result = await rpc('book/progress', {
          bookId: book.id,
          bookTitle: book.title,
          author: book.author,
          chapterIndex: chapter.index,
          chapterTitle: chapter.title,
          scrollRatio: position.ratio,
          blockIndex: position.blockIndex,
          seconds,
        })
        if (result && typeof result.today === 'number') store.set({ todaySeconds: result.today })
      } catch (error) {
        report('progress-error', { message: errText(error) })
      }
    }

    function flushReading() {
      const state = store.state
      const book = state.book
      if (!book || pendingSeconds <= 0) return Promise.resolve()
      const seconds = Math.min(pendingSeconds, 600)
      pendingSeconds = 0
      return rpc('reading/tick', { bookId: book.id, seconds })
        .then((result) => {
          if (result && typeof result.today === 'number') store.set({ todaySeconds: result.today })
        })
        .catch(() => {})
    }

    async function loadStats() {
      try {
        const result = await rpc('stats/get')
        if (result && typeof result.today === 'number') store.set({ todaySeconds: result.today })
      } catch (error) { /* stats are optional */ }
    }

    function scheduleProgressSave() {
      if (progressTimer !== null) clearTimeout(progressTimer)
      progressTimer = setTimeout(() => {
        progressTimer = null
        saveProgressNow()
      }, 1500)
    }

    async function loadNotes() {
      const request = ++notesRequest
      store.set({ kbLoading: true })
      try {
        const result = await rpc('kb/list', { limit: 100 })
        if (request !== notesRequest) return
        store.set({ kbNotes: result.notes || [], kbTotal: (result.notes || []).length, kbLoading: false })
      } catch (error) {
        if (request !== notesRequest) return
        store.set({ kbLoading: false, error: errText(error) })
      }
    }

    async function searchNotes(query) {
      const text = String(query || '').trim()
      if (text.length === 0) return loadNotes()
      const request = ++notesRequest
      store.set({ kbLoading: true })
      try {
        const result = await rpc('kb/search', { query: text, limit: 50 })
        if (request !== notesRequest) return
        store.set({ kbNotes: result.notes || [], kbLoading: false })
      } catch (error) {
        if (request !== notesRequest) return
        store.set({ kbLoading: false, error: errText(error) })
      }
    }

    async function openNote(id) {
      try {
        const result = await rpc('kb/note', { id })
        store.set({ kbDetail: result.note })
      } catch (error) {
        toast('读取笔记失败：' + errText(error))
      }
    }

    // Quote cards: the reader can save a selected passage as a knowledge card
    // without asking the AI, and reopen the book with the passage underlined.
    async function loadQuoteRanges() {
      const state = store.state
      if (!state.book || !state.chapter) { store.set({ quoteRanges: [] }); return }
      try {
        const result = await rpc('quote/list', {
          bookId: state.book.id,
          book: state.book.title,
          chapterIndex: state.chapter.index,
        })
        store.set({ quoteRanges: (result && result.quotes) || [] })
      } catch (error) {
        store.set({ quoteRanges: [] })
        report('quote-list-error', { message: errText(error) })
      }
    }

    async function saveQuote(selection, reflection) {
      const state = store.state
      const book = state.book
      const chapter = state.chapter
      if (!book || !chapter || !selection) return
      const note = String(reflection || '').trim()
      try {
        const result = await rpc('quote/save', {
          bookId: book.id,
          book: book.title,
          author: book.author,
          chapterIndex: chapter.index,
          chapterTitle: chapter.title,
          quote: selection.text,
          reflection: note,
          startBlock: selection.startBlock,
          startOffset: selection.startOffset,
          endBlock: selection.endBlock,
          endOffset: selection.endOffset,
        })
        const saved = (result && result.note) || {}
        toast(note.length > 0 ? '已收录，原文已保存' : '已收藏这段原文')
        store.set({ selection: null, quoteDraft: null })
        loadQuoteRanges()
        report('quote-saved', { id: saved.id, length: selection.text.length, hasReflection: note.length > 0 })
      } catch (error) {
        report('quote-save-error', { message: errText(error) })
        toast('保存失败：' + errText(error))
      }
    }

    async function openReview(book) {
      const target = book || store.state.book
      if (!target) return
      store.set({ view: 'review', reviewBook: target, reviewLoading: true, tocOpen: false, settingsOpen: false, selection: null })
      bumpActivity()
      try {
        const notesResult = await rpc('kb/list', { book: target.title, limit: 200 }).catch(() => ({ notes: [] }))
        const reportsResult = await rpc('report/list', { book: target.title, limit: 100 }).catch(() => ({ reports: [] }))
        store.set({ reviewNotes: notesResult.notes || [], reports: reportsResult.reports || [], reviewLoading: false })
        report('review-open', { book: target.title, notes: (notesResult.notes || []).length })
      } catch (error) {
        store.set({ reviewLoading: false })
        report('review-error', { message: errText(error) })
      }
    }

    async function refreshReports(book) {
      const title = (book && book.title) || (store.state.reviewBook && store.state.reviewBook.title) || ''
      try {
        const result = await rpc('report/list', { book: title, limit: 100 })
        store.set({ reports: result.reports || [] })
      } catch (error) {
        report('reports-error', { message: errText(error) })
      }
    }

    // ------------------------------------------------------------------
    // selection -> conversation composer
    // ------------------------------------------------------------------
    function buildContextBlock(selectionText) {
      const state = store.state
      const book = state.book
      const chapter = state.chapter
      if (!book) return ''
      const lines = []
      lines.push('【阅读上下文】')
      lines.push('书名：' + bookLabel(book.title) + (book.author ? ' · 作者：' + book.author : ''))
      if (chapter) {
        lines.push('章节：' + (chapter.title || '') + '（第 ' + (chapter.index + 1) + ' / ' + (book.chapters ? book.chapters.length : '?') + ' 章）')
      }
      lines.push('进度：第 ' + ((chapter ? chapter.index : 0) + 1) + ' 章 · 约 ' + Math.round(position.ratio * 100) + '%')
      if (selectionText) {
        lines.push('')
        lines.push('选中原文：')
        lines.push(String(selectionText).split('\n').map((line) => '> ' + line).join('\n'))
      }
      if (state.settings.chatScope === 'kb') {
        lines.push('')
        lines.push('（这个回答可以先用 kb_search 在我的整个个人阅读知识库里检索相关笔记，再结合当前这本书回答。）')
      }
      return lines.join('\n')
    }

    function injectPrompt(kind, selectionText) {
      const state = store.state
      const context = buildContextBlock(selectionText)
      let text = context
      if (kind === 'explain') text += '\n\n请解释这段原文的意思，并结合上下文说明它在本章里的作用。'
      else if (kind === 'ask') text += '\n\n我想问：'
      else if (kind === 'idea') text += '\n\n我的想法：'
      else if (kind === 'chapter') text += '\n\n请帮我回顾这一章：作者主要在论证什么？这一章和全书的关系是什么？'
      else if (kind === 'organize') text += '\n\n请帮我理一理我在这本书里目前表达过的想法：哪些值得收录、它们之间有什么联系、还有哪些问题没想清楚。'
      else if (kind === 'materials') text += '\n\n我想写一篇这本书的读书心得。请先用 kb_materials 取出我在这本书里的笔记、原文引用和待探索问题作为素材，帮我梳理出几个可能的主题线索；心得正文我自己写，不要代写。'
      const actions = bridge.inputActions
      if (!actions || typeof actions.setDraft !== 'function') {
        report('inject-missing', { kind, hasActions: Boolean(actions), workbench: Boolean(bridge.workbench) })
        if (bridge.workbench && typeof bridge.startConversation === 'function') {
          if (bridge.sessionBound) { toast('对话输入框还没准备好，请稍等再试'); return false }
          // The user just asked a session-dependent question: open the linked
          // conversation, then drop the prompt in as soon as its input mounts.
          bridge.pendingDraft = text
          toast('正在为你打开伴读对话…')
          bridge.startConversation()
          return true
        }
        toast('对话输入框还没准备好，请稍后再试')
        return false
      }
      try {
        actions.setDraft(text)
        report('inject-ok', { kind, length: text.length })
        toast(kind === 'explain' ? '已放进对话框，按 Enter 发送' : '已放进对话框，补充你的问题后发送')
        return true
      } catch (error) {
        report('inject-error', { kind, message: errText(error) })
        toast('没能写入对话输入框：' + errText(error))
        return false
      }
    }

    // ------------------------------------------------------------------
    // styles
    // ------------------------------------------------------------------
    const CSS = `
.rcc-root{display:flex;flex-direction:column;height:100%;width:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;position:relative}
.rcc-root *{box-sizing:border-box}
.rcc-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.rcc-grow{flex:1 1 auto;min-width:0}
.rcc-btn,.rcc-ghost,.rcc-chip,.rcc-tool{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 10px;font-size:12px;line-height:1.2;cursor:pointer;font-family:inherit;white-space:nowrap}
.rcc-btn:hover,.rcc-ghost:hover,.rcc-chip:hover,.rcc-tool:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rcc-btn:disabled,.rcc-ghost:disabled{opacity:.45;cursor:default}
.rcc-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.rcc-chip{border-radius:999px;padding:4px 10px;background:transparent}
.rcc-chip-on{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.rcc-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit;outline:none;min-width:0}
.rcc-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.rcc-top{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:46px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.rcc-brand{font-weight:600;font-size:14px;letter-spacing:.5px}
.rcc-nav{display:flex;align-items:center;gap:4px}
.rcc-top-right{margin-left:auto;display:flex;align-items:center;gap:6px;min-width:0}
.rcc-top-book{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.rcc-body{flex:1 1 auto;display:flex;min-height:0;overflow:hidden}
.rcc-left{flex:0 0 60%;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l2);position:relative;overflow:hidden;background:var(--dsw-alias-bg-base)}
.rcc-center-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;color:var(--dsw-alias-label-secondary)}
.rcc-empty{padding:36px 24px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
/* shelf */
.rcc-shelf{display:flex;flex-direction:column;height:100%;min-height:0}
.rcc-shelf-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.rcc-shelf-head .rcc-input{flex:1 1 180px}
.rcc-grid{flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px 16px 48px;display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:20px 16px;align-content:start}
.rcc-book{display:flex;flex-direction:column;gap:5px;min-width:0;padding:0;border:none;background:transparent;text-align:left;font-family:inherit;color:var(--dsw-alias-label-primary);cursor:pointer}
.rcc-cover{position:relative;width:100%;aspect-ratio:3/4;border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 2px 8px rgba(0,0,0,.14);display:flex;align-items:center;justify-content:center}
.rcc-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.rcc-cover-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);text-align:center;word-break:break-word;overflow:hidden}
.rcc-book:hover .rcc-cover{border-color:var(--dsw-alias-border-l3)}
.rcc-book:hover .rcc-cover img{transform:scale(1.02);transition:transform .18s ease}
.rcc-book-title{font-size:13px;font-weight:500;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.rcc-book-author{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rcc-book-meta{font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rcc-book-actions{display:flex;gap:6px;margin-top:1px;opacity:0}
.rcc-book:hover .rcc-book-actions,.rcc-book:focus-within .rcc-book-actions{opacity:1}
/* reader */
.rcc-reader{display:flex;flex-direction:column;height:100%;min-height:0;position:relative;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.rcc-reader[data-theme="paper"]{background:#f4eddd;color:#3b342a}
.rcc-reader[data-theme="paper"] .rcc-reader-head,.rcc-reader[data-theme="paper"] .rcc-reader-foot{border-color:#e2d8c2;background:#efe7d5;color:#5b5242}
.rcc-reader[data-theme="dark"]{background:#141519;color:#d7d8dc}
.rcc-reader[data-theme="dark"] .rcc-reader-head,.rcc-reader[data-theme="dark"] .rcc-reader-foot{background:#1a1b20;border-color:#2a2c33;color:#c8c9cf}
.rcc-reader[data-theme="dark"] .rcc-muted{color:#8b8d96}
.rcc-reader[data-theme="paper"] .rcc-ghost,.rcc-reader[data-theme="paper"] .rcc-btn,.rcc-reader[data-theme="paper"] .rcc-chip,.rcc-reader[data-theme="paper"] .rcc-tool{color:#4a4131;background:#f8f1e1;border-color:#d9cbb0}
.rcc-reader[data-theme="paper"] .rcc-ghost{background:transparent;border-color:transparent;color:#564d3d}
.rcc-reader[data-theme="paper"] .rcc-ghost:hover,.rcc-reader[data-theme="paper"] .rcc-btn:hover,.rcc-reader[data-theme="paper"] .rcc-chip:hover,.rcc-reader[data-theme="paper"] .rcc-tool:hover{background:#e9dec5}
.rcc-reader[data-theme="paper"] .rcc-btn:disabled,.rcc-reader[data-theme="paper"] .rcc-ghost:disabled{opacity:.55;color:#9c9079}
.rcc-reader[data-theme="paper"] .rcc-chip-on{background:#e7dcc1;border-color:#8a6d3b;color:#6b5124}
.rcc-reader[data-theme="paper"] .rcc-muted{color:#7a6f5c}
.rcc-reader[data-theme="paper"] .rcc-reader-title{color:#3b342a}
.rcc-reader[data-theme="paper"] .rcc-chapter-meta,.rcc-reader[data-theme="paper"] .rcc-reader-foot-progress{color:#7a6f5c}
.rcc-reader[data-theme="dark"] .rcc-ghost,.rcc-reader[data-theme="dark"] .rcc-btn,.rcc-reader[data-theme="dark"] .rcc-chip,.rcc-reader[data-theme="dark"] .rcc-tool{color:#d3d4da;background:#23242b;border-color:#3a3c46}
.rcc-reader[data-theme="dark"] .rcc-ghost{background:transparent;border-color:transparent;color:#c8c9cf}
.rcc-reader[data-theme="dark"] .rcc-ghost:hover,.rcc-reader[data-theme="dark"] .rcc-btn:hover,.rcc-reader[data-theme="dark"] .rcc-chip:hover,.rcc-reader[data-theme="dark"] .rcc-tool:hover{background:#2d2f37}
.rcc-reader[data-theme="dark"] .rcc-chip-on{background:#2f3340;border-color:#7f9bd6;color:#a9bde8}
.rcc-chip[disabled]{opacity:.4;cursor:default}
.rcc-reader-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.rcc-reader-title{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
.rcc-reader-head .rcc-muted{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rcc-scroll{flex:1 1 auto;overflow-y:auto;padding:30px 42px 90px;min-height:0}
.rcc-page{max-width:700px;margin:0 auto}
.rcc-chapter-head{margin-bottom:1.4em;padding-bottom:.8em;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rcc-chapter-title{font-size:1.18em;font-weight:600;line-height:1.5;margin-bottom:.3em}
.rcc-chapter-meta{font-size:.72em;color:var(--dsw-alias-label-tertiary);letter-spacing:.05em}
.rcc-p{margin:0 0 .95em;text-align:justify;word-break:break-word}
.rcc-p-first{margin-top:.2em}
.rcc-h{margin:1.4em 0 .7em;font-weight:600;line-height:1.45}
.rcc-reader h1.rcc-h{font-size:1.42em}
.rcc-reader h2.rcc-h{font-size:1.28em}
.rcc-reader h3.rcc-h{font-size:1.14em}
.rcc-reader h4.rcc-h,.rcc-reader h5.rcc-h,.rcc-reader h6.rcc-h{font-size:1.02em}
.rcc-reader-foot{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;height:42px;padding:0 12px;border-top:1px solid var(--dsw-alias-border-l2)}
.rcc-reader-foot .rcc-muted{font-size:11px}
/* floating selection toolbar */
.rcc-toolbar{position:fixed;z-index:80;display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);box-shadow:0 8px 24px rgba(0,0,0,.18);transform:translateX(-50%)}
.rcc-tool{border-color:transparent;background:transparent;padding:5px 9px}
/* saved quote underlines */
.rcc-mark{background:rgba(255,205,86,.35);color:inherit;border-bottom:1px solid rgba(176,132,18,.55);border-radius:2px;padding:0 1px;cursor:pointer}
.rcc-reader[data-theme="paper"] .rcc-mark{background:rgba(230,190,90,.32);border-bottom-color:rgba(150,110,20,.5)}
.rcc-reader[data-theme="dark"] .rcc-mark{background:rgba(233,193,90,.24);border-bottom-color:rgba(233,193,90,.45)}
/* quote save dialog */
.rcc-dialog-mask{position:absolute;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.3)}
.rcc-dialog{width:min(560px,100%);display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:14px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);box-shadow:0 18px 48px rgba(0,0,0,.28)}
.rcc-dialog-head{font-size:13px;font-weight:600}
.rcc-dialog-quote{max-height:150px;overflow-y:auto;padding:8px 10px;border-left:3px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1);border-radius:6px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.rcc-dialog-input{width:100%;resize:vertical;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:10px;padding:10px;font-size:13px;line-height:1.7;font-family:inherit;outline:none}
.rcc-dialog-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.rcc-dialog-actions{display:flex;align-items:center;gap:8px}
/* toc / settings */
.rcc-toc{position:absolute;top:0;left:0;bottom:0;width:320px;max-width:82%;display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--dsw-alias-bg-layer-2);border-right:1px solid var(--dsw-alias-border-l3);z-index:40;box-shadow:6px 0 24px rgba(0,0,0,.12)}
.rcc-toc-head{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 2px 6px}
.rcc-toc-list{flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;gap:1px}
.rcc-toc-item{display:flex;gap:10px;align-items:baseline;text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.6;padding:6px 8px;border-radius:6px;cursor:pointer}
.rcc-toc-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rcc-toc-on{background:var(--dsw-alias-interactive-bg-active)}
.rcc-toc-num{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:22px}
.rcc-toc-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rcc-settings{position:absolute;top:52px;right:10px;width:300px;z-index:50;display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);box-shadow:0 12px 32px rgba(0,0,0,.18)}
.rcc-settings-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rcc-settings-row>span:first-child{width:44px;color:var(--dsw-alias-label-secondary);font-size:12px}
.rcc-value{font-size:12px;color:var(--dsw-alias-label-tertiary);min-width:42px;text-align:center}
.rcc-settings-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}
/* knowledge base */
.rcc-kb{display:flex;flex-direction:column;height:100%;min-height:0}
.rcc-kb-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.rcc-kb-head .rcc-input{flex:1 1 200px}
.rcc-kb-list{flex:1 1 auto;overflow-y:auto;padding:10px 16px 40px;display:flex;flex-direction:column;gap:6px}
.rcc-card{display:flex;flex-direction:column;gap:3px;text-align:left;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:9px;cursor:pointer;font-family:inherit;color:var(--dsw-alias-label-primary)}
.rcc-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rcc-card-title{font-size:13px;font-weight:500;line-height:1.4}
.rcc-card-meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.rcc-kb-detail{flex:1 1 auto;overflow-y:auto;padding:14px 16px 40px}
.rcc-kb-detail-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.rcc-kb-detail-body{white-space:pre-wrap;font-size:13px;line-height:1.75;color:var(--dsw-alias-label-primary)}
.rcc-kb-detail pre{margin:0;font-family:inherit;white-space:pre-wrap}
.rcc-kb-related{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
/* setup */
.rcc-setup-wrap{display:flex;align-items:center;justify-content:center;height:100%;padding:24px;overflow-y:auto}
.rcc-setup{width:100%;max-width:560px;display:flex;flex-direction:column;gap:14px;padding:24px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rcc-setup h1{margin:0;font-size:18px;font-weight:600}
.rcc-setup p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}
.rcc-field{display:flex;flex-direction:column;gap:6px}
.rcc-field>label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rcc-field-row{display:flex;gap:6px}
.rcc-field-row .rcc-input{flex:1 1 auto}
.rcc-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
/* chat column */
.rcc-chat{flex:1 1 40%;min-width:300px;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.rcc-chat-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.rcc-chat-title{font-size:12px;font-weight:500}
.rcc-chat-scope{display:flex;gap:4px;margin-left:auto}
.rcc-chat-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.rcc-chat-fallback{display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
/* toast */
.rcc-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:90;max-width:80%;padding:7px 14px;border-radius:999px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-alias-label-primary-inverted);font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.2);pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* continue reading */
.rcc-continue{flex:0 0 auto;display:flex;align-items:center;gap:10px;margin:12px 16px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-business-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.rcc-continue-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46vw}
.rcc-continue-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.rcc-continue-actions{margin-left:auto;display:flex;gap:6px;flex-shrink:0}
.rcc-book-actions{display:flex;gap:6px;margin-top:2px}
.rcc-mini{padding:2px 6px;font-size:11px;border-radius:6px}
.rcc-chapter-end{display:flex;align-items:center;justify-content:center;gap:10px;padding:26px 0 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;flex-wrap:wrap}
.rcc-chapter-end::before{content:"";flex:1 1 40px;height:1px;background:var(--dsw-alias-border-l1)}
.rcc-chapter-end::after{content:"";flex:1 1 40px;height:1px;background:var(--dsw-alias-border-l1)}
.rcc-reader-foot-progress{font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:44px;text-align:center}
/* chat quick prompts */
.rcc-chat-quick{flex:0 0 auto;display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}
.rcc-chat-quick .rcc-chip{font-size:11px;padding:3px 9px}
/* review */
.rcc-review{display:flex;flex-direction:column;height:100%;min-height:0}
.rcc-review-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.rcc-review-title{font-size:13px;font-weight:600}
.rcc-review-body{flex:1 1 auto;display:flex;min-height:0;overflow:hidden}
.rcc-review-col{flex:1 1 50%;min-width:0;overflow-y:auto;padding:12px 16px 40px;display:flex;flex-direction:column}
.rcc-review-col+.rcc-review-col{border-left:1px solid var(--dsw-alias-border-l2)}
.rcc-review-section{margin-bottom:16px}
.rcc-review-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:8px}
.rcc-review-chapter{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:10px 0 4px;letter-spacing:.04em}
.rcc-review-note{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.6;padding:5px 8px;border-radius:6px;cursor:pointer}
.rcc-review-note:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rcc-review-note-type{color:var(--dsw-alias-label-tertiary);margin-right:6px;font-size:11px}
.rcc-textarea{width:100%;min-height:240px;flex:1 1 auto;resize:vertical;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:10px;padding:12px;font-size:13px;line-height:1.8;font-family:inherit;outline:none;margin-top:8px}
.rcc-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.rcc-report-item{display:flex;align-items:center;gap:6px;font-size:12px;padding:6px 8px;border-radius:6px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;text-align:left;width:100%}
.rcc-report-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rcc-report-on{background:var(--dsw-alias-interactive-bg-active)}
.rcc-report-item small{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
/* desktop workbench: the native chat column sits beside this panel */
.rcc-workbench .rcc-left{flex:1 1 auto;border-right:none}
.rcc-workbench .rcc-top{flex-wrap:wrap;height:auto;min-height:46px;padding:6px 12px;gap:8px}
.rcc-workbench .rcc-top-book{max-width:min(360px,40vw)}
.rcc-workbench-tip{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:7px 14px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.4;background:var(--dsw-alias-bg-layer-1)}
.rcc-workbench-tip .rcc-btn{margin-left:auto}
`

    function StyleSheet() {
      return h('style', { 'data-reading-companion': 'style', dangerouslySetInnerHTML: { __html: CSS } })
    }

    function Toast() {
      const state = useStore()
      useEffect(() => {
        if (!state.toast) return undefined
        const timer = setTimeout(() => store.set({ toast: '' }), 2600)
        return () => clearTimeout(timer)
      }, [state.toast])
      if (!state.toast) return null
      return h('div', { className: 'rcc-toast' }, state.toast)
    }

    // ------------------------------------------------------------------
    // setup
    // ------------------------------------------------------------------
    function SetupView(props) {
      const config = props.config || {}
      const defaults = config.defaults || {}
      const [epubDir, setEpubDir] = useState(defaults.epubDir || '')
      const [kbDir, setKbDir] = useState(defaults.kbDir || '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const pickInto = async (setter) => {
        const uiWorkspace = bridge.uiWorkspace
        if (uiWorkspace && typeof uiWorkspace.pickDirectory === 'function') {
          try {
            const picked = await uiWorkspace.pickDirectory()
            if (typeof picked === 'string' && picked.trim().length > 0) setter(picked.trim())
          } catch (pickError) {
            setError('选择目录失败：' + errText(pickError))
          }
          return
        }
        const ctx = ctxRef
        const candidate = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
        if (candidate && typeof candidate.pickDirectory === 'function') {
          try {
            const picked = await candidate.pickDirectory()
            if (typeof picked === 'string' && picked.trim().length > 0) setter(picked.trim())
          } catch (pickError) {
            setError('选择目录失败：' + errText(pickError))
          }
          return
        }
        setError('当前环境没有目录选择器，请直接输入文件夹路径。')
      }

      const submit = async () => {
        const epub = epubDir.trim()
        const kb = kbDir.trim()
        if (epub.length === 0 || kb.length === 0) {
          setError('请先选择或填写 EPUB 书籍文件夹和知识库文件夹。')
          return
        }
        setBusy(true)
        setError('')
        try {
          const result = await setupDirectories(epub, kb)
          const stats = result && result.stats ? result.stats : {}
          toast('已建立书架：' + (stats.books || 0) + ' 本书')
        } catch (setupError) {
          setError(errText(setupError))
          setBusy(false)
        }
      }

      return h('div', { className: 'rcc-setup-wrap' },
        h('div', { className: 'rcc-setup' },
          h('h1', null, '随读 · 第一次使用'),
          h('p', null, '只需要设置一次：告诉我你的 EPUB 文件夹和知识库文件夹。之后所有书、笔记和阅读进度都会自动记住。'),
          h('p', { className: 'rcc-setup-hint' }, '如果之前已经设置过，出现这个页面说明配置没有读到；请重新选择你原来的书库目录。'),
          h('div', { className: 'rcc-field' },
            h('label', null, 'EPUB 书籍文件夹'),
            h('div', { className: 'rcc-field-row' },
              h('input', {
                className: 'rcc-input',
                value: epubDir,
                placeholder: defaults.epubDir || '例如 E:\\Books',
                onChange: (event) => setEpubDir(event.target.value),
              }),
              h('button', { className: 'rcc-btn', onClick: () => pickInto(setEpubDir) }, '选择'),
            ),
          ),
          h('div', { className: 'rcc-field' },
            h('label', null, '个人知识库文件夹（自动创建）'),
            h('div', { className: 'rcc-field-row' },
              h('input', {
                className: 'rcc-input',
                value: kbDir,
                placeholder: defaults.kbDir || '例如 E:\\Books\\Reading-KB',
                onChange: (event) => setKbDir(event.target.value),
              }),
              h('button', { className: 'rcc-btn', onClick: () => pickInto(setKbDir) }, '选择'),
            ),
          ),
          error ? h('div', { className: 'rcc-error' }, error) : null,
          h('div', { className: 'rcc-field-row', style: { justifyContent: 'flex-end' } },
            h('button', { className: 'rcc-btn', disabled: busy, onClick: submit }, busy ? '正在准备书架…' : '开始阅读'),
          ),
          h('p', null, '原始 EPUB 文件只会被读取，不会被修改、移动或覆盖。'),
        ),
      )
    }

    // ------------------------------------------------------------------
    // shelf
    // ------------------------------------------------------------------
    function ShelfView(props) {
      const state = props.state
      const [query, setQuery] = useState('')
      const books = state.books
      const filtered = useMemo(() => {
        const text = query.trim()
        if (text.length === 0) return books
        return books.filter((book) => String(book.title || '').includes(text) || String(book.author || '').includes(text) || String(book.fileName || '').includes(text))
      }, [books, query])
      const current = useMemo(() => books.find((book) => book.progress && book.progress.lastRead), [books])
      const todayMinutes = Math.round((Number(state.todaySeconds) || 0) / 60)
      return h('div', { className: 'rcc-shelf' },
        h('div', { className: 'rcc-shelf-head' },
          h('input', {
            className: 'rcc-input',
            placeholder: '搜索书名或作者',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { className: 'rcc-btn', disabled: state.booksLoading, onClick: () => refreshBooks() }, state.booksLoading ? '扫描中…' : '刷新书架'),
          h('span', { className: 'rcc-muted' }, String(books.length) + ' 本'),
          todayMinutes > 0 ? h('span', { className: 'rcc-muted' }, '· 今日已读 ' + todayMinutes + ' 分钟') : null,
        ),
        current
          ? h('div', { className: 'rcc-continue' },
            h('div', { className: 'rcc-grow' },
              h('div', { className: 'rcc-continue-title' }, bookLabel(current.title)),
              h('div', { className: 'rcc-continue-meta' },
                '上次读到 ' + (current.progress.chapterTitle || ('第 ' + ((current.progress.chapterIndex || 0) + 1) + ' 章')) +
                (current.progress.readingSeconds ? ' · 累计 ' + Math.max(1, Math.round(current.progress.readingSeconds / 60)) + ' 分钟' : ''),
              ),
            ),
            h('div', { className: 'rcc-continue-actions' },
              h('button', { className: 'rcc-ghost', onClick: () => openReview(current) }, '回顾'),
              h('button', { className: 'rcc-btn', onClick: () => openBook(current.id) }, '继续阅读'),
            ),
          )
          : null,
        state.booksLoading && books.length === 0
          ? h('div', { className: 'rcc-empty' }, '正在扫描 EPUB 书架…')
          : filtered.length === 0
            ? h('div', { className: 'rcc-empty' }, books.length === 0 ? (state.booksWarning ? '书库读取失败：' + state.booksWarning : '这个文件夹里还没有 EPUB 书籍。') : '没有找到匹配的书。')
            : h('div', { className: 'rcc-grid' }, filtered.slice(0, 400).map((book) => h('div', {
              key: book.id,
              className: 'rcc-book',
              role: 'button',
              tabIndex: 0,
              title: book.fileName,
              onClick: () => { openBook(book.id) },
              onKeyDown: (event) => { if (event.target !== event.currentTarget || event.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openBook(book.id) } },
            },
            h('div', { className: 'rcc-cover' },
              h('div', { className: 'rcc-cover-fallback' }, book.title || book.fileName || '未知书名'),
              h('img', {
                src: '/reading/cover/' + encodeURIComponent(book.id),
                alt: '',
                loading: 'lazy',
                draggable: false,
                onError: (event) => { event.currentTarget.style.display = 'none' },
              }),
            ),
            h('div', { className: 'rcc-book-title' }, book.title || book.fileName || '未知书名'),
            h('div', { className: 'rcc-book-author' }, book.author || '未知作者'),
            h('div', { className: 'rcc-book-meta' },
              (book.chapterCount ? book.chapterCount + ' 节 · ' : '') +
              (book.progress && book.progress.lastRead
                ? '读到 ' + (book.progress.chapterTitle || '第 ' + ((book.progress.chapterIndex || 0) + 1) + ' 章')
                : '未开始'),
            ),
            h('div', { className: 'rcc-book-actions' },
              h('button', {
                className: 'rcc-ghost rcc-mini',
                onClick: (event) => { event.stopPropagation(); openReview(book) },
              }, '回顾'),
            ),
            ))),
      )
    }

    // ------------------------------------------------------------------
    // reader
    // ------------------------------------------------------------------
    function TocPanel(props) {
      const state = props.state
      const book = state.book
      const [query, setQuery] = useState('')
      const chapters = useMemo(() => {
        const all = (book && book.chapters) || []
        const text = query.trim()
        if (text.length === 0) return all
        return all.filter((chapter) => String(chapter.title || '').includes(text))
      }, [book, query])
      return h('div', { className: 'rcc-toc' },
        h('div', { className: 'rcc-toc-head' },
          h('span', null, '目录'),
          h('button', { className: 'rcc-ghost', onClick: () => store.set({ tocOpen: false }) }, '关闭'),
        ),
        h('input', { className: 'rcc-input', placeholder: '搜索章节', value: query, onChange: (event) => setQuery(event.target.value) }),
        h('div', { className: 'rcc-toc-list' }, chapters.slice(0, 800).map((chapter) => h('button', {
          key: chapter.index,
          className: 'rcc-toc-item' + (state.chapter && state.chapter.index === chapter.index ? ' rcc-toc-on' : ''),
          onClick: () => { store.set({ tocOpen: false }); gotoChapter(chapter.index) },
        },
        h('span', { className: 'rcc-toc-num' }, String(chapter.index + 1)),
        h('span', { className: 'rcc-toc-title' }, chapter.title || '第 ' + (chapter.index + 1) + ' 节'),
        ))),
      )
    }

    function openQuoteNote(id) {
      store.set({ view: 'kb', kbDetail: null, tocOpen: false, settingsOpen: false, selection: null })
      loadNotes()
      openNote(id)
    }

    function SelectionToolbar(props) {
      const selection = props.selection
      const style = {
        left: Math.max(90, selection.x) + 'px',
        top: Math.max(12, selection.y - 46) + 'px',
      }
      return h('div', { className: 'rcc-toolbar', style },
        h('button', { className: 'rcc-tool', title: '直接把这段原文收进知识库', onClick: () => saveQuote(selection, '') }, '收藏'),
        h('button', { className: 'rcc-tool', title: '写一句自己的想法，再一起保存', onClick: () => store.set({ quoteDraft: { selection } }) }, '写想法'),
        h('button', { className: 'rcc-tool', onClick: () => injectPrompt('explain', selection.text) }, '解释'),
        h('button', { className: 'rcc-tool', onClick: () => injectPrompt('ask', selection.text) }, '问 AI'),
      )
    }

    function QuoteDialog(props) {
      const draft = props.draft
      const selection = draft && draft.selection
      const [reflection, setReflection] = useState('')
      const [busy, setBusy] = useState(false)
      if (!selection) return null
      const submit = async () => {
        if (busy) return
        setBusy(true)
        await saveQuote(selection, reflection)
        setBusy(false)
      }
      return h('div', { className: 'rcc-dialog-mask', onClick: () => store.set({ quoteDraft: null }) },
        h('div', { className: 'rcc-dialog', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'rcc-dialog-head' }, '收藏这段原文'),
          h('div', { className: 'rcc-dialog-quote' }, selection.text),
          h('textarea', {
            className: 'rcc-dialog-input',
            rows: 4,
            autoFocus: true,
            placeholder: '想写就写一句你的想法；不写也可以，直接保存原文。',
            value: reflection,
            onChange: (event) => setReflection(event.target.value),
            onKeyDown: (event) => {
              if (event.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit() }
            },
          }),
          h('div', { className: 'rcc-dialog-actions' },
            h('span', { className: 'rcc-muted' }, 'Ctrl/⌘ + Enter 保存'),
            h('div', { className: 'rcc-grow' }),
            h('button', { className: 'rcc-ghost', onClick: () => store.set({ quoteDraft: null }) }, '取消'),
            h('button', { className: 'rcc-btn', disabled: busy, onClick: submit }, busy ? '保存中…' : '保存'),
          ),
        ),
      )
    }

    function blockElementOf(node) {
      let element = node && node.nodeType === 3 ? node.parentNode : node
      while (element && typeof element.getAttribute === 'function') {
        if (element.getAttribute('data-block') !== null) return element
        element = element.parentNode
      }
      return null
    }

    function textOffsetIn(blockElement, node, offset) {
      try {
        const range = document.createRange()
        range.setStart(blockElement, 0)
        range.setEnd(node, offset)
        return String(range.toString() || '').length
      } catch (error) { return 0 }
    }

    function blockSpans(blockIndex, textLength, quotes) {
      const spans = []
      for (const quote of quotes || []) {
        const fromBlock = Math.max(0, Number(quote.startBlock) || 0)
        const toBlock = Math.max(fromBlock, Number(quote.endBlock) || fromBlock)
        if (blockIndex < fromBlock || blockIndex > toBlock) continue
        const from = blockIndex === fromBlock ? Math.max(0, Number(quote.startOffset) || 0) : 0
        const to = blockIndex === toBlock ? Math.min(textLength, Number(quote.endOffset) || textLength) : textLength
        if (to > from) spans.push({ from, to, id: quote.id })
      }
      spans.sort((a, b) => a.from - b.from)
      const merged = []
      for (const span of spans) {
        const last = merged[merged.length - 1]
        if (last && span.from <= last.to) {
          last.to = Math.max(last.to, span.to)
          if (!last.ids.includes(span.id)) last.ids.push(span.id)
        } else {
          merged.push({ from: span.from, to: span.to, ids: [span.id] })
        }
      }
      return merged
    }

    function renderMarkedText(text, blockIndex, quotes) {
      const source = String(text || '')
      const spans = blockSpans(blockIndex, source.length, quotes)
      if (spans.length === 0) return source
      const parts = []
      let cursor = 0
      spans.forEach((span, index) => {
        if (span.from > cursor) parts.push(source.slice(cursor, span.from))
        parts.push(h('mark', {
          key: 'mark-' + blockIndex + '-' + index,
          className: 'rcc-mark',
          title: '查看这条卡片',
          'data-note': span.ids[0],
          onClick: (event) => { event.stopPropagation(); openQuoteNote(span.ids[0]) },
        }, source.slice(span.from, span.to)))
        cursor = span.to
      })
      if (cursor < source.length) parts.push(source.slice(cursor))
      return parts
    }

    function ReaderColumn(props) {
      const state = props.state
      const scrollRef = useRef(null)
      const restoredToken = useRef(0)

      const handleScroll = useCallback(() => {
        const element = scrollRef.current
        if (!element) return
        bumpActivity()
        const max = Math.max(1, element.scrollHeight - element.clientHeight)
        const ratio = Math.max(0, Math.min(1, element.scrollTop / max))
        position.ratio = ratio
        position.blockIndex = Math.round(ratio * Math.max(0, (store.state.chapter && store.state.chapter.blocks ? store.state.chapter.blocks.length : 1) - 1))
        scheduleProgressSave()
      }, [])

      const handleMouseUp = useCallback(() => {
        const stateNow = store.state
        if (!stateNow.chapter) return
        bumpActivity()
        const selection = window.getSelection ? window.getSelection() : null
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          if (stateNow.selection !== null) store.set({ selection: null })
          return
        }
        const range = selection.getRangeAt(0)
        const container = scrollRef.current
        if (!container || !container.contains(range.startContainer) || !container.contains(range.endContainer)) {
          if (stateNow.selection !== null) store.set({ selection: null })
          return
        }
        const text = String(selection.toString() || '').replace(/\s+/g, ' ').trim().slice(0, 4000)
        if (text.length < 2) {
          if (stateNow.selection !== null) store.set({ selection: null })
          return
        }
        const startElement = blockElementOf(range.startContainer)
        const endElement = blockElementOf(range.endContainer)
        const startBlock = startElement ? Number(startElement.getAttribute('data-block')) : -1
        const endBlock = endElement ? Number(endElement.getAttribute('data-block')) : startBlock
        const startOffset = startElement ? textOffsetIn(startElement, range.startContainer, range.startOffset) : 0
        const endOffset = endElement ? textOffsetIn(endElement, range.endContainer, range.endOffset) : text.length
        let rect = null
        try { rect = range.getBoundingClientRect() } catch (error) { rect = null }
        const x = rect ? rect.left + rect.width / 2 : 120
        const y = rect ? rect.top : 120
        store.set({
          selection: {
            text,
            x,
            y,
            startBlock: Math.max(0, startBlock),
            startOffset,
            endBlock: Math.max(Math.max(0, startBlock), endBlock),
            endOffset,
          },
        })
        report('selection', { length: text.length, preview: text.slice(0, 40) })
        reportContext({ selection: text })
      }, [])

      useEffect(() => {
        const restore = state.pendingRestore
        if (!restore || !restore.token || restoredToken.current === restore.token) return
        restoredToken.current = restore.token
        const element = scrollRef.current
        if (!element) return
        requestAnimationFrame(() => {
          const ratio = Math.max(0, Math.min(1, Number(restore.ratio) || 0))
          const max = Math.max(0, element.scrollHeight - element.clientHeight)
          element.scrollTop = ratio * max
          position.ratio = ratio
          position.blockIndex = Number(restore.blockIndex) || Math.round(ratio * Math.max(0, ((store.state.chapter && store.state.chapter.blocks) || []).length - 1))
        })
      }, [state.chapter, state.pendingRestore])

      useEffect(() => () => {
        scheduleProgressSave()
      }, [])

      // Quiet reading-time accounting: only when the reader is visible and the
      // reader has interacted within the last few minutes. No UI, no prompts.
      useEffect(() => {
        const timer = setInterval(() => {
          const stateNow = store.state
          if (stateNow.view !== 'read' || !stateNow.book) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          if (Date.now() - lastActivityAt > 3 * 60 * 1000) return
          pendingSeconds += 30
          if (pendingSeconds >= 60) flushReading()
        }, 30000)
        return () => { clearInterval(timer); flushReading() }
      }, [])

      if (!state.book || !state.chapter) {
        return h('div', { className: 'rcc-empty' }, '还没有打开书。去书架选一本，开始阅读。')
      }

      const book = state.book
      const chapter = state.chapter
      const settings = state.settings
      const theme = settings.theme || 'auto'
      const family = resolveFontStack(settings.family)

      return h('div', {
        className: 'rcc-reader',
        'data-theme': theme,
        style: { fontSize: String(settings.fontSize || 18) + 'px', lineHeight: String(settings.lineHeight || 1.9) },
        onClick: () => { if (store.state.settingsOpen) store.set({ settingsOpen: false }) },
      },
      h('div', { className: 'rcc-reader-head' },
        h('button', { className: 'rcc-ghost', onClick: () => store.set({ view: 'shelf', tocOpen: false, selection: null }) }, '书架'),
        h('div', { className: 'rcc-reader-title' }, bookLabel(book.title)),
        h('span', { className: 'rcc-muted' }, book.author || ''),
        h('div', { className: 'rcc-grow' }),
        h('button', { className: 'rcc-ghost', title: '阅读设置', onClick: (event) => { event.stopPropagation(); store.set({ settingsOpen: !state.settingsOpen }) } }, 'Aa'),
        h('button', { className: 'rcc-ghost', onClick: () => store.set({ tocOpen: !state.tocOpen }) }, '目录'),
      ),
      h('div', {
        className: 'rcc-scroll',
        ref: scrollRef,
        onScroll: handleScroll,
        onMouseUp: handleMouseUp,
        onClick: () => { if (store.state.tocOpen) store.set({ tocOpen: false }) },
      },
        h('div', { className: 'rcc-page', style: { fontFamily: family, maxWidth: '700px' } },
          h('div', { className: 'rcc-chapter-head' },
            h('div', { className: 'rcc-chapter-title' }, chapter.title || '第 ' + (chapter.index + 1) + ' 节'),
            h('div', { className: 'rcc-chapter-meta' }, '第 ' + (chapter.index + 1) + ' / ' + ((book.chapters && book.chapters.length) || '?') + ' 章'),
          ),
          chapter.blocks.length === 0
            ? h('div', { className: 'rcc-empty' }, '这一节没有可显示的正文。')
            : chapter.blocks.map((block, index) => {
              const isHeading = /^h[1-6]$/.test(String(block.type))
              const Tag = isHeading ? block.type : 'p'
              return h(Tag, {
                key: index,
                className: isHeading ? 'rcc-h' : 'rcc-p' + (index === 0 ? ' rcc-p-first' : ''),
                'data-block': index,
              }, renderMarkedText(block.text, index, state.quoteRanges))
            }),
          h('div', { className: 'rcc-chapter-end' },
            h('span', null, '本章完'),
            h('button', { className: 'rcc-ghost rcc-mini', onClick: () => injectPrompt('idea') }, '记一句想法'),
            h('button', { className: 'rcc-ghost rcc-mini', onClick: () => injectPrompt('chapter') }, '回顾这一章'),
            book.chapters && chapter.index < book.chapters.length - 1
              ? h('button', { className: 'rcc-ghost rcc-mini', onClick: () => { gotoChapter(chapter.index + 1) } }, '下一章')
              : null,
          ),
        ),
      ),
      state.tocOpen ? h(TocPanel, { state }) : null,
      state.selection ? h(SelectionToolbar, { selection: state.selection }) : null,
      state.quoteDraft ? h(QuoteDialog, { draft: state.quoteDraft }) : null,
      h('div', { className: 'rcc-reader-foot' },
        h('button', { className: 'rcc-ghost', disabled: chapter.index <= 0, onClick: () => { gotoChapter(chapter.index - 1) } }, '上一章'),
        h('span', { className: 'rcc-muted' }, '第 ' + (chapter.index + 1) + ' 章'),
        h('span', { className: 'rcc-reader-foot-progress' }, Math.round(position.ratio * 100) + '%'),
        Math.round((Number(state.todaySeconds) || 0) / 60) > 0
          ? h('span', { className: 'rcc-muted' }, '今日 ' + Math.round((Number(state.todaySeconds) || 0) / 60) + ' 分钟')
          : null,
        h('button', { className: 'rcc-ghost', title: '记一句想法', onClick: () => injectPrompt('idea') }, '记一句'),
        h('div', { className: 'rcc-grow' }),
        h('button', { className: 'rcc-ghost', disabled: !book.chapters || chapter.index >= book.chapters.length - 1, onClick: () => { gotoChapter(chapter.index + 1) } }, '下一章'),
      ),
      )
    }

    // ------------------------------------------------------------------
    // knowledge base
    // ------------------------------------------------------------------
    function KnowledgeView(props) {
      const state = props.state
      const [query, setQuery] = useState('')
      useEffect(() => {
        if (state.kbNotes.length === 0 && !state.kbLoading) loadNotes()
      }, [])
      const detail = state.kbDetail
      if (detail) {
        const body = String(detail.body || '').replace(/^---[\s\S]*?---\r?\n?/, '').trim()
        const related = Array.isArray(detail.related) ? detail.related : []
        const backlinks = Array.isArray(detail.backlinks) ? detail.backlinks : []
        return h('div', { className: 'rcc-kb' },
          h('div', { className: 'rcc-kb-head' },
            h('button', { className: 'rcc-ghost', onClick: () => store.set({ kbDetail: null }) }, '返回列表'),
            h('span', { className: 'rcc-muted' }, (TYPE_LABELS[detail.type] || detail.type || '') + (detail.book ? ' · ' + bookLabel(detail.book) : '')),
          ),
          h('div', { className: 'rcc-kb-detail' },
            h('div', { className: 'rcc-kb-detail-head' }, h('strong', null, detail.title || '未命名')),
            h('pre', { className: 'rcc-kb-detail-body' }, body),
            related.length > 0 || backlinks.length > 0
              ? h('div', { className: 'rcc-kb-related' },
                ...related.map((entry) => h('button', { key: 'r-' + entry.id, className: 'rcc-chip', onClick: () => openNote(entry.id) }, '→ ' + (entry.title || entry.id))),
                ...backlinks.map((entry) => h('button', { key: 'b-' + entry.id, className: 'rcc-chip', onClick: () => openNote(entry.id) }, '← ' + (entry.title || entry.id))),
              )
              : null,
          ),
        )
      }
      return h('div', { className: 'rcc-kb' },
        h('div', { className: 'rcc-kb-head' },
          h('input', {
            className: 'rcc-input',
            placeholder: '搜索我的知识库（自然语言即可）',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (!event.isComposing && event.keyCode !== 229 && event.key === 'Enter') searchNotes(query) },
          }),
          h('button', { className: 'rcc-btn', onClick: () => searchNotes(query) }, '搜索'),
          h('span', { className: 'rcc-muted' }, state.kbLoading ? '检索中…' : String(state.kbNotes.length) + ' 条'),
        ),
        h('div', { className: 'rcc-kb-list' },
          state.kbNotes.length === 0
            ? h('div', { className: 'rcc-empty' }, '阅读中表达的想法和问题会自动收进这里，你不需要手动整理。')
            : state.kbNotes.map((note) => h('button', {
              key: note.id,
              className: 'rcc-card',
              onClick: () => { openNote(note.id) },
            },
            h('div', { className: 'rcc-card-title' }, note.title || '未命名'),
            h('div', { className: 'rcc-card-meta' },
              (TYPE_LABELS[note.type] || note.type || '') +
              (note.book ? ' · ' + bookLabel(note.book) : '') +
              (note.chapter ? ' · ' + note.chapter : '') +
              (note.tags && note.tags.length > 0 ? ' · #' + note.tags.join(' #') : ''),
            ),
            )),
        ),
      )
    }

    // ------------------------------------------------------------------
    // embedded AI conversation (same shape as the subagent sidebar chat)
    // ------------------------------------------------------------------
    function FixedChatConversationView(props) {
      return props.renderSlot('conversation.session', { view: 'chat' })
    }

    function EmbeddedConversation(props) {
      const sessionId = props.sessionId
      const useSession = props.useSession
      const useConversation = props.useConversation
      const useSessions = props.useSessions
      const renderFactorySlot = props.renderFactorySlot
      const session = useSession((value) => value)
      const conversation = useConversation((value) => value)
      const summaryBlank = useSessions((value) => (sessionId === undefined ? undefined : value.byId[sessionId] && value.byId[sessionId].blank))

      let shellPhase = 'blank'
      if (conversation && conversation.activeTargets && conversation.activeTargets.size > 0) shellPhase = 'active'
      else if (!session.blank && !session.awaitingFirstTurn) shellPhase = 'active'
      else if (session.running) shellPhase = 'active'
      else if (session.promptAttempted) shellPhase = 'engaging'
      const parentAvailabilityPending = session.subagent && session.subagent.address && session.subagent.address.mode === 'continuable' && session.subagent.parentAvailable === undefined
      const settling = (shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true) || parentAvailabilityPending
      const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
      const phase = settling ? 'settling' : hero ? 'hero' : 'active'

      if (typeof renderFactorySlot !== 'function') {
        report('chat-factory-missing', {})
        return h('div', { className: 'rcc-chat-fallback' },
          h('div', null, '阅读对话暂时没有挂载。'),
          h('div', null, '你可以点右上角「返回对话」继续和 AI 讨论。'),
        )
      }
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, { slots: { views: FixedChatConversationView } })
    }

    class ChatBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { error: '' }
      }
      static getDerivedStateFromError(error) {
        return { error: errText(error) }
      }
      componentDidCatch(error) {
        report('chat-crashed', { message: errText(error) })
      }
      render() {
        if (this.state.error) {
          return h('div', { className: 'rcc-chat-fallback' },
            h('div', null, '阅读对话暂时无法显示：' + this.state.error),
            h('div', null, '左侧阅读不受影响；必要时可以点「返回对话」。'),
          )
        }
        return this.props.children
      }
    }

    function ChatColumn(props) {
      const state = useStore()
      useEffect(() => {
        bridge.inputActions = props.inputActions
        report('input-actions', { available: Boolean(props.inputActions) })
      }, [props.inputActions])
      const scope = state.settings.chatScope || 'book'
      const ready = typeof props.useSession === 'function' && typeof props.useConversation === 'function' && typeof props.useSessions === 'function'
      return h('div', { className: 'rcc-chat' },
        h('div', { className: 'rcc-chat-head' },
          h('div', { className: 'rcc-chat-title' }, 'AI 阅读对话'),
          h('div', { className: 'rcc-chat-scope' },
            h('button', { className: 'rcc-chip' + (scope === 'book' ? ' rcc-chip-on' : ''), onClick: () => saveSettings({ chatScope: 'book' }) }, '本书'),
            h('button', { className: 'rcc-chip' + (scope === 'kb' ? ' rcc-chip-on' : ''), onClick: () => saveSettings({ chatScope: 'kb' }) }, '知识库'),
          ),
        ),
        h('div', { className: 'rcc-chat-quick' },
          h('button', { className: 'rcc-chip', onClick: () => injectPrompt('chapter') }, '回顾这一章'),
          h('button', { className: 'rcc-chip', onClick: () => injectPrompt('organize') }, '理理我的想法'),
          h('button', { className: 'rcc-chip', onClick: () => injectPrompt('materials') }, '心得素材'),
        ),
        h('div', { className: 'rcc-chat-body' },
          ready
            ? h(ChatBoundary, null, h(EmbeddedConversation, props))
            : h('div', { className: 'rcc-chat-fallback' },
              h('div', null, '阅读对话正在等待当前会话。'),
              h('div', null, '如果一直这样，可以点右上角「返回对话」后重新进入随读。'),
            ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // review & reflection
    // ------------------------------------------------------------------
    function ReviewView(props) {
      const state = props.state
      const reviewBook = state.reviewBook || state.book
      const notes = state.reviewNotes || []
      const reports = state.reports || []
      const [reportId, setReportId] = useState(null)
      const [title, setTitle] = useState('')
      const [content, setContent] = useState('')
      const [saving, setSaving] = useState(false)
      const bookTitle = reviewBook ? String(reviewBook.title || '') : ''
      const defaultTitle = () => (bookTitle ? '《' + bookLabel(bookTitle) + '》读书心得' : '读书心得')

      const grouped = useMemo(() => {
        const groups = []
        const index = new Map()
        notes.forEach((note) => {
          const key = String(note.chapter || '未标注章节')
          if (!index.has(key)) {
            index.set(key, { chapter: key, notes: [] })
            groups.push(index.get(key))
          }
          index.get(key).notes.push(note)
        })
        return groups
      }, [notes])

      const openQuestions = useMemo(() => notes.filter((note) => note.status === 'open' || String(note.type) === '问题'), [notes])

      useEffect(() => {
        if (reportId !== null) return
        setTitle(defaultTitle())
      }, [bookTitle])

      const startNew = () => {
        setReportId(null)
        setTitle(defaultTitle())
        setContent('')
      }

      const openReport = (id) => {
        rpc('report/get', { id })
          .then((result) => {
            const report = result.report || {}
            setReportId(report.id || id)
            setTitle(report.title || defaultTitle())
            setContent(report.content || '')
          })
          .catch((error) => toast('读取心得失败：' + errText(error)))
      }

      const save = () => {
        if (String(content || '').trim().length === 0) {
          toast('先写一点你的心得再保存。')
          return
        }
        setSaving(true)
        const payload = {
          title: String(title || '').trim() || defaultTitle(),
          content,
          book: bookTitle,
          bookId: reviewBook ? reviewBook.id : '',
        }
        if (reportId) payload.id = reportId
        rpc('report/save', payload)
          .then((result) => {
            setReportId(result.id || reportId)
            report('report-saved', { id: result.id, words: result.words })
            toast('已保存')
            return refreshReports(reviewBook)
          })
          .catch((error) => toast('保存失败：' + errText(error)))
          .then(() => setSaving(false))
      }

      const requestMaterials = () => {
        const lines = ['【阅读上下文】']
        lines.push('书名：' + bookLabel(bookTitle) + (reviewBook && reviewBook.author ? ' · 作者：' + reviewBook.author : ''))
        lines.push('场景：我正在为这本书写读书心得。')
        lines.push('')
        lines.push('我想写一篇这本书的读书心得。请先用 kb_materials 取出我在这本书里的笔记、原文引用和待探索问题作为素材，帮我梳理出几个可能的主题线索；心得正文我自己写，不要代写。')
        const actions = bridge.inputActions
        if (!actions || typeof actions.setDraft !== 'function') {
          toast('对话输入框还没准备好，请稍后再试')
          return
        }
        try {
          actions.setDraft(lines.join('\n'))
        } catch (error) {
          report('inject-error', { message: errText(error) })
        }
      }

      if (!reviewBook) {
        return h('div', { className: 'rcc-review' }, h('div', { className: 'rcc-empty' }, '先打开一本书，再来回顾。'))
      }

      return h('div', { className: 'rcc-review' },
        h('div', { className: 'rcc-review-head' },
          h('span', { className: 'rcc-review-title' }, bookLabel(bookTitle)),
          h('span', { className: 'rcc-muted' }, notes.length + ' 条笔记 · ' + reports.length + ' 篇心得'),
          h('div', { className: 'rcc-grow' }),
          h('button', { className: 'rcc-ghost', onClick: () => store.set({ view: 'shelf' }) }, '回到书架'),
        ),
        h('div', { className: 'rcc-review-body' },
          h('div', { className: 'rcc-review-col' },
            h('div', { className: 'rcc-review-section' },
              h('div', { className: 'rcc-review-section-title' }, '我在书里留下的'),
              state.reviewLoading ? h('div', { className: 'rcc-muted' }, '正在整理…') : null,
              notes.length === 0 ? h('div', { className: 'rcc-muted' }, '还没有笔记。读到有想法的地方，选中原文点「记下想法」就好。') : null,
              grouped.map((group) => h('div', { key: group.chapter },
                h('div', { className: 'rcc-review-chapter' }, group.chapter),
                group.notes.map((note) => h('button', {
                  key: note.id,
                  className: 'rcc-review-note',
                  onClick: () => { store.set({ view: 'kb' }); openNote(note.id) },
                },
                h('span', { className: 'rcc-review-note-type' }, '【' + (TYPE_LABELS[note.type] || note.type || '笔记') + '】'),
                note.title || note.core || note.id,
                )),
              )),
            ),
            openQuestions.length > 0 ? h('div', { className: 'rcc-review-section' },
              h('div', { className: 'rcc-review-section-title' }, '待探索的问题'),
              openQuestions.map((note) => h('button', {
                key: note.id,
                className: 'rcc-review-note',
                onClick: () => { store.set({ view: 'kb' }); openNote(note.id) },
              }, '· ' + (note.title || note.core || note.id))),
            ) : null,
            h('div', { className: 'rcc-review-section' },
              h('div', { className: 'rcc-review-section-title' }, '读书心得'),
              h('button', { className: 'rcc-ghost rcc-mini', onClick: startNew }, '＋ 新建一篇'),
              reports.length === 0 ? h('div', { className: 'rcc-muted', style: { marginTop: '6px' } }, '还没有心得。读完之后想写时再写，不必每章都写。') : null,
              reports.map((item) => h('button', {
                key: item.id,
                className: 'rcc-report-item' + (item.id === reportId ? ' rcc-report-on' : ''),
                onClick: () => openReport(item.id),
              },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || '未命名心得'),
              h('small', null, (item.words || 0) + ' 字'),
              )),
            ),
          ),
          h('div', { className: 'rcc-review-col' },
            h('div', {
              className: 'rcc-review-section',
              style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0' },
            },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('input', {
                className: 'rcc-input',
                placeholder: '心得标题',
                value: title,
                onChange: (event) => setTitle(event.target.value),
                style: { flex: '1 1 auto' },
              }),
              h('button', { className: 'rcc-ghost rcc-mini', onClick: requestMaterials }, 'AI 准备素材'),
            ),
            h('textarea', {
              className: 'rcc-textarea',
              placeholder: '写你自己的读书心得、想法和内化后的理解。这里不会有人催你，也没有模板。',
              value: content,
              onChange: (event) => setContent(event.target.value),
            }),
            h('div', { className: 'rcc-settings-actions', style: { justifyContent: 'space-between' } },
              h('span', { className: 'rcc-muted' }, String((content || '').length) + ' 字'),
              h('button', { className: 'rcc-btn', disabled: saving, onClick: save }, saving ? '保存中…' : '保存心得'),
            ),
            ),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // workbench frame
    // ------------------------------------------------------------------
    function SettingsPanel(props) {
      const settings = props.state.settings
      return h('div', { className: 'rcc-settings' },
        h('div', { className: 'rcc-settings-row' },
          h('span', null, '字号'),
          h('button', { className: 'rcc-ghost', onClick: () => saveSettings({ fontSize: Math.max(13, (settings.fontSize || 18) - 1) }) }, 'A−'),
          h('span', { className: 'rcc-value' }, String(settings.fontSize || 18) + 'px'),
          h('button', { className: 'rcc-ghost', onClick: () => saveSettings({ fontSize: Math.min(30, (settings.fontSize || 18) + 1) }) }, 'A+'),
        ),
        h('div', { className: 'rcc-settings-row' },
          h('span', null, '行距'),
          [1.6, 1.9, 2.2].map((value) => h('button', {
            key: value,
            className: 'rcc-chip' + (Number(settings.lineHeight || 1.9) === value ? ' rcc-chip-on' : ''),
            onClick: () => saveSettings({ lineHeight: value }),
          }, String(value))),
        ),
        h('div', { className: 'rcc-settings-row' },
          h('span', null, '字体'),
          FONT_FAMILIES.map((entry) => {
            const available = fontAvailable(entry.key)
            return h('button', {
              key: entry.key,
              className: 'rcc-chip' + (resolveFontStack(settings.family) === entry.stack ? ' rcc-chip-on' : ''),
              title: available ? entry.label : entry.label + '（系统未安装，已回退到宋体）',
              onClick: () => {
                saveSettings({ family: entry.key })
                if (!available) toast(entry.label + ' 系统还没安装，已先回退到宋体')
              },
            }, entry.label)
          }),
        ),
        h('div', { className: 'rcc-settings-row' },
          h('span', null, '主题'),
          Object.keys(THEME_LABELS).map((key) => h('button', {
            key,
            className: 'rcc-chip' + ((settings.theme || 'auto') === key ? ' rcc-chip-on' : ''),
            onClick: () => saveSettings({ theme: key }),
          }, THEME_LABELS[key])),
        ),
        h('div', { className: 'rcc-settings-actions' },
          h('button', {
            className: 'rcc-ghost',
            onClick: () => {
              rpc('kb/rebuild').then((result) => toast('知识索引已重建（' + ((result && result.count) || 0) + ' 条）')).catch((error) => toast('重建失败：' + errText(error)))
            },
          }, '重建索引'),
          h('button', { className: 'rcc-btn', onClick: () => store.set({ settingsOpen: false }) }, '完成'),
        ),
      )
    }

    function ReadingPane(props) {
      const state = useStore()
      const sessionId = props.sessionId
      const bootedRef = useRef(false)
      const workspaceDir = typeof props.useSessions === 'function'
        ? props.useSessions((value) => (sessionId === undefined ? undefined : value.byId[sessionId] && value.byId[sessionId].cwd))
        : undefined

      useEffect(() => {
        bridge.sessionId = sessionId
      }, [sessionId])

      useEffect(() => {
        if (bootedRef.current) return undefined
        if (typeof workspaceDir === 'string' && workspaceDir.length > 0) {
          bootedRef.current = true
          bootstrap(workspaceDir)
          return undefined
        }
        const timer = setTimeout(() => {
          if (bootedRef.current) return
          bootedRef.current = true
          bootstrap(undefined)
        }, 700)
        return () => clearTimeout(timer)
      }, [workspaceDir])

      useEffect(() => {
        bridge.workbench = false
        bridge.startConversation = undefined
        bridge.pendingDraft = ''
        const uiWorkspace = ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get('uiWorkspace') : undefined
        bridge.uiWorkspace = uiWorkspace
        const layout = ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get('layout') : undefined
        bridge.layout = layout
        report('pane-mounted', {
          hasFactory: typeof props.renderFactorySlot === 'function',
          hasInput: Boolean(props.inputActions),
          hasPicker: Boolean(uiWorkspace && typeof uiWorkspace.pickDirectory === 'function'),
        })
      }, [])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (store.state.settingsOpen) { store.set({ settingsOpen: false }); return }
          if (store.state.tocOpen) { store.set({ tocOpen: false }); return }
          if (store.state.selection !== null) store.set({ selection: null })
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [])

      const leaveToConversation = () => {
        const layout = bridge.layout || (ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get('layout') : undefined)
        if (layout && typeof layout.selectPanel === 'function') {
          try { layout.selectPanel(null) } catch (error) { report('select-panel-error', { message: errText(error) }) }
        }
      }

      if (state.status === 'loading' && state.config === null) {
        return h('div', { className: 'rcc-root' }, h(StyleSheet), h('div', { className: 'rcc-center-loading' }, h('div', null, '正在打开随读…')))
      }
      if (state.status === 'error') {
        return h('div', { className: 'rcc-root' }, h(StyleSheet),
          h('div', { className: 'rcc-center-loading' },
            h('div', null, '随读后台暂时不可用：' + state.error),
            h('button', { className: 'rcc-btn', onClick: () => { bootedRef.current = false; bootstrap(workspaceDir) } }, '重试'),
            h('button', { className: 'rcc-ghost', onClick: leaveToConversation }, '返回对话'),
          ),
        )
      }
      const config = state.config
      if (config && config.configured !== true) {
        return h('div', { className: 'rcc-root' }, h(StyleSheet), h(SetupView, { config }))
      }

      const viewButton = (label, view) => h('button', {
        className: 'rcc-chip' + (state.view === view ? ' rcc-chip-on' : ''),
        onClick: () => {
          store.set({ view, tocOpen: false, settingsOpen: false })
          if (view === 'kb') loadNotes()
        },
      }, label)

      return h('div', { className: 'rcc-root' },
        h(StyleSheet),
        h('div', { className: 'rcc-top' },
          h('div', { className: 'rcc-brand' }, '随读'),
          h('div', { className: 'rcc-nav' },
            viewButton('书架', 'shelf'),
            state.book ? viewButton('阅读', 'read') : null,
            state.book ? h('button', {
              className: 'rcc-chip' + (state.view === 'review' ? ' rcc-chip-on' : ''),
              onClick: () => { if (state.view !== 'review') openReview(state.book) },
            }, '回顾') : null,
            viewButton('知识库', 'kb'),
          ),
          h('div', { className: 'rcc-top-right' },
            state.book ? h('span', { className: 'rcc-top-book' }, bookLabel(state.book.title)) : null,
            h('button', { className: 'rcc-ghost', onClick: () => store.set({ settingsOpen: !state.settingsOpen }) }, '阅读设置'),
            h('button', { className: 'rcc-ghost', onClick: leaveToConversation }, '返回对话'),
          ),
        ),
        h('div', { className: 'rcc-body' },
          h('div', { className: 'rcc-left' },
            state.view === 'shelf'
              ? h(ShelfView, { state })
              : state.view === 'kb'
                ? h(KnowledgeView, { state })
                : state.view === 'review'
                  ? h(ReviewView, { state })
                  : h(ReaderColumn, { state }),
            state.settingsOpen ? h(SettingsPanel, { state }) : null,
          ),
          h(ChatColumn, props),
        ),
        h(Toast, null),
        state.error && state.view !== 'shelf' ? h('div', { className: 'rcc-toast' }, state.error) : null,
      )
    }

    // ------------------------------------------------------------------
    // desktop workbench (standard split: reading panel + host chat column)
    // ------------------------------------------------------------------
    const WORKBENCH_REPOSITORY = 'https://github.com/LeriusLei/dsh-readmate'
    // The workbench service identifies a provider by `owner/repo` (lowercase) for
    // packages that are not listed in the market yet.
    const WORKBENCH_ID = WORKBENCH_REPOSITORY.replace(/^https:\/\/github\.com\//, '').toLowerCase()
    const READING_PRESET_ID = 'reading'

    function adoptReadingPreset(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      try {
        const remote = clientService('remote') || (ctxRef && ctxRef.remote)
        const presets = remote && remote.agentPresets
        if (!presets || typeof presets.select !== 'function') return
        Promise.resolve(presets.select(sessionId, READING_PRESET_ID)).catch(() => {})
      } catch (error) { /* preset adoption is best effort */ }
    }

    function useExternalSnapshot(source) {
      const read = useCallback(() => {
        try {
          return source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : undefined
        } catch (error) { return undefined }
      }, [source])
      const subscribe = useCallback((notify) => {
        try {
          return source && typeof source.subscribe === 'function' ? source.subscribe(notify) : () => {}
        } catch (error) { return () => {} }
      }, [source])
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribe, read, read)
      }
      return read()
    }

    function clientService(name) {
      try {
        if (ctxRef && typeof ctxRef.get === 'function') {
          const fromGet = ctxRef.get(name)
          if (fromGet != null) return fromGet
        }
      } catch (error) { /* fall through to the plain property */ }
      try {
        if (ctxRef && ctxRef[name] != null) return ctxRef[name]
      } catch (error) { /* service not there yet */ }
      return undefined
    }

    // The host conversation column materializes its composer actions on the
    // uiSession binding; the workbench component can read them without slots.
    function readComposerActions() {
      try {
        const uiSession = clientService('uiSession')
        const current = uiSession && uiSession.current
        const snapshot = current && typeof current.getSnapshot === 'function' ? current.getSnapshot() : undefined
        const actions = snapshot && snapshot.props ? snapshot.props.inputActions : undefined
        if (actions && typeof actions.setDraft === 'function') return actions
      } catch (error) { /* the binding may not be materialized yet */ }
      return undefined
    }

    function ReadingWorkbench(props) {
      const service = props.service
      const state = useStore()
      const sessions = clientService('sessions')
      const sessionList = useExternalSnapshot(sessions ? sessions.list : undefined)
      const uiSession = clientService('uiSession')
      useExternalSnapshot(uiSession && uiSession.current)

      let sessionId
      try {
        sessionId = service && typeof service.currentSession === 'function' ? service.currentSession() : undefined
      } catch (error) { sessionId = undefined }
      let bound = false
      try {
        const serviceState = service && service.state
        const entryId = props.entry && typeof props.entry.id === 'string' ? props.entry.id : WORKBENCH_ID
        const owner = sessionId && serviceState && serviceState.sessionBindings
          ? serviceState.sessionBindings[sessionId]
          : undefined
        bound = Boolean(sessionId && owner && (owner === entryId || owner === WORKBENCH_ID))
      } catch (error) { bound = false }
      const actions = bound ? readComposerActions() : undefined
      const cwd = bound && sessionId && sessionList && sessionList.byId && sessionList.byId[sessionId]
        ? sessionList.byId[sessionId].cwd
        : undefined
      const bootedRef = useRef(false)

      useEffect(() => {
        bridge.workbench = true
        bridge.sessionBound = bound
        bridge.sessionId = bound ? sessionId : undefined
        bridge.inputActions = actions
        report('workbench-bridge', { bound: Boolean(bound), hasActions: Boolean(actions) })
        return () => { bridge.workbench = false }
      }, [bound, sessionId, actions])

      // A prompt asked for before the conversation existed: deliver it once the
      // native composer is ready. The user still presses Enter to send.
      useEffect(() => {
        if (!actions || !bridge.pendingDraft) return
        const text = bridge.pendingDraft
        bridge.pendingDraft = ''
        try {
          actions.setDraft(text)
          toast('对话已开好，原文已放进输入框，按 Enter 发送')
        } catch (error) {
          toast('没能写入对话输入框：' + errText(error))
        }
      }, [actions])

      useEffect(() => {
        bridge.uiWorkspace = clientService('uiWorkspace')
        bridge.layout = undefined
      }, [])

      useEffect(() => {
        if (bootedRef.current) return undefined
        if (typeof cwd === 'string' && cwd.length > 0) {
          bootedRef.current = true
          bootstrap(cwd)
          return undefined
        }
        const timer = setTimeout(() => {
          if (bootedRef.current) return
          bootedRef.current = true
          bootstrap(undefined)
        }, 600)
        return () => clearTimeout(timer)
      }, [cwd])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (store.state.settingsOpen) { store.set({ settingsOpen: false }); return }
          if (store.state.tocOpen) { store.set({ tocOpen: false }); return }
          if (store.state.selection !== null) store.set({ selection: null })
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [])

      const startConversation = useCallback(() => {
        if (!service) { toast('工作台还没准备好，请稍后再试'); return }
        try {
          const workspace = typeof service.defaultWorkspace === 'function' ? service.defaultWorkspace() : undefined
          const workspaceId = workspace && (workspace.workspaceId || workspace.id)
          const pending = workspaceId ? service.newSession(workspaceId) : service.newWorkspaceSession()
          if (typeof service.run === 'function') service.run(pending)
          else if (pending && typeof pending.catch === 'function') pending.catch((error) => toast('开始对话失败：' + errText(error)))
          // A freshly created blank session can adopt the reading preset; if the
          // selection is refused the conversation simply keeps the current one.
          Promise.resolve(pending).then(() => {
            setTimeout(() => {
              try {
                adoptReadingPreset(typeof service.currentSession === 'function' ? service.currentSession() : undefined)
              } catch (error) { /* ignore */ }
            }, 400)
          }, () => {})
        } catch (error) {
          toast('开始对话失败：' + errText(error))
        }
      }, [service])

      useEffect(() => {
        bridge.startConversation = startConversation
        return () => { if (bridge.startConversation === startConversation) bridge.startConversation = undefined }
      }, [startConversation])

      if (state.status === 'loading' && state.config === null) {
        return h('div', { className: 'rcc-root rcc-workbench' }, h(StyleSheet), h('div', { className: 'rcc-center-loading' }, h('div', null, '正在打开随读…')))
      }
      if (state.status === 'error') {
        return h('div', { className: 'rcc-root rcc-workbench' }, h(StyleSheet),
          h('div', { className: 'rcc-center-loading' },
            h('div', null, '随读后台暂时不可用：' + state.error),
            h('button', { className: 'rcc-btn', onClick: () => { bootedRef.current = false; bootstrap(cwd) } }, '重试'),
          ),
        )
      }
      const config = state.config
      if (config && config.configured !== true) {
        return h('div', { className: 'rcc-root rcc-workbench' }, h(StyleSheet), h(SetupView, { config }))
      }

      const viewButton = (label, view) => h('button', {
        className: 'rcc-chip' + (state.view === view ? ' rcc-chip-on' : ''),
        onClick: () => {
          store.set({ view, tocOpen: false, settingsOpen: false })
          if (view === 'kb') loadNotes()
        },
      }, label)

      return h('div', { className: 'rcc-root rcc-workbench' },
        h(StyleSheet),
        h('div', { className: 'rcc-top' },
          h('div', { className: 'rcc-brand' }, '随读'),
          h('div', { className: 'rcc-nav' },
            viewButton('书架', 'shelf'),
            state.book ? viewButton('阅读', 'read') : null,
            state.book ? h('button', {
              className: 'rcc-chip' + (state.view === 'review' ? ' rcc-chip-on' : ''),
              onClick: () => { if (state.view !== 'review') openReview(state.book) },
            }, '回顾') : null,
            viewButton('知识库', 'kb'),
          ),
          h('div', { className: 'rcc-top-right' },
            state.book ? h('span', { className: 'rcc-top-book' }, bookLabel(state.book.title)) : null,
            h('button', { className: 'rcc-ghost', onClick: () => store.set({ settingsOpen: !state.settingsOpen }) }, '阅读设置'),
          ),
        ),
        h('div', { className: 'rcc-body' },
          h('div', { className: 'rcc-left' },
            state.view === 'shelf'
              ? h(ShelfView, { state })
              : state.view === 'kb'
                ? h(KnowledgeView, { state })
                : state.view === 'review'
                  ? h(ReviewView, { state })
                  : h(ReaderColumn, { state }),
            state.settingsOpen ? h(SettingsPanel, { state }) : null,
          ),
        ),
        bound ? null : h('div', { className: 'rcc-workbench-tip' },
          h('span', null, '右侧还没有伴读对话。可以随时阅读；选中原文时开始对话，AI 就能看到书名、章节和原文。'),
          h('button', { className: 'rcc-btn', onClick: startConversation }, '开始伴读对话'),
        ),
        h(Toast, null),
        state.error && state.view !== 'shelf' ? h('div', { className: 'rcc-toast' }, state.error) : null,
      )
    }

    function ReadingPanel(props) {
      if (typeof props.renderSlot !== 'function') {
        return h('div', { className: 'rcc-root' }, h(StyleSheet), h('div', { className: 'rcc-center-loading' }, '正在载入随读…'))
      }
      return h('div', { className: 'rcc-root' }, h(StyleSheet), props.renderSlot('reading.pane', {}))
    }

    function ReadingIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', opacity: props.active ? 1 : 0.85 },
      },
      h('path', { d: 'M4 5.6C4 4.72 4.72 4 5.6 4H9.5c1.38 0 2.5 1.12 2.5 2.5V20c0 .83-.67 1.5-1.5 1.5H6.5C5.12 21.5 4 20.38 4 19V5.6Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
      h('path', { d: 'M20 5.6C20 4.72 19.28 4 18.4 4H14.5C13.12 4 12 5.12 12 6.5V20c0 .83.67 1.5 1.5 1.5h4c1.38 0 2.5-1.12 2.5-2.5V5.6Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
      h('path', { d: 'M6.4 8.6h2.2M6.4 12h2.2M14.4 8.6h3.2M14.4 12h3.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', opacity: 0.55 }),
      )
    }

    // ------------------------------------------------------------------
    // plugin
    // ------------------------------------------------------------------
    function apply(ctx) {
      ctxRef = ctx
      try {
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_KEY,
          order: 30,
          label: () => '随读',
        }, ReadingIcon)), 'reading-companion: sidebar panel icon')
      } catch (error) {
        report('register-icon-error', { message: errText(error) })
      }
      try {
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_KEY,
          children: { 'reading.pane': { kind: 'single', scope: 'session-maybe' } },
        }, ReadingPanel)), 'reading-companion: reading main panel')
      } catch (error) {
        report('register-main-error', { message: errText(error) })
      }
      try {
        ctx.effect(() => ctx.slots.inject('reading.pane', () => ctx.slots.register({
          name: 'reading.pane',
        }, ReadingPane)), 'reading-companion: reading pane body')
      } catch (error) {
        report('register-pane-error', { message: errText(error) })
      }
      try {
        ctx.effect(() => {
          let disposer
          let timer
          let attempts = 0
          let disposed = false
          const attemptRegister = () => {
            if (disposed) return
            let workbenches
            try { workbenches = clientService('desktopWorkbenches') } catch (error) { workbenches = undefined }
            if (workbenches && typeof workbenches.register === 'function') {
              try {
                disposer = workbenches.register({
                  title: '随读·读书搭档',
                  description: '把 EPUB 放进文件夹就自动收进书架，随手取书即读；读到心里一动，AI 陪你把想法收成自己的知识库。',
                  repository: WORKBENCH_REPOSITORY,
                  panelTitle: '随读',
                  // Reading is the main task here, so the panel owns most of the
                  // width and the host's native conversation stays on the right.
                  layout: { businessSide: 'left', businessWidth: 0.6 },
                }, ReadingWorkbench)
                report('workbench-registered', {})
              } catch (error) {
                report('register-workbench-error', { message: errText(error) })
              }
              return
            }
            attempts += 1
            if (attempts > 8) { report('workbench-missing', { attempts }); return }
            timer = setTimeout(attemptRegister, 500)
          }
          attemptRegister()
          return () => {
            disposed = true
            if (timer) clearTimeout(timer)
            if (typeof disposer === 'function') {
              try { disposer() } catch (error) { /* the service may already be gone */ }
            }
          }
        }, 'reading-companion: desktop workbench')
      } catch (error) {
        report('register-workbench-error', { message: errText(error) })
      }
      report('client-ready', { version: '0.3.2' })
    }

    return { inject: ['slots', 'connection'], apply }
  },
})
