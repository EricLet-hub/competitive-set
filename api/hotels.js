export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'POST' ? (req.body || {}) : req.query;
  const { action, q, property_token, check_in_date, check_out_date, api_key } = params;

  try {

    // ACTION: search
    if (action === 'search' || !action) {
      if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });
      if (!q) return res.status(400).json({ error: 'Paramètre q manquant' });

      const words = q.trim().split(' ');
      const city = words.slice(-2).join(' ');

      const localRef = await serpFetch({ engine: 'google_local', q, hl: 'fr', gl: 'fr', api_key });
      const ref = localRef.local_results?.[0] || {};
      const refLat = ref.gps_coordinates?.latitude;
      const refLng = ref.gps_coordinates?.longitude;

      const zoneQ = { engine: 'google_local', q: `hotel ${city}`, hl: 'fr', gl: 'fr', api_key };
      if (refLat && refLng) zoneQ.ll = `@${refLat},${refLng},13z`;
      const zoneData = await serpFetch(zoneQ);
      const zoneResults = zoneData.local_results || [];

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

      const refHotel = {
        name: ref.title || q,
        overall_rating: ref.rating || findRating(ref.title || q),
        address: ref.address || null,
        property_token: findToken(ref.title || q),
        isReference: true
      };

      const exclude = /camping|auberge|hostel|gite|chambre d'hôtes|résidence|appartement|studio/i;
      const seen = new Set([norm(refHotel.name)]);
      const competitors = [];

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

    // ACTION: details
    if (action === 'details') {
      if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });
      if (!property_token) return res.status(400).json({ error: 'property_token manquant' });
      if (!check_in_date || !check_out_date) return res.status(400).json({ error: 'Dates manquantes' });

      const data = await serpFetch({
        engine: 'google_hotels',
        q: q || 'hotel',
        property_token,
        check_in_date, check_out_date,
        adults: '2', currency: 'EUR', hl: 'fr', gl: 'fr', api_key
      });

      console.log('Details response keys:', Object.keys(data));
      console.log('Properties count:', data.properties?.length);

      // Les prix peuvent être dans properties[0].prices ou directement dans prices
      const prop = data.properties?.[0] || {};
      const rawPrices = prop.prices || data.prices || [];
      
      const prices = rawPrices.map(p => ({
        source: p.source,
        price: p.rate_per_night?.extracted_lowest || null
      })).filter(p => p.price);

      // Fallback: si pas de prices, chercher rate_per_night directement
      if (prices.length === 0 && prop.rate_per_night?.extracted_lowest) {
        prices.push({ source: 'Google Hotels', price: prop.rate_per_night.extracted_lowest });
      }

      return res.status(200).json({
        name: prop.name || '',
        overall_rating: prop.overall_rating || null,
        lowest_price: prices.length ? Math.min(...prices.map(p => p.price)) : null,
        prices,
        amenities: prop.amenities || [],
        debug_keys: Object.keys(data)
      });
    }

    // ACTION: score — scoring algorithmique 100% gratuit, basé sur les données Google
    if (action === 'score') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST requis' });
      const body = req.body || {};
      if (!body.hotels || !Array.isArray(body.hotels)) return res.status(400).json({ error: 'Paramètres manquants' });

      const scored = body.hotels.map(h => {
        const googleRating = parseFloat(h.overall_rating) || 3.5;
        const amenities = h.amenities || [];
        const name = (h.name || '').toLowerCase();
        const address = (h.address || '').toLowerCase();

        // RATING: 0-30 pts
        const ratingScore = Math.min(30, Math.round((googleRating / 5) * 30));

        // LOCATION: 0-25 pts
        let locationScore = 14;
        if (/centre|center|gare|historique|coeur|hyper/i.test(name + address)) locationScore = 22;
        else if (/nord|sud|est|ouest|peripherie|zone|commercial/i.test(name + address)) locationScore = 12;
        else if (/aeroport|airport|autoroute/i.test(name + address)) locationScore = 8;

        // ROOM SIZE: 0-15 pts
        let roomScore = 9;
        if (/formule|premiere classe|etap|\bf1\b/i.test(name)) roomScore = 5;
        else if (/ibis budget|b&b|bb hotel/i.test(name)) roomScore = 7;
        else if (/ibis|campanile|kyriad|comfort/i.test(name)) roomScore = 9;
        else if (/mercure|novotel|best western|holiday inn|crowne/i.test(name)) roomScore = 12;
        else if (/pullman|hilton|marriott|hyatt|sheraton|sofitel|intercontinental/i.test(name)) roomScore = 15;

        // AMENITIES: 0-20 pts
        let amenScore = 0;
        const amStr = amenities.join(' ').toLowerCase();
        if (/pool|piscine/i.test(amStr)) amenScore += 6;
        if (/restaurant|dining/i.test(amStr)) amenScore += 5;
        if (/meeting|reunion|conference/i.test(amStr)) amenScore += 5;
        if (/spa|wellness/i.test(amStr)) amenScore += 4;
        if (/parking/i.test(amStr)) amenScore += 2;
        if (/fitness|gym/i.test(amStr)) amenScore += 2;
        amenScore = Math.min(20, amenScore);

        // COMPETITIVE: 0-10 pts
        const compScore = googleRating >= 4.5 ? 9 : googleRating >= 4.0 ? 7 : googleRating >= 3.5 ? 5 : 3;

        // Description emplacement
        let locationDesc = 'Zone urbaine';
        if (/centre|center|historique|coeur/i.test(name + address)) locationDesc = 'Centre-ville';
        else if (/gare/i.test(name + address)) locationDesc = 'Quartier gare';
        else if (/nord/i.test(name)) locationDesc = 'Zone nord';
        else if (/sud/i.test(name)) locationDesc = 'Zone sud';
        else if (/aeroport|airport/i.test(name)) locationDesc = 'Zone aeroport';

        const roomSizeSqm = roomScore <= 5 ? 14 : roomScore <= 7 ? 17 : roomScore <= 9 ? 20 : roomScore <= 12 ? 26 : 32;
        const advantage = googleRating >= 4.3 ? 'Excellente note clients' : googleRating >= 4.0 ? 'Bonne note clients' : 'Rapport qualite-prix';

        return {
          name: h.name,
          score: { rating: ratingScore, location: locationScore, roomSize: roomScore, amenities: amenScore, competitive: compScore },
          details: { locationDesc, roomSizeSqm, advantage }
        };
      });

      return res.status(200).json({ scored });
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
