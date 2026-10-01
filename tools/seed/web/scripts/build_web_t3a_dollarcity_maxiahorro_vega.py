"""Build tools/seed/web/<chain>.json for tiendas3a, dollarcity, maxiahorro, vega
from the raw official-source responses saved under tools/seed/web/raw/<chain>/.

Run: python tools/seed/web/scripts/build_web_t3a_dollarcity_maxiahorro_vega.py
(raw files are fetched separately: see fetch_dollarcity.py and the "method" field of each output)
"""
import json, os, re, html, math, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.normpath(os.path.join(HERE, ".."))
RAW = os.path.join(WEB, "raw")
RETRIEVED = "2026-10-01"

LOWER_WORDS = {"de", "del", "la", "las", "los", "y", "el", "e", "en", "a"}
# INEI-style spelling for district / province names that appear in the sources
ACCENTS = {
    "ancon": "Ancón", "brena": "Breña", "lurin": "Lurín", "mi peru": "Mi Perú", "pachacamac": "Pachacámac",
    "rimac": "Rímac", "san martin de porres": "San Martín de Porres", "villa maria del triunfo": "Villa María del Triunfo",
    "canete": "Cañete", "huarochiri": "Huarochirí", "jesus maria": "Jesús María",
    "san juan de lurigancho": "San Juan de Lurigancho", "villa el salvador": "Villa El Salvador",
}
ALIASES = {  # source spelling -> INEI district name (only unambiguous cases)
    "surco": "Santiago de Surco", "ate vitarte": "Ate", "cercado de lima": "Lima", "chosica": "Lurigancho",
    "molina": "La Molina", "san juan miraflores": "San Juan de Miraflores", "cuzco": "Cusco",
    "piuria": "Piura", "cercado de arequipa": "Arequipa", "smp": "San Martín de Porres",
}
CALLAO_DISTRICTS = {"Callao", "Bellavista", "Carmen de la Legua Reynoso", "La Perla", "La Punta", "Ventanilla", "Mi Perú"}


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def fix_mojibake(s):
    if s and ("Ã" in s or "Â" in s):
        try:
            return s.encode("cp1252").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return s
    return s


def proper(s):
    s = re.sub(r"\s+", " ", (s or "").strip())
    if not s:
        return ""
    words = s.lower().split(" ")
    out = []
    for i, w in enumerate(words):
        if i > 0 and w in LOWER_WORDS:
            out.append(w)
        else:
            out.append(w[:1].upper() + w[1:])
    return " ".join(out)


def admin_name(s):
    """Normalise a district/province name to proper case with accents (INEI spelling where known)."""
    s = re.sub(r"\s+", " ", fix_mojibake(s or "").strip())
    if not s:
        return ""
    key = strip_accents(s).lower()
    if key in ALIASES:
        return ALIASES[key]
    if key in ACCENTS:
        return ACCENTS[key]
    return proper(s)


def in_peru(lat, lng):
    return lat is not None and lng is not None and -18.4 <= lat <= -0.03 and -81.4 <= lng <= -68.6


def num(x):
    try:
        v = float(str(x).strip())
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def dist_m(a, b, c, d):
    R = 6371000.0
    p1, p2 = math.radians(a), math.radians(c)
    dp, dl = p2 - p1, math.radians(d - b)
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def store(name, address, district="", province="", department="", lat=None, lng=None, url="", secondary=False, notes=""):
    if lat is not None or lng is not None:
        lat, lng = round(lat, 7), round(lng, 7)
        if not in_peru(lat, lng):
            raise ValueError(f"coords outside Peru for {name}: {lat},{lng}")
    return {
        "name": re.sub(r"\s+", " ", name).strip(), "address": re.sub(r"\s+", " ", address or "").strip(),
        "district": district, "province": province, "department": department,
        "lat": lat, "lng": lng, "coordsSource": "official" if lat is not None else "none",
        "url": url, "secondary": secondary, "notes": notes.strip(),
    }


