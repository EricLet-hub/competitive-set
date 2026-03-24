export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'POST' ? (req.body || {}) : req.query;
  const { action, q, property_token, check_in_date, check_out_date, api_key, lat, lng } = params;

  try {

    // ── ACTION: search ────────────────────────────────────────────────────────
    if (action === 'search' || !action) {
      if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });
      if (!q) return res.status(400).json({ error: 'Paramètre q manquant' });

      const ci = check_in_date || getTomorrow(7);
      const co = check_out_date || getTomorrow(8);

      // Appel 1: Google Local → hôtel de référence avec GPS
      const localRef = await serpFetch({ engine: 'google_local', q, hl: 'fr', gl: 'fr', api_key });
      const ref = localRef.local_results?.[0] || {};
      const refLat = ref.gps_coordinates?.latitude;
      const refLng = ref.gps_coordinates?.longitude;

      // Appel 2: Google Local zone → concurrents avec GPS
      const words = q.trim().split(' ');
      const city = words.slice(-2).join(' ');
      const zoneQ = { engine: 'google_local', q: `hotel ${city}`, hl: 'fr', gl: 'fr', api_key };
      if (refLat && refLng) zoneQ.ll = `@${refLat},${refLng},13z`;
      const zoneData = await serpFetch(zoneQ);
      const zoneResults = zoneData.local_results || [];

      // Fonction: trouver le token via GPS (zoom très serré = hôtel unique)
      async function getTokenByGPS(name, gpsLat, gpsLng) {
        if (!gpsLat || !gpsLng) return { token: null, hotel_class: null, rating: null };
        const r = await serpFetch({
          engine: 'google_hotels',
          q: `hotel ${city}`,
          ll: `@${gpsLat},${gpsLng},15z`, // zoom 15 = ~500m radius
          check_in_date: ci, check_out_date: co,
          adults: '2', currency: 'EUR', hl: 'fr', gl: 'fr', api_key
        });
        const props = r.properties || [];
        if (!props.length) return { token: null, hotel_class: null, rating: null };
        return {
          token: props[0].property_token || null,
          hotel_class: props[0].hotel_class || null,
          rating: props[0].overall_rating || null,
          name: props[0].name || name
        };
      }

      const exclude = /camping|auberge|hostel|gite|résidence|appartement|studio/i;

      // Référence: token via GPS
      const refData = await getTokenByGPS(ref.title || q, refLat, refLng);
      const refHotel = {
        name: ref.title || q,
        overall_rating: ref.rating || refData.rating || null,
        hotel_class: refData.hotel_class || null,
        address: ref.address || null,
        gps_coordinates: ref.gps_coordinates || null,
        property_token: refData.token || null,
        isReference: true
      };

      // Concurrents: token via GPS pour chacun
      const seen = new Set([(ref.title || q).toLowerCase()]);
      const hotelZone = zoneResults
        .filter(h => {
          if (exclude.test(h.title) || exclude.test(h.type || '')) return false;
          const n = h.title.toLowerCase();
          if (seen.has(n)) return false;
          seen.add(n);
          return true;
        })
        .slice(0, 8);

      // Récupérer tokens par lots de 4
      const competitors = [];
      const chunks = chunkArray(hotelZone, 4);
      for (const chunk of chunks) {
        const results = await Promise.all(chunk.map(h =>
          getTokenByGPS(h.title, h.gps_coordinates?.latitude, h.gps_coordinates?.longitude)
        ));
        chunk.forEach((h, i) => {
          const d = results[i];
          // Exclure si même token que la référence
          if (d.token && d.token === refData.token) return;
          competitors.push({
            name: h.title,
            overall_rating: h.rating || d.rating || null,
            hotel_class: d.hotel_class || null,
            address: h.address || null,
            gps_coordinates: h.gps_coordinates || null,
            property_token: d.token || null,
            isReference: false
          });
        });
      }

      return res.status(200).json({ properties: [refHotel, ...competitors] });
    }

    // ── ACTION: details ───────────────────────────────────────────────────────
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

      const prop = data.properties?.[0] || {};
      const rawPrices = prop.prices || data.prices || [];
      const prices = rawPrices.map(p => ({
        source: p.source,
        price: p.rate_per_night?.extracted_lowest || null
      })).filter(p => p.price);

      if (prices.length === 0 && prop.rate_per_night?.extracted_lowest) {
        prices.push({ source: 'Google Hotels', price: prop.rate_per_night.extracted_lowest });
      }

      return res.status(200).json({
        name: prop.name || '',
        overall_rating: prop.overall_rating || null,
        hotel_class: prop.hotel_class || null,
        lowest_price: prices.length ? Math.min(...prices.map(p => p.price)) : null,
        prices,
        amenities: prop.amenities || []
      });
    }

    // ── ACTION: timeseries ────────────────────────────────────────────────────
    // Récupère les prix sur plusieurs dates pour le graphique temporel
    if (action === 'timeseries') {
      if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });
      if (!property_token) return res.status(400).json({ error: 'property_token manquant' });

      // 5 dates : J+7, J+14, J+21, J+30, J+60
      const offsets = [7, 14, 21, 30, 60];
      const datePoints = offsets.map(d => ({
        checkin: getTomorrow(d),
        checkout: getTomorrow(d + 1),
        label: getTomorrow(d)
      }));

      const results = await Promise.all(datePoints.map(async dp => {
        try {
          const data = await serpFetch({
            engine: 'google_hotels',
            q: q || 'hotel',
            property_token,
            check_in_date: dp.checkin,
            check_out_date: dp.checkout,
            adults: '2', currency: 'EUR', hl: 'fr', gl: 'fr', api_key
          });
          const prop = data.properties?.[0] || {};
          const rawPrices = prop.prices || [];
          const prices = rawPrices.map(p => p.rate_per_night?.extracted_lowest).filter(Boolean);
          const lowest = prices.length ? Math.min(...prices) : (prop.rate_per_night?.extracted_lowest || null);
          return { date: dp.label, price: lowest };
        } catch(e) {
          return { date: dp.label, price: null };
        }
      }));

      return res.status(200).json({ timeseries: results });
    }

    // ── ACTION: score ─────────────────────────────────────────────────────────
    if (action === 'score') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST requis' });
      const body = req.body || {};
      if (!body.hotels || !Array.isArray(body.hotels)) return res.status(400).json({ error: 'Paramètres manquants' });

      const scored = body.hotels.map(h => {
        const googleRating = parseFloat(h.overall_rating) || 3.5;
        const amenities = h.amenities || [];
        const name = (h.name || '').toLowerCase();
        const address = (h.address || '').toLowerCase();

        let stars = parseInt(h.hotel_class) || 0;
        if (!stars) {
          if (/formule|premiere classe|etap|\bf1\b|ibis budget|b&b|bb hotel/i.test(name)) stars = 2;
          else if (/ibis(?! budget)|campanile|kyriad|comfort|logis|noemys|tulip/i.test(name)) stars = 3;
          else if (/mercure|novotel|best western|holiday inn|crowne|ace|victoria/i.test(name)) stars = 4;
          else if (/pullman|hilton|marriott|hyatt|sheraton|sofitel/i.test(name)) stars = 5;
          else stars = 3;
        }

        const ratingScore = Math.min(30, Math.round((googleRating / 5) * 30));

        let locationScore = 14;
        if (/centre|center|gare|historique|coeur|hyper/i.test(name + address)) locationScore = 22;
        else if (/nord|sud|est|ouest|peripherie|zone|commercial/i.test(name + address)) locationScore = 12;
        else if (/aeroport|airport|autoroute/i.test(name + address)) locationScore = 8;

        const roomScore = Math.min(15, Math.max(4, stars * 3));

        let amenScore = Math.round(Math.min(6, stars * 1.2));
        const amStr = amenities.join(' ').toLowerCase();
        if (/pool|piscine/i.test(amStr)) amenScore += 6;
        if (/restaurant|dining/i.test(amStr)) amenScore += 5;
        if (/meeting|reunion|conference/i.test(amStr)) amenScore += 5;
        if (/spa|wellness/i.test(amStr)) amenScore += 4;
        if (/parking/i.test(amStr)) amenScore += 2;
        if (/fitness|gym/i.test(amStr)) amenScore += 2;
        amenScore = Math.min(20, amenScore);

        const compScore = Math.min(10, Math.round(
          (googleRating >= 4.5 ? 5 : googleRating >= 4.0 ? 4 : googleRating >= 3.5 ? 3 : 2) +
          (stars >= 4 ? 3 : stars >= 3 ? 2 : 1)
        ));

        let locationDesc = 'Zone urbaine';
        if (/centre|center|historique|coeur/i.test(name + address)) locationDesc = 'Centre-ville';
        else if (/gare|tgv/i.test(name + address)) locationDesc = 'Quartier gare';
        else if (/nord/i.test(name)) locationDesc = 'Zone nord';
        else if (/sud/i.test(name)) locationDesc = 'Zone sud';
        else if (/aeroport|airport/i.test(name)) locationDesc = 'Zone aeroport';

        const roomSizeSqm = stars <= 2 ? 17 : stars === 3 ? 20 : stars === 4 ? 26 : 32;
        const advantage = stars >= 4 ? `${stars} etoiles standing superieur` : googleRating >= 4.3 ? 'Excellente note clients' : 'Rapport qualite-prix';

        return {
          name: h.name,
          score: { rating: ratingScore, location: locationScore, roomSize: roomScore, amenities: amenScore, competitive: compScore },
          details: { locationDesc, roomSizeSqm, advantage, stars }
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

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
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
