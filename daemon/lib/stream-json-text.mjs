// stream-json-text — pull the agent's plain assistant text out of a
// `--output-format stream-json` transcript (development-plan §5.5).
//
// The bug this fixes: a `<BINDING>` manifest the agent prints lives INSIDE a
// stream-json text field, so in the raw stdout its JSON is escaped
// (`\"AC-S2-1\"`). Parsing the raw stream → JSON.parse fails → zero bindings →
// every AC stays unbound → the story "fails" despite green tests. Decoding the
// stream-json first (JSON.parse unescapes each event's text) yields the real,
// unescaped message text where `<BINDING>` parses cleanly.

/**
 * Concatenate the assistant's text from a stream-json transcript. Tolerates
 * non-JSON lines (logs) and partial streams. Prefers complete `assistant`
 * message blocks; falls back to streamed `text_delta`s and the final `result`
 * string when no assistant blocks are present (so we never miss the manifest).
 *
 * @param {string} raw  the accumulated stream-json stdout
 * @returns {string} the decoded assistant text
 */
export function extractAssistantText(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const assistantBlocks = [];
  const deltas = [];
  let resultText = '';

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }

    if (ev.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'text' && typeof block.text === 'string') assistantBlocks.push(block.text);
      }
    } else if (ev.type === 'stream_event') {
      const d = ev.event?.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') deltas.push(d.text);
    } else if (ev.type === 'result' && typeof ev.result === 'string') {
      resultText = ev.result;
    }
  }

  // Complete assistant blocks are authoritative + non-duplicated; only fall back
  // to deltas / result when there were none.
  if (assistantBlocks.length) return assistantBlocks.join('\n');
  if (deltas.length) return deltas.join('');
  return resultText;
}
