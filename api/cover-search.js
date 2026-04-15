// api/cover-search.js — Cerca copertina per ISBN su Google Books e Open Library
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

  const { isbn } = req.body
  if (!isbn) return res.status(400).json({ error: 'isbn mancante' })

  const cleanIsbn = isbn.replace(/[-\s]/g, '')
  if (!/^\d{10,13}$/.test(cleanIsbn)) return res.status(400).json({ error: 'ISBN non valido' })

  try {
    const gbUrl = process.env.GOOGLE_BOOKS_API_KEY
      ? `https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}&fields=items(volumeInfo/imageLinks)&key=${process.env.GOOGLE_BOOKS_API_KEY}`
      : `https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}&fields=items(volumeInfo/imageLinks)`
    const r = await fetch(gbUrl, { headers: { 'User-Agent': 'AiBooks/1.0' }, signal: AbortSignal.timeout(5000) })
    if (r.ok) {
      const data = await r.json()
      const links = data.items?.[0]?.volumeInfo?.imageLinks
      if (links) {
        let url = links.extraLarge || links.large || links.medium || links.thumbnail || null
        if (url) {
          url = url.replace('&edge=curl', '').replace(/^http:\/\//, 'https://')
          return res.json({ source: 'google-books', url })
        }
      }
    }
  } catch (_) {}

  try {
    const r = await fetch(`https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg?default=false`,
      { method: 'HEAD', signal: AbortSignal.timeout(4000) })
    if (r.ok) return res.json({ source: 'open-library', url: `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg` })
  } catch (_) {}

  return res.status(404).json({ error: 'not_found' })
}
