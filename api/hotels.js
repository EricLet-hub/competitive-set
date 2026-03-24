export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { q, check_in_date, check_out_date, hotel_class, api_key } = req.query;
  if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });
  if (!q) return res.status(400).json({ error: 'Paramètre q manquant' });

  // Extraire la ville du nom (derniers mots) et construire une requête zone
  const words = q.trim().split(' ');
  const city = words.slice(-1)[0]; // dernier mot = ville probable
  const zoneQuery = `hotels ${city}`;

  async function search(query, withClass) {
    const p = new URLSearchParams({
      engine: 'google_hotels',
      q: query,
      check_in_date: check_in_date || '',
      check_out_date: check_out_date || '',
      adults: '2',
      currency: 'EUR',
      hl: 'fr',
      gl: 'fr',
      api_key
    });
    if (withClass) p.set('hotel_class', hotel_class || '3');
    const r = await fetch(`https://serpapi.com/search.json?${p}`);
    return r.json();
  }

  try {
    // Essai 1 : nom exact avec filtre étoiles
    let data = await search(q, true);
    
    // Essai 2 : nom exact sans filtre étoiles
    if (!data.properties?.length) {
      data = await search(q, false);
    }

    // Essai 3 : recherche par ville avec filtre étoiles
    if (!data.properties?.length) {
      data = await search(zoneQuery, true);
    }

    // Essai 4 : recherche par ville sans filtre
    if (!data.properties?.length) {
      data = await search(zoneQuery, false);
    }

    if (data.error) return res.status(400).json({ error: data.error });
    if (!data.properties?.length) return res.status(404).json({ error: `Aucun hôtel trouvé pour "${q}". Essayez uniquement la ville : "Valence" ou "Valence France".` });

    return res.status(200).json(data);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
