/**
 * _cover-utils.js — Utilità condivise per la ricerca di copertine
 *
 * Fonti usate (tutte gratuite, nessuna API key richiesta):
 *  1. Google Books  — ricerca per titolo+autore, fino a 5 cover candidate
 *  2. Open Library Search — ricerca per titolo+autore via cover_id, fino a 5 cover
 *  3. Open Library Works — tutte le edizioni di un'opera tramite Work OLID, fino a 8 cover
 *  4. Open Library ISBN  — copertina diretta per ISBN (fast path)
 *  5. Amazon CDN         — URL pubblico prevedibile da ISBN-10 (fallback per libri non in OL)
 */

const OL_COVER = 'https://covers.openlibrary.org/b'

// ── Helper: URL copertina da ID Open Library ──────────────────────────────────
export function olCoverFromId(id) {
  return `${OL_COVER}/id/${id}-L.jpg`
}

// ── Helper: ISBN-13 → ISBN-10 ─────────────────────────────────────────────────
export function isbn13to10(isbn13) {
  const digits = isbn13.replace(/\D/g, '')
  if (digits.length !== 13 || !digits.startsWith('978')) return null
  const body = digits.slice(3, 12)
  let sum = 0
  for (let i = 0; i < 9; i++) sum += (10 - i) * parseInt(body[i])
  const check = (11 - (sum % 11)) % 11
  return body + (check === 10 ? 'X' : String(check))
}

// ── Helper: URL copertina diretta da ISBN ─────────────────────────────────────
export async function olCoverFromIsbn(isbn) {
  try {
    const r = await fetch(`${OL_COVER}/isbn/${isbn}-L.jpg?default=false`,
      { method: 'HEAD', signal: AbortSignal.timeout(4000) })
    return r.ok ? `${OL_COVER}/isbn/${isbn}-L.jpg` : null
  } catch (_) { return null }
}

// ── Helper: copertina Amazon CDN da ISBN (fallback) ───────────────────────────
// Amazon serve le cover di quasi tutti i libri indicizzati via URL prevedibile.
// Non richiede API key ma funziona solo per libri nel catalogo Amazon.
export async function amazonCoverFromIsbn(isbn13) {
  const isbn10 = isbn13to10(isbn13)
  if (!isbn10) return null
  // Prova due formati CDN Amazon
  const urls = [
    `https://m.media-amazon.com/images/P/${isbn10}.jpg`,
    `https://images-na.ssl-images-amazon.com/images/P/${isbn10}.01.LZZZZZZZ.jpg`,
  ]
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(4000),
      })
      // Evita il placeholder "no image" di Amazon (~807 bytes)
      const size = parseInt(r.headers.get('content-length') || '0')
      if (r.ok && size > 2000) return url
    } catch (_) {}
  }
  return null
}

