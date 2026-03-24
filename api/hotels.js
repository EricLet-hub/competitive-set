export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'POST' ? (req.body || {}) : req.query;
  const { action, q, property_token, check_in_date, check_out_date, api_key } = params;

  try {

    // ACTION: search — trouve les hôtels de la zone
    if (action === 'search' || !action) {
      if (!api_key) return res.status(400).json({ error: 'Clé API manquante' });
      if (!q) return res.status(400).json({ error: 'Paramètre q manquant' });

      const words = q.trim().split(' ');
      const city = words.slice(-2).join(' ');
      const ci = check_in_date || getTomorrow(7);
      const co = check_out_date || getTomorrow(8);

      // Appel 1: Google Local — localiser l'hôtel de référence
      const localRef = await serpFetch({ engine: 'google_local', q, hl: 'fr', gl: 'fr', api_key });
      const ref = localRef.local_results?.[0] || {};
      const refLat = ref.gps_coordinates?.latitude;
      const refLng = ref.gps_coordinates?.longitude;

      // Appel 2: Google Local zone — concurrents autour
      const zoneQ = { engine: 'google_local', q: `hotel ${city}`, hl: 'fr', gl: 'fr', api_key };
      if (refLat && refLng) zoneQ.ll = `@${refLat},${refLng},13z`;
      const zoneData = await serpFetch(zoneQ);
      const zoneResults = zoneData.local_results || [];

      // Appel 3: Google Hotels sur la ville — récupère tokens ET prix
      const hotelsSearch = await serpFetch({
        engine: 'google_hotels', q: `hotels ${city}`,
        check_in_date: ci, check_out_date: co,
        adults: '2', currency: 'EUR', hl: 'fr', gl: 'fr', api_key
      });
      const hotelsList = hotelsSearch.properties || [];

      // Index des tokens par nom normalisé — matching STRICT (garde la marque)
      function normStrict(s) {
        return (s || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
      }

      // Pour chaque hôtel de Google Hotels, on garde son token associé à son nom exact
      const tokenIndex = {};
      for (const h of hotelsList) {
        if (h.property_token && h.name) {
          tokenIndex[normStrict(h.name)] = { token: h.property_token, rating: h.overall_rating };
        }
      }

      // Recherche du bon token : matching strict d'abord, puis par mots significatifs
      function findBestToken(name) {
        const n = normStrict(name);
        // 1. Exact match
        if (tokenIndex[n]) return tokenIndex[n];
        // 2. Match par mots significatifs (longueur > 3, GARDE la marque)
        const words1 = n.split(' ').filter(w => w.length > 3);
        let bestMatch = null, bestScore = 0;
        for (const [key, val] of Object.entries(tokenIndex)) {
          const words2 = key.split(' ').filter(w => w.length > 3);
          const common = words1.filter(w => words2.includes(w)).length;
          // Score basé sur proportion de mots communs
          const score = common / Math.max(words1.length, words2.length);
          if (score > bestScore && score >= 0.5) {
            bestScore = score;
            bestMatch = val;
          }
        }
        return bestMatch;
      }

      const refMatch = findBestToken(ref.title || q);
      const refHotel = {
        name: ref.title || q,
        overall_rating: ref.rating || refMatch?.rating || null,
        address: ref.address || null,
        property_token: refMatch?.token || null,
        isReference: true
      };

      const exclude = /camping|auberge|hostel|gite|chambre d'hôtes|résidence|appartement|studio/i;
      const seen = new Set([normStrict(refHotel.name)]);
      const competitors = [];

      // D'abord les hôtels Google Hotels (ont des tokens fiables)
      for (const h of hotelsList) {
        if (competitors.length >= 12) break;
        const n = normStrict(h.name);
        const refN = normStrict(refHotel.name);
        if (seen.has(n)) continue;
        // Éviter de dupliquer l'hôtel de référence
        if (n === refN || (n.includes(refN.split(' ')[0]) && refN.includes(n.split(' ')[0]))) continue;
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
        const n = normStrict(h.title);
        if (seen.has(n)) continue;
        if (exclude.test(h.title) || exclude.test(h.type || '')) continue;
        seen.add(n);
        const match = findBestToken(h.title);
        competitors.push({
          name: h.title,
          overall_rating: h.rating || match?.rating || null,
          address: h.address || null,
          property_token: match?.token || null,
          isReference: false
        });
      }

      return res.status(200).json({ properties: [refHotel, ...competitors] });
    }

    // ACTION: details — prix par OTA pour un hôtel via son property_token
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
        lowest_price: prices.length ? Math.min(...prices.map(p => p.price)) : null,
        prices,
        amenities: prop.amenities || []
      });
    }

    // ACTION: score — scoring algorithmique gratuit
    if (action === 'score') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST requis' });
      const body = req.body || {};
      if (!body.hotels || !Array.isArray(body.hotels)) return res.status(400).json({ error: 'Paramètres manquants' });

      const scored = body.hotels.map(h => {
        const googleRating = parseFloat(h.overall_rating) || 3.5;
        const amenities = h.amenities || [];
        const name = (h.name || '').toLowerCase();
        const address = (h.address || '').toLowerCase();

        const ratingScore = Math.min(30, Math.round((googleRating / 5) * 30));

        let locationScore = 14;
        if (/centre|center|gare|historique|coeur|hyper/i.test(name + address)) locationScore = 22;
        else if (/nord|sud|est|ouest|peripherie|zone|commercial/i.test(name + address)) locationScore = 12;
        else if (/aeroport|airport|autoroute/i.test(name + address)) locationScore = 8;

        let roomScore = 9;
        if (/formule|premiere classe|etap|\bf1\b/i.test(name)) roomScore = 5;
        else if (/ibis budget|b&b|bb hotel|first/i.test(name)) roomScore = 7;
        else if (/ibis|campanile|kyriad|comfort|logis/i.test(name)) roomScore = 9;
        else if (/mercure|novotel|best western|holiday inn|crowne|ace/i.test(name)) roomScore = 12;
        else if (/pullman|hilton|marriott|hyatt|sheraton|sofitel|intercontinental/i.test(name)) roomScore = 15;

        let amenScore = 0;
        const amStr = amenities.join(' ').toLowerCase();
        if (/pool|piscine/i.test(amStr)) amenScore += 6;
        if (/restaurant|dining/i.test(amStr)) amenScore += 5;
        if (/meeting|reunion|conference/i.test(amStr)) amenScore += 5;
        if (/spa|wellness/i.test(amStr)) amenScore += 4;
        if (/parking/i.test(amStr)) amenScore += 2;
        if (/fitness|gym/i.test(amStr)) amenScore += 2;
        amenScore = Math.min(20, amenScore);

        const compScore = googleRating >= 4.5 ? 9 : googleRating >= 4.0 ? 7 : googleRating >= 3.5 ? 5 : 3;

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
