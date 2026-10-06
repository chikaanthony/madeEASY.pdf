import React, { useEffect, useMemo, useRef, useState } from 'react'

const PAPER_SIZES = {
  A4: { w: 210, h: 297 },
  Letter: { w: 216, h: 279 },
  A3: { w: 297, h: 420 },
}

const A4_PAGE_WIDTH = 794
const A4_PAGE_HEIGHT = 1123
const A4_MARGIN = 72 // Strict 1-inch (72px) margin on all 4 sides (top, bottom, left, right)
const A4_PRINTABLE_HEIGHT = A4_PAGE_HEIGHT - A4_MARGIN * 2 // 979px
const A4_PAGE_GAP = 24 // Gap between page sheets
const A4_PAGE_DEAD_ZONE = A4_MARGIN * 2 + A4_PAGE_GAP // 168px (72 bottom + 24 gap + 72 top)

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
  const [exportModal, setExportModal] = useState(null)

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

  // Exact 1-inch printable boundaries per page
  function getPageContentStart(pageIndex) {
    return A4_MARGIN + pageIndex * (A4_PAGE_HEIGHT + A4_PAGE_GAP)
  }

  function getPageContentEnd(pageIndex) {
    return getPageContentStart(pageIndex) + A4_PRINTABLE_HEIGHT
  }

  // Strict page count determination:
  // Documents that fit on one page stay strictly on 1 page.
  // A second page is only created when content actually overflows past the 1-inch bottom margin of Page 1.
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

    const page1End = getPageContentEnd(0)
    if (maxContentBottom <= page1End && minimumPageCount <= 1) {
      setPageCount((curr) => (curr === 1 ? curr : 1))
      return
    }

    let requiredPages = 1
    while (maxContentBottom > getPageContentEnd(requiredPages - 1)) {
      requiredPages++
    }

    const nextPageCount = Math.max(minimumPageCount, requiredPages)
    setPageCount((currentPageCount) => (currentPageCount === nextPageCount ? currentPageCount : nextPageCount))
  }

  function getPageLayoutSignature(element) {
    return Array.from(element.children)
      .filter((child) => !child.hasAttribute('data-virtual-page-break'))
      .map((child) => `${child.tagName}:${child.offsetTop}:${child.offsetHeight}:${child.textContent?.length || 0}`)
      .join('|')
  }

  function insertVirtualPageBreak(block, nextPageIndex) {
    const spacer = document.createElement('div')
    spacer.setAttribute('data-virtual-page-break', 'true')
    spacer.setAttribute('contenteditable', 'false')
    spacer.setAttribute('aria-hidden', 'true')

    const targetTop = getPageContentStart(nextPageIndex)
    const currentTop = block.offsetTop
    const spacerHeight = Math.max(0, targetTop - currentTop)

    spacer.style.height = `${spacerHeight}px`
    spacer.style.width = '100%'
    spacer.style.display = 'block'
    spacer.style.margin = '0'
    spacer.style.padding = '0'
    spacer.style.pointerEvents = 'none'
    spacer.style.userSelect = 'none'
    spacer.style.background = 'transparent'

    block.before(spacer)
  }

  // Clean Page Jump & No Gap Bleed (Requirement 1):
  // When content reaches the 1-inch bottom margin of Page 1, it stops and jumps cleanly
  // over the 24px dark gap to begin exactly 1 inch (72px) below the top edge of Page 2.
  // No text or code line ever sits inside the dark gap between pages.
  function paginateDocument(element = editorRef.current) {
    if (!element) return

    Array.from(element.querySelectorAll(':scope > [data-virtual-page-break]')).forEach((spacer) => spacer.remove())
    void element.offsetHeight

    let pageIndex = 0
    const blocks = Array.from(element.children).filter((child) => !child.hasAttribute('data-virtual-page-break'))

    blocks.forEach((block) => {
      const blockHeight = block.offsetHeight
      if (blockHeight === 0) return

      while (block.offsetTop >= getPageContentEnd(pageIndex)) {
        const nextPageIndex = pageIndex + 1
        if (block.offsetTop < getPageContentStart(nextPageIndex)) {
          insertVirtualPageBreak(block, nextPageIndex)
        }
        pageIndex = nextPageIndex
      }

      if (block.offsetTop + blockHeight > getPageContentEnd(pageIndex)) {
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

  function saveSelection() {
    try {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      if (!editorRef.current?.contains(range.commonAncestorContainer)) return
      savedRangeRef.current = range.cloneRange()
    } catch (e) {}
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
    setZoom((z) => clamp(Math.round((z + 0.1) * 100) / 100, 0.5, 2.5))
  }
  function zoomOut() {
    setZoom((z) => clamp(Math.round((z - 0.1) * 100) / 100, 0.5, 2.5))
  }

  function getDistance(touches) {
    const [a, b] = touches
    const dx = a.clientX - b.clientX
    const dy = a.clientY - b.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  function isInToolbar(target) {
    try {
      if (!target) return false
      const el = target.nodeType === 3 ? target.parentElement : target
      return Boolean(el && el.closest && el.closest('.toolbar'))
    } catch (e) {
      return false
    }
  }

  // Requirement 2: Paper-Only Canvas Zooming (Lock Website Viewport Zooming)
  // Pinch gestures scale ONLY the document paper canvas, while the UI shell remains locked at 100%
  function handleTouchStart(e) {
    if (isInToolbar(e.target)) return

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

    if (e.touches && e.touches.length === 2) {
      pinchRef.current.pinching = true
      pinchRef.current.initialDistance = getDistance(e.touches)
      pinchRef.current.initialZoom = zoom
      setIsSelecting(false)
      e.preventDefault()
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
        const newWidth = Math.max(24, Math.min(imagePinchRef.current.initialWidth * ratio, 1000))
        if (imagePinchRef.current.img) {
          imagePinchRef.current.img.style.width = `${newWidth}px`
          imagePinchRef.current.img.style.height = 'auto'
        }
        e.preventDefault()
        return
      }
    } catch (err) {}

    if (pinchRef.current.pinching && e.touches && e.touches.length === 2) {
      e.preventDefault()
      const distance = getDistance(e.touches)
      const ratio = distance / pinchRef.current.initialDistance
      const next = clamp(Math.round(pinchRef.current.initialZoom * ratio * 100) / 100, 0.5, 2.5)
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

  // Prevent browser viewport pinch zoom on iOS Safari so main web UI never stretches
  useEffect(() => {
    const preventGesture = (e) => e.preventDefault()
    document.addEventListener('gesturestart', preventGesture, { passive: false })
    document.addEventListener('gesturechange', preventGesture, { passive: false })
    document.addEventListener('gestureend', preventGesture, { passive: false })

    return () => {
      document.removeEventListener('gesturestart', preventGesture)
      document.removeEventListener('gesturechange', preventGesture)
      document.removeEventListener('gestureend', preventGesture)
    }
  }, [])

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

  function triggerDirectDownload(blobUrl, filename = 'madeEASY.pdf') {
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
    }, 2000)
  }

  // Requirement 1 & 3: Multi-Page Flow with 1-Inch Margins & Native Mobile Web Share Integration
  async function handleExportPdf() {
    if (isExporting) return
    setIsExporting(true)

    try {
      const editorEl = editorRef.current
      const articleEl = document.querySelector('article.a4-document')
      if (!editorEl || !articleEl) return

      const { jsPDF } = await import('jspdf')
      const html2canvasMod = await import('html2canvas')
      const html2canvas = html2canvasMod.default || html2canvasMod

      const baseDim = PAPER_SIZES[paperType] || PAPER_SIZES.A4
      const isLandscape = orientation === 'landscape'
      const paperWidthMm = isLandscape ? baseDim.h : baseDim.w
      const paperHeightMm = isLandscape ? baseDim.w : baseDim.h

      const pageWidthPx = Math.round((paperWidthMm * 96) / 25.4)
      const pageHeightPx = Math.round((paperHeightMm * 96) / 25.4)
      const pageGapPx = A4_PAGE_GAP

      // Refresh pagination to verify exact page count
      paginateDocument(editorEl)
      const currentPages = pageCount
      const totalDocHeight = currentPages * pageHeightPx + Math.max(0, currentPages - 1) * pageGapPx

      // Create unscaled 1:1 staging clone off-screen matching exact sheet layout
      const stagingContainer = document.createElement('div')
      stagingContainer.className = 'pdf-export-hidden'
      stagingContainer.style.position = 'fixed'
      stagingContainer.style.left = '-9999px'
      stagingContainer.style.top = '0'
      stagingContainer.style.width = `${pageWidthPx}px`
      stagingContainer.style.zIndex = '-9999'
      stagingContainer.style.background = '#12161f'

      const articleClone = articleEl.cloneNode(true)
      articleClone.style.transform = 'none'
      articleClone.style.transformOrigin = 'top left'
      articleClone.style.margin = '0'
      articleClone.style.position = 'relative'
      articleClone.style.width = `${pageWidthPx}px`
      articleClone.style.height = `${totalDocHeight}px`

      // Remove drop-shadows on cloned sheets and enforce strict 1-inch (72px) padding
      const clonedSheets = articleClone.querySelectorAll('.a4-page-sheet')
      clonedSheets.forEach((sheet) => {
        sheet.style.boxShadow = 'none'
        sheet.style.width = `${pageWidthPx}px`
        sheet.style.height = `${pageHeightPx}px`
        sheet.style.padding = `${A4_MARGIN}px`
        sheet.style.margin = `0 auto ${pageGapPx}px`
      })

      const clonedEditor = articleClone.querySelector('.document-editor')
      if (clonedEditor) {
        clonedEditor.style.padding = `${A4_MARGIN}px`
        clonedEditor.style.width = `${pageWidthPx}px`
        clonedEditor.style.fontSize = '14px'
      }

      // Sync checkbox checked states in the clone
      const origCheckboxes = editorEl.querySelectorAll('input[type="checkbox"]')
      const clonedCheckboxes = articleClone.querySelectorAll('input[type="checkbox"]')
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

      stagingContainer.appendChild(articleClone)
      document.body.appendChild(stagingContainer)

      // High-resolution canvas capture at 2x scale
      const canvas = await html2canvas(articleClone, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#12161f',
        width: pageWidthPx,
        windowWidth: pageWidthPx,
        logging: false,
      })

      if (document.body.contains(stagingContainer)) {
        document.body.removeChild(stagingContainer)
      }

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

      // Render each page sheet into the PDF:
      // Slices out the 24px gap so Page 1 and Page 2 each have strict 1-inch (72px) margins on all 4 sides!
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
        pageCtx.drawImage(
          canvas,
          0,
          sourceY,
          canvas.width,
          pageHeightCanvasPx,
          0,
          0,
          canvas.width,
          pageHeightCanvasPx
        )

        const imgData = pageCanvas.toDataURL('image/jpeg', 0.98)
        pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidthPt, pdfHeightPt, undefined, 'FAST')
      }

      const pdfBlob = pdf.output('blob')
      const pdfFile = new File([pdfBlob], 'madeEASY.pdf', { type: 'application/pdf' })
      const blobUrl = URL.createObjectURL(pdfBlob)

      setExportModal({ blob: pdfBlob, file: pdfFile, url: blobUrl })

      // Requirement 3: Native Mobile Download / Share Integration (navigator.share)
      if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
        try {
          await navigator.share({
            files: [pdfFile],
            title: 'madeEASY.pdf',
            text: 'Exported from madeEASY.pdf',
          })
        } catch (shareErr) {
          if (shareErr.name !== 'AbortError') {
            triggerDirectDownload(blobUrl, 'madeEASY.pdf')
          }
        }
      } else {
        // Desktop / direct download fallback without new tab
        triggerDirectDownload(blobUrl, 'madeEASY.pdf')
      }
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
      {/* Header - Fixed UI shell at 100% size (Requirement 2) */}
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

      {/* Top meta strip - Fixed UI shell at 100% size */}
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

      {/* Main content area - Scrolling occurs only here; pinch zoom scales paper canvas only (Requirement 2) */}
      <main className="editor-workspace flex-1">
        <div
          ref={viewportRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="a4-document-viewport"
          style={{ touchAction: 'pan-x pan-y' }}
        >
          {(() => {
            const effectiveScale = pageScale * zoom
            const documentHeight = pageCount * A4_PAGE_HEIGHT + Math.max(0, pageCount - 1) * A4_PAGE_GAP
            const stageStyle = {
              width: A4_PAGE_WIDTH * effectiveScale,
              height: documentHeight * effectiveScale,
            }
            const documentStyle = {
              width: A4_PAGE_WIDTH,
              height: documentHeight,
              transform: `scale(${effectiveScale})`,
              transformOrigin: 'top center',
            }
            const editorStyle = {
              position: 'absolute',
              top: 0,
              left: 0,
              width: A4_PAGE_WIDTH,
              minHeight: A4_PAGE_HEIGHT,
              padding: `${A4_MARGIN}px`,
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

      {/* Requirement 3: Sticky Export Action Bar / Sheet for Native Mobile Share & Download */}
      {exportModal && (
        <div className="export-action-bar" role="alert" aria-live="polite">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-8 w-8 rounded-lg bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center flex-shrink-0 text-indigo-400">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white truncate">madeEASY.pdf Ready</div>
              <div className="text-[11px] text-slate-400 truncate">1-Inch Margins • 1:1 Export</div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => triggerDirectDownload(exportModal.url, 'madeEASY.pdf')}
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 shadow transition-colors"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>Download</span>
            </button>

            {navigator.canShare && navigator.canShare({ files: [exportModal.file] }) && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.share({
                      files: [exportModal.file],
                      title: 'madeEASY.pdf',
                      text: 'Exported from madeEASY.pdf',
                    })
                  } catch (e) {}
                }}
                className="bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="18" cy="5" r="3"></circle>
                  <circle cx="6" cy="12" r="3"></circle>
                  <circle cx="18" cy="19" r="3"></circle>
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
                </svg>
                <span>Share</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setExportModal(null)}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
              aria-label="Close action bar"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Formatting toolbar - Fixed UI shell at bottom of screen / keyboard */}
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
