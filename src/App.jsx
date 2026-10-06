import React, { useEffect, useMemo, useRef, useState } from 'react'

const PAPER_SIZES = {
  A4: { w: 210, h: 297 },
  Letter: { w: 216, h: 279 },
  A3: { w: 297, h: 420 },
}

const A4_PAGE_WIDTH = 794
const A4_PAGE_HEIGHT = 1123
const A4_VERTICAL_MARGIN = 72
const A4_PRINTABLE_HEIGHT = A4_PAGE_HEIGHT - A4_VERTICAL_MARGIN * 2
const A4_PAGE_GAP = 24
const A4_PAGE_DEAD_ZONE = A4_VERTICAL_MARGIN * 2 + A4_PAGE_GAP

const TOP_MENU_ITEMS = [
  { id: 'editor', label: 'Editor' },
  { id: 'templates', label: 'Templates' },
  { id: 'library', label: 'Library' },
  { id: 'config', label: 'Config' },
]

export default function App() {
  const [paperType, setPaperType] = useState(() => 'A4')
  const [orientation, setOrientation] = useState(() => 'portrait')
  const [autoFit, setAutoFit] = useState(false)
  const [activeTab, setActiveTab] = useState('editor')
  const [showTopMenu, setShowTopMenu] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [isSelecting, setIsSelecting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  // Track soft keyboard size and visual viewport so toolbar docks directly to keyboard
  const [viewportStyle, setViewportStyle] = useState(() => ({
    height: typeof window !== 'undefined' ? `${window.innerHeight}px` : '100%',
    top: '0px',
  }))
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false)

  const editorRef = useRef(null)
  const viewportRef = useRef(null)
  const topMenuRef = useRef(null)
  const menuButtonRef = useRef(null)
  const topMenuItemRefs = useRef([])
  const savedRangeRef = useRef(null)
  const pageLayoutFrameRef = useRef(null)
  const pageLayoutSignatureRef = useRef(null)
  const pinchRef = useRef({ pinching: false, initialDistance: 0, initialZoom: 1 })
  const fileInputRef = useRef(null)
  const imagePinchRef = useRef({ active: false, img: null, initialDistance: 0, initialWidth: 0 })
  const imageDragRef = useRef({ dragging: false, img: null, startX: 0, startY: 0, originX: 0, originY: 0 })

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

  function getPageContentStart(pageIndex) {
    return A4_VERTICAL_MARGIN + pageIndex * (A4_PRINTABLE_HEIGHT + A4_PAGE_DEAD_ZONE)
  }

  function getPageContentEnd(pageIndex) {
    return getPageContentStart(pageIndex) + A4_PRINTABLE_HEIGHT
  }

  // Strict page count determination:
  // Documents that fit on one page should stay strictly on 1 page!
  // A second page is only created when content actually overflows past the bottom margin of Page 1.
  function updatePageCount(element = editorRef.current, minimumPageCount = 1) {
    if (!element) return

    const contentBlocks = Array.from(element.children).filter(
      (child) => !child.hasAttribute('data-virtual-page-break')
    )

    if (contentBlocks.length === 0) {
      setPageCount(1)
      return
    }

    let maxContentBottom = 0
    for (const block of contentBlocks) {
      const bottom = block.offsetTop + block.offsetHeight
      if (bottom > maxContentBottom) {
        maxContentBottom = bottom
      }
    }

    // Page 1 printable area ends at getPageContentEnd(0) (1051px).
    // Allow a small 4px subpixel/line-height buffer so minor rendering differences do not cause false overflows.
    const page1End = getPageContentEnd(0)
    if (maxContentBottom <= page1End + 4 && minimumPageCount <= 1) {
      setPageCount((curr) => (curr === 1 ? curr : 1))
      return
    }

    // If content extends beyond Page 1, calculate the required number of pages
    let requiredPages = 1
    while (maxContentBottom > getPageContentEnd(requiredPages - 1) + 4) {
      requiredPages++
    }

    const nextPageCount = Math.max(minimumPageCount, requiredPages)
    setPageCount((currentPageCount) => (currentPageCount === nextPageCount ? currentPageCount : nextPageCount))
  }

  function getPageLayoutSignature(element) {
    return Array.from(element.children)
      .filter((child) => !child.hasAttribute('data-virtual-page-break'))
      .map((child) => `${child.tagName}:${child.offsetHeight}:${child.textContent?.length || 0}`)
      .join('|')
  }

  function insertVirtualPageBreak(block, nextPageIndex) {
    const spacer = document.createElement('div')
    spacer.setAttribute('data-virtual-page-break', 'true')
    spacer.setAttribute('data-page-dead-zone', `${A4_PAGE_DEAD_ZONE}`)
    spacer.setAttribute('contenteditable', 'false')
    spacer.setAttribute('aria-hidden', 'true')
    spacer.style.height = `${Math.max(0, getPageContentStart(nextPageIndex) - block.offsetTop)}px`
    spacer.style.pointerEvents = 'none'
    block.before(spacer)
  }

  function paginateDocument(element = editorRef.current) {
    if (!element) return

    Array.from(element.querySelectorAll(':scope > [data-virtual-page-break]')).forEach((spacer) => spacer.remove())

    let pageIndex = 0
    const blocks = Array.from(element.children)

    blocks.forEach((block) => {
      const blockHeight = block.offsetHeight
      if (blockHeight === 0 || blockHeight > A4_PRINTABLE_HEIGHT) return

      while (block.offsetTop >= getPageContentEnd(pageIndex)) {
        const nextPageIndex = pageIndex + 1
        if (block.offsetTop < getPageContentStart(nextPageIndex)) {
          insertVirtualPageBreak(block, nextPageIndex)
        }
        pageIndex = nextPageIndex
      }

      if (block.offsetTop + blockHeight > getPageContentEnd(pageIndex) + 4) {
        const nextPageIndex = pageIndex + 1
        insertVirtualPageBreak(block, nextPageIndex)
        pageIndex = nextPageIndex
      }
    })

    updatePageCount(element, pageIndex + 1)
  }

  function scheduleDocumentPagination(element = editorRef.current) {
    if (!element) return
    if (pageLayoutFrameRef.current) cancelAnimationFrame(pageLayoutFrameRef.current)

    pageLayoutFrameRef.current = requestAnimationFrame(() => {
      const signature = getPageLayoutSignature(element)
      if (signature !== pageLayoutSignatureRef.current) {
        paginateDocument(element)
        pageLayoutSignatureRef.current = getPageLayoutSignature(element)
      } else {
        updatePageCount(element)
      }
      pageLayoutFrameRef.current = null
    })
  }

  function handleContentInput(e) {
    saveSelection()
    checkActiveFormats()
    scheduleDocumentPagination(e.currentTarget)
  }

  // Toolbar controls take focus on mobile. Keep the editor's range so a format
  // action still applies to the text the user selected before touching the dock.
  function saveSelection() {
    try {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return

      const range = selection.getRangeAt(0)
      if (!editorRef.current?.contains(range.commonAncestorContainer)) return
      savedRangeRef.current = range.cloneRange()
    } catch (e) {
      // A browser can discard the range while a touch interaction is ending.
    }
  }

  function restoreSelection() {
    try {
      const range = savedRangeRef.current
      if (!range || !editorRef.current?.contains(range.commonAncestorContainer)) return false

      const selection = window.getSelection()
      if (!selection) return false
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    } catch (e) {
      return false
    }
  }

  function executeFormat(command, value = null) {
    try {
      saveSelection()
      editorRef.current?.focus()
      restoreSelection()
      const didApply = document.execCommand(command, false, value)
      saveSelection()
      return didApply
    } catch (e) {
      console.warn('format failed', e)
      return false
    }
  }

  function zoomIn() {
    setZoom((z) => clamp(Math.round((z + 0.1) * 100) / 100, 0.5, 2.0))
  }
  function zoomOut() {
    setZoom((z) => clamp(Math.round((z - 0.1) * 100) / 100, 0.5, 2.0))
  }

  function getDistance(touches) {
    const [a, b] = touches
    const dx = a.clientX - b.clientX
    const dy = a.clientY - b.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  function isInEditorOrToolbar(target) {
    try {
      if (!target) return false
      const el = target.nodeType === 3 ? target.parentElement : target
      if (!el || !el.closest) return false
      return Boolean(el.closest('[contenteditable="true"]') || el.closest('.toolbar'))
    } catch (e) {
      return false
    }
  }

  function handleTouchStart(e) {
    try {
      const t = e.target.nodeType === 3 ? e.target.parentElement : e.target
      const img = t && t.closest ? t.closest('img') : null
      if (img && e.touches && e.touches.length === 2 && editorRef.current && editorRef.current.contains(img)) {
        imagePinchRef.current.active = true
        imagePinchRef.current.img = img
        imagePinchRef.current.initialDistance = getDistance(e.touches)
        const rect = img.getBoundingClientRect()
        imagePinchRef.current.initialWidth = rect.width
        e.preventDefault()
        return
      }
    } catch (err) {}

    if (isInEditorOrToolbar(e.target)) return

    if (e.touches && e.touches.length === 2) {
      pinchRef.current.pinching = true
      pinchRef.current.initialDistance = getDistance(e.touches)
      pinchRef.current.initialZoom = zoom
      setIsSelecting(false)
      return
    }
    if (e.touches && e.touches.length === 1) {
      setIsSelecting(true)
    }
  }

  function handleTouchMove(e) {
    try {
      if (imagePinchRef.current.active && e.touches && e.touches.length === 2) {
        const distance = getDistance(e.touches)
        const ratio = distance / imagePinchRef.current.initialDistance
        const newWidth = Math.max(24, Math.min(imagePinchRef.current.initialWidth * ratio, (editorRef.current?.getBoundingClientRect().width || 1000)))
        if (imagePinchRef.current.img) {
          imagePinchRef.current.img.style.width = `${newWidth}px`
          imagePinchRef.current.img.style.height = 'auto'
        }
        e.preventDefault()
        return
      }
    } catch (err) {}

    if (pinchRef.current.pinching && e.touches && e.touches.length === 2) {
      if (!isInEditorOrToolbar(e.target)) {
        e.preventDefault()
      }
      const distance = getDistance(e.touches)
      const ratio = distance / pinchRef.current.initialDistance
      const next = clamp(pinchRef.current.initialZoom * ratio, 0.5, 2.0)
      setZoom(next)
    }
  }

  function handleTouchEnd(e) {
    try {
      if (imagePinchRef.current.active && (!e.touches || e.touches.length < 2)) {
        imagePinchRef.current.active = false
        imagePinchRef.current.img = null
      }
    } catch (err) {}

    if (!e.touches || e.touches.length < 2) {
      pinchRef.current.pinching = false
    }
    if (!e.touches || e.touches.length === 0) {
      setTimeout(() => setIsSelecting(false), 50)
    }
  }

  // Visual viewport tracking: locks outer viewport and docks toolbar directly to keyboard top edge
  useEffect(() => {
    const handleViewportUpdate = () => {
      if (window.visualViewport) {
        const vv = window.visualViewport
        const isKeyboard = window.innerHeight - vv.height > 100
        setIsKeyboardOpen(isKeyboard)
        setViewportStyle({
          height: `${vv.height}px`,
          top: `${vv.offsetTop}px`,
        })
      } else {
        setViewportStyle({
          height: `${window.innerHeight}px`,
          top: '0px',
        })
      }
    }

    handleViewportUpdate()
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportUpdate)
      window.visualViewport.addEventListener('scroll', handleViewportUpdate)
    }
    window.addEventListener('resize', handleViewportUpdate)
    window.addEventListener('orientationchange', handleViewportUpdate)

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleViewportUpdate)
        window.visualViewport.removeEventListener('scroll', handleViewportUpdate)
      }
      window.removeEventListener('resize', handleViewportUpdate)
      window.removeEventListener('orientationchange', handleViewportUpdate)
    }
  }, [])

  // Page scale for responsive editor stage
  const [pageScale, setPageScale] = useState(1)
  useEffect(() => {
    const updateScale = () => {
      const margin = 32
      const availableWidth = window.innerWidth - margin
      const calculatedScale = Math.min(availableWidth / A4_PAGE_WIDTH, 1)
      setPageScale(calculatedScale)
    }
    updateScale()
    window.addEventListener('resize', updateScale)
    return () => window.removeEventListener('resize', updateScale)
  }, [])

  // Sync page count with content height changes
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const syncPageCount = () => scheduleDocumentPagination(editor)
    syncPageCount()

    if (!window.ResizeObserver) {
      return () => {
        if (pageLayoutFrameRef.current) cancelAnimationFrame(pageLayoutFrameRef.current)
      }
    }

    const observer = new ResizeObserver(syncPageCount)
    observer.observe(editor)
    return () => {
      observer.disconnect()
      if (pageLayoutFrameRef.current) cancelAnimationFrame(pageLayoutFrameRef.current)
    }
  }, [])

  // Focus tracking
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const onFocus = () => setIsEditing(true)
    const onBlur = () => setTimeout(() => setIsEditing(false), 120)
    el.addEventListener('focus', onFocus)
    el.addEventListener('blur', onBlur)
    return () => {
      el.removeEventListener('focus', onFocus)
      el.removeEventListener('blur', onBlur)
    }
  }, [editorRef.current])

  // Close top menu when clicking outside
  useEffect(() => {
    function onDocClick(e) {
      if (showTopMenu && topMenuRef.current && !topMenuRef.current.contains(e.target)) setShowTopMenu(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [showTopMenu])

  useEffect(() => {
    if (!showTopMenu) return
    function onKeyDown(e) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setShowTopMenu(false)
      menuButtonRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [showTopMenu])

  // Toolbar selection state
  const [toolbarActive, setToolbarActive] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [isBold, setIsBold] = useState(false)
  const [isItalic, setIsItalic] = useState(false)
  const [isUnderline, setIsUnderline] = useState(false)
  const [isOrderedList, setIsOrderedList] = useState(false)
  const [isUnorderedList, setIsUnorderedList] = useState(false)
  const [fontSize, setFontSize] = useState('16px')
  const [textAlign, setTextAlign] = useState('left')
  const [isAlignLeft, setIsAlignLeft] = useState(false)
  const [isAlignCenter, setIsAlignCenter] = useState(false)
  const [isAlignRight, setIsAlignRight] = useState(false)
  const rafRef = useRef(null)

  // Runtime error overlay
  useEffect(() => {
    const showError = (msg) => {
      try {
        let el = document.getElementById('runtime-error')
        if (!el) {
          el = document.createElement('div')
          el.id = 'runtime-error'
          Object.assign(el.style, {
            position: 'fixed',
            left: '8px',
            right: '8px',
            top: '8px',
            background: '#7f1d1d',
            color: 'white',
            padding: '12px',
            zIndex: 2147483647,
            borderRadius: '6px',
            fontSize: '13px',
            maxHeight: '40vh',
            overflow: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          })
          document.body.appendChild(el)
        }
        el.textContent = msg
      } catch (err) {}
    }

    const onErr = (e) => {
      try {
        const msg = e && (e.error && e.error.stack ? e.error.stack : e.message || String(e))
        console.error(e)
        showError('Runtime Error:\n' + msg)
      } catch (err) {}
    }

    const onRej = (e) => {
      try {
        const r = e && e.reason ? (e.reason.stack || e.reason.message || String(e.reason)) : String(e)
        console.error('UnhandledRejection', e)
        showError('Unhandled Rejection:\n' + r)
      } catch (err) {}
    }

    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)
    return () => {
      window.removeEventListener('error', onErr)
      window.removeEventListener('unhandledrejection', onRej)
      const el = document.getElementById('runtime-error')
      if (el) el.remove()
    }
  }, [])

  function checkActiveFormats() {
    try {
      setIsBold(Boolean(document.queryCommandState && document.queryCommandState('bold')))
      setIsItalic(Boolean(document.queryCommandState && document.queryCommandState('italic')))
      setIsUnderline(Boolean(document.queryCommandState && document.queryCommandState('underline')))
      setIsOrderedList(Boolean(document.queryCommandState && document.queryCommandState('insertOrderedList')))
      setIsUnorderedList(Boolean(document.queryCommandState && document.queryCommandState('insertUnorderedList')))
      try {
        setIsAlignLeft(Boolean(document.queryCommandState && document.queryCommandState('justifyLeft')))
        setIsAlignCenter(Boolean(document.queryCommandState && document.queryCommandState('justifyCenter')))
        setIsAlignRight(Boolean(document.queryCommandState && document.queryCommandState('justifyRight')))
      } catch (e) {}
      try {
        const sel = window.getSelection && window.getSelection()
        if (sel && sel.anchorNode) {
          const node = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode
          const el = node && node.closest ? node.closest('[contenteditable="true"] *') || node : node
          const size = el ? window.getComputedStyle(el).fontSize : null
          if (size) setFontSize(size)
        }
      } catch (e) {}
    } catch (e) {
      setIsBold(false)
      setIsItalic(false)
      setIsUnderline(false)
      setIsOrderedList(false)
      setIsUnorderedList(false)
      setFontSize('16px')
    }
  }

  function applyFontSizeToSelection(size) {
    try {
      saveSelection()
      editorRef.current?.focus()
      restoreSelection()
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      const selectedHtml = range.cloneContents()
      const div = document.createElement('div')
      div.appendChild(selectedHtml)
      const html = div.innerHTML
      const wrapped = `<span style="font-size:${size}">${html || '&nbsp;'}</span>`
      document.execCommand('insertHTML', false, wrapped)
      editorRef.current?.focus()
      saveSelection()
      checkActiveFormats()
    } catch (e) {
      console.warn('applyFontSize failed', e)
    }
  }

  function updateToolbarState() {
    const sel = window.getSelection && window.getSelection()
    if (!sel || sel.rangeCount === 0) {
      setToolbarActive(false)
      setIsBold(false)
      setIsItalic(false)
      setIsUnderline(false)
      setIsOrderedList(false)
      return
    }

    const anchor = sel.anchorNode
    const inEditor = editorRef.current && anchor && editorRef.current.contains(anchor)
    const hasText = sel.toString().length > 0
    const active = Boolean(inEditor && (hasText || document.activeElement === editorRef.current))

    setToolbarActive(active)
    checkActiveFormats()
    try {
      setIsOrderedList(Boolean(document.queryCommandState && document.queryCommandState('insertOrderedList')))
    } catch (e) {
      setIsOrderedList(false)
    }
  }

  useEffect(() => {
    const handler = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        saveSelection()
        updateToolbarState()
        rafRef.current = null
      })
    }

    document.addEventListener('selectionchange', handler)
    const el = editorRef.current
    let onKeyDown = null
    let onPointerDownImg = null
    let onPointerMoveImg = null
    let onPointerUpImg = null

    if (el) {
      el.addEventListener('keyup', handler)
      el.addEventListener('mouseup', handler)
      el.addEventListener('touchend', handler)
      el.addEventListener('focus', handler)
      el.addEventListener('blur', handler)

      onKeyDown = (ev) => {
        if (ev.key === 'Enter') {
          try {
            const sel = window.getSelection()
            if (!sel || !sel.rangeCount) return
            const node = sel.anchorNode
            const block = node && node.nodeType === 1 ? node.closest('p,div,li') : node.parentElement && node.parentElement.closest ? node.parentElement.closest('p,div,li') : null
            if (!block) return
            const first = block.firstElementChild
            if (first && first.tagName === 'INPUT' && first.type === 'checkbox') {
              ev.preventDefault()
              const newBlock = document.createElement('div')
              const cb = document.createElement('input')
              cb.type = 'checkbox'
              cb.style.marginRight = '0.5rem'
              newBlock.appendChild(cb)
              const text = document.createTextNode('')
              newBlock.appendChild(text)
              if (block.parentNode) {
                block.parentNode.insertBefore(newBlock, block.nextSibling)
                const r = document.createRange()
                r.setStart(text, 0)
                r.collapse(true)
                sel.removeAllRanges()
                sel.addRange(r)
              }
            }
          } catch (err) {}
        }
      }
      el.addEventListener('keydown', onKeyDown)

      onPointerDownImg = (ev) => {
        try {
          const t = ev.target.nodeType === 3 ? ev.target.parentElement : ev.target
          const img = t && t.closest ? t.closest('img') : null
          if (!img || !editorRef.current.contains(img)) return
          imageDragRef.current.dragging = true
          imageDragRef.current.img = img
          imageDragRef.current.startX = ev.clientX
          imageDragRef.current.startY = ev.clientY
          const m = img.style.transform.match(/translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)/)
          imageDragRef.current.originX = m ? parseFloat(m[1]) : 0
          imageDragRef.current.originY = m ? parseFloat(m[2]) : 0
          ev.target.setPointerCapture && ev.target.setPointerCapture(ev.pointerId)
          ev.preventDefault()
        } catch (err) {}
      }

      onPointerMoveImg = (ev) => {
        try {
          if (!imageDragRef.current.dragging || !imageDragRef.current.img) return
          const dx = ev.clientX - imageDragRef.current.startX
          const dy = ev.clientY - imageDragRef.current.startY
          const tx = (imageDragRef.current.originX || 0) + dx
          const ty = (imageDragRef.current.originY || 0) + dy
          imageDragRef.current.img.style.transform = `translate(${tx}px, ${ty}px)`
          imageDragRef.current.img.style.touchAction = 'none'
          ev.preventDefault()
        } catch (err) {}
      }

      onPointerUpImg = (ev) => {
        try {
          if (imageDragRef.current.dragging) {
            imageDragRef.current.dragging = false
            imageDragRef.current.img = null
            ev.target.releasePointerCapture && ev.target.releasePointerCapture(ev.pointerId)
            scheduleDocumentPagination()
            setTimeout(() => updateToolbarState(), 10)
          }
        } catch (err) {}
      }
      el.addEventListener('pointerdown', onPointerDownImg)
      el.addEventListener('pointermove', onPointerMoveImg)
      el.addEventListener('pointerup', onPointerUpImg)
    }

    return () => {
      document.removeEventListener('selectionchange', handler)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (el) {
        el.removeEventListener('keyup', handler)
        el.removeEventListener('mouseup', handler)
        el.removeEventListener('touchend', handler)
        el.removeEventListener('focus', handler)
        el.removeEventListener('blur', handler)
        if (onKeyDown) el.removeEventListener('keydown', onKeyDown)
        if (onPointerDownImg) el.removeEventListener('pointerdown', onPointerDownImg)
        if (onPointerMoveImg) el.removeEventListener('pointermove', onPointerMoveImg)
        if (onPointerUpImg) el.removeEventListener('pointerup', onPointerUpImg)
      }
    }
  }, [])

  useEffect(() => {
    const savedType = localStorage.getItem('madeEASY.pdf:paperType')
    const savedOrient = localStorage.getItem('madeEASY.pdf:orientation')
    if (savedType) setPaperType(savedType)
    if (savedOrient) setOrientation(savedOrient)
  }, [])

  useEffect(() => {
    localStorage.setItem('madeEASY.pdf:paperType', paperType)
    localStorage.setItem('madeEASY.pdf:orientation', orientation)
  }, [paperType, orientation])

  const dims = useMemo(() => {
    const base = PAPER_SIZES[paperType] || PAPER_SIZES.A4
    if (orientation === 'portrait') return { width: base.w, height: base.h }
    return { width: base.h, height: base.w }
  }, [paperType, orientation])

  const applyFormatCb = React.useCallback((command) => {
    executeFormat(command)
    try { checkActiveFormats() } catch (e) {}
    requestAnimationFrame(updateToolbarState)
  }, [])

  const handleInsertCheckbox = React.useCallback((e) => {
    if (e && e.preventDefault) e.preventDefault()
    try {
      saveSelection()
      editorRef.current?.focus()
      restoreSelection()
      const sel = window.getSelection()
      if (!sel) return
      const range = sel.getRangeAt(0)
      let node = range.startContainer
      while (node && node !== editorRef.current && node.nodeType !== 1) node = node.parentNode
      let block = node && node.nodeType === 1 ? node.closest('p,div,li') : null
      if (!block || !editorRef.current.contains(block)) {
        block = document.createElement('div')
        block.innerHTML = '<br>'
        editorRef.current.appendChild(block)
      }

      const first = block.firstElementChild
      if (first && first.tagName === 'INPUT' && first.type === 'checkbox') {
        // already checkbox
      } else {
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.style.marginRight = '0.5rem'
        block.insertBefore(cb, block.firstChild)
      }

      editorRef.current?.focus()
      requestAnimationFrame(updateToolbarState)
    } catch (err) {
      console.warn(err)
    }
  }, [])

  const handleInsertImage = React.useCallback((e) => {
    if (e && e.preventDefault) e.preventDefault()
    try {
      saveSelection()
      fileInputRef.current?.click()
    } catch (err) {
      console.warn('file input click failed', err)
    }
  }, [])

  const handleImageUpload = React.useCallback((e) => {
    try {
      const input = e && e.target
      const file = input && input.files && input.files[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = function(ev) {
        const dataUrl = ev.target.result
        try {
          saveSelection()
          editorRef.current?.focus()
          restoreSelection()
          const sel = window.getSelection()
          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0)
            const img = document.createElement('img')
            img.src = dataUrl
            img.alt = file.name || 'img'
            img.style.maxWidth = '100%'
            img.style.height = 'auto'
            img.style.display = 'inline-block'
            img.style.margin = '0.5rem auto'
            img.style.borderRadius = '0.375rem'
            range.insertNode(img)
            const r = document.createRange()
            r.setStartAfter(img)
            r.collapse(true)
            sel.removeAllRanges()
            sel.addRange(r)
          } else {
            try { document.execCommand('insertImage', false, dataUrl) } catch (err) {}
          }
        } catch (err) {
          console.warn('insert image failed', err)
        }
        try { input.value = '' } catch (err) {}
        scheduleDocumentPagination()
        requestAnimationFrame(updateToolbarState)
      }
      reader.readAsDataURL(file)
    } catch (err) {
      console.warn('handleImageUpload error', err)
    }
  }, [])

  // Robust 1:1 PDF Generation with Direct Automatic Download (Requirements 1, 3, 4)
  async function handleExportPdf() {
    if (isExporting) return
    setIsExporting(true)

    try {
      const editorEl = editorRef.current
      if (!editorEl) return

      const { jsPDF } = await import('jspdf')
      const html2canvasMod = await import('html2canvas')
      const html2canvas = html2canvasMod.default || html2canvasMod

      const baseDim = PAPER_SIZES[paperType] || PAPER_SIZES.A4
      const isLandscape = orientation === 'landscape'
      const paperWidthMm = isLandscape ? baseDim.h : baseDim.w
      const paperHeightMm = isLandscape ? baseDim.w : baseDim.h

      // Target 96 DPI pixel dimensions matching editor canvas
      const pageWidthPx = Math.round((paperWidthMm * 96) / 25.4)
      const pageHeightPx = Math.round((paperHeightMm * 96) / 25.4)
      const pageGapPx = A4_PAGE_GAP

      // Refresh pagination to verify exact page count
      paginateDocument(editorEl)
      const currentPages = pageCount

      // Create unscaled 1:1 staging clone off-screen
      const stagingContainer = document.createElement('div')
      stagingContainer.className = 'pdf-export-hidden'
      stagingContainer.style.position = 'fixed'
      stagingContainer.style.left = '-9999px'
      stagingContainer.style.top = '0'
      stagingContainer.style.width = `${pageWidthPx}px`
      stagingContainer.style.zIndex = '-9999'
      stagingContainer.style.background = '#ffffff'

      const cloneWrapper = document.createElement('div')
      cloneWrapper.style.width = `${pageWidthPx}px`
      cloneWrapper.style.position = 'relative'
      cloneWrapper.style.background = '#ffffff'
      cloneWrapper.style.color = '#0f172a'
      cloneWrapper.style.boxSizing = 'border-box'

      const editorClone = editorEl.cloneNode(true)
      editorClone.style.position = 'relative'
      editorClone.style.top = '0'
      editorClone.style.left = '0'
      editorClone.style.width = `${pageWidthPx}px`
      editorClone.style.padding = `${A4_VERTICAL_MARGIN}px 80px`
      editorClone.style.boxSizing = 'border-box'
      editorClone.style.transform = 'none'
      editorClone.style.fontSize = '14px' // exact base font size matching editor
      editorClone.style.lineHeight = '1.6'
      editorClone.style.whiteSpace = 'pre-wrap'
      editorClone.style.background = '#ffffff'
      editorClone.style.color = '#0f172a'
      editorClone.style.outline = 'none'
      editorClone.style.boxShadow = 'none'

      // Synchronize checkbox values in the clone
      const origCheckboxes = editorEl.querySelectorAll('input[type="checkbox"]')
      const clonedCheckboxes = editorClone.querySelectorAll('input[type="checkbox"]')
      origCheckboxes.forEach((orig, idx) => {
        if (clonedCheckboxes[idx]) {
          clonedCheckboxes[idx].checked = orig.checked
          if (orig.checked) {
            clonedCheckboxes[idx].setAttribute('checked', 'checked')
          } else {
            clonedCheckboxes[idx].removeAttribute('checked')
          }
        }
      })

      cloneWrapper.appendChild(editorClone)
      stagingContainer.appendChild(cloneWrapper)
      document.body.appendChild(stagingContainer)

      // High-resolution canvas capture at 2x scale
      const canvas = await html2canvas(cloneWrapper, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        width: pageWidthPx,
        windowWidth: pageWidthPx,
        logging: false,
      })

      if (document.body.contains(stagingContainer)) {
        document.body.removeChild(stagingContainer)
      }

      // Initialize jsPDF with matching paper size and orientation
      const pdf = new jsPDF({
        orientation: isLandscape ? 'landscape' : 'portrait',
        unit: 'pt',
        format: paperType.toLowerCase(),
      })

      const pdfWidthPt = pdf.internal.pageSize.getWidth()
      const pdfHeightPt = pdf.internal.pageSize.getHeight()

      const scale = 2
      const pageHeightCanvasPx = pageHeightPx * scale
      const pageGapCanvasPx = pageGapPx * scale
      const totalCanvasHeight = canvas.height

      // Render each page slice into the PDF
      // A 1-page document produces strictly 1 page in the PDF without ghost pages
      for (let i = 0; i < currentPages; i++) {
        if (i > 0) {
          pdf.addPage()
        }

        const pageCanvas = document.createElement('canvas')
        pageCanvas.width = canvas.width
        pageCanvas.height = pageHeightCanvasPx
        const pageCtx = pageCanvas.getContext('2d')

        pageCtx.fillStyle = '#ffffff'
        pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)

        const sourceY = i * (pageHeightCanvasPx + pageGapCanvasPx)
        const remainingHeight = Math.max(0, totalCanvasHeight - sourceY)
        const sliceHeight = Math.min(pageHeightCanvasPx, remainingHeight)

        if (sliceHeight > 0) {
          pageCtx.drawImage(
            canvas,
            0,
            sourceY,
            canvas.width,
            sliceHeight,
            0,
            0,
            canvas.width,
            sliceHeight
          )
        }

        const imgData = pageCanvas.toDataURL('image/jpeg', 0.98)
        pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidthPt, pdfHeightPt, undefined, 'FAST')
      }

      // Requirement 4: Automatic Direct PDF Download straight to user's device Downloads/Files folder
      // without opening a new browser tab or preview page
      const filename = 'madeEASY.pdf'
      const pdfBlob = pdf.output('blob')
      const blobUrl = URL.createObjectURL(pdfBlob)

      const downloadAnchor = document.createElement('a')
      downloadAnchor.href = blobUrl
      downloadAnchor.download = filename
      downloadAnchor.style.display = 'none'
      document.body.appendChild(downloadAnchor)
      downloadAnchor.click()

      setTimeout(() => {
        if (document.body.contains(downloadAnchor)) {
          document.body.removeChild(downloadAnchor)
        }
        URL.revokeObjectURL(blobUrl)
      }, 2000)
    } catch (err) {
      console.error('PDF Export failed:', err)
    } finally {
      setIsExporting(false)
    }
  }

  function focusTopMenuItem(index) {
    const itemCount = TOP_MENU_ITEMS.length
    const nextIndex = (index + itemCount) % itemCount
    requestAnimationFrame(() => topMenuItemRefs.current[nextIndex]?.focus())
  }

  function openTopMenu(focusIndex) {
    setShowTopMenu(true)
    if (typeof focusIndex === 'number') focusTopMenuItem(focusIndex)
  }

  function selectTopMenuItem(tab) {
    setActiveTab(tab)
    setShowTopMenu(false)
    requestAnimationFrame(() => menuButtonRef.current?.focus())
  }

  function handleMenuButtonKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      openTopMenu(0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      openTopMenu(TOP_MENU_ITEMS.length - 1)
    } else if (e.key === 'Escape' && showTopMenu) {
      e.preventDefault()
      setShowTopMenu(false)
    }
  }

  function handleTopMenuKeyDown(e) {
    const currentIndex = topMenuItemRefs.current.indexOf(document.activeElement)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusTopMenuItem(currentIndex < 0 ? 0 : currentIndex + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusTopMenuItem(currentIndex < 0 ? TOP_MENU_ITEMS.length - 1 : currentIndex - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusTopMenuItem(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusTopMenuItem(TOP_MENU_ITEMS.length - 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setShowTopMenu(false)
      menuButtonRef.current?.focus()
    }
  }

  const baseBtn = 'toolbar-btn px-1.5 py-0.5 rounded text-xs bg-slate-800 text-slate-100 focus:outline-none transition-colors'
  const activeCls = 'bg-indigo-600 text-white font-bold shadow'
  const tapStyle = { WebkitTapHighlightColor: 'transparent' }

  return (
    <div
      className="app-shell text-slate-100"
      style={{
        height: viewportStyle.height,
        top: viewportStyle.top,
      }}
    >
      {/* Header */}
      <header className="px-4 py-3 border-b border-slate-800 flex items-center justify-between flex-shrink-0 bg-slate-900/90 backdrop-blur-md z-30">
        <div className="flex items-center gap-3">
          <div className="relative" ref={topMenuRef}>
            <button
              ref={menuButtonRef}
              onClick={() => setShowTopMenu((s) => !s)}
              onKeyDown={handleMenuButtonKeyDown}
              aria-haspopup="menu"
              aria-expanded={showTopMenu}
              aria-controls="top-navigation-menu"
              aria-label={`Navigation menu. Current tab: ${TOP_MENU_ITEMS.find((item) => item.id === activeTab)?.label || 'Editor'}`}
              className={`relative h-8 min-w-10 px-1.5 bg-slate-800 rounded flex items-center justify-center gap-0.5 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${showTopMenu ? 'text-white bg-slate-700' : 'text-slate-300'}`}
            >
              ME
              <svg
                aria-hidden="true"
                className={`h-3 w-3 transition-transform ${showTopMenu ? 'rotate-180' : ''}`}
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {showTopMenu && (
              <div
                id="top-navigation-menu"
                className="top-nav-menu absolute left-0 mt-2 w-44 rounded bg-slate-800 border border-slate-700 p-2 z-50 shadow-xl"
                role="menu"
                aria-label="Main navigation"
                onKeyDown={handleTopMenuKeyDown}
              >
                {TOP_MENU_ITEMS.map((item, index) => (
                  <button
                    key={item.id}
                    ref={(element) => { topMenuItemRefs.current[index] = element }}
                    type="button"
                    role="menuitem"
                    aria-current={activeTab === item.id ? 'page' : undefined}
                    onClick={() => selectTopMenuItem(item.id)}
                    className={`w-full text-left px-2 py-1 rounded transition-colors ${activeTab === item.id ? 'bg-slate-700 text-white' : 'hover:bg-slate-700'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <h1 className="text-lg font-semibold tracking-tight">madeEASY.pdf</h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportPdf}
            disabled={isExporting}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-xs px-3.5 py-1.5 rounded transition-colors flex items-center gap-1.5 shadow-sm"
            aria-label="Export PDF"
          >
            {isExporting ? (
              <>
                <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                <span>Exporting...</span>
              </>
            ) : (
              <>
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <span>Export</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Top meta strip (hidden when keyboard is open on small screens to preserve screen estate) */}
      {!isKeyboardOpen && (
        <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-2 flex-shrink-0 bg-slate-900/60 text-xs">
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} style={{ display: 'none' }} />
          <div>
            <select
              value={paperType}
              onChange={(e) => setPaperType(e.target.value)}
              className="bg-slate-800 text-slate-100 rounded text-xs py-0.5 px-2 border border-slate-700"
              aria-label="Paper size"
            >
              {Object.keys(PAPER_SIZES).map((k) => (
                <option key={k} value={k} className="bg-slate-900 text-xs">
                  {k}
                </option>
              ))}
            </select>
          </div>

          <div>
            <button
              onClick={() => setOrientation((o) => (o === 'portrait' ? 'landscape' : 'portrait'))}
              className="bg-slate-800 text-slate-100 rounded text-xs py-0.5 px-2 border border-slate-700"
              aria-pressed={orientation === 'landscape'}
            >
              {orientation.toUpperCase()}
            </button>
          </div>

          <div className="text-[11px] text-slate-400 px-1 py-0.5 rounded bg-slate-900/60">{dims.width} × {dims.height} mm</div>

          <div className="ml-auto flex items-center gap-1">
            <button onClick={zoomOut} className="bg-slate-800 text-slate-100 rounded text-xs py-0.5 px-2 border border-slate-700">−</button>
            <div className="text-xs text-slate-200 px-1.5">{Math.round(zoom * 100)}%</div>
            <button onClick={zoomIn} className="bg-slate-800 text-slate-100 rounded text-xs py-0.5 px-2 border border-slate-700">+</button>
          </div>
        </div>
      )}

      {/* Main content area - Only this container scrolls, body is locked (Requirement 5) */}
      <main className="editor-workspace flex-1">
        <div
          ref={viewportRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="a4-document-viewport"
          style={{ touchAction: 'pan-y pinch-zoom' }}
        >
          {(() => {
            const documentHeight = pageCount * A4_PAGE_HEIGHT + Math.max(0, pageCount - 1) * A4_PAGE_GAP
            const stageStyle = {
              width: A4_PAGE_WIDTH * pageScale,
              height: documentHeight * pageScale,
            }
            const documentStyle = {
              width: A4_PAGE_WIDTH,
              height: documentHeight,
              transform: `scale(${pageScale})`,
              transformOrigin: 'top left',
            }
            const editorStyle = {
              position: 'absolute',
              top: 0,
              left: 0,
              width: A4_PAGE_WIDTH,
              minHeight: A4_PAGE_HEIGHT,
              padding: `${A4_VERTICAL_MARGIN}px 80px`,
              boxSizing: 'border-box',
              outline: 'none',
              background: 'transparent',
              color: '#0f172a',
              whiteSpace: 'pre-wrap',
              userSelect: 'text',
              WebkitUserSelect: 'text',
              WebkitTouchCallout: 'default',
              touchAction: 'auto',
            }

            return (
              <div className="a4-document-stage" style={stageStyle}>
                <article className="a4-document" style={documentStyle}>
                  <div className="a4-page-stack" aria-hidden="true">
                    {Array.from({ length: pageCount }, (_, index) => (
                      <div className="a4-page-sheet" key={`page-${index + 1}`} />
                    ))}
                  </div>

                  <div
                    ref={editorRef}
                    contentEditable={true}
                    suppressContentEditableWarning
                    className="document-editor select-text pointer-events-auto"
                    style={editorStyle}
                    onInput={handleContentInput}
                    onKeyUp={() => { saveSelection(); checkActiveFormats() }}
                    onMouseUp={() => { saveSelection(); checkActiveFormats() }}
                    onTouchEnd={() => { saveSelection(); checkActiveFormats() }}
                  >
                    <h1 className="text-2xl font-bold">madeEASY.pdf — Start typing</h1>
                    <p className="mt-4 text-slate-700">This is an editable document area. Use the formatting toolbar to style text.</p>
                  </div>
                </article>
              </div>
            )
          })()}
        </div>
      </main>

      {/* Requirement 2 & 5: Single-row, edge-to-edge dock attached directly to top edge of soft keyboard / screen bottom */}
      <footer className="toolbar-dock toolbar">
        <div className="toolbar-scroll-row">
          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); applyFormatCb('bold'); checkActiveFormats() }}
            className={`${baseBtn} ${isBold && toolbarActive ? activeCls : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isBold}
            style={tapStyle}
            title="Bold"
          >
            <b>B</b>
          </button>

          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); applyFormatCb('italic'); checkActiveFormats() }}
            className={`${baseBtn} ${isItalic && toolbarActive ? activeCls : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isItalic}
            style={tapStyle}
            title="Italic"
          >
            <i>I</i>
          </button>

          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); applyFormatCb('underline'); checkActiveFormats() }}
            className={`${baseBtn} ${isUnderline && toolbarActive ? activeCls : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isUnderline}
            style={tapStyle}
            title="Underline"
          >
            <u>U</u>
          </button>

          <select
            value={fontSize}
            onChange={(e) => { setFontSize(e.target.value); applyFontSizeToSelection(e.target.value) }}
            className="toolbar-select bg-slate-700 text-white text-xs border border-slate-600 rounded px-1.5 py-0.5 focus:outline-none"
            onTouchStart={saveSelection}
            onMouseDown={saveSelection}
            onFocus={saveSelection}
            title="Font Size"
          >
            {['12px','14px','16px','18px','20px','24px','32px'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); applyFormatCb('justifyLeft'); checkActiveFormats() }}
            className={`${baseBtn} ${isAlignLeft && toolbarActive ? activeCls : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isAlignLeft}
            title="Align left"
            style={tapStyle}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="4" width="14" height="2" rx="1" fill="currentColor"/>
              <rect x="3" y="8" width="18" height="2" rx="1" fill="currentColor"/>
              <rect x="3" y="12" width="14" height="2" rx="1" fill="currentColor"/>
              <rect x="3" y="16" width="18" height="2" rx="1" fill="currentColor"/>
            </svg>
          </button>

          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); applyFormatCb('justifyCenter'); checkActiveFormats() }}
            className={`${baseBtn} ${isAlignCenter && toolbarActive ? activeCls : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isAlignCenter}
            title="Align center"
            style={tapStyle}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="5" y="4" width="14" height="2" rx="1" fill="currentColor"/>
              <rect x="3" y="8" width="18" height="2" rx="1" fill="currentColor"/>
              <rect x="5" y="12" width="14" height="2" rx="1" fill="currentColor"/>
              <rect x="3" y="16" width="18" height="2" rx="1" fill="currentColor"/>
            </svg>
          </button>

          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); applyFormatCb('justifyRight'); checkActiveFormats() }}
            className={`${baseBtn} ${isAlignRight && toolbarActive ? activeCls : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isAlignRight}
            title="Align right"
            style={tapStyle}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="7" y="4" width="14" height="2" rx="1" fill="currentColor"/>
              <rect x="3" y="8" width="18" height="2" rx="1" fill="currentColor"/>
              <rect x="7" y="12" width="14" height="2" rx="1" fill="currentColor"/>
              <rect x="3" y="16" width="18" height="2" rx="1" fill="currentColor"/>
            </svg>
          </button>

          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); applyFormatCb('insertUnorderedList'); checkActiveFormats() }}
            className={`${baseBtn} ${isUnorderedList && toolbarActive ? activeCls : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            style={tapStyle}
            title="Bullet List"
          >
            •
          </button>

          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); applyFormatCb('insertOrderedList'); checkActiveFormats() }}
            className={`${baseBtn} ${isOrderedList && toolbarActive ? activeCls : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            style={tapStyle}
            title="Numbered List"
          >
            1.
          </button>

          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); handleInsertImage(e) }}
            className={baseBtn}
            style={tapStyle}
            title="Insert Image"
          >
            📷
          </button>

          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); handleInsertCheckbox(e) }}
            className={baseBtn}
            style={tapStyle}
            title="Insert Checkbox"
          >
            ☐
          </button>

          <button
            type="button"
            onTouchStart={saveSelection}
            onMouseDown={(e) => { e.preventDefault(); setAutoFit((v) => !v); requestAnimationFrame(updateToolbarState) }}
            className={baseBtn}
            style={tapStyle}
            title="Auto Fit"
          >
            ⇱
          </button>
        </div>
      </footer>
    </div>
  )
}
