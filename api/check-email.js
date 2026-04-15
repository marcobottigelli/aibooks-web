// api/check-email.js — Verifica se un'email è già registrata (solo signup)
// Usa la service role key per accedere all'Admin API di Supabase.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

  const { email } = req.body
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email mancante' })

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Config server mancante' })

  try {
    const r = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email.trim().toLowerCase())}`,
      {
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
        },
      }
    )
    if (!r.ok) return res.status(500).json({ error: 'Errore Supabase' })
    const data = await r.json()
    const exists = Array.isArray(data.users) ? data.users.length > 0 : false
    return res.json({ exists })
  } catch (e) {
    console.error('[check-email]', e.message)
    return res.status(500).json({ error: 'Errore interno' })
  }
}
