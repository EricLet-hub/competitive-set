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
      const ci = check_in_date || getTomorrow(7);
      const co = check_out_date || getTomorrow(8);

      // Appel 1: Google Hotels sur la ville → liste principale avec tokens fiables
      const hotelsSearch = await serpFetch({
        engine: 'google_hotels', q: `hotels ${city}`,
        check_in_date: ci, check_out_date: co,
        adults: '2', currency: 'EUR', hl: 'fr', gl: 'fr', api_key
      });
      const hotelsList = hotelsSearch.properties || [];

      // Appel 2: Google Hotels sur le nom exact de la référence → token fiable
      const refSearch = await serpFetch({
        engine: 'google_hotels', q,
        check_in_date: ci, check_out_date: co,
        adults: '2', currency: 'EUR', hl: 'fr', gl: 'fr', api_key
      });
      const refHotelsResults = refSearch.properties || [];

      // Appel 3: Google Local pour localiser l'hôtel de référence précisément
      const localRef = await serpFetch({ engine: 'google_local', q, hl: 'fr', gl: 'fr', api_key });
      const ref = localRef.local_results?.[0] || {};
      const refLat = ref.gps_coordinates?.latitude;
      const refLng = ref.gps_coordinates?.longitude;

      // Appel 3: Google Local zone pour compléter si Google Hotels insuffisant
      const zoneQ = { engine: 'google_local', q: `hotel ${city}`, hl: 'fr', gl: 'fr', api_key };
      if (refLat && refLng) zoneQ.ll = `@${refLat},${refLng},13z`;
      const zoneData = await serpFetch(zoneQ);
      const zoneResults = zoneData.local_results || [];

      // Trouver l'hôtel de référence dans Google Hotels par matching strict du nom
      function normName(s) {
        return (s || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      }

      const refNameNorm = normName(ref.title || q);

      // Chercher d'abord dans les résultats dédiés (recherche par nom exact)
      let refHotelData = refHotelsResults[0] || null;

      // Si pas trouvé, chercher dans la liste générale
      if (!refHotelData) {
        refHotelData = hotelsList.find(h => normName(h.name) === refNameNorm);
      }
      if (!refHotelData) {
        const refWords = refNameNorm.split(' ').filter(w => w.length > 3);
        let bestScore = 0;
        for (const h of [...refHotelsResults, ...hotelsList]) {
          const hn = normName(h.name);
          const hw = hn.split(' ').filter(w => w.length > 3);
          const common = refWords.filter(w => hw.includes(w)).length;
          const score = common / Math.max(refWords.length, hw.length, 1);
          if (score > bestScore && score >= 0.5) {
            bestScore = score;
            refHotelData = h;
          }
        }
      }

      const refHotel = {
        name: ref.title || q,
        overall_rating: ref.rating || refHotelData?.overall_rating || null,
        hotel_class: refHotelData?.hotel_class || null,
        address: ref.address || null,
        property_token: refHotelData?.property_token || null,
        isReference: true
      };

      // Construire les concurrents depuis Google Hotels (tokens fiables)
      const seen = new Set([normName(refHotel.name)]);
      const competitors = [];
      const exclude = /camping|auberge|hostel|gite|résidence|appartement|studio/i;

      // Tokens de la référence à exclure des concurrents
      const refTokens = new Set(refHotelsResults.slice(0,3).map(h => h.property_token).filter(Boolean));
      if (refHotelData?.property_token) refTokens.add(refHotelData.property_token);

      // D'abord tous les hôtels Google Hotels (tokens 100% fiables)
      for (const h of hotelsList) {
        if (competitors.length >= 12) break;
        const n = normName(h.name);
        // Exclure la référence et ses tokens
        if (n === normName(refHotel.name)) continue;
        if (refTokens.has(h.property_token)) continue;
        if (seen.has(n)) continue;
        if (exclude.test(h.name)) continue;
        seen.add(n);
        competitors.push({
          name: h.name,
          overall_rating: h.overall_rating || null,
          hotel_class: h.hotel_class || null,
          address: null,
          property_token: h.property_token || null,
          isReference: false
        });
      }

      // Compléter avec Google Local si besoin
      for (const h of zoneResults) {
        if (competitors.length >= 12) break;
        const n = normName(h.title);
        if (seen.has(n)) continue;
        if (exclude.test(h.title) || exclude.test(h.type || '')) continue;
        seen.add(n);
        competitors.push({
          name: h.title,
          overall_rating: h.rating || null,
          hotel_class: null,
          address: h.address || null,
          property_token: null,
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

    // ACTION: score — scoring algorithmique avec étoiles comme critère
    if (action === 'score') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST requis' });
      const body = req.body || {};
      if (!body.hotels || !Array.isArray(body.hotels)) return res.status(400).json({ error: 'Paramètres manquants' });

      const scored = body.hotels.map(h => {
        const googleRating = parseFloat(h.overall_rating) || 3.5;
        const amenities = h.amenities || [];
        const name = (h.name || '').toLowerCase();
        const address = (h.address || '').toLowerCase();
        // Étoiles : depuis hotel_class Google ou estimation par nom de chaîne
        let stars = parseInt(h.hotel_class) || 0;
        if (!stars) {
          if (/formule|premiere classe|etap|\bf1\b|ibis budget|b&b|bb hotel/i.test(name)) stars = 1;
          else if (/ibis(?! budget)|campanile|kyriad|comfort|logis|noemys/i.test(name)) stars = 3;
          else if (/mercure|novotel|best western|holiday inn|crowne|ace|victoria/i.test(name)) stars = 4;
          else if (/pullman|hilton|marriott|hyatt|sheraton|sofitel/i.test(name)) stars = 5;
          else stars = 3; // défaut
        }

        // RATING: 0-30 pts — note Google
        const ratingScore = Math.min(30, Math.round((googleRating / 5) * 30));

        // LOCATION: 0-25 pts
        let locationScore = 14;
        if (/centre|center|gare|historique|coeur|hyper/i.test(name + address)) locationScore = 22;
        else if (/nord|sud|est|ouest|peripherie|zone|commercial/i.test(name + address)) locationScore = 12;
        else if (/aeroport|airport|autoroute/i.test(name + address)) locationScore = 8;

        // ROOM SIZE: 0-15 pts — basé sur les étoiles (critère principal)
        const roomScore = Math.min(15, Math.max(5, stars * 3));
        // 1★→3, 2★→6, 3★→9, 4★→12, 5★→15

        // AMENITIES: 0-20 pts — équipements réels + bonus étoiles
        let amenScore = Math.min(8, stars * 1.5); // bonus étoiles (5★ → +7.5)
        const amStr = amenities.join(' ').toLowerCase();
        if (/pool|piscine/i.test(amStr)) amenScore += 6;
        if (/restaurant|dining/i.test(amStr)) amenScore += 5;
        if (/meeting|reunion|conference/i.test(amStr)) amenScore += 5;
        if (/spa|wellness/i.test(amStr)) amenScore += 4;
        if (/parking/i.test(amStr)) amenScore += 2;
        if (/fitness|gym/i.test(amStr)) amenScore += 2;
        amenScore = Math.min(20, Math.round(amenScore));

        // COMPETITIVE: 0-10 pts — note + étoiles
        const compScore = Math.min(10, Math.round((googleRating >= 4.5 ? 5 : googleRating >= 4.0 ? 4 : googleRating >= 3.5 ? 3 : 2) + (stars >= 4 ? 3 : stars >= 3 ? 2 : 1)));

        // Description
        let locationDesc = 'Zone urbaine';
        if (/centre|center|historique|coeur/i.test(name + address)) locationDesc = 'Centre-ville';
        else if (/gare/i.test(name + address)) locationDesc = 'Quartier gare';
        else if (/nord/i.test(name)) locationDesc = 'Zone nord';
        else if (/sud/i.test(name)) locationDesc = 'Zone sud';
        else if (/aeroport|airport/i.test(name)) locationDesc = 'Zone aeroport';

        const roomSizeSqm = stars <= 1 ? 14 : stars === 2 ? 17 : stars === 3 ? 20 : stars === 4 ? 26 : 32;
        const advantage = stars >= 4 ? `${stars} etoiles - standing superieur` : googleRating >= 4.3 ? 'Excellente note clients' : 'Rapport qualite-prix';

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