// ── 1. Google Books — ricerca per titolo+autore ───────────────────────────────
export async function fetchGoogleBooksCovers(title, author) {
  try {
    const q = encodeURIComponent(`intitle:${title}${author ? ` inauthor:${author}` : ''}`)
    const key = process.env.GOOGLE_BOOKS_API_KEY
    const url = key
      ? `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=8&key=${key}`
      : `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=8`
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return []
    const data = await r.json()
    const covers = []
    for (const item of (data.items || [])) {
      const links = item.volumeInfo?.imageLinks
      if (!links) continue
      let url = links.extraLarge || links.large || links.medium || links.thumbnail || null
      if (url) {
        url = url.replace('&edge=curl', '').replace(/^http:\/\//, 'https://')
        // Upgrade thumbnail → large sostituendo zoom=1 con zoom=3
        url = url.replace('zoom=1', 'zoom=3')
        if (!covers.includes(url)) covers.push(url)
      }
      if (covers.length >= 5) break
    }
    return covers
  } catch (_) { return [] }
}

// ── 2. Open Library Search — ricerca per titolo+autore ───────────────────────
export async function fetchOpenLibrarySearchCovers(title, author) {
  try {
    const titleParam = encodeURIComponent(title)
    const authorParam = author ? `&author=${encodeURIComponent(author)}` : ''
    const url = `https://openlibrary.org/search.json?title=${titleParam}${authorParam}&fields=cover_i&limit=10`
    const r = await fetch(url, {
      headers: { 'User-Agent': 'AiBooks/1.0' },
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok) return []
    const data = await r.json()
    const covers = []
    for (const doc of (data.docs || [])) {
      if (doc.cover_i && doc.cover_i !== -1) {
        const url = olCoverFromId(doc.cover_i)
        if (!covers.includes(url)) covers.push(url)
      }
      if (covers.length >= 5) break
    }
    return covers
  } catch (_) { return [] }
}

// ── 3. Open Library Works — tutte le edizioni di un'opera ────────────────────
// Richiede il Work OLID (es. "OL1234W"), restituisce cover dalle prime edizioni
export async function fetchOpenLibraryWorkCovers(workOlid) {
  if (!workOlid) return []
  try {
    const url = `https://openlibrary.org/works/${workOlid}/editions.json?limit=30`
    const r = await fetch(url, {
      headers: { 'User-Agent': 'AiBooks/1.0' },
      signal: AbortSignal.timeout(7000),
    })
    if (!r.ok) return []
    const data = await r.json()
    const covers = []
    for (const edition of (data.entries || [])) {
      for (const coverId of (edition.covers || [])) {
        if (coverId > 0) {
          const url = olCoverFromId(coverId)
          if (!covers.includes(url)) covers.push(url)
        }
        if (covers.length >= 8) break
      }
      if (covers.length >= 8) break
    }
    return covers
  } catch (_) { return [] }
}

// ── Estrattore Work OLID da risposta Open Library edition ────────────────────
export function extractWorkOlid(olEditionData) {
  // olEditionData.works = [{ key: "/works/OL1234W" }]
  const key = olEditionData?.works?.[0]?.key
  if (!key) return null
  return key.split('/').pop() || null  // → "OL1234W"
}

// ── Helper: verifica che un URL restituisca un'immagine reale (non un placeholder) ─
// I placeholder "image not available" di Google Books / Open Library sono tipicamente
// sotto i 5 KB. Le cover reali superano quasi sempre i 10 KB.
async function isRealCover(url, minBytes = 5000) {
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'AiBooks/1.0' },
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) return false
    const contentType = r.headers.get('content-type') || ''
    if (!contentType.startsWith('image/')) return false
    const size = parseInt(r.headers.get('content-length') || '0')
    // Se content-length non è dichiarato lasciamo passare (Open Library non lo mette sempre)
    if (size > 0 && size < minBytes) return false
    return true
  } catch (_) { return false }
}

// ── Master: aggrega tutte le fonti ───────────────────────────────────────────
// title, author: per la ricerca per testo
// existingCover: eventuale copertina già nota (viene messa prima)
// workOlid: se disponibile, aggiunge le cover di tutte le edizioni
// isbn13: se disponibile, usato come fallback Amazon CDN
export async function fetchAllCovers(title, author, existingCover, workOlid, isbn13) {
  const candidates = []
  if (existingCover) candidates.push(existingCover)

  if (title) {
    // Lancia le tre ricerche per testo in parallelo
    const [gbSettled, olSearchSettled, olWorkSettled] = await Promise.allSettled([
      fetchGoogleBooksCovers(title, author),
      fetchOpenLibrarySearchCovers(title, author),
      fetchOpenLibraryWorkCovers(workOlid),
    ])

    const gbCovers  = gbSettled.status === 'fulfilled'       ? gbSettled.value       : []
    const olSCovers = olSearchSettled.status === 'fulfilled' ? olSearchSettled.value : []
    const olWCovers = olWorkSettled.status === 'fulfilled'   ? olWorkSettled.value   : []

    // Interleave GB + OL-Search per varietà di stile
    const maxAB = Math.max(gbCovers.length, olSCovers.length)
    for (let i = 0; i < maxAB && candidates.length < 10; i++) {
      if (gbCovers[i]  && !candidates.includes(gbCovers[i]))  candidates.push(gbCovers[i])
      if (olSCovers[i] && !candidates.includes(olSCovers[i])) candidates.push(olSCovers[i])
    }

    // Aggiungi copertine da edizioni (Work API) — varietà di edizioni diverse
    for (const u of olWCovers) {
      if (!candidates.includes(u)) candidates.push(u)
      if (candidates.length >= 12) break
    }
  }

  // Fallback Amazon CDN — utile per libri non in OL (es. piccoli editori italiani)
  if (candidates.length === 0 && isbn13) {
    const amazonUrl = await amazonCoverFromIsbn(isbn13)
    if (amazonUrl) candidates.push(amazonUrl)
  }

  // ── Filtra i placeholder: verifica in parallelo che ogni URL sia un'immagine reale ──
  if (candidates.length === 0) return []
  const validationResults = await Promise.allSettled(
    candidates.map(url => isRealCover(url))
  )
  const covers = candidates.filter((_, i) =>
    validationResults[i].status === 'fulfilled' && validationResults[i].value === true
  )

  return covers
}
