// api/chat.js — Chatbot AI con contesto libreria utente
// La chiave OpenAI viene letta dalla variabile d'ambiente OPENAI_API_KEY.
// I libri dell'utente vengono inviati dal client nel body della richiesta.

export const config = { maxDuration: 60 }

// ─────────────────────────────────────────────────────────────────────────────
// REGOLA DI AUTO-VERIFICA — richiamata nel system prompt per ogni titolo proposto
// ─────────────────────────────────────────────────────────────────────────────
const REGOLA_AUTO_VERIFICA = `
══ FASE 0 — CONSOLIDA I VINCOLI (eseguila PRIMA di proporre qualsiasi titolo) ══

Analizza l'intera conversazione ed identifica OGNI vincolo espresso dall'utente,
sia dalle scelte dei menu che da qualsiasi testo libero scritto in qualunque momento.
Questi vincoli alimentano la riga "🔍 Sto cercando:" che DEVI scrivere nel PASSO 1 della risposta.

Vincoli da estrarre e trattare tutti come OBBLIGATORI:
  • Genere, tipo di lettura, epoca → da D1/D2/D3
  • Destinazione geografica → da D2b o da testo libero (es. "ambientati in Giappone")
  • Ambito biografico / sottogenere → da D2c, D2c_sub, D2d o da testo libero
  • Libri citati come riferimento → analizza genere, stile, tono; usali per calibrare la ricerca
  • Autori citati come riferimento → calibra stile e densità narrativa di conseguenza
  • Autori da evitare → ESCLUDI qualsiasi loro libro, senza eccezioni
  • Qualsiasi altra preferenza espressa (ambientazione, tema, periodo, tipo di personaggi, ecc.)

REGOLA ASSOLUTA SUL TESTO LIBERO:
Un vincolo espresso in forma libera vale ESATTAMENTE come un vincolo scelto dal menu.
Esempio: "vorrei libri ambientati a Lisbona simili a X o Y dell'autore N" →
  - TUTTI i libri proposti devono essere ambientati a Lisbona
  - TUTTI devono essere coerenti con lo stile di X/Y
  - NON puoi includere libri che soddisfano solo alcuni vincoli e non altri
Un libro che non soddisfa anche solo uno dei vincoli estratti viene SCARTATO, non incluso con una nota.

══ REGOLA DI AUTO-VERIFICA — OBBLIGATORIA PER OGNI TITOLO ══

Un titolo viene proposto SOLO SE soddisfa CONTEMPORANEAMENTE TUTTE E TRE le condizioni:

CONDIZIONE A — CRITERI SELEZIONATI (tutti devono essere soddisfatti):
  □ Il libro appartiene al genere indicato (narrativa, viaggio, saggistica, autobiografia…)?
  □ Se è stata indicata una destinazione geografica (dal menu O da testo libero): il libro riguarda
     QUELLA destinazione specifica? (Es: "Messico" → ambientato in Messico, non in altri paesi)
  □ Se è stato indicato un ambito biografico: il protagonista è di quell'ambito?
  □ Il libro rispetta le preferenze di lettura (leggera/impegnativa) e di epoca indicate?
  □ Il libro rispetta TUTTI i vincoli aggiuntivi estratti nella FASE 0?

CONDIZIONE B — GUSTI PERSONALI (deve essere soddisfatta):
  □ Il libro risuona con lo stile, i temi o la sensibilità dei libri a 5★ dell'utente?
     Confronta esplicitamente: autore simile, densità narrativa analoga, temi affini, stesso tipo di emozione.

CONDIZIONE C — VERIFICA ANTI-ALLUCINAZIONE (CRITICA — non saltare mai):
  Questa condizione esiste perché i modelli AI commettono errori specifici sui libri:
  inventano titoli che non esistono, oppure attribuiscono libri reali ad autori sbagliati.
  Esempi di errori VIETATI (accaduti realmente):
    ✗ "Le farfalle di Sarajevo" attribuito a David Albahari — titolo/abbinamento non verificato
    ✗ "Il dolore di Sarajevo" di Serif Patkovic — autore probabilmente inventato

  Per ogni titolo che stai per proporre, rispondi mentalmente a TUTTE queste domande:
  □ Questo libro esiste davvero con QUESTO ESATTO TITOLO? (non una variante, non una traduzione approssimativa)
  □ Questo autore ha DAVVERO scritto QUESTO libro? (non un libro simile, non un altro libro dello stesso autore)
  □ Sono certo al 100% di questo abbinamento titolo↔autore, senza margine di dubbio?
  □ Ricordo l'anno (anche solo il decennio) di prima pubblicazione di questo libro?
     Se non riesco a ricordarlo, è un segnale che il mio ricordo è impreciso → scarta.

  Se la risposta a UNA QUALSIASI di queste domande è "non sono sicuro" o "forse":
  → SCARTA immediatamente il titolo. Non proporlo. Non "rischiare". Non lasciarlo con una nota di incertezza.
  → Sostituiscilo con un titolo di cui sei COMPLETAMENTE certo.

  Regola d'oro: è preferibile proporre 4 titoli verificati al 100% piuttosto che 8 titoli
  di cui alcuni potrebbero essere inventati o mal attribuiti.

→ Se TUTTE E TRE le condizioni A, B e C sono soddisfatte: aggiungi il titolo.
→ Se anche solo UNA condizione non è soddisfatta: scarta il titolo e trovane un altro.
→ Obiettivo: 8-10 titoli. Se applicando questi criteri riesci a trovarne solo 5 di alta qualità, proponi 5.
   MAI scendere sotto 5. MAI allentare i criteri per arrivare a 10: qualità > quantità.

Applica questa verifica a CIASCUN titolo individualmente, in sequenza, prima di includerlo nell'elenco.
`

