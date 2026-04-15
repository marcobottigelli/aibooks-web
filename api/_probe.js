// Endpoint temporaneo per testare disponibilità modelli OpenAI — DA ELIMINARE DOPO IL TEST
export const config = { maxDuration: 15 }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method !== 'POST') return res.status(405).end()
  const { model } = req.body
  if (!model) return res.status(400).json({ error: 'model mancante' })
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'no key' })
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Rispondi solo con il nome del modello che sei.' }],
        max_tokens: 30,
      }),
      signal: AbortSignal.timeout(10000),
    })
    const data = await r.json()
    if (!r.ok) return res.json({ exists: false, error: data.error?.message })
    return res.json({ exists: true, reply: data.choices?.[0]?.message?.content, model_used: data.model })
  } catch (e) {
    return res.json({ exists: false, error: e.message })
  }
}
