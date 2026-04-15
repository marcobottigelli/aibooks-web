// api/isbn-lookup.js — ISBN lookup con Google Books + Open Library + OpenAI per metadati
export const config = { maxDuration: 30 }

async function aiLookupMeta(titolo, autori, isbn) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || !titolo) return { casa_editrice: null, genere: null }
  try {
    const autoreStr = Array.isArray(autori) ? autori.join(', ') : (autori || '')
    const prompt =
      `Libro: "${titolo}"${autoreStr ? ` di ${autoreStr}` : ''} (ISBN ${isbn}).\n` +
      `Rispondi SOLO con un oggetto JSON con questi due campi:\n` +
      `- "casa_editrice": nome della casa editrice italiana (es. "Iperborea", "Mondadori", "Einaudi")\n` +
      `- "genere": genere letterario in italiano (es. "Narrativa", "Romanzo", "Thriller", "Saggistica", "Biografia")\n` +
      `Usa null per i campi di cui non sei sicuro. Nessun testo fuori dal JSON.`
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 60,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return { casa_editrice: null, genere: null }
    const data = await r.json()
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}')
    return { casa_editrice: parsed.casa_editrice || null, genere: parsed.genere || null }
  } catch (_) {
    return { casa_editrice: null, genere: null }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

  const { isbn } = req.body
  if (!isbn) return res.status(400).json({ error: 'isbn mancante' })

  const cleanIsbn = isbn.replace(/[-\s]/g, '')
  if (!/^\d{10,13}$/.test(cleanIsbn)) return res.status(400).json({ error: 'ISBN non valido' })
  const TIMEOUT = 6000

  const gbUrl = process.env.GOOGLE_BOOKS_API_KEY
    ? `https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}&key=${process.env.GOOGLE_BOOKS_API_KEY}`
    : `https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}`

  const [gbSettled, olSettled] = await Promise.allSettled([
    fetch(gbUrl,      { headers: { 'User-Agent': 'AiBooks/1.0' }, signal: AbortSignal.timeout(TIMEOUT) }),
    fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`,
          { headers: { 'User-Agent': 'AiBooks/1.0' }, signal: AbortSignal.timeout(TIMEOUT) }),
  ])

  let gbData = null, olBook = null

  if (gbSettled.status === 'fulfilled' && gbSettled.value.ok) {
    try { gbData = await gbSettled.value.json() } catch (_) {}
  }
  if (olSettled.status === 'fulfilled' && olSettled.value.ok) {
    try {
      const olRaw = await olSettled.value.json()
      olBook = olRaw[`ISBN:${cleanIsbn}`] || null
    } catch (_) {}
  }

  // ── 1. Google Books ──────────────────────────────────────────────────────────
  if (gbData?.totalItems > 0 && gbData.items?.[0]?.volumeInfo) {
    const v = gbData.items[0].volumeInfo
    let copertina = null
    if (v.imageLinks) {
      copertina = (v.imageLinks.large || v.imageLinks.medium || v.imageLinks.thumbnail || null)
      if (copertina) copertina = copertina.replace('&edge=curl', '').replace(/^http:\/\//, 'https://')
    }
    const anno = v.publishedDate ? parseInt(v.publishedDate.substring(0, 4)) || null : null
    const aiMeta = await aiLookupMeta(v.title, v.authors, cleanIsbn)
    return res.json({
      source: 'google-books', titolo: v.title || null, autore: v.authors || [],
      casa_editrice: v.publisher || olBook?.publishers?.[0]?.name || aiMeta.casa_editrice,
      anno_pubblicazione: anno, descrizione: v.description || null, copertina,
      genere: aiMeta.genere ? [aiMeta.genere] : [],
      lingua_originale: v.language || null, pagine: v.pageCount || null,
    })
  }

  // ── 2. Open Library Books API ─────────────────────────────────────────────
  if (olBook?.title) {
    const autori = (olBook.authors || []).map(a => a.name).filter(Boolean)
    const aiMeta = await aiLookupMeta(olBook.title, autori, cleanIsbn)
    const anno = olBook.publish_date ? parseInt(String(olBook.publish_date).match(/\d{4}/)?.[0]) || null : null
    let copertina = null
    try {
      const cr = await fetch(`https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg?default=false`,
        { method: 'HEAD', signal: AbortSignal.timeout(3000) })
      if (cr.ok) copertina = `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`
    } catch (_) {}
    return res.json({
      source: 'open-library', titolo: olBook.title || null, autore: autori,
      casa_editrice: olBook.publishers?.[0]?.name || aiMeta.casa_editrice,
      anno_pubblicazione: anno, descrizione: null, copertina,
      genere: aiMeta.genere ? [aiMeta.genere] : [], lingua_originale: null,
      pagine: olBook.number_of_pages || null,
    })
  }

  // ── 3. Open Library edition endpoint ─────────────────────────────────────
  try {
    const r = await fetch(`https://openlibrary.org/isbn/${cleanIsbn}.json`,
      { headers: { 'User-Agent': 'AiBooks/1.0' }, signal: AbortSignal.timeout(5000) })
    if (r.ok) {
      const data = await r.json()
      if (data.title) {
        let autori = []
        if (Array.isArray(data.authors)) {
          const resolved = await Promise.all(
            data.authors.slice(0, 3).map(async (a) => {
              try {
                const ar = await fetch(`https://openlibrary.org${a.key}.json`, { signal: AbortSignal.timeout(3000) })
                if (ar.ok) { const ad = await ar.json(); return ad.name || ad.personal_name || null }
              } catch (_) {}
              return null
            })
          )
          autori = resolved.filter(Boolean)
        }
        let copertina = null
        try {
          const cr = await fetch(`https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg?default=false`,
            { method: 'HEAD', signal: AbortSignal.timeout(3000) })
          if (cr.ok) copertina = `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`
        } catch (_) {}
        const anno = data.publish_date ? parseInt(String(data.publish_date).match(/\d{4}/)?.[0]) || null : null
        const lingua = data.languages?.[0]?.key?.split('/').pop() || null
        const descrizione = data.description
          ? (typeof data.description === 'string' ? data.description : data.description.value || null)
          : null
        const aiMeta = await aiLookupMeta(data.title, autori, cleanIsbn)
        return res.json({
          source: 'open-library', titolo: data.title || null, autore: autori,
          casa_editrice: data.publishers?.[0] || aiMeta.casa_editrice,
          anno_pubblicazione: anno, descrizione, copertina,
          genere: aiMeta.genere ? [aiMeta.genere] : [], lingua_originale: lingua,
          pagine: data.number_of_pages || null,
        })
      }
    }
  } catch (e) { console.error('[OL edition]', e.message) }

  return res.status(404).json({ error: 'not_found' })
}