// Sanitizza una stringa per l'inserimento nel system prompt (anti prompt-injection)
function sanitize(str) {
  if (!str) return ''
  return String(str).replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E\u00C0-\u024F]/g, c => c).slice(0, 300)
}

// ── Estrazione vincoli chiave dalla cronologia messaggi (pura JS, senza AI) ───
// Rileva la risposta dell'utente alla domanda D2b (destinazione geografica)
// e qualsiasi altro vincolo esplicito scritto in forma libera.
function extractKeyConstraints(messages) {
  const constraints = {}

  // Pattern multilingua per la domanda D2b
  const D2B_PATTERNS = [
    'destinazione geografica', 'geographical destination', 'destination géographique',
    'destino geográfico', 'geografisches Ziel', 'bestemming',
  ]

  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue

    const isD2b = D2B_PATTERNS.some(p => msg.content.toLowerCase().includes(p))
    if (!isD2b) continue

    const next = messages[i + 1]
    if (next?.role !== 'user') continue

    const v = next.content.trim()
    // Scarta risposte che significano "non importa"
    const isSkip = !v || v === '1' || /non importa|doesn.t matter|peu importe|no importa|egal/i.test(v)
    if (!isSkip && v.length < 120) {
      constraints.destinazione = sanitize(v)
    }
  }

  return constraints
}

// ── Fase 1: chiede all'AI una lista candidati in JSON strutturato ─────────────
// Usa response_format json_object per avere output affidabile da parsare.
// Ritorna [] se la conversazione è ancora nella fase domande (D1-D4 incompleta).
async function getBookCandidates(systemPrompt, messages, apiKey, constraints = {}) {
  // Vincoli estratti server-side — iniettati in cima per massima priorità
  const constraintBlock = constraints.destinazione
    ? `\n⚠ VINCOLO DESTINAZIONE — NON NEGOZIABILE:\n` +
      `Ogni libro candidato DEVE essere ambientato a ${constraints.destinazione} o riguardarla direttamente.\n` +
      `Un libro NON ambientato a ${constraints.destinazione} NON deve apparire nella lista, anche se reale.\n`
    : ''

  const suffix = constraintBlock + `

══ MODALITÀ RICERCA CANDIDATI ══
Rispondi ESCLUSIVAMENTE con un oggetto JSON nel formato: {"libri": [...]}
Se la conversazione è ancora nella fase domande (D1-D4 non ancora completata),
rispondi con {"libri": []}.
Se invece tutte le domande sono state poste e l'utente ha dato la risposta finale
(es. "No grazie, procedi", oppure ha scritto dettagli aggiuntivi), fornisci 15 candidati.
Applica FASE 0, Condizioni A, B, C a ciascuno prima di includerlo.
Ogni elemento dell'array DEVE avere ESATTAMENTE questi campi:
  "titolo_italiano"  — titolo come si chiama in italiano (traduzione o originale italiano)
  "titolo_originale" — titolo ESATTO nella lingua originale di pubblicazione
  "autore"           — "Nome Cognome" dell'autore principale
  "anno"             — anno di prima pubblicazione (numero intero, es. 1985)`

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [
          { role: 'system', content: systemPrompt + suffix },
          ...messages.slice(-14),
        ],
        max_completion_tokens: 1100,
        temperature: 0.35,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(22000),
    })
    if (!res.ok) return []
    const data = await res.json()
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}')
    return Array.isArray(parsed.libri) ? parsed.libri : []
  } catch (_) {
    return []
  }
}

