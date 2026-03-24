export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { action, q, property_token, check_in_date, check_out_date, api_key } = req.query;
  if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });

  try {

    // ── ACTION: search ─────────────────────────────────────────────────────
    if (action === 'search' || !action) {
      if (!q) return res.status(400).json({ error: 'Paramètre q manquant' });

      const words = q.trim().split(' ');
      const city = words.slice(-2).join(' ');

      // Appel 1 : Google Local pour localiser l'hôtel de référence
      const localRef = await serpFetch({ engine: 'google_local', q, hl: 'fr', gl: 'fr', api_key });
      const ref = localRef.local_results?.[0] || {};
      const refLat = ref.gps_coordinates?.latitude;
      const refLng = ref.gps_coordinates?.longitude;

      // Appel 2 : Google Local zone pour les concurrents
      const zoneQ = { engine: 'google_local', q: `hotel ${city}`, hl: 'fr', gl: 'fr', api_key };
      if (refLat && refLng) zoneQ.ll = `@${refLat},${refLng},13z`;
      const zoneData = await serpFetch(zoneQ);
      const zoneResults = zoneData.local_results || [];

      // Appel 3 : Google Hotels search sur la ville pour récupérer les property_token
      const hotelsSearch = await serpFetch({
        engine: 'google_hotels',
        q: `hotels ${city}`,
        check_in_date: check_in_date || getTomorrow(7),
        check_out_date: check_out_date || getTomorrow(8),
        adults: '2', currency: 'EUR', hl: 'fr', gl: 'fr', api_key
      });
      const hotelsList = hotelsSearch.properties || [];

      function norm(s) {
        return (s || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/hotel|hôtel|ibis|novotel|mercure|campanile|kyriad|formule|premiere|classe|b&b|bb/gi, '')
          .replace(/\s+/g, ' ').trim();
      }

      function findToken(name) {
        const n = norm(name);
        const match = hotelsList.find(h => {
          const hn = norm(h.name || '');
          if (hn.includes(n) || n.includes(hn)) return true;
          const w1 = n.split(' ').filter(w => w.length > 2);
          const w2 = hn.split(' ').filter(w => w.length > 2);
          return w1.filter(w => w2.includes(w)).length >= 2;
        });
        return match?.property_token || null;
      }

      function findRating(name) {
        const n = norm(name);
        const match = hotelsList.find(h => {
          const hn = norm(h.name || '');
          return hn.includes(n) || n.includes(hn);
        });
        return match?.overall_rating || null;
      }

      // Construire hôtel de référence
      const refHotel = {
        name: ref.title || q,
        overall_rating: ref.rating || findRating(ref.title || q),
        address: ref.address || null,
        property_token: findToken(ref.title || q),
        gps_coordinates: ref.gps_coordinates || null,
        isReference: true
      };

      // Construire concurrents
      const exclude = /camping|auberge|hostel|gite|chambre d'hôtes|résidence|appartement|studio/i;
      const seen = new Set([norm(refHotel.name)]);
      const competitors = [];

      // D'abord depuis Google Hotels (ont déjà les tokens)
      for (const h of hotelsList) {
        if (competitors.length >= 12) break;
        const n = norm(h.name);
        const refN = norm(refHotel.name);
        if (seen.has(n) || n.includes(refN) || refN.includes(n)) continue;
        seen.add(n);
        competitors.push({
          name: h.name,
          overall_rating: h.overall_rating || null,
          address: null,
          property_token: h.property_token || null,
          isReference: false
        });
      }

      // Compléter avec Google Local
      for (const h of zoneResults) {
        if (competitors.length >= 12) break;
        const n = norm(h.title);
        if (seen.has(n)) continue;
        if (exclude.test(h.title) || exclude.test(h.type || '')) continue;
        seen.add(n);
        competitors.push({
          name: h.title,
          overall_rating: h.rating || findRating(h.title),
          address: h.address || null,
          property_token: findToken(h.title),
          isReference: false
        });
      }

      return res.status(200).json({ properties: [refHotel, ...competitors] });
    }

    // ── ACTION: details ────────────────────────────────────────────────────
    if (action === 'details') {
      if (!property_token) return res.status(400).json({ error: 'property_token manquant' });
      if (!check_in_date || !check_out_date) return res.status(400).json({ error: 'Dates manquantes' });

      const data = await serpFetch({
        engine: 'google_hotels',
        property_token,
        check_in_date, check_out_date,
        adults: '2', currency: 'EUR', hl: 'fr', gl: 'fr', api_key
      });

      const prop = data.properties?.[0] || {};
      const prices = (prop.prices || []).map(p => ({
        source: p.source,
        price: p.rate_per_night?.extracted_lowest || null,
        logo: p.logo || null
      })).filter(p => p.price);

      return res.status(200).json({
        name: prop.name || '',
        overall_rating: prop.overall_rating || null,
        lowest_price: prices.length ? Math.min(...prices.map(p => p.price)) : null,
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

function getTomorrow(days = 1) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
