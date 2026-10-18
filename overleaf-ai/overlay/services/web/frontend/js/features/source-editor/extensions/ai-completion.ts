import { Prec, StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { isVisual } from './visual/visual'

type Suggestion = { text: string; pos: number; doc: string }

const setSuggestion = StateEffect.define<Suggestion | null>()

class GhostText extends WidgetType {
  constructor(private text: string) {
    super()
  }

  toDOM() {
    const element = document.createElement('span')
    element.className = 'ol-ai-completion-ghost'
    element.textContent = this.text
    element.setAttribute('aria-hidden', 'true')
    element.style.color = '#888'
    element.style.opacity = '0.72'
    element.style.whiteSpace = 'pre-wrap'
    element.style.pointerEvents = 'none'
    return element
  }

  ignoreEvent() {
    return true
  }
}

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, transaction) {
    let next = value
    for (const effect of transaction.effects) {
      if (effect.is(setSuggestion)) next = effect.value
    }
    const hasSuggestionEffect = transaction.effects.some(effect => effect.is(setSuggestion))
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection)
    if ((transaction.docChanged || selectionChanged) && !hasSuggestionEffect) {
      next = null
    }
    if (next && (next.pos > transaction.state.doc.length || next.doc !== transaction.state.doc.toString())) {
      return null
    }
    return next
  },
  provide: field => EditorView.decorations.from(field, suggestion =>
    suggestion
      ? Decoration.set(Decoration.widget({ widget: new GhostText(suggestion.text), side: 1 }).range(suggestion.pos))
      : Decoration.none
  ),
})

function csrfToken() {
  return document.querySelector('meta[name="ol-csrfToken"]')?.getAttribute('content') || ''
}

function acceptSuggestion(view: EditorView) {
  const suggestion = view.state.field(suggestionField)
  if (!suggestion || view.state.doc.toString() !== suggestion.doc) return false
  view.dispatch({
    changes: { from: suggestion.pos, to: suggestion.pos, insert: suggestion.text },
    selection: { anchor: suggestion.pos + suggestion.text.length },
    annotations: Transaction.userEvent.of('input.complete'),
  })
  return true
}

function dismissSuggestion(view: EditorView) {
  if (!view.state.field(suggestionField)) return false
  view.dispatch({ effects: setSuggestion.of(null) })
  return true
}

class AICompletionPlugin {
  private timer?: number
  private abortController?: AbortController

  constructor(private view: EditorView) {}

  update(update: ViewUpdate) {
    const localTyping = update.transactions.some(
      transaction =>
        transaction.docChanged &&
        !transaction.annotation(Transaction.remote) &&
        transaction.annotation(Transaction.userEvent) !== 'input.complete'
    )
    if (update.selectionSet || update.docChanged) {
      this.abortController?.abort()
      window.clearTimeout(this.timer)
    }
    if (localTyping && update.state.selection.main.empty && !isVisual(this.view)) {
      this.timer = window.setTimeout(() => this.fetchSuggestion(), 750)
    }
  }

  destroy() {
    this.abortController?.abort()
    window.clearTimeout(this.timer)
  }

  private async fetchSuggestion() {
    const state = this.view.state
    const position = state.selection.main.head
    const documentText = state.doc.toString()
    const prefix = state.doc.sliceString(Math.max(0, position - 1_800), position)
    const suffix = state.doc.sliceString(position, Math.min(state.doc.length, position + 800))
    if (prefix.trim().length < 24) return

    const controller = new AbortController()
    this.abortController = controller
    try {
      const response = await fetch('/ai/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken(),
        },
        body: JSON.stringify({ prefix, suffix }),
        signal: controller.signal,
      })
      if (!response.ok) return
      const result = (await response.json()) as { completion?: string }
      const completion = result.completion
      if (
        !completion?.trim() ||
        this.view.state.doc.toString() !== documentText ||
        this.view.state.selection.main.head !== position
      ) {
        return
      }
      this.view.dispatch({
        effects: setSuggestion.of({ text: completion.slice(0, 800), pos: position, doc: documentText }),
      })
    } catch {
      // AI failures should not interrupt editing.
    }
  }
}

export function aiCompletion() {
  return [
    suggestionField,
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: acceptSuggestion },
        { key: 'Escape', run: dismissSuggestion },
      ])
    ),
    ViewPlugin.fromClass(AICompletionPlugin),
  ]
}