// ── Alias geografici per la verifica della destinazione ──────────────────────
// Mappa le destinazioni comuni alle keyword rilevanti in inglese e italiano.
const DEST_KEYWORDS = {
  'istanbul':    ['istanbul', 'stamboul', 'stambul', 'constantinople', 'costantinopoli', 'byzantium', 'byzantine', 'bisanzio', 'ottoman', 'ottomano', 'turkey', 'turchia', 'turkish', 'turco', 'bosphorus', 'bosphore', 'bosforo', 'anatolia', 'anatolian', 'topkapi', 'galata', 'beyoglu'],
  'parigi':      ['paris', 'parigi', 'france', 'francia', 'french', 'francese', 'seine', 'senna', 'montmartre', 'montparnasse', 'marais', 'louvre'],
  'paris':       ['paris', 'parigi', 'france', 'francia', 'french', 'francese', 'seine', 'montmartre'],
  'londra':      ['london', 'londra', 'england', 'inghilterra', 'britain', 'british', 'english', 'thames', 'tamigi', 'soho', 'whitechapel'],
  'london':      ['london', 'londra', 'england', 'inghilterra', 'britain', 'british', 'thames'],
  'tokyo':       ['tokyo', 'japan', 'giappone', 'japanese', 'giapponese', 'edo', 'kyoto', 'osaka', 'shinjuku'],
  'giappone':    ['japan', 'giappone', 'japanese', 'giapponese', 'tokyo', 'kyoto', 'osaka', 'edo', 'samurai'],
  'new york':    ['new york', 'manhattan', 'brooklyn', 'bronx', 'harlem', 'nyc'],
  'roma':        ['rome', 'roma', 'roman', 'romano', 'italy', 'italia', 'trastevere', 'vaticano', 'colosseo'],
  'rome':        ['rome', 'roma', 'roman', 'italy', 'italia', 'trastevere'],
  'berlino':     ['berlin', 'berlino', 'germany', 'germania', 'german', 'tedesco', 'weimar', 'reichstag'],
  'berlin':      ['berlin', 'berlino', 'germany', 'germania', 'german'],
  'madrid':      ['madrid', 'spain', 'spagna', 'spanish', 'spagnolo', 'castilla', 'iberia'],
  'india':       ['india', 'indian', 'indiano', 'bombay', 'mumbai', 'delhi', 'calcutta', 'kolkata', 'ganges', 'gange', 'rajasthan', 'bengal'],
  'cina':        ['china', 'cina', 'chinese', 'cinese', 'beijing', 'shanghai', 'peking', 'yangtze', 'canton'],
  'china':       ['china', 'cina', 'chinese', 'beijing', 'shanghai', 'peking'],
  'messico':     ['mexico', 'messico', 'mexican', 'messicano', 'aztec', 'azteco', 'maya', 'oaxaca'],
  'mexico':      ['mexico', 'messico', 'mexican', 'aztec', 'maya'],
  'argentina':   ['argentina', 'argentine', 'argentino', 'buenos aires', 'patagonia', 'pampas'],
  'grecia':      ['greece', 'grecia', 'greek', 'greco', 'athens', 'atene', 'aegean', 'egeo', 'hellas', 'olimpo'],
  'marocco':     ['morocco', 'marocco', 'moroccan', 'marrakech', 'marrakesh', 'fez', 'casablanca', 'sahara', 'maghreb'],
  'iran':        ['iran', 'persia', 'persian', 'persiano', 'tehran', 'isfahan', 'shiraz'],
  'egitto':      ['egypt', 'egitto', 'egyptian', 'egiziano', 'cairo', 'nile', 'nilo', 'faraone', 'pharaoh'],
  'egypt':       ['egypt', 'egitto', 'egyptian', 'cairo', 'nile', 'pharaoh'],
  'vietnam':     ['vietnam', 'vietnamese', 'saigon', 'hanoi', 'indochina', 'indocina', 'mekong'],
  'cuba':        ['cuba', 'cuban', 'cubano', 'havana', 'avana', 'caribbean', 'caraibi'],
  'israele':     ['israel', 'israele', 'jerusalem', 'gerusalemme', 'tel aviv', 'palestina', 'palestine'],
  'barcellona':  ['barcelona', 'barcellona', 'catalonia', 'catalogna', 'catalan', 'catalano', 'gothic quarter', 'barri gotic', 'sagrada familia', 'gaudi', 'ramblas'],
  'barcelona':   ['barcelona', 'barcellona', 'catalonia', 'catalogna', 'catalan', 'gaudi', 'ramblas'],
  'vienna':      ['vienna', 'wien', 'austria', 'austrian', 'austriaco', 'danube', 'danubio', 'habsburg', 'asburgo'],
  'lisbona':     ['lisbon', 'lisbona', 'portugal', 'portogallo', 'portuguese', 'portoghese', 'tejo', 'tagus', 'fado', 'alfama'],
  'lisbon':      ['lisbon', 'lisbona', 'portugal', 'portogallo', 'tejo', 'fado', 'alfama'],
  'praga':       ['prague', 'praga', 'czech', 'ceco', 'bohemia', 'boemia', 'kafka', 'moldau', 'moldava'],
  'prague':      ['prague', 'praga', 'czech', 'bohemia', 'kafka', 'moldau'],
  'budapest':    ['budapest', 'hungary', 'ungheria', 'hungarian', 'ungherese', 'danube', 'danubio'],
  'mosca':       ['moscow', 'mosca', 'russia', 'russian', 'russo', 'kremlin', 'cremlino', 'siberia'],
  'moscow':      ['moscow', 'mosca', 'russia', 'russian', 'kremlin'],
  'amsterdam':   ['amsterdam', 'netherlands', 'olanda', 'dutch', 'olandese', 'holland', 'canal', 'canale'],
  'dubai':       ['dubai', 'uae', 'emirates', 'emirati', 'persian gulf', 'golfo persico'],
  'bangkok':     ['bangkok', 'thailand', 'tailandia', 'thai', 'siam', 'mekong'],
  'sydney':      ['sydney', 'australia', 'australian', 'australiano', 'outback'],
}

