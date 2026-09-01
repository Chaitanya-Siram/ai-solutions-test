// Renders the lightweight **bold** markup the LLM emits in insights/summaries.
// Splits on **…** runs and bolds them; everything else is plain text.
export function Rich({ text }) {
  if (!text) return null
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

// Splits "- bullet" markdown blocks into an array of bullet strings.
export function toBullets(markdown) {
  if (!markdown) return []
  return String(markdown)
    .split('\n')
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
}
