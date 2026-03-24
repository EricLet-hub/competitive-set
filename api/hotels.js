export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { q, check_in_date, check_out_date, api_key } = req.query;
  if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });
  if (!q) return res.status(400).json({ error: 'Paramètre q manquant' });

  try {
    // Extraire la ville : dernier ou deux derniers mots
    const words = q.trim().split(' ');
    const city = words.length >= 2 ? words.slice(-2).join(' ') : words[0];

    // Appel 1 : Google Hotels sur la ville → vrais prix
    const hotelsParams = new URLSearchParams({
      engine: 'google_hotels',
      q: `hotels ${city}`,
      check_in_date: check_in_date || '',
      check_out_date: check_out_date || '',
      adults: '2',
      currency: 'EUR',
      hl: 'fr',
      gl: 'fr',
      api_key
    });
    const hotelsRes = await fetch(`https://serpapi.com/search.json?${hotelsParams}`);
    const hotelsData = await hotelsRes.json();
    const hotelPrices = hotelsData.properties || [];

    // Appel 2 : Google Local sur le nom exact → position GPS + infos
    const localParams = new URLSearchParams({
      engine: 'google_local',
      q: q,
      hl: 'fr',
      gl: 'fr',
      api_key
    });
    const localRes = await fetch(`https://serpapi.com/search.json?${localParams}`);
    const localData = await localRes.json();
    const localRef = localData.local_results?.[0] || {};

    // Appel 3 : Google Local zone pour concurrents
    const zoneParams = new URLSearchParams({
      engine: 'google_local',
      q: `hotel ${city}`,
      hl: 'fr',
      gl: 'fr',
      api_key
    });
    if (localRef.gps_coordinates) {
      const { latitude: lat, longitude: lng } = localRef.gps_coordinates;
      zoneParams.set('ll', `@${lat},${lng},13z`);
    }
    const zoneRes = await fetch(`https://serpapi.com/search.json?${zoneParams}`);
    const zoneData = await zoneRes.json();
    const localZone = zoneData.local_results || [];

    // Normalisation pour matching flou
    function norm(s) {
      return (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/hotel|hôtel|ibis|novotel|mercure|&|-/gi, '')
        .replace(/\s+/g, ' ').trim();
    }

    // Trouver le prix d'un hôtel dans la liste Google Hotels
    function findPrice(name) {
      const n = norm(name);
      return hotelPrices.find(h => {
        const hn = norm(h.name);
        if (hn.includes(n) || n.includes(hn)) return true;
        const w1 = n.split(' ').filter(w => w.length > 2);
        const w2 = hn.split(' ').filter(w => w.length > 2);
        return w1.filter(w => w2.includes(w)).length >= 2;
      }) || null;
    }

    // Identifier l'hôtel de référence dans Google Hotels
    const refName = localRef.title || q;
    const refHotelData = findPrice(refName);
    const refPrice = refHotelData?.rate_per_night?.extracted_lowest || null;

    const refHotel = {
      name: refName,
      overall_rating: localRef.rating || refHotelData?.overall_rating || null,
      rate_per_night: refPrice ? { extracted_lowest: refPrice } : null,
      amenities: refHotelData?.amenities || (localRef.type ? [localRef.type] : []),
      address: localRef.address || null,
      isReference: true
    };

    // Fusionner Google Hotels (avec prix) + Google Local (zone)
    const seen = new Set([norm(refName)]);
    const excludeTypes = /camping|auberge|hostel|gite|chambre|residence/i;
    const competitors = [];

    // D'abord les hôtels Google Hotels (ont des prix)
    for (const h of hotelPrices) {
      if (competitors.length >= 12) break;
      const n = norm(h.name);
      if (seen.has(n)) continue;
      seen.add(n);
      competitors.push({
        name: h.name,
        overall_rating: h.overall_rating || null,
        rate_per_night: h.rate_per_night || null,
        amenities: h.amenities || [],
        isReference: false
      });
    }

    // Compléter avec Google Local si besoin
    for (const h of localZone) {
      if (competitors.length >= 12) break;
      const n = norm(h.title);
      if (seen.has(n)) continue;
      if (excludeTypes.test(h.title) || excludeTypes.test(h.type || '')) continue;
      seen.add(n);
      const priceMatch = findPrice(h.title);
      competitors.push({
        name: h.title,
        overall_rating: h.rating || null,
        rate_per_night: priceMatch?.rate_per_night || null,
        amenities: h.type ? [h.type] : [],
        isReference: false
      });
    }

    if (!refHotel.name && competitors.length === 0) {
      return res.status(404).json({ error: `Aucun résultat pour "${q}". Essayez : "Ibis Valence" ou "Valence".` });
    }

    return res.status(200).json({
      properties: [refHotel, ...competitors]
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