function getDestinationKeywords(dest) {
  const d = dest.toLowerCase().trim()
  // Cerca prima una corrispondenza esatta, poi controlla se la chiave è una sottostringa
  if (DEST_KEYWORDS[d]) return DEST_KEYWORDS[d]
  for (const [key, kws] of Object.entries(DEST_KEYWORDS)) {
    if (d.includes(key) || key.includes(d)) return kws
  }
  return [d] // fallback: la destinazione stessa come keyword
}

// ── Confronto titoli: verifica che il titolo trovato corrisponda a quello cercato ─
// Normalizza, rimuove articoli e punteggiatura, poi controlla sovrapposizione parole.
function titlesMatch(candidate, found) {
  const stop = new Set(['il','lo','la','i','gli','le','un','una','uno','the','a','an',
    'de','del','della','dei','degli','delle','di','da','in','e','ed','el','les','der','die','das'])
  const norm = s => (s || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w))
  const cWords = norm(candidate)
  const fWords = new Set(norm(found))
  if (cWords.length === 0 || fWords.size === 0) return false
  // Corrispondenza esatta normalizzata
  if (cWords.join(' ') === [...fWords].join(' ')) return true
  // Il titolo trovato contiene come sottostringa quello cercato (titoli tradotti/abbreviati)
  const fStr = [...fWords].join(' ')
  const cStr = cWords.join(' ')
  if (fStr.includes(cStr) || cStr.includes(fStr)) return true
  // Almeno il 55% delle parole significative del candidato compaiono nel trovato
  const matches = cWords.filter(w => fWords.has(w))
  return matches.length / cWords.length >= 0.55
}

