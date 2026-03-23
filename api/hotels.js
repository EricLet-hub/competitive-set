export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { q, check_in_date, check_out_date, hotel_class, api_key } = req.query;

  if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });
  if (!q)       return res.status(400).json({ error: 'Paramètre q manquant' });

  try {
    const params = new URLSearchParams({
      engine: 'google_hotels',
      q,
      check_in_date:  check_in_date  || '',
      check_out_date: check_out_date || '',
      adults:         '2',
      currency:       'EUR',
      hl:             'fr',
      gl:             'fr',
      hotel_class:    hotel_class || '3',
      api_key
    });

    const serpRes = await fetch(`https://serpapi.com/search.json?${params}`);
    const data    = await serpRes.json();

    if (!serpRes.ok || data.error) {
      return res.status(400).json({ error: data.error || `SerpAPI error ${serpRes.status}` });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
