// api/cover-lookup.js — Riconoscimento libri da foto via GPT-4o-mini Vision
export const config = { maxDuration: 30 }

import { fetchAllCovers, extractWorkOlid } from './_cover-utils.js'

// ── Lookup per ISBN — restituisce dati + array di copertine candidate ─────────
async function lookupByIsbn(isbn) {
  const cleanIsbn = isbn.replace(/[-\s]/g, '')
  if (!/^\d{10,13}$/.test(cleanIsbn)) return null

  const key = process.env.GOOGLE_BOOKS_API_KEY
  const gbUrl = key
    ? `https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}&key=${key}`
    : `https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}`

  try {
    const [gbSettled, olSettled] = await Promise.allSettled([
      fetch(gbUrl, { signal: AbortSignal.timeout(6000) }),
      fetch(`https://openlibrary.org/isbn/${cleanIsbn}.json`,
        { headers: { 'User-Agent': 'AiBooks/1.0' }, signal: AbortSignal.timeout(6000) }),
    ])

    let gbResult = null, workOlid = null

    if (gbSettled.status === 'fulfilled' && gbSettled.value.ok) {
      const data = await gbSettled.value.json().catch(() => null)
      if (data?.totalItems > 0 && data.items?.[0]?.volumeInfo) {
        gbResult = buildFromGoogleBooks(data.items[0].volumeInfo, cleanIsbn)
      }
    }

    if (olSettled.status === 'fulfilled' && olSettled.value.ok) {
      const olData = await olSettled.value.json().catch(() => null)
      workOlid = extractWorkOlid(olData)
    }

    if (gbResult) {
      const covers = await fetchAllCovers(gbResult.titolo, gbResult.autore?.[0], gbResult.copertina, workOlid, cleanIsbn)
      return { ...gbResult, covers }
    }
  } catch (_) {}
  return null
}

// ── Lookup per titolo+autore ──────────────────────────────────────────────────
async function lookupByText(title, author) {
  const q = encodeURIComponent(`intitle:${title}${author ? ` inauthor:${author}` : ''}`)
  const key = process.env.GOOGLE_BOOKS_API_KEY
  const url = key
    ? `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&key=${key}`
    : `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return null
    const data = await r.json()
    if (!data.totalItems || !data.items?.[0]?.volumeInfo) return null
    const v = data.items[0].volumeInfo
    const isbn = v.industryIdentifiers?.find(i => i.type === 'ISBN_13' || i.type === 'ISBN_10')?.identifier || null
    const result = buildFromGoogleBooks(v, isbn)
    const covers = await fetchAllCovers(result.titolo, result.autore?.[0], result.copertina, null)
    return { ...result, covers }
  } catch (_) { return null }
}

function buildFromGoogleBooks(v, isbn) {
  let copertina = null
  if (v.imageLinks) {
    copertina = v.imageLinks.extraLarge || v.imageLinks.large || v.imageLinks.medium || v.imageLinks.thumbnail || null
    if (copertina) copertina = copertina.replace('&edge=curl', '').replace(/^http:\/\//, 'https://')
  }
  const anno = v.publishedDate ? parseInt(v.publishedDate.substring(0, 4)) || null : null
  return {
    source: 'google-books',
    isbn: isbn || null,
    titolo: v.title || null,
    autore: v.authors || [],
    casa_editrice: v.publisher || null,
    anno_pubblicazione: anno,
    descrizione: v.description || null,
    copertina,
    covers: copertina ? [copertina] : [],
    genere: [],
    lingua_originale: v.language || null,
    pagine: v.pageCount || null,
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

  const { imageBase64, mimeType = 'image/jpeg' } = req.body
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 mancante' })

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Chiave OpenAI non configurata' })

  // 1. GPT-4o-mini Vision — riconosce i libri nell'immagine
  let recognized = []
  try {
    const visionRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' },
            },
            {
              type: 'text',
              text: `Guarda questa immagine. Identifica tutti i libri visibili (copertina o costa di scaffale).
Per ogni libro restituisci un oggetto con:
- "title": titolo esatto (stringa)
- "author": autore principale (stringa o null se non visibile)
- "isbn": ISBN se visibile nell'immagine come numero (stringa, solo cifre, o null)
- "confidence": "high" se titolo chiaramente leggibile, "medium" se probabile, "low" se incerto

Rispondi ESCLUSIVAMENTE con un array JSON valido, senza testo aggiuntivo.
Se non vedi alcun libro: []`,
            },
          ],
        }],
        max_tokens: 600,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(20000),
    })

    if (!visionRes.ok) {
      const err = await visionRes.json().catch(() => ({}))
      console.error('[cover-lookup] OpenAI error:', err.error?.message)
      return res.status(500).json({ error: 'Errore nel riconoscimento visivo' })
    }

    const visionData = await visionRes.json()
    const raw = (visionData.choices?.[0]?.message?.content || '[]').trim()
    const cleaned = raw.replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim()
    const parsed = JSON.parse(cleaned)
    recognized = Array.isArray(parsed) ? parsed : []
  } catch (e) {
    console.error('[cover-lookup] vision parse error:', e.message)
    return res.status(500).json({ error: 'Errore nel riconoscimento visivo' })
  }

  if (recognized.length === 0) return res.json({ books: [] })

  // 2. Arricchisce ogni libro con metadati + array di copertine candidate
  const books = await Promise.all(
    recognized.slice(0, 12).map(async (item) => {
      const base = {
        ai_title: item.title || null,
        ai_author: item.author || null,
        confidence: item.confidence || 'medium',
      }

      if (item.isbn) {
        const byIsbn = await lookupByIsbn(item.isbn)
        if (byIsbn) return { ...base, ...byIsbn }
      }

      if (item.title) {
        const byText = await lookupByText(item.title, item.author)
        if (byText) return { ...base, ...byText }
      }

      // Fallback: solo AI, cerca comunque copertine per titolo
      const covers = await fetchAllCovers(item.title, item.author, null, null)
      return {
        ...base,
        source: 'ai-only',
        isbn: null,
        titolo: item.title || null,
        autore: item.author ? [item.author] : [],
        casa_editrice: null,
        anno_pubblicazione: null,
        descrizione: null,
        copertina: covers[0] || null,
        covers,
        genere: [],
        lingua_originale: null,
        pagine: null,
      }
    })
  )

  return res.json({ books })
}