// ── Fase 2: verifica un libro contro Google Books + Open Library ──────────────
// Controlla sia l'esistenza che la corrispondenza del titolo — evita falsi positivi
// dove GB/OL restituisce un libro dello stesso autore con titolo diverso.
async function searchBookExists(titoloOriginale, titoloItaliano, autore, destinazione = null) {
  const TIMEOUT = 5000
  const searchTitle = titoloOriginale || titoloItaliano || ''
  if (!searchTitle || !autore) return false

  const q = encodeURIComponent(`intitle:${searchTitle} inauthor:${autore}`)
  const gbKey = process.env.GOOGLE_BOOKS_API_KEY

  // Recupera sempre title + subtitle per il confronto; aggiunge description/categories se c'è destinazione
  const baseFields = 'totalItems,items(volumeInfo/title,volumeInfo/subtitle)'
  const fields = destinazione
    ? 'totalItems,items(volumeInfo/title,volumeInfo/subtitle,volumeInfo/description,volumeInfo/categories)'
    : baseFields

  const gbUrl = gbKey
    ? `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&fields=${encodeURIComponent(fields)}&key=${gbKey}`
    : `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&fields=${encodeURIComponent(fields)}`

  // OL: chiede anche il titolo per verificarlo
  const olUrl = `https://openlibrary.org/search.json?title=${encodeURIComponent(searchTitle)}&author=${encodeURIComponent(autore)}&limit=1&fields=key,title`

  const [gbResult, olResult] = await Promise.allSettled([
    fetch(gbUrl, { headers: { 'User-Agent': 'AiBooks/1.0' }, signal: AbortSignal.timeout(TIMEOUT) })
      .then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(olUrl, { headers: { 'User-Agent': 'AiBooks/1.0' }, signal: AbortSignal.timeout(TIMEOUT) })
      .then(r => r.ok ? r.json() : null).catch(() => null),
  ])

  const gbData = gbResult.status === 'fulfilled' ? gbResult.value : null
  const olData = olResult.status === 'fulfilled' ? olResult.value : null

  // ── Verifica GB: esiste E il titolo restituito corrisponde al candidato ───────
  let gbVerified = false
  if ((gbData?.totalItems ?? 0) > 0 && gbData?.items?.[0]?.volumeInfo?.title) {
    const gbTitle = gbData.items[0].volumeInfo.title
    gbVerified = titlesMatch(searchTitle, gbTitle)
    if (!gbVerified) {
      // Prova anche col titolo italiano come fallback (libri tradotti)
      if (titoloItaliano && titoloItaliano !== searchTitle)
        gbVerified = titlesMatch(titoloItaliano, gbTitle)
    }
    if (!gbVerified)
      console.log(`[chat] GB title mismatch: cercato "${searchTitle}", trovato "${gbTitle}"`)
  }

  // ── Verifica OL: esiste E il titolo restituito corrisponde al candidato ───────
  let olVerified = false
  if ((olData?.numFound ?? 0) > 0 && olData?.docs?.[0]?.title) {
    const olTitle = olData.docs[0].title
    olVerified = titlesMatch(searchTitle, olTitle)
    if (!olVerified && titoloItaliano && titoloItaliano !== searchTitle)
      olVerified = titlesMatch(titoloItaliano, olTitle)
    if (!olVerified)
      console.log(`[chat] OL title mismatch: cercato "${searchTitle}", trovato "${olTitle}"`)
  }

  if (!gbVerified && !olVerified) return false

  // ── Verifica di pertinenza geografica (solo se la destinazione è attiva) ──────
  if (destinazione && gbVerified && gbData?.items?.[0]) {
    const v = gbData.items[0].volumeInfo || {}
    const hasDescription = !!(v.description || (v.categories && v.categories.length > 0))

    const candidateTitleLower = searchTitle.toLowerCase()
    const keywords = getDestinationKeywords(destinazione)
    const titleContainsDest = keywords.some(kw => candidateTitleLower.includes(kw.toLowerCase()))
    if (titleContainsDest) return true

    if (hasDescription) {
      const text = [
        v.title || '', v.subtitle || '',
        v.description || '',
        ...(v.categories || []),
      ].join(' ').toLowerCase()

      const relevant = keywords.some(kw => text.includes(kw.toLowerCase()))
      if (!relevant) {
        console.log(`[chat] scartato (non riguarda "${destinazione}"): "${searchTitle}" — ${autore}`)
        return false
      }
    }
  }

  return true
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

  const { messages, books, userName: rawName, language: rawLang } = req.body
  if (!messages?.length) return res.status(400).json({ error: 'messages mancanti' })
  if (!Array.isArray(books)) return res.status(400).json({ error: 'books mancanti' })

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Chiave OpenAI non configurata sul server.' })

  const userName = (typeof rawName === 'string' && rawName.length <= 50)
    ? rawName.replace(/[<>"'`]/g, '').trim() || 'tu'
    : 'tu'

  // ── Lingua di risposta ──────────────────────────────────────────────────────
  const LANGUAGE_LABELS = {
    it: 'italiano', en: 'English', es: 'español', fr: 'français',
    de: 'Deutsch', pt: 'português', ja: '日本語', zh: '中文简体',
    nl: 'Nederlands', pl: 'polski',
  }
  const langCode = (typeof rawLang === 'string' && LANGUAGE_LABELS[rawLang]) ? rawLang : 'it'
  const responseLang = LANGUAGE_LABELS[langCode]

  // ── Elabora libri dal client ────────────────────────────────────────────────
  const tuttiLetti    = books.filter(b => b.stato_lettura === 'letto')
  const daLeggereRaw  = books.filter(b => b.stato_lettura === 'da_leggere')
  const cinqueStelle  = tuttiLetti.filter(l => l.voto === 5)
  const quattroStelle = tuttiLetti.filter(l => l.voto === 4)

  const totale   = books.length
  const nLetti   = tuttiLetti.length
  const nLettura = books.filter(b => b.stato_lettura === 'in_lettura').length
  const nDaLegg  = daLeggereRaw.length

  const lettiPerAnno = {}
  for (const l of tuttiLetti) {
    if (l.anno_lettura) {
      const a = String(l.anno_lettura)
      lettiPerAnno[a] = (lettiPerAnno[a] || 0) + 1
    }
  }
  const anniStr = Object.keys(lettiPerAnno)
    .sort((a, b) => Number(b) - Number(a))
    .map(a => `${a}:${lettiPerAnno[a]}`)
    .join(', ')

  // ── Formattazione ───────────────────────────────────────────────────────────
  function fmt5(l) {
    const autore  = (l.autore || []).map(sanitize).join(', ') || '?'
    const editore = sanitize(l.casa_editrice) || null
    const genere  = (l.genere || []).map(sanitize).join(', ') || null
    const annoL   = l.anno_lettura ? ` [${l.anno_lettura}]` : ''
    return `"${sanitize(l.titolo) || '?'}" — ${[autore, editore, genere].filter(Boolean).join(', ')}${annoL}`
  }

  function fmt4(l) {
    const autore = (l.autore || []).map(sanitize).join(', ') || '?'
    const genere = (l.genere || []).map(sanitize).join(', ') || null
    return `"${sanitize(l.titolo) || '?'}" — ${[autore, genere].filter(Boolean).join(', ')}`
  }

  function fmtBase(l) {
    return `"${sanitize(l.titolo) || '?'}" (${(l.autore || []).map(sanitize).join(', ') || '?'})`
  }

  const stelle = n => '★'.repeat(n || 0) + '☆'.repeat(Math.max(0, 5 - (n || 0)))
  const lettiPerAnnoMap = {}
  for (const l of tuttiLetti) {
    const anno = l.anno_lettura ? String(l.anno_lettura) : '?'
    if (!lettiPerAnnoMap[anno]) lettiPerAnnoMap[anno] = []
    const autore = (l.autore || []).join(', ') || '?'
    lettiPerAnnoMap[anno].push(`"${l.titolo || '?'}" — ${autore} ${stelle(l.voto)}`)
  }
  const lettiPerAnnoStr = Object.keys(lettiPerAnnoMap)
    .sort((a, b) => Number(b) - Number(a))
    .map(anno => `${anno}:\n${lettiPerAnnoMap[anno].map(r => `  • ${r}`).join('\n')}`)
    .join('\n')

  // ── System prompt ───────────────────────────────────────────────────────────
  const systemPrompt = `Sei l'assistente letterario personale di ${userName}.
LINGUA DI RISPOSTA — REGOLA ASSOLUTA: Scrivi TUTTO in ${responseLang} — domande, opzioni numerate, suggerimenti, note, qualsiasi parola. Non importa in che lingua scrive l'utente: tu rispondi SEMPRE e SOLO in ${responseLang}. Le domande D1/D2/D3/D4 e le loro opzioni sono template in italiano che devi tradurre in ${responseLang} prima di mostrarle.
FORMATO DOMANDE — REGOLA ASSOLUTA: NON includere mai le etichette D1, D2, D2b, D2c, D2d, D3, D4 nel testo mostrato all'utente. Quelle etichette sono solo riferimenti interni per te. Mostra SOLO il testo della domanda e le opzioni numerate.
Tono caldo e appassionato.

══ FLUSSO SUGGERIMENTI — segui questo ordine RIGOROSO ══

Quando l'utente chiede consigli su cosa leggere, poni UNA domanda alla volta seguendo questo flusso:

D1 — Preferisci una lettura leggera o impegnativa?
1. Leggera e scorrevole
2. Impegnativa e profonda
3. Non ho preferenze
4. Altro: scrivi tu...

D2 — Che tipo di libro stai cercando?
1. Narrativa
2. Narrativa di viaggio / reportage
3. Saggistica
4. Autobiografia / memoir
5. Altro: scrivi tu...

D2b — [SOLO se l'utente ha scelto "Narrativa di viaggio / reportage" in D2]
Poni questa domanda:
"Hai una destinazione geografica specifica in mente? Scrivila pure qui sotto — altrimenti scegli:"
1. Non importa, scegli tu
2. Altro: scrivi tu...

D2c — [SOLO se l'utente ha scelto "Autobiografia / memoir" in D2]
Poni questa domanda:
"Di che ambito vorresti leggere? Scegli o scrivi tu:"
1. Musicale / artistico
2. Sportivo
3. Politico / storico
4. Letterario / intellettuale
5. Scientifico / accademico
6. Imprenditoria / business
7. Non ho preferenze
8. Altro: scrivi tu...

D2c_sub — [SOLO per alcuni ambiti scelti in D2c — vedi sotto]

Se ha scelto "Musicale / artistico":
"Che genere o disciplina ti interessa? Scegli o scrivi tu:"
1. Rock / pop / indie
2. Jazz / blues / soul / R&B
3. Musica classica / lirica / opera
4. Cinema / teatro / danza
5. Arte visiva / pittura / scultura
6. Non ho preferenze
7. Altro: scrivi tu...

Se ha scelto "Sportivo":
"Che sport ti interessa? Scegli o scrivi tu:"
1. Calcio
2. Ciclismo / atletica / maratona
3. Tennis / sport individuali
4. Basket / sport americani
5. Sport estremi / avventura
6. Non ho preferenze
7. Altro: scrivi tu...

Se ha scelto "Imprenditoria / business":
"Che settore ti interessa? Scegli o scrivi tu:"
1. Finanza / investimenti (es. Warren Buffett, Ray Dalio)
2. Tech / startup / innovazione (es. Musk, Jobs)
3. Moda / lusso / retail
4. Industria / manifattura
5. Non ho preferenze
6. Altro: scrivi tu...

Se ha scelto "Politico / storico", "Letterario / intellettuale", "Scientifico / accademico"
o "Non ho preferenze": salta D2c_sub e vai direttamente a D3.

D2d — [SOLO se l'utente ha scelto "Saggistica" in D2]
Poni questa domanda:
"Che tipo di saggistica stai cercando? Scegli o scrivi tu:"
1. Filosofia / pensiero
2. Storia / politica
3. Scienza / natura / ambiente
4. Psicologia / mente / comportamento
5. Economia / società / geopolitica
6. Arte / cultura / critica letteraria
7. Viaggi / esplorazioni / geografie umane
8. Non ho preferenze
9. Altro: scrivi tu...

D3 — Tema o epoca?
1. Contemporaneo
2. Storico (qualsiasi epoca)
3. Nessuna preferenza
4. Altro: scrivi tu...

D4 — OBBLIGATORIA, sempre, qualunque sia il ramo seguito. Non saltarla mai.
Poni questa domanda esattamente così (2 opzioni numerate + testo intro):
"C'è qualche ulteriore informazione che vuoi aggiungere alla ricerca? Ad esempio: un autore che ami o che non sopporti, un'ambientazione specifica, un libro simile a uno che ti è piaciuto molto…"
1. No grazie, procedi
2. Altro: scrivi qui i tuoi dettagli...

Se l'utente clicca "No grazie, procedi" o scrive qualcosa di equivalente (niente, vai, procedi…): passa direttamente ai suggerimenti.
Se l'utente scrive dettagli nel campo libero o clicca l'opzione 2: registra ogni informazione come VINCOLO OBBLIGATORIO (vedi FASE 0), poi passa ai suggerimenti.
IMPORTANTE: un testo libero dell'utente in qualsiasi fase (non solo D4) può contenere vincoli impliciti — destinazioni, autori di riferimento, stili, ambientazioni. Estrai e applica TUTTI senza eccezioni.

Flusso completo (branch paralleli da D2, non sequenziali):
D1 → D2 → ┬─ [se Narrativa] ──────────────────────────────────────────── D3 → D4
           ├─ [se Narrativa di viaggio] → D2b ──────────────────────────── D3 → D4
           ├─ [se Saggistica] → D2d ────────────────────────────────────── D3 → D4
           ├─ [se Autobiografia] → D2c → [D2c_sub se musicale/sport/biz] → D3 → D4
           └─ [se Altro] ──────────────────────────────────────────────── D3 → D4
Poni UNA domanda alla volta. NON saltare domande. D4 è l'ultima domanda SEMPRE — non dare suggerimenti prima di averla posta.

${REGOLA_AUTO_VERIFICA}

══ REGOLE PER I SUGGERIMENTI ══

REGOLA ASSOLUTA — DESTINAZIONE:
Se l'utente ha indicato una destinazione geografica in D2b, TUTTI i libri suggeriti DEVONO essere ambientati in quella destinazione o riguardarla direttamente.

REGOLA — AUTOBIOGRAFIA:
Se l'utente ha indicato un ambito in D2c, proponi solo autobiografie di persone di quell'ambito.

PROFILO GUSTI:
Basa le scelte sullo stile, i temi e gli autori dei libri a 5★ e 4★ di ${userName}.
Preferisci autori simili, stessa densità narrativa, temi affini.

STRUTTURA RISPOSTA (seguila sempre):

PASSO 1 — RIGA DI RIEPILOGO (obbligatoria, visibile all'utente, PRIMA di qualsiasi libro):
Scrivi esattamente questa riga, compilata con i vincoli reali della conversazione:
🔍 **Sto cercando:** [genere] | [destinazione in MAIUSCOLO se indicata] | [intensità lettura] | [epoca] | [eventuali vincoli aggiuntivi]
Esempio: 🔍 **Sto cercando:** narrativa di viaggio | ambientata a PARIGI | lettura leggera | contemporanea

PASSO 2 — LIBRI (solo dopo aver scritto il PASSO 1):
Proponi 8-10 libri (minimo 5 se i criteri sono molto restrittivi) che l'utente NON ha ancora in libreria.
Ogni libro proposto DEVE essere coerente con la riga "Sto cercando:" scritta al PASSO 1.
Se un titolo non rispetta anche solo uno dei vincoli elencati in quella riga → scartalo.
Per ognuno usa esattamente questo formato (markdown):

**"Titolo"** — Autore
[Una frase che descrive il libro: di cosa parla, ambientazione, tono]
*Perché te lo propongo:* [collegamento specifico con le risposte date e/o con i libri a 5★]

Dopo i suggerimenti principali, controlla la lista "DA LEGGERE" fornita sopra:
- Se trovi titoli EFFETTIVAMENTE PRESENTI in quella lista pertinenti alle preferenze espresse, aggiungi:

---
📚 **Hai già in libreria, da non dimenticare:**
**"Titolo esatto dalla lista"** — breve nota sul perché si adatta

- Se NON trovi nessun titolo pertinente nella lista DA LEGGERE, scrivi invece:

---
📚 *Non ho trovato nulla di già disponibile in libreria che si adatti alle tue preferenze.*

REGOLE AGGIUNTIVE:
- Non suggerire MAI libri dalla lista "TUTTI I LIBRI LETTI"
- Usa SOLO il formato • bullet per i suggerimenti (mai liste numerate 1. 2. 3.)
- Puoi citare libri dalla lista "DA LEGGERE" SOLO nella sezione finale — e SOLO se compaiono verbatim in quella lista
- NON inventare, NON parafrasare, NON citare titoli che non siano presenti ESATTAMENTE nella lista DA LEGGERE

══ LIBRERIA DI ${userName.toUpperCase()} ══

Totale: ${totale} libri | Letti: ${nLetti} | In lettura: ${nLettura} | Da leggere: ${nDaLegg}
Letti per anno: ${anniStr || 'n.d.'}

★★★★★ LIBRI A 5 STELLE (gusti primari — base per i suggerimenti):
${cinqueStelle.map(fmt5).join('\n') || '(nessuno)'}

★★★★ LIBRI A 4 STELLE (gusti secondari):
${quattroStelle.map(fmt4).join('\n') || '(nessuno)'}

TUTTI I LIBRI LETTI — non suggerire MAI questi titoli:
${lettiPerAnnoStr || '(nessuno)'}

DA LEGGERE — ${nDaLegg} titoli (menzionali solo nella sezione finale se pertinenti):
${daLeggereRaw.map(fmtBase).join('\n') || '(lista vuota)'}`

  // ── Estrai vincoli chiave dalla cronologia (pura JS, zero AI call) ───────────
  const constraints = extractKeyConstraints(messages)

  // ── Fase 1: candidati strutturati in JSON ───────────────────────────────────
  let validatedBooks = []
  try {
    const candidates = await getBookCandidates(systemPrompt, messages, apiKey, constraints)

    if (candidates.length > 0) {
      // ── Fase 2: validazione parallela su Google Books + Open Library ─────────
      const results = await Promise.all(
        candidates.map(async (b) => {
          const found = await searchBookExists(b.titolo_originale, b.titolo_italiano, b.autore, constraints.destinazione)
          return found ? b : null
        })
      )
      validatedBooks = results.filter(Boolean)
      // Deduplicazione: rimuove titoli con stesso titolo_originale + autore
      const seen = new Set()
      validatedBooks = validatedBooks.filter(b => {
        const key = `${b.titolo_originale}|${b.autore}`.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      // Rimuovi libri già letti dall'utente (confronto per titolo, case-insensitive)
      const lettiSet = new Set(tuttiLetti.map(b => (b.titolo || '').toLowerCase().trim()))
      validatedBooks = validatedBooks.filter(b => {
        const tIt = (b.titolo_italiano || '').toLowerCase().trim()
        const tOr = (b.titolo_originale || '').toLowerCase().trim()
        return !lettiSet.has(tIt) && !lettiSet.has(tOr)
      })
      console.log(`[chat] candidati: ${candidates.length}, validati: ${validatedBooks.length}, vincoli:`, constraints)
    }
  } catch (e) {
    console.warn('[chat] fase candidati/validazione fallita, uso risposta diretta:', e.message)
  }

  // ── Fase 3: risposta finale ──────────────────────────────────────────────────
  const constraintReminder = constraints.destinazione
    ? `\n⚠ VINCOLO DESTINAZIONE ATTIVO: proponi SOLO libri ambientati a ${constraints.destinazione}.\n`
    : ''

  const validatedSection = validatedBooks.length >= 3
    ? constraintReminder +
      `\n══ LIBRI VERIFICATI — proponi SOLO questi, nessun altro ══\n` +
      `I seguenti ${validatedBooks.length} libri sono stati confermati come reali da Google Books e Open Library.\n` +
      `Scrivi la risposta seguendo la STRUTTURA RISPOSTA: prima la riga 🔍 Sto cercando:, poi le descrizioni.\n` +
      `Non aggiungere titoli non presenti in questa lista.\n` +
      validatedBooks.map(b =>
        `• "${b.titolo_italiano}"${b.titolo_originale !== b.titolo_italiano ? ` (orig. "${b.titolo_originale}")` : ''} — ${b.autore} (${b.anno})`
      ).join('\n')
    : constraintReminder

  const finalSystemPrompt = systemPrompt + validatedSection

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [
          { role: 'system', content: finalSystemPrompt },
          ...messages.slice(-14),
        ],
        max_completion_tokens: 4000,
        temperature: 0.4,
      }),
    })

    let data
    try { data = await openaiRes.json() } catch (_) {
      return res.status(500).json({ error: 'Risposta non valida da OpenAI' })
    }
    if (!openaiRes.ok) {
      console.error('[chat] OpenAI error:', data.error?.message)
      return res.status(500).json({ error: 'Errore del servizio AI. Riprova tra qualche secondo.' })
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) return res.status(500).json({ error: 'Risposta AI vuota' })
    return res.json({ content })
  } catch (e) {
    console.error('[chat] fetch error:', e.message)
    return res.status(500).json({ error: 'Errore di connessione verso OpenAI' })
  }
}
