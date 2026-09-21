import React, { useEffect, useMemo, useRef, useState } from 'react'

const PAPER_SIZES = {
  A4: { w: 210, h: 297 },
  Letter: { w: 216, h: 279 },
  A3: { w: 297, h: 420 },
}

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
  const [isSelecting, setIsSelecting] = useState(false)
  const editorRef = useRef(null)
  const viewportRef = useRef(null)
  const topMenuRef = useRef(null)
  const menuButtonRef = useRef(null)
  const topMenuItemRefs = useRef([])
  const pinchRef = useRef({ pinching: false, initialDistance: 0, initialZoom: 1 })
  const fileInputRef = useRef(null)
  const imagePinchRef = useRef({ active: false, img: null, initialDistance: 0, initialWidth: 0 })
  const imageDragRef = useRef({ dragging: false, img: null, startX: 0, startY: 0, originX: 0, originY: 0 })

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

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
      // if target is a text node, use its parent element
      const el = target.nodeType === 3 ? target.parentElement : target
      if (!el || !el.closest) return false
      return Boolean(el.closest('[contenteditable="true"]') || el.closest('.toolbar'))
    } catch (e) {
      return false
    }
  }

  function handleTouchStart(e) {
    // If the touch started on an image inside the editor, handle image pinch/drag separately
    try {
      const t = e.target.nodeType === 3 ? e.target.parentElement : e.target
      const img = t && t.closest ? t.closest('img') : null
      if (img && e.touches && e.touches.length === 2 && editorRef.current && editorRef.current.contains(img)) {
        // start image pinch
        imagePinchRef.current.active = true
        imagePinchRef.current.img = img
        imagePinchRef.current.initialDistance = getDistance(e.touches)
        const rect = img.getBoundingClientRect()
        imagePinchRef.current.initialWidth = rect.width
        e.preventDefault()
        return
      }
    } catch (err) {
      // ignore
    }

    // if touching inside editor or toolbar, don't treat as pinch/pan starter here
    if (isInEditorOrToolbar(e.target)) return

    if (e.touches && e.touches.length === 2) {
      pinchRef.current.pinching = true
      pinchRef.current.initialDistance = getDistance(e.touches)
      pinchRef.current.initialZoom = zoom
      // when pinching, ensure we are not in selection mode
      setIsSelecting(false)
      return
    }
    // single-finger touch may start selection
    if (e.touches && e.touches.length === 1) {
      setIsSelecting(true)
    }
  }

  function handleTouchMove(e) {
    // image pinch-to-resize
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
      // only prevent default if the event is NOT inside the editable area or toolbar
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
    // end image pinch
    try {
      if (imagePinchRef.current.active && (!e.touches || e.touches.length < 2)) {
        imagePinchRef.current.active = false
        imagePinchRef.current.img = null
      }
    } catch (err) {}

    if (!e.touches || e.touches.length < 2) {
      pinchRef.current.pinching = false
    }
    // end selection on touchend
    if (!e.touches || e.touches.length === 0) {
      setTimeout(() => setIsSelecting(false), 50)
    }
  }

  // If browser doesn't support CSS zoom, adjust editor font-size to approximate zoom
  useEffect(() => {
    try {
      if (editorRef.current) editorRef.current.style.fontSize = `${100 * zoom}%`
    } catch (e) {
      // ignore
    }
  }, [zoom])

  // Track soft keyboard size / visual viewport so toolbar can sit above it on mobile
  const [keyboardOffset, setKeyboardOffset] = useState(0)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const handleResize = () => {
      const offset = window.innerHeight - viewport.height
      setKeyboardOffset(offset > 100 ? offset : 0)
    }

    handleResize()
    viewport.addEventListener('resize', handleResize)
    viewport.addEventListener('scroll', handleResize)
    return () => {
      viewport.removeEventListener('resize', handleResize)
      viewport.removeEventListener('scroll', handleResize)
    }
  }, [])

  // Page scale for true A4 preview (794 x 1123 px at 96 DPI)
  const [pageScale, setPageScale] = useState(1)
  useEffect(() => {
    const updateScale = () => {
      const margin = 32 // 16px padding on left and right
      const availableWidth = window.innerWidth - margin
      const calculatedScale = Math.min(availableWidth / 794, 1)
      setPageScale(calculatedScale)
    }
    updateScale()
    window.addEventListener('resize', updateScale)
    return () => window.removeEventListener('resize', updateScale)
  }, [])

  // Track focus on the editable canvas to hide/show UI chrome
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

  // Escape closes an open menu even when focus has moved away from its items.
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

  // Runtime error overlay (helpful when DevTools isn't open) — displays errors on the page
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
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)'
          })
          document.body.appendChild(el)
        }
        el.textContent = msg
      } catch (err) {
        // ignore
      }
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
      // detect computed font-size at caret
      try {
        const sel = window.getSelection && window.getSelection()
        if (sel && sel.anchorNode) {
          const node = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode
          const el = node && node.closest ? node.closest('[contenteditable="true"] *') || node : node
          const size = el ? window.getComputedStyle(el).fontSize : null
          if (size) setFontSize(size)
        }
      } catch (e) {
        // ignore
      }
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
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      const selectedHtml = range.cloneContents()
      // Serialize selected contents
      const div = document.createElement('div')
      div.appendChild(selectedHtml)
      const html = div.innerHTML
      // Wrap selection in a span with font-size
      const wrapped = `<span style="font-size:${size}">${html || '&nbsp;'}</span>`
      document.execCommand('insertHTML', false, wrapped)
      // restore focus
      editorRef.current?.focus()
      // re-run format checks
      checkActiveFormats()
    } catch (e) {
      console.warn('applyFontSize failed', e)
    }
  }

  function cycleTextAlign() {
    try {
      const next = textAlign === 'left' ? 'center' : textAlign === 'center' ? 'right' : 'left'
      setTextAlign(next)
      if (next === 'left') document.execCommand('justifyLeft')
      if (next === 'center') document.execCommand('justifyCenter')
      if (next === 'right') document.execCommand('justifyRight')
      editorRef.current?.focus()
    } catch (e) {}
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
    const collapsed = sel.isCollapsed
    const hasText = sel.toString().length > 0
    const active = Boolean(inEditor && (hasText || document.activeElement === editorRef.current))

    setToolbarActive(active)

    // keep visual and overlay font-size in sync for zoom
    try {
      if (editorRef.current) editorRef.current.style.fontSize = `${100 * zoom}%`
    } catch (e) {}

    // queryCommandState works for caret or selection to detect applied styles
    checkActiveFormats()
    try {
      setIsOrderedList(Boolean(document.queryCommandState && document.queryCommandState('insertOrderedList')))
    } catch (e) {
      setIsOrderedList(false)
    }
  }

  useEffect(() => {
    // Throttle selection updates using requestAnimationFrame to avoid rapid React renders
    const handler = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        updateToolbarState()
        rafRef.current = null
      })
    }

    document.addEventListener('selectionchange', handler)
    // also listen for focus/mouse/key events inside editor
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
      // keydown for checklist Enter behavior
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
              // inside a checklist line: create next checklist line
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
                // place caret in newBlock
                const r = document.createRange()
                r.setStart(text, 0)
                r.collapse(true)
                sel.removeAllRanges()
                sel.addRange(r)
              }
            }
          } catch (err) {
            // ignore
          }
        }
      }
      el.addEventListener('keydown', onKeyDown)
      // pointer events for dragging images
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

  // aspect ratio string computed safely (avoid template literal pitfalls inside JSX)
  const aspectRatio = String(dims.width) + '/' + String(dims.height)

  function applyFormat(command) {
    try {
      document.execCommand(command)
      editorRef.current?.focus()
    } catch (e) {
      console.warn('format failed', e)
    }
  }

  // Memoize action handlers so their identity is stable during touch sequences
  const applyFormatCb = React.useCallback((command) => {
    try {
      document.execCommand(command)
      editorRef.current?.focus()
    } catch (e) {
      console.warn('format failed', e)
    }
    // immediately update active format states and schedule a toolbar refresh
    try { checkActiveFormats() } catch (e) {}
    requestAnimationFrame(updateToolbarState)
  }, [/* stable */])

  const handleInsertCheckbox = React.useCallback((e) => {
    if (e && e.preventDefault) e.preventDefault()
    try {
      const sel = window.getSelection()
      if (!sel) return
      const range = sel.getRangeAt(0)
      // find block ancestor (p, div, li) inside editor
      let node = range.startContainer
      while (node && node !== editorRef.current && node.nodeType !== 1) node = node.parentNode
      let block = node && node.nodeType === 1 ? node.closest('p,div,li') : null
      if (!block || !editorRef.current.contains(block)) {
        // fallback: insert new paragraph at end
        block = document.createElement('div')
        block.innerHTML = '<br>'
        editorRef.current.appendChild(block)
      }

      // insert checkbox input at start of block if not already
      const first = block.firstElementChild
      if (first && first.tagName === 'INPUT' && first.type === 'checkbox') {
        // already a checkbox, do nothing
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
          // Try to insert at current selection using Range API
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
            // place caret after the inserted image
            const r = document.createRange()
            r.setStartAfter(img)
            r.collapse(true)
            sel.removeAllRanges()
            sel.addRange(r)
          } else {
            // fallback to execCommand
            try { document.execCommand('insertImage', false, dataUrl) } catch (err) {}
          }
        } catch (err) {
          console.warn('insert image failed', err)
        }
        // reset input so same file can be selected again
        try { input.value = '' } catch (err) {}
        requestAnimationFrame(updateToolbarState)
      }
      reader.readAsDataURL(file)
    } catch (err) {
      console.warn('handleImageUpload error', err)
    }
  }, [])

  // Memoized toolbar element (kept outside of JSX to avoid nested-brace parsing issues)
  const toolbarMemo = useMemo(() => {
    const showToolbar = toolbarActive || isEditing || keyboardOffset > 0
    const containerClass = `fixed right-4 bottom-4 z-50 bg-slate-900/60 backdrop-blur-md rounded-full border border-slate-700/40 shadow-xl text-slate-100 p-1 flex flex-row items-center gap-1 max-w-[95vw] w-auto ${showToolbar ? 'opacity-100 pointer-events-auto' : 'opacity-30 pointer-events-none'}`
    const baseBtn = 'px-1.5 py-0.5 rounded text-xs bg-slate-800 text-slate-100 focus:outline-none'
    const activeCls = 'bg-indigo-600 text-white'
    const tapStyle = { WebkitTapHighlightColor: 'transparent' }

    return (
      <div
        className={containerClass + ' toolbar floating-toolbar'}
        style={{ bottom: `${keyboardOffset + 12}px` }}
        onTouchStart={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
      >
        {/* Top row: Text & Style */}
        <div className="flex items-center gap-1">
          <button
            onPointerDown={(e) => { e.preventDefault(); applyFormatCb('bold'); checkActiveFormats() }}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => { e.preventDefault(); applyFormatCb('bold'); checkActiveFormats() }}
            className={`${baseBtn} ${isBold && toolbarActive ? activeCls + ' font-bold shadow' : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isBold}
            style={tapStyle}
          >
            B
          </button>

          <button
            onPointerDown={(e) => { e.preventDefault(); applyFormatCb('italic'); checkActiveFormats() }}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => { e.preventDefault(); applyFormatCb('italic'); checkActiveFormats() }}
            className={`${baseBtn} ${isItalic && toolbarActive ? activeCls + ' font-bold shadow' : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isItalic}
            style={tapStyle}
          >
            I
          </button>

          <button
            onPointerDown={(e) => { e.preventDefault(); applyFormatCb('underline'); checkActiveFormats() }}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => { e.preventDefault(); applyFormatCb('underline'); checkActiveFormats() }}
            className={`${baseBtn} ${isUnderline && toolbarActive ? activeCls + ' font-bold shadow' : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isUnderline}
            style={tapStyle}
          >
            U
          </button>

          <select
            value={fontSize}
            onChange={(e) => { setFontSize(e.target.value); applyFontSizeToSelection(e.target.value) }}
            className="bg-slate-700 text-white text-xs border border-slate-600 rounded px-1 py-0.5 toolbar-select"
            style={{ marginLeft: 4 }}
            onTouchStart={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
          >
            {['12px','14px','16px','18px','20px','24px','32px'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          {/* Alignment icons */}
          <button
            onPointerDown={(e) => { e.preventDefault(); document.execCommand('justifyLeft'); checkActiveFormats(); editorRef.current?.focus() }}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            className={`${baseBtn} ${isAlignLeft && toolbarActive ? activeCls + ' shadow' : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isAlignLeft}
            title="Align left"
            style={tapStyle}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="14" height="2" rx="1" fill="currentColor"/><rect x="3" y="8" width="18" height="2" rx="1" fill="currentColor"/><rect x="3" y="12" width="14" height="2" rx="1" fill="currentColor"/><rect x="3" y="16" width="18" height="2" rx="1" fill="currentColor"/></svg>
          </button>

          <button
            onPointerDown={(e) => { e.preventDefault(); document.execCommand('justifyCenter'); checkActiveFormats(); editorRef.current?.focus() }}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            className={`${baseBtn} ${isAlignCenter && toolbarActive ? activeCls + ' shadow' : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isAlignCenter}
            title="Align center"
            style={tapStyle}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="4" width="14" height="2" rx="1" fill="currentColor"/><rect x="3" y="8" width="18" height="2" rx="1" fill="currentColor"/><rect x="5" y="12" width="14" height="2" rx="1" fill="currentColor"/><rect x="3" y="16" width="18" height="2" rx="1" fill="currentColor"/></svg>
          </button>

          <button
            onPointerDown={(e) => { e.preventDefault(); document.execCommand('justifyRight'); checkActiveFormats(); editorRef.current?.focus() }}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            className={`${baseBtn} ${isAlignRight && toolbarActive ? activeCls + ' shadow' : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            aria-pressed={isAlignRight}
            title="Align right"
            style={tapStyle}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="7" y="4" width="14" height="2" rx="1" fill="currentColor"/><rect x="3" y="8" width="18" height="2" rx="1" fill="currentColor"/><rect x="7" y="12" width="14" height="2" rx="1" fill="currentColor"/><rect x="3" y="16" width="18" height="2" rx="1" fill="currentColor"/></svg>
          </button>
        </div>

        {/* Bottom row: Lists & Tools */}
        <div className="flex items-center gap-1">
          <button
            onPointerDown={(e) => { e.preventDefault(); applyFormatCb('insertUnorderedList'); checkActiveFormats(); try { setIsUnorderedList(Boolean(document.queryCommandState && document.queryCommandState('insertUnorderedList'))) } catch (err) {} }}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            className={`${baseBtn} ${isUnorderedList && toolbarActive ? activeCls + ' font-bold shadow' : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            style={tapStyle}
          >
            •
          </button>

          <button
            onPointerDown={(e) => { e.preventDefault(); applyFormatCb('insertOrderedList'); checkActiveFormats(); try { setIsOrderedList(Boolean(document.queryCommandState && document.queryCommandState('insertOrderedList'))) } catch (err) {} }}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            className={`${baseBtn} ${isOrderedList && toolbarActive ? activeCls + ' font-bold shadow' : 'bg-transparent text-slate-300 hover:bg-slate-700/50'}`}
            style={tapStyle}
          >
            1.
          </button>

          <button onPointerDown={handleInsertImage} onMouseDown={(e) => e.preventDefault()} onTouchStart={(e) => e.preventDefault()} className={baseBtn} style={tapStyle}>📷</button>

          <button onPointerDown={handleInsertCheckbox} onMouseDown={(e) => e.preventDefault()} onTouchStart={(e) => e.preventDefault()} className={baseBtn} style={tapStyle}>☐</button>

          <button onPointerDown={(e) => { e.preventDefault(); setAutoFit((v) => !v); requestAnimationFrame(updateToolbarState) }} onMouseDown={(e) => e.preventDefault()} onTouchStart={(e) => e.preventDefault()} className={baseBtn} style={tapStyle}>⇱</button>
        </div>
      </div>
    )
  }, [toolbarActive, isBold, isItalic, isUnderline, isOrderedList, isUnorderedList, fontSize, textAlign, isAlignLeft, isAlignCenter, isAlignRight, applyFormatCb, handleInsertCheckbox, handleInsertImage, keyboardOffset, isEditing])

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

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      {/* Header */}
      <header className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
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
                className="top-nav-menu absolute left-0 mt-2 w-44 rounded bg-slate-800 border border-slate-700 p-2 z-50"
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
                    className={`w-full text-left px-2 py-1 rounded ${activeTab === item.id ? 'bg-slate-700 text-white' : 'hover:bg-slate-700'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <h1 className="text-lg font-semibold">madeEASY.pdf</h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              const el = document.querySelector('article')
              try {
                const mod = await import('html2pdf.js')
                const html2pdf = mod.default || mod
                html2pdf().from(el).save()
              } catch (e) {
                // fallback
                console.warn('html2pdf not available, falling back to print', e)
                window.print()
              }
            }}
            className="bg-slate-700 text-slate-100 text-xs px-3 py-1 rounded"
            aria-label="Export PDF"
          >
            Export
          </button>
        </div>
      </header>

      {/* Ultra-compact single-line top meta strip */}
      {!(isEditing || keyboardOffset > 0) && (
        <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        {/* hidden file input for image uploads triggered from toolbar */}
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} style={{ display: 'none' }} />
        <div>
          <select
            value={paperType}
            onChange={(e) => setPaperType(e.target.value)}
            className="bg-slate-800 text-slate-100 rounded text-xs py-0.5 px-2"
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
            className="bg-slate-800 text-slate-100 rounded text-xs py-0.5 px-2"
            aria-pressed={orientation === 'landscape'}
          >
            {orientation.toUpperCase()}
          </button>
        </div>

        <div className="text-[11px] text-slate-400 px-1 py-0.5 rounded bg-slate-900/60">{dims.width} × {dims.height} mm</div>

        <div className="ml-auto flex items-center gap-1">
          <button onClick={zoomOut} className="bg-slate-800 text-slate-100 rounded text-xs py-0.5 px-2">−</button>
          <div className="text-xs text-slate-200 px-2">{Math.round(zoom * 100)}%</div>
          <button onClick={zoomIn} className="bg-slate-800 text-slate-100 rounded text-xs py-0.5 px-2">+</button>
        </div>
        </div>
      )}

      {/* Main content area */}
      <main className="flex-1 p-6 flex justify-center items-start overflow-auto">
        <div className="w-full max-w-[1000px] flex justify-center">
          <div
            ref={viewportRef}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className="overflow-auto w-full"
            style={{ maxHeight: 'calc(100vh - 180px)', WebkitOverflowScrolling: 'touch', touchAction: 'pan-y pinch-zoom' }}
          >
            {/** Compute article style explicitly so Chrome device emulation reliably uses CSS zoom for selection */}
            {
              (() => {
                // Overlay architecture: visual replica (non-interactive) + unscaled contenteditable overlay
                // Use responsive CSS for the paper and keep the editable overlay unscaled
                const wrapperStyle = { position: 'relative', boxSizing: 'border-box', minHeight: '400px' }
                const visualStyle = { position: 'relative', pointerEvents: 'none', color: '#0f172a' }
                const overlayStyle = {
                  position: 'absolute', left: 0, top: 0, right: 0, bottom: 0,
                  padding: '2rem', boxSizing: 'border-box', outline: 'none', background: 'transparent', color: 'inherit',
                  whiteSpace: 'pre-wrap', userSelect: 'text', WebkitUserSelect: 'text', WebkitTouchCallout: 'default', touchAction: 'auto'
                }

                return (
                  <div className="a4-viewport w-full flex justify-center">
                    <div style={{ transform: `scale(${pageScale})`, transformOrigin: 'top center', width: 794 }}>
                      <article className="text-slate-900 shadow-lg rounded-md mx-auto" style={{ background: '#ffffff', width: 794, height: 1123 }}>
                        <div style={wrapperStyle} className="h-full box-border overflow-auto p-0">
                      <div
                        ref={editorRef}
                        contentEditable={true}
                        suppressContentEditableWarning
                        className="min-h-full outline-none focus:outline-none select-text pointer-events-auto p-8"
                        style={overlayStyle}
                        onKeyUp={() => checkActiveFormats()}
                        onMouseUp={() => checkActiveFormats()}
                        onTouchEnd={() => checkActiveFormats()}
                      >
                        <h1 className="text-2xl font-bold">madeEASY.pdf — Start typing</h1>
                        <p className="mt-4 text-slate-700">This is an editable document area. Use the formatting toolbar to style text.</p>
                      </div>
                    </div>
                  </article>
                    </div>
                  </div>
                )
              })()
            }
          </div>
        </div>
      </main>

      {/* Floating Formatting Toolbar (elevated above bottom nav) */}
      {toolbarMemo}

    </div>
  )
}
