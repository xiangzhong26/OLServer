import { useState } from 'react'
import type { FormEvent } from 'react'
import { useCodeMirrorStateContext, useCodeMirrorViewContext } from './codemirror-context'
import { isVisual } from '../extensions/visual/visual'

type TransformResult = { from: number; to: number; selected: string; replacement: string }

function csrfToken() {
  return document.querySelector('meta[name="ol-csrfToken"]')?.getAttribute('content') || ''
}

export default function AISelectionAssistant() {
  const state = useCodeMirrorStateContext()
  const view = useCodeMirrorViewContext()
  const [open, setOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState<TransformResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const selection = state.selection.main
  const canUse = !state.readOnly && !selection.empty && !isVisual(view)
  const selectionChanged = result != null &&
    view.state.doc.sliceString(result.from, result.to) !== result.selected

  async function submit(event: FormEvent) {
    event.preventDefault()
    const { from, to } = view.state.selection.main
    const selected = view.state.doc.sliceString(from, to)
    if (!selected || !instruction.trim()) return

    setBusy(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch('/ai/transform', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken(),
        },
        body: JSON.stringify({
          instruction: instruction.trim(),
          selection: selected,
          contextBefore: view.state.doc.sliceString(Math.max(0, from - 2_000), from),
          contextAfter: view.state.doc.sliceString(to, Math.min(view.state.doc.length, to + 2_000)),
        }),
      })
      if (!response.ok) throw new Error(response.status === 429 ? 'AI 请求较频繁，请稍后再试。' : 'AI 修改失败，请检查设置或稍后重试。')
      const data = (await response.json()) as { replacement: string }
      setResult({ from, to, selected, replacement: data.replacement })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'AI 修改失败。')
    } finally {
      setBusy(false)
    }
  }

  function applyReplacement() {
    if (!result || selectionChanged) return
    view.dispatch({
      changes: { from: result.from, to: result.to, insert: result.replacement },
      selection: { anchor: result.from + result.replacement.length },
    })
    setResult(null)
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!canUse}
        title="对选中文本执行 AI 指令"
        onClick={() => {
          setOpen(value => !value)
          setResult(null)
          setError('')
        }}
      >
        AI 修改
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="AI 修改选中文本"
          style={{ position: 'fixed', zIndex: 1200, top: 150, right: 24, width: 380, maxWidth: 'calc(100vw - 32px)', padding: 16, background: 'var(--ol-bg, #fff)', color: 'var(--ol-fg, #222)', border: '1px solid #bbb', borderRadius: 6, boxShadow: '0 4px 18px #0003' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>AI 修改选中文本</strong>
            <button type="button" className="btn btn-link btn-sm" onClick={() => setOpen(false)}>关闭</button>
          </div>
          {!canUse && <p>先在源码编辑器中选中一段文字。</p>}
          <form onSubmit={submit}>
            <label htmlFor="ol-ai-instruction">指令</label>
            <textarea
              id="ol-ai-instruction"
              className="form-control"
              rows={3}
              maxLength={1_000}
              value={instruction}
              onChange={event => setInstruction(event.target.value)}
              placeholder="例如：把这几句加粗，或改成红色"
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" type="submit" disabled={!canUse || busy || !instruction.trim()}>
                {busy ? '处理中…' : '生成修改稿'}
              </button>
              {result && <button className="btn btn-secondary btn-sm" type="button" disabled={selectionChanged} onClick={applyReplacement}>应用</button>}
              {result && <button className="btn btn-link btn-sm" type="button" onClick={() => setResult(null)}>丢弃</button>}
            </div>
          </form>
          {error && <p role="alert" className="text-danger" style={{ marginTop: 8 }}>{error}</p>}
          {selectionChanged && <p role="alert" className="text-danger" style={{ marginTop: 8 }}>原选区已变化，请重新选择并生成。</p>}
          {result && (
            <div style={{ marginTop: 12 }}>
              <strong>修改预览</strong>
              <pre style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', marginTop: 6 }}>{result.replacement}</pre>
            </div>
          )}
        </div>
      )}
    </>
  )
}
