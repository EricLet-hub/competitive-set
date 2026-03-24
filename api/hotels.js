export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { action, q, property_token, check_in_date, check_out_date, api_key } = req.query;
  if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });

  try {

    // ── ACTION: search ── liste les hôtels de la zone
    if (action === 'search' || !action) {
      if (!q) return res.status(400).json({ error: 'Paramètre q manquant' });

      // Extraire ville (2 derniers mots)
      const words = q.trim().split(' ');
      const city = words.slice(-2).join(' ');

      // Google Local : trouver l'hôtel de référence + coordonnées GPS
      const localRef = await serpFetch({
        engine: 'google_local', q, hl: 'fr', gl: 'fr', api_key
      });
      const ref = localRef.local_results?.[0] || {};
      const refLat = ref.gps_coordinates?.latitude;
      const refLng = ref.gps_coordinates?.longitude;

      // Google Local zone : concurrents autour
      const zoneQ = { engine: 'google_local', q: `hotel ${city}`, hl: 'fr', gl: 'fr', api_key };
      if (refLat && refLng) zoneQ.ll = `@${refLat},${refLng},13z`;
      const zoneData = await serpFetch(zoneQ);
      const zoneResults = zoneData.local_results || [];

      // Google Hotels : récupérer property_tokens supplémentaires via autocomplete
      const autoData = await serpFetch({
        engine: 'google_hotels_autocomplete', q: city, hl: 'fr', gl: 'fr', api_key
      });
      const autoSuggestions = autoData.suggestions || [];

      // Construire index property_token depuis autocomplete
      function norm(s) {
        return (s || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/hotel|hôtel|&|-/gi, '').replace(/\s+/g, ' ').trim();
      }
      function findToken(name) {
        const n = norm(name);
        const s = autoSuggestions.find(a => {
          const an = norm(a.value || '');
          return an.includes(n) || n.includes(an);
        });
        return s?.property_token || null;
      }

      // Hôtel de référence
      const refToken = findToken(ref.title || q) || ref.property_token || null;
      const refHotel = {
        name: ref.title || q,
        overall_rating: ref.rating || null,
        address: ref.address || null,
        property_token: refToken,
        gps_coordinates: ref.gps_coordinates || null,
        isReference: true
      };

      // Concurrents
      const exclude = /camping|auberge|hostel|gite|chambre|residence/i;
      const seen = new Set([norm(refHotel.name)]);
      const competitors = [];

      for (const h of zoneResults) {
        if (competitors.length >= 14) break;
        const n = norm(h.title);
        if (seen.has(n)) continue;
        if (exclude.test(h.title) || exclude.test(h.type || '')) continue;
        seen.add(n);
        competitors.push({
          name: h.title,
          overall_rating: h.rating || null,
          address: h.address || null,
          property_token: findToken(h.title) || h.property_token || null,
          gps_coordinates: h.gps_coordinates || null,
          isReference: false
        });
      }

      return res.status(200).json({ properties: [refHotel, ...competitors] });
    }

    // ── ACTION: details ── prix détaillés par OTA pour un hôtel
    if (action === 'details') {
      if (!property_token) return res.status(400).json({ error: 'property_token manquant' });
      if (!check_in_date || !check_out_date) return res.status(400).json({ error: 'Dates manquantes' });

      const data = await serpFetch({
        engine: 'google_hotels',
        property_token,
        check_in_date,
        check_out_date,
        adults: '2',
        currency: 'EUR',
        hl: 'fr',
        gl: 'fr',
        api_key
      });

      // Extraire les prix par OTA
      const prop = data.properties?.[0] || {};
      const prices = (prop.prices || []).map(p => ({
        source: p.source,
        price: p.rate_per_night?.extracted_lowest || null,
        logo: p.logo || null
      })).filter(p => p.price);

      const lowestPrice = prices.length > 0 ? Math.min(...prices.map(p => p.price)) : null;

      return res.status(200).json({
        name: prop.name || '',
        overall_rating: prop.overall_rating || null,
        lowest_price: lowestPrice,
        prices,
        amenities: prop.amenities || [],
        typical_price_range: prop.typical_price_range || null
      });
    }

    return res.status(400).json({ error: `Action inconnue: ${action}` });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}

async function serpFetch(params) {
  const p = new URLSearchParams(params);
  const r = await fetch(`https://serpapi.com/search.json?${p}`);
  return r.json();
}
