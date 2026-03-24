export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { q, check_in_date, check_out_date, hotel_class, api_key } = req.query;
  if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });
  if (!q) return res.status(400).json({ error: 'Paramètre q manquant' });

  const stars = parseInt(hotel_class) || 3;

  try {

    // ETAPE 1 : Google Local pour trouver l hotel de reference et sa position GPS
    const localParams = new URLSearchParams({
      engine: 'google_local',
      q: q,
      hl: 'fr',
      gl: 'fr',
      api_key
    });
    const localRes = await fetch(`https://serpapi.com/search.json?${localParams}`);
    const localData = await localRes.json();

    let refLat = null, refLng = null, refName = q;
    if (localData.local_results && localData.local_results.length > 0) {
      const ref = localData.local_results[0];
      refLat = ref.gps_coordinates?.latitude;
      refLng = ref.gps_coordinates?.longitude;
      refName = ref.title || q;
    }

    // ETAPE 2 : Google Local pour trouver les concurrents dans la zone
    const words = q.trim().split(' ');
    const cityGuess = words.slice(-2).join(' ');
    const starLabel = stars <= 2 ? 'budget' : stars === 3 ? '3 etoiles' : stars === 4 ? '4 etoiles' : '5 etoiles luxe';
    const zoneQuery = `hotel ${starLabel} ${cityGuess}`;

    const zoneParams = new URLSearchParams({
      engine: 'google_local',
      q: zoneQuery,
      hl: 'fr',
      gl: 'fr',
      api_key
    });
    if (refLat && refLng) {
      zoneParams.set('ll', `@${refLat},${refLng},13z`);
    }

    const zoneRes = await fetch(`https://serpapi.com/search.json?${zoneParams}`);
    const zoneData = await zoneRes.json();
    const localCompetitors = zoneData.local_results || [];

    // ETAPE 3 : Google Hotels pour les prix
    const hotelsParams = new URLSearchParams({
      engine: 'google_hotels',
      q: cityGuess,
      check_in_date: check_in_date || '',
      check_out_date: check_out_date || '',
      adults: '2',
      currency: 'EUR',
      hl: 'fr',
      gl: 'fr',
      hotel_class: stars,
      api_key
    });

    const hotelsRes = await fetch(`https://serpapi.com/search.json?${hotelsParams}`);
    const hotelsData = await hotelsRes.json();
    const hotelPrices = hotelsData.properties || [];

    // ETAPE 4 : Fusion Local + Hotels
    function normalize(str) {
      return (str || '').toLowerCase()
        .replace(/hotel|hôtel|&|-/gi, '')
        .replace(/\s+/g, ' ').trim();
    }

    function findPrice(name) {
      const n = normalize(name);
      const match = hotelPrices.find(h => {
        const hn = normalize(h.name);
        if (hn.includes(n) || n.includes(hn)) return true;
        const w1 = n.split(' ').filter(w => w.length > 3);
        const w2 = hn.split(' ').filter(w => w.length > 3);
        return w1.filter(w => w2.includes(w)).length >= 2;
      });
      return match?.rate_per_night?.extracted_lowest || null;
    }

    const refLocalData = localData.local_results?.[0] || {};
    const refPrice = findPrice(refName);
    const refHotel = {
      name: refName,
      overall_rating: refLocalData.rating || null,
      rate_per_night: refPrice ? { extracted_lowest: refPrice } : null,
      amenities: refLocalData.type ? [refLocalData.type] : [],
      gps_coordinates: refLocalData.gps_coordinates || null,
      address: refLocalData.address || null,
      isReference: true
    };

    const excludeTypes = /camping|auberge|hostel|gite|chambre|résidence|residence/i;
    const competitors = localCompetitors
      .filter(h => {
        const title = normalize(h.title);
        const refNorm = normalize(refName);
        if (title.includes(refNorm) || refNorm.includes(title)) return false;
        if (excludeTypes.test(h.title) || excludeTypes.test(h.type || '')) return false;
        return true;
      })
      .slice(0, 9)
      .map(h => {
        const price = findPrice(h.title);
        return {
          name: h.title,
          overall_rating: h.rating || null,
          rate_per_night: price ? { extracted_lowest: price } : null,
          amenities: h.type ? [h.type] : [],
          gps_coordinates: h.gps_coordinates || null,
          address: h.address || null,
          isReference: false
        };
      });

    // Completer avec Google Hotels si pas assez de concurrents
    if (competitors.length < 3 && hotelPrices.length > 0) {
      const refNorm = normalize(refName);
      const extra = hotelPrices
        .filter(h => {
          const hn = normalize(h.name);
          if (hn.includes(refNorm) || refNorm.includes(hn)) return false;
          if (competitors.some(c => normalize(c.name).includes(hn) || hn.includes(normalize(c.name)))) return false;
          return true;
        })
        .slice(0, 5 - competitors.length)
        .map(h => ({
          name: h.name,
          overall_rating: h.overall_rating || null,
          rate_per_night: h.rate_per_night || null,
          amenities: h.amenities || [],
          isReference: false
        }));
      competitors.push(...extra);
    }

    if (competitors.length === 0 && !refHotel.name) {
      return res.status(404).json({ error: `Aucun résultat pour "${q}". Essayez : "Ibis Valence" ou "Valence France".` });
    }

    return res.status(200).json({
      reference: refHotel,
      properties: [refHotel, ...competitors]
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