def flag_duplicate_coords(stores):
    """Return list of (i, j) index pairs whose coordinates are within 5 m of each other."""
    pairs = []
    pts = [(i, s["lat"], s["lng"]) for i, s in enumerate(stores) if s["lat"] is not None]
    for a in range(len(pts)):
        for b in range(a + 1, len(pts)):
            if dist_m(pts[a][1], pts[a][2], pts[b][1], pts[b][2]) < 5:
                pairs.append((pts[a][0], pts[b][0]))
    return pairs


def write(chain, payload):
    path = os.path.join(WEB, f"{chain}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    n = len(payload["stores"])
    nc = sum(1 for s in payload["stores"] if s["lat"] is not None)
    print(f"{chain}: {n} stores ({nc} with official coords) -> {path}")


# ---------------------------------------------------------------- Tiendas 3A
def build_tiendas3a():
    api = "https://8eegp3sdde.execute-api.us-east-1.amazonaws.com/prod/v1/informacion-general/tiendas"
    page = "https://www.tiendas3a.pe/ubicanos"
    d = json.load(open(os.path.join(RAW, "tiendas3a", "api_tiendas.json"), encoding="utf-8"))
    rows = d["tiendas"]
    assert d.get("total") == len(rows), "API total != rows"
    stores = []
    for t in sorted(rows, key=lambda t: int(t["cencodigo"])):
        prov = admin_name(t["ubiprovincia"])
        dist = admin_name(t["ubidistrito"])
        dept = "Callao" if prov == "Callao" else "Lima" if prov in ("Lima", "Cañete", "Huarochirí") else ""
        # API field names are swapped-looking but correct: coordenadax = latitude, coordenaday = longitude
        lat, lng = num(t["coordenadax"]), num(t["coordenaday"])
        stores.append(store(
            f"Tiendas 3A {proper(t['cennombre'])}", fix_mojibake(t["dirdireccioncompleta"]), dist, prov, dept,
            lat, lng, page, notes=f"store code (cencodigo) {t['cencodigo']}; official name '{fix_mojibake(t['cennombre'])}'"))
    for i, j in flag_duplicate_coords(stores):
        a, b = stores[i], stores[j]
        print("  tiendas3a duplicate coords:", a["name"], "|", b["name"])
    # Known data error in the official feed: 'MANUEL 5' (Jr. Manuel Gonzales 716, Urb. El Retablo, COMAS) carries
    # exactly the same coordinates as store 1262 '12 DE OCTUBRE' (San Martin de Porres). El Retablo is in Comas,
    # several km north of that point, so its coordinates are dropped (to be geocoded later) and the raw values kept in notes.
    # Manual QA of the feed (district-median outlier check + near-duplicate check):
    drop_coords = {
        "1259": ("official feed coords (-11.9988410, -77.0927320) are an exact copy of store 1262 '12 de Octubre' "
                 "(San Martin de Porres) and do not match this Comas address -> set to null, needs geocoding"),
        "1217": ("official feed coords ({lat}, {lng}) lie 18 km from San Miguel, ~300 m from store 'Proceres 6' (Chorrillos), "
                 "and cannot match Av. Juan Bertolotto 720, Urb. San Miguel Antiguo -> set to null, needs geocoding"),
    }
    extra_notes = {
        "1070": "feed district 'COMAS' but coords are near Av. Tupac Amaru cdra. 8 (Rimac/Independencia/SMP area); district must come from point-in-polygon",
        "1087": "only 24 m from store 1133 'Bolognesi 9' (both Santa Anita) in the official feed; verify both exist as separate stores",
        "1133": "only 24 m from store 1087 'La Cultura' (both Santa Anita) in the official feed; verify both exist as separate stores",
    }
    for s in stores:
        code = re.match(r"store code \(cencodigo\) (\d+);", s["notes"]).group(1)
        if code in drop_coords:
            s["notes"] += "; " + drop_coords[code].format(lat=s["lat"], lng=s["lng"])
            s["lat"] = s["lng"] = None
            s["coordsSource"] = "none"
        if code in extra_notes:
            s["notes"] += "; " + extra_notes[code]
    return {
        "chain": "tiendas3a", "retrieved": RETRIEVED,
        "sources": [page, api,
                    "https://forbes.pe/negocios/2026-08-31/nueva-ola-de-discounters-asi-es-como-el-mercado-de-mas-de-us850-millones-seguira-su-avance-en-peru/"],
        "reportedCount": {"value": 258, "source": "https://forbes.pe/negocios/2026-08-31/nueva-ola-de-discounters-asi-es-como-el-mercado-de-mas-de-us850-millones-seguira-su-avance-en-peru/",
                          "date": "2026-08-31"},
        "complete": True,
        "method": ("Official store locator https://www.tiendas3a.pe/ubicanos (Astro page + Leaflet) loads all stores from the JSON API "
                   f"{api} (fields cencodigo, cennombre, dirdireccioncompleta, ubiprovincia, ubidistrito, coordenadax=lat, coordenaday=lng). "
                   f"One GET returned total={d['total']} stores, all with coordinates (raw: raw/tiendas3a/api_tiendas.json). "
                   "Mojibake in district/province names (e.g. 'BREÃ‘A') repaired; names proper-cased. One store (code 1259 'MANUEL 5', Comas) "
                   "had coordinates identical to store 1262 in San Martin de Porres and one (1217 'BERTOLOTTO 7', San Miguel) had coordinates 18 km away in Chorrillos; both set to null for geocoding. "
                   "Independent count for comparison: Forbes Peru 2026-08-31 reports 258 stores (Peru-Retail 2026-04-24: 240 in Lima). "
                   "All stores are in Lima Metropolitana/Callao plus 1 in Asia (Cañete) and 1 in San Antonio (Huarochirí)."),
        "stores": stores,
    }


# ---------------------------------------------------------------- Dollarcity
DC_REGION = {"ARE": "Arequipa", "LIM": "Lima", "LAL": "La Libertad", "PIU": "Piura", "UCA": "Ucayali", "JUN": "Junín",
             "LAM": "Lambayeque", "ICA": "Ica", "ANC": "Áncash", "CAJ": "Cajamarca", "CUS": "Cusco", "HUC": "Huánuco",
             "LOR": "Loreto", "AYA": "Ayacucho"}


def build_dollarcity():
    loc = "https://dollarcity.com/ubicaciones"
    api = "https://dollarcity.com/ubicaciones/locations/GetDataByCoordinates"
    rows = json.load(open(os.path.join(RAW, "dollarcity", "locator_stores.json"), encoding="utf-8"))
    stores, skipped = [], []
    # the feed holds two records for Av. Mariscal Castilla 320 (Arequipa): ref 4089 (BusinessStatus 0) and an older
    # ref 3404 (BusinessStatus 4, same coordinates) -> keep only the active one
    for r in sorted(rows, key=lambda r: int(r["ExtraData"]["ReferenceCode"])):
        ex, a = r["ExtraData"], r["ExtraData"]["Address"]
        if ex.get("BusinessStatus") != 0:
            skipped.append(r)
            continue
        lng, lat = r["Location"]["coordinates"]
        line1 = (a.get("AddressNonStruct_Line1") or "").strip()
        line2 = (a.get("AddressNonStruct_Line2") or "").strip()
        address = line1 + (", " + line2 if line2 and line2.lower() != "none" else "")
        region = a.get("Region") or ""
        dept = DC_REGION.get(region.upper(), admin_name(region) if region else "")
        if dept == "Ancash":
            dept = "Áncash"
        if dept == "Cuzco":
            dept = "Cusco"
        long_name = ex["Name"]["LongName"] or r["Name"]
        # per-store detail pages (built with the site's slug rule) proved unreliable (some 404) -> link the locator itself
        url = loc
        stores.append(store(
            long_name, address, admin_name(a.get("Locality") or ""), "", dept, lat, lng, url,
            notes=(f"ReferenceCode {ex['ReferenceCode']}, LocationNumber {r['LocationNumber']}, LocationId {r['LocationId']}; locator locality='{a.get('Locality')}', "
                   f"region='{region}', postal={a.get('PostalCode')}. Locator admin fields are city-level/inconsistent -> use point-in-polygon")))
    dc_extra = {
        "4096": ("QA: locator text is inconsistent - name 'Prolongación Huaylas', Urb. San Juan Bautista de Villa and locality Chorrillos, "
                 "region 'Ayacucho', but the coordinates fall near Av. Caminos del Inca (Santiago de Surco); verify the location"),
    }
    for st in stores:
        ref = re.match(r"ReferenceCode (\d+),", st["notes"]).group(1)
        if ref in dc_extra:
            st["notes"] += "; " + dc_extra[ref]
    # Stores announced by press as open but absent from the locator feed (secondary sources, no coordinates)
    stores.append(store(
        "Dollarcity Plaza San Miguel", "Centro Comercial Plaza San Miguel, tercer nivel (ex local de Chuck E. Cheese), 840 m²",
        "San Miguel", "Lima", "Lima", None, None, "https://accep.org.pe/2026/04/08/dollarcity-inaugura-su-nueva-tienda-en-plaza-san-miguel/",
        secondary=True, notes="Opening reported 2026-04-08 by ACCEP (store 'number 111' in Peru); not present in the official locator feed on 2026-10-01"))
    stores.append(store(
        "Dollarcity Sullana Centro", "Calle Sucre N.° 601, transversal Lima y Calle Leoncio Prado, sector Centro",
        "Sullana", "Sullana", "Piura", None, None,
        "https://www.peru-retail.com/dollarcity-alcanza-las-116-tiendas-en-peru-con-una-nueva-apertura-donde-esta-ubicada/",
        secondary=True, notes="Opening reported 2026-07-02 by Peru-Retail (brought total to 116); not present in the official locator feed on 2026-10-01"))
    for i, j in flag_duplicate_coords(stores):
        print("  dollarcity duplicate coords:", stores[i]["name"], "|", stores[j]["name"])
    official = sum(1 for s in stores if not s["secondary"])
    return {
        "chain": "dollarcity", "retrieved": RETRIEVED,
        "sources": [loc, api, "https://dollarcity.com/ubicaciones/locations/GetDataByState",
                    "https://www.peru-retail.com/dollarcity-alcanza-las-116-tiendas-en-peru-con-una-nueva-apertura-donde-esta-ubicada/",
                    "https://accep.org.pe/2026/04/08/dollarcity-inaugura-su-nueva-tienda-en-plaza-san-miguel/"],
        "reportedCount": {"value": 116, "source": "https://www.peru-retail.com/dollarcity-alcanza-las-116-tiendas-en-peru-con-una-nueva-apertura-donde-esta-ubicada/",
                          "date": "2026-07-02"},
        "complete": False,
        "method": ("Official store locator https://dollarcity.com/ubicaciones (Umbraco + Mapbox). Its JSON endpoint "
                   "POST /ubicaciones/locations/GetDataByCoordinates?longitude&latitude&distance&units=kilometers&filter=PE caps the radius at ~160 km, "
                   "so a 1.8-degree grid of 88 query points covering all of Peru (every point within ~145 km of a node) was queried at 1 req/s, "
                   "plus GetDataByState for all 26 PE region codes (found nothing new); de-duplicated by LocationId "
                   f"(script scripts/fetch_dollarcity.py, raw: raw/dollarcity/). Feed: {len(rows)} PE records -> {official} active stores "
                   f"(skipped {len(skipped)} record(s) with BusinessStatus!=0: ref 3404, an older duplicate of Mariscal Castilla/Arequipa ref 4089). "
                   "Store reference codes run 4001-4111 with only 4105 missing. All locator stores have official coordinates. "
                   "The locator appears to lag recent openings: press reported 116 stores on 2026-07-02 (Peru-Retail; a 2026-09-24 Peru-Retail piece repeats "
                   "'116 a mediados de 2026'), and two press-reported openings are absent from the feed; they were added with secondary=true and no coordinates "
                   "(Plaza San Miguel, Apr 2026; Sullana Calle Sucre 601, Jul 2026). Press also mentions a Tarapoto opening without an address -> not added. "
                   "Press counts are mutually inconsistent (e.g. Gestión 2026-02-10: 113; ACCEP 2026-04-08: Plaza San Miguel = #111), so the exact gap is unknown. "
                   "Store url = the locator page (per-store detail URLs built with the site's slug rule were not reliable: 1 of 4 spot checks returned 404)."),
        "stores": stores,
    }


# ---------------------------------------------------------------- Maxiahorro
MX_DISTRICT = {  # label in locator -> district (only when the label itself names the district/city)
    "Rimac": "Rímac", "Lince (Iquitos)": "Lince", "La Victoria (Manco Capac)": "La Victoria",
    "SMP (Gran Caqueta)": "San Martín de Porres", "Barranca": "Barranca", "Huacho": "Huacho", "Ica": "Ica",
    "Sullana": "Sullana", "Sullana (Jose de Lama)": "Sullana", "Paita": "Paita", "Chulucanas": "Chulucanas",
    "Sechura": "Sechura", "Piura (La Unión)": "La Unión",
}


def build_maxiahorro():
    page = "https://maxiahorro.com.pe/tiendas/"
    s = open(os.path.join(RAW, "maxiahorro", "tiendas.html"), encoding="utf-8").read()
    cards = re.findall(r'<div class="cards--shops" data-departament="([^"]*)" data-distrito="([^"]*)" data-lat="([^"]*)" data-lng="([^"]*)">(.*?)<div class="hour">(.*?)</div>', s, re.S)
    stores = []
    for dept, label, lat, lng, body, hour in cards:
        label = html.unescape(label).strip()
        h4 = html.unescape(re.sub(r"\s+", " ", re.search(r"<h4>(.*?)</h4>", body, re.S).group(1)).strip())
        addr = html.unescape(re.sub(r"\s+", " ", re.search(r'<div class="direction">\s*<span>(.*?)</span>', body, re.S).group(1)).strip())
        hours = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", hour)).strip())
        stores.append(store(f"Maxiahorro {h4}", addr, MX_DISTRICT.get(label, ""), "", html.unescape(dept),
                            num(lat), num(lng), page, notes=f"locator label '{label}'" + (f"; hours: {hours}" if hours else "")))
    assert len(stores) == len(re.findall(r'class="cards--shops"', s)), "card parse mismatch"
    for i, j in flag_duplicate_coords(stores):
        print("  maxiahorro duplicate coords:", stores[i]["name"], "|", stores[j]["name"])
    return {
        "chain": "maxiahorro", "retrieved": RETRIEVED,
        "sources": [page, "https://gestion.pe/economia/empresas/smu-inaugura-dos-maxiahorro-en-piura-y-refuerza-su-expansion-en-el-norte-del-peru-noticia/"],
        "reportedCount": {"value": 32, "source": "https://gestion.pe/economia/empresas/smu-inaugura-dos-maxiahorro-en-piura-y-refuerza-su-expansion-en-el-norte-del-peru-noticia/",
                          "date": "2026-03-10"},
        "complete": True,
        "method": ("Official WordPress page https://maxiahorro.com.pe/tiendas/ (SMU Peru / Mayorsa) renders every store server-side as "
                   "<div class='cards--shops' data-departament data-distrito data-lat data-lng> with name, address and hours; parsed all cards "
                   f"({len(stores)}, raw: raw/maxiahorro/tiendas.html). Coordinates are the site's own data-lat/data-lng. 'district' is filled only "
                   "where the store label names the district/city; Piura-city stores (labels like 'Piura (Grau)') are left blank for point-in-polygon. "
                   "Count matches Gestión 2026-03-10 ('llega a 32 locales')."),
        "stores": stores,
    }


# ---------------------------------------------------------------- Vega
def build_vega():
    page = "https://www.vega.pe/nuestras-tiendas"
    pickup_api = "https://www.vega.pe/api/checkout/pub/pickup-points"
    content = json.load(open(os.path.join(RAW, "vega", "sucursales_content.json"), encoding="utf-8"))
    props = json.load(open(os.path.join(RAW, "vega", "sucursales_props_default.json"), encoding="utf-8"))
    pickup = {}
    for fn in os.listdir(os.path.join(RAW, "vega")):
        if fn.startswith("pp_"):
            for it in json.load(open(os.path.join(RAW, "vega", fn), encoding="utf-8"))["items"]:
                pickup[it["pickupPoint"]["id"]] = it["pickupPoint"]
    # pickup point id -> keyword in the locator name (for coordinate fallback / cross-check)
    pp_key = {"huamantanga": "Huamantanga", "chorrillos": "Supermayorista Chorrillos", "sanantonio": "Supermayorista San Antonio",
              "sandiego": "San Diego", "colonial": "Colonial", "filomeno": "Ciudad y Campo", "limaves": "Villa Lima",
              "santaclara": "Santa Clara", "belaunde": "Belaunde", "minka": "Minka", "maranga": "Market Maranga",
              "ventanilla": "Gambetta", "naranjal": "Sol de Naranjal", "surco": "Tomas Marsano"}
    stores, blank = [], 0
    for x in content:
        raw_name = re.sub(r"\s+", " ", (x.get("NOMBRE") or "")).strip()
        if not raw_name:
            blank += 1
            continue
        m = re.match(r"^(.*?)\s*-\s*(.*)$", raw_name)
        dist_src, nm = (m.group(1).strip(), m.group(2).strip()) if m else ("", raw_name)
        if not nm.lower().startswith("vega"):
            nm = "Vega " + nm
        if nm.strip().lower() == "vega market":  # 'Canta Callao - Vega Market ' -> name it after its location
            nm = "Vega Market " + dist_src
            dist_src = ""
        district = admin_name(dist_src) if dist_src.lower() not in ("canta callao",) else ""
        district = re.sub(r"\s+", " ", district)
        if district == "Villa el Salvador":
            district = "Villa El Salvador"
        dept = "Callao" if district in CALLAO_DISTRICTS else "Lima"
        prov = dept
        lat, lng = num(x.get("Latitud")), num(x.get("Longitud"))
        notes = [f"locator entry '{raw_name}'"]
        fmt = next((f for f in ("Supermayorista", "Mayorista", "Supermercado", "Market") if f.lower() in nm.lower()), None)
        notes.append(f"format: {fmt}" if fmt else "format not stated")
        if x.get("TELEFONO"):
            notes.append(f"tel {x['TELEFONO'].strip()}")
        # pickup-point cross-check
        pp = next((p for pid, p in pickup.items() for k, kw in pp_key.items()
                   if re.search(rf"vegaperu0*\d+{k}_", pid) and kw.lower() in nm.lower() + " " + raw_name.lower()), None)
        if pp:
            plng, plat = pp["address"]["geoCoordinates"]
            notes.append(f"VTEX pickup point {pp['id']} at {plat:.6f},{plng:.6f}")
        addr = re.sub(r"^[\s:]+", "", x.get("DIRECCION") or "")
        stores.append([nm, addr, district, prov, dept, lat, lng, notes, pp])
    out = []
    # coordinate fixes: (a) missing coords -> pickup point coords; (b) Colonial carries Belaunde's coords (copy error)
    for nm, addr, district, prov, dept, lat, lng, notes, pp in stores:
        if pp and (lat is None or lng is None):
            plng, plat = pp["address"]["geoCoordinates"]
            lat, lng = plat, plng
            notes.append("locator has no coordinates; used the official VTEX pickup-point coordinates")
        if "Colonial" in nm and lat is not None and dist_m(lat, lng, -11.939644247204237, -77.05097850353803) < 50 and pp:
            plng, plat = pp["address"]["geoCoordinates"]
            notes.append(f"locator coords ({lat}, {lng}) duplicate Supermayorista Belaunde (Comas), not Av. Colonial 679 -> replaced by pickup-point coords")
            lat, lng = plat, plng
        out.append(store(nm, addr, district, prov, dept, lat, lng, page, notes="; ".join(notes)))
    for i, j in flag_duplicate_coords(out):
        print("  vega duplicate coords:", out[i]["name"], "|", out[j]["name"])
    # entries of the older default list that have no counterpart (same name ignoring accents, or within 150 m) in the current list
    def key(n):
        n = strip_accents(re.sub(r"\s+", " ", n or "")).lower()
        return re.sub(r"^vega (market|supermayorista|mayorista|supermercado) ", "", n.split(" - ", 1)[-1].strip())
    now_keys = {key(x.get("NOMBRE")) for x in content if (x.get("NOMBRE") or "").strip()}
    dropped = []
    for p in props:
        plat, plng = num(p.get("Latitud")), num(p.get("Longitud"))
        near = plat is not None and plng is not None and any(
            s["lat"] is not None and dist_m(plat, plng, s["lat"], s["lng"]) < 150 for s in out)
        if key(p["NOMBRE"]) not in now_keys and not near:
            dropped.append(p["NOMBRE"])
    return {
        "chain": "vega", "retrieved": RETRIEVED,
        "sources": [page, pickup_api,
                    "https://gestion.pe/economia/empresas/grupo-vega-alista-10-tiendas-en-2026-y-cambia-su-estrategia-apuesta-por-formato-market-noticia/"],
        "reportedCount": {"value": 65, "source": "https://gestion.pe/economia/empresas/grupo-vega-alista-10-tiendas-en-2026-y-cambia-su-estrategia-apuesta-por-formato-market-noticia/",
                          "date": "2026-04-27"},
        "complete": True,
        "method": ("Official VTEX IO site https://www.vega.pe/nuestras-tiendas: the 'mapSearch' block embeds the store list in the page's "
                   "server-rendered runtime JSON as 'sucursales' [{NOMBRE, DIRECCION, TELEFONO, Correo, Latitud, Longitud}]. The block carries two arrays: "
                   f"the theme default 'props' ({len(props)} entries, older) and the Site-Editor 'content' ({len(content)} entries, {blank} blank) that overrides it "
                   "and is what the page renders; the content list was used (raw: raw/vega/sucursales_content.json; the props list is kept as "
                   "sucursales_props_default.json). Cross-checked with the public VTEX pickup-points API (14 supermayorista/market pickup points with "
                   "coordinates, raw/vega/pp_*.json), used only to fill missing coordinates (Gambetta/Ventanilla) and to fix Colonial, whose locator "
                   "coordinates were a copy of Belaunde's. Includes all formats (Market, Supermayorista/cash & carry, Mayorista, Supermercado); format is in notes. "
                   f"Entries only in the older default list (possibly closed or renamed): {', '.join(dropped) if dropped else 'none'}. "
                   "Gestión 2026-04-27: 65 stores (≈47 market, 14 cash & carry, 1 supermarket, 2-3 mayoristas); several Market openings since."),
        "stores": out,
    }


if __name__ == "__main__":
    for fn in (build_tiendas3a, build_dollarcity, build_maxiahorro, build_vega):
        payload = fn()
        write(payload["chain"], payload)
