"""
osm.py - Convert CNES establishment records to JOSM-ready OpenStreetMap GeoJSON.
"""

import math
import re

ACCENT_DICT = {
    r"\bIndependencia\b": "Independência",
    r"\bGaviao\b": "Gavião",
    r"\bSao\b": "São",
    r"\bCristovao\b": "Cristóvão",
    r"\bJoao\b": "João",
    r"\bEsperanca\b": "Esperança",
    r"\bServico\b": "Serviço",
    r"\bReabilitacao\b": "Reabilitação",
    r"\bFisica\b": "Física",
    r"\bNivel\b": "Nível",
    r"\bIntermediario\b": "Intermediário",
    r"\bDiagnostico\b": "Diagnóstico",
    r"\bFarmacia\b": "Farmácia",
    r"\bSatelite\b": "Satélite",
    r"\bBasica\b": "Básica",
    r"\bBasico\b": "Básico",
    r"\bAvancado\b": "Avançado",
    r"\bAvancada\b": "Avançada",
    r"\bParana\b": "Paraná",
    r"\bClevelandia\b": "Clevelândia",
    r"\bVigano\b": "Viganó",
    r"\bSergio\b": "Sérgio",
    r"\bMauricio\b": "Maurício",
    r"\bIguacu\b": "Iguaçu",
    r"\bTapajos\b": "Tapajós",
    r"\bArarigboia\b": "Ararigbóia",
    r"\bGarcas\b": "Garças",
    r"\bAbastacimento\b": "Abastecimento",
    r"\bFamaceutico\b": "Farmacêutico",
    r"\bPsicissocial\b": "Psicossocial",
    r"\bItalia\b": "Itália",
    r"\bFreddo\b": "Freddo",
    r"\bOeste\b": "Oeste",
    r"\bSul\b": "Sul",
    r"\bChopim\b": "Chopim",
    r"\bMarcos\b": "Marcos",
    r"\bPenso\b": "Penso",
    r"\bAlbuquerque\b": "Albuquerque",
    r"\bMatias\b": "Matias",
    r"\bIvai\b": "Ivaí",
    r"\bXxi\b": "XXI",
    r"\bVictorio\b": "Victório",
    r"\bLourenco\b": "Lourenço",
}

# Verified coordinates for Pato Branco to replace default placeholders or erroneous values
VERIFIED_COORDINATES = {
    4102231: (-26.2279538, -52.6717836),  # CAPSi
    6368662: (-26.2273293, -52.6734782),  # COAS
    8002266: (-26.2206826, -52.6735109),  # 07 Regional de Saúde
    7406088: (-26.2206826, -52.6735109),  # CEREST
    7260342: (-26.2143600, -52.6764393),  # SAMU Avançada
    28592: (-26.2425781, -52.6726842),    # CAPS II
    7817789: (-26.2463664, -52.6844466),  # Academia Pinheirinho
    4615735: (-26.2349977, -52.6499421),  # UBS Parque do Som
    9043144: (-26.2388100, -52.6670800),  # UBS Industrial
    17892: (-26.2563503, -52.6818531),    # UBS Morumbi
    6960863: (-26.2458753, -52.6801589),  # UBS Pinheirinho
    17841: (-26.2310682, -52.6753720),    # Central Health Complex
    9945385: (-26.2310682, -52.6753720),
    9737375: (-26.2310682, -52.6753720),
    2942380: (-26.2310682, -52.6753720),
    8436304: (-26.2310682, -52.6753720),
    7401280: (-26.2310682, -52.6753720),
    28290: (-26.2622743, -52.6044296),    # Fazenda da Barra
}


def apply_accents(text: str) -> str:
    res = text
    for pattern, rep in ACCENT_DICT.items():
        res = re.sub(pattern, rep, res, flags=re.IGNORECASE)
    return res


def title_case_pt(text: str) -> str:
    if not text:
        return ""
    words = text.strip().split()
    lower_words = {"de", "da", "do", "das", "dos", "e", "em", "por", "para"}
    acronyms = {
        "UBS": "UBS",
        "UPA": "UPA",
        "ESF": "ESF",
        "CAPS": "CAPS",
        "CAPSI": "CAPSi",
        "CEO": "CEO",
        "CER": "CER",
        "CEREST": "CEREST",
        "COAS": "COAS",
        "CONIMS": "CONIMS",
        "CIS": "CIS",
        "SAMU": "SAMU",
        "SAD": "SAD",
        "CAF": "CAF",
        "CAS": "CAS",
        "SESA": "SESA",
        "SUS": "SUS",
        "LACEN": "LACEN",
        "PR": "PR",
        "24H": "24h",
        "24": "24",
        "II": "II",
        "III": "III",
        "192": "192",
    }

    formatted = []
    for i, w in enumerate(words):
        upper_w = w.upper().rstrip(",.-")
        trailing = w[len(upper_w) :]
        if upper_w in acronyms:
            formatted.append(acronyms[upper_w] + trailing)
        elif i > 0 and w.lower() in lower_words:
            formatted.append(w.lower())
        else:
            formatted.append(w.capitalize())

    return apply_accents(" ".join(formatted))


def clean_phone(phone_str: str) -> str:
    if not phone_str:
        return ""
    digits = re.sub(r"\D", "", str(phone_str))
    if not digits:
        return ""
    if digits.startswith("55"):
        digits = digits[2:]
    if digits.startswith("0"):
        digits = digits[1:]
    if len(digits) in (8, 9):
        ddd = "46"
        num = digits
    elif len(digits) in (10, 11):
        ddd = digits[:2]
        num = digits[2:]
    else:
        return str(phone_str).strip()

    if len(num) == 8:
        return f"+55 {ddd} {num[:4]}-{num[4:]}"
    elif len(num) == 9:
        return f"+55 {ddd} {num[:5]}-{num[5:]}"
    return f"+55 {ddd} {num}"


def clean_cep(cep_str: str) -> str:
    if not cep_str:
        return ""
    digits = re.sub(r"\D", "", str(cep_str))
    if len(digits) == 8:
        return f"{digits[:5]}-{digits[5:]}"
    return str(cep_str).strip()


def clean_email(email_str: str) -> str:
    if not email_str:
        return ""
    cleaned = str(email_str).strip().lower().replace(",", ".")
    if re.match(r"^[\w\.-]+@[\w\.-]+\.\w+$", cleaned):
        return cleaned
    return ""


def determine_category_and_tags(estab: dict) -> tuple:
    """
    Determines:
      - comment: concise category string (e.g. 'UBS', 'UPA 24h', 'CAPS', 'CEO', etc.)
      - tags: dictionary of standard OSM tags
    """
    cnes = estab.get("codigo_cnes")
    tipo = estab.get("codigo_tipo_unidade")
    nome_fantasia = (estab.get("nome_fantasia") or "").strip()
    nat_jur = str(estab.get("descricao_natureza_juridica_estabelecimento") or "")
    logr = (estab.get("endereco_estabelecimento") or "").strip()
    num = (estab.get("numero_estabelecimento") or "").strip()
    bairro = (estab.get("bairro_estabelecimento") or "").strip()
    cep = clean_cep(estab.get("codigo_cep_estabelecimento"))
    tel = clean_phone(estab.get("numero_telefone_estabelecimento"))
    email = clean_email(estab.get("endereco_email_estabelecimento"))

    # Determine operator
    if nat_jur == "1023":
        operator = "Governo do Estado do Paraná"
    elif nat_jur == "1210":
        operator = "CONIMS - Consórcio Intermunicipal de Saúde"
    else:
        operator = "Prefeitura Municipal de Pato Branco"

    tags = {
        "operator": operator,
        "operator:type": "public",
        "ref:CNES": str(cnes),
        "source": "cnes;datasus;dados_abertos_saude",
        "official_name": nome_fantasia,
    }

    if logr:
        clean_street = logr.strip()
        clean_street = re.sub(r"^RUA\s+TRAVESSA\b", "TRAVESSA", clean_street, flags=re.IGNORECASE)
        if not any(
            clean_street.upper().startswith(p)
            for p in ["RUA ", "AVENIDA ", "TRAVESSA ", "RODOVIA ", "ESTRADA ", "LOCALIDADE ", "SEDE "]
        ):
            clean_street = f"Rua {clean_street}"
        tags["addr:street"] = title_case_pt(clean_street)

    if num and num.upper() not in ("S/N", "0000", "0", "SN", "S/Nº"):
        tags["addr:housenumber"] = num

    if bairro and bairro.upper() not in ("INTERIOR", "PATO BRANCO"):
        tags["addr:suburb"] = title_case_pt(bairro)

    tags["addr:city"] = "Pato Branco"
    tags["addr:state"] = "PR"
    tags["addr:country"] = "BR"

    if cep:
        tags["addr:postcode"] = cep
    if tel:
        tags["phone"] = tel
    if email:
        tags["email"] = email

    fantasia_upper = nome_fantasia.upper()

    # Classification logic
    if tipo in (1, 2):  # Posto de Saúde / UBS
        tags["amenity"] = "clinic"
        tags["healthcare"] = "clinic"
        if "PRISIONAL" in fantasia_upper:
            comment = "UBS Prisional"
            tags["name"] = "Unidade Básica de Saúde Prisional"
            tags["short_name"] = "UBS Prisional"
            tags["access"] = "private"
        elif "SAD" in fantasia_upper or "DOMICILIAR" in fantasia_upper:
            comment = "Serviço de Atenção Domiciliar"
            tags["name"] = "Serviço de Atenção Domiciliar (SAD)"
            tags["short_name"] = "SAD"
        elif cnes == 17841:
            comment = "UBS"
            tags["name"] = "Unidade Central de Saúde"
            tags["short_name"] = "UBS Central"
        elif cnes == 9945385:
            comment = "UBS"
            tags["name"] = "Unidade Básica de Saúde Central (ESF)"
            tags["short_name"] = "UBS ESF Central"
        else:
            comment = "UBS"
            sub_name = fantasia_upper.replace("UNIDADE DE SAUDE", "").strip()
            sub_title = title_case_pt(sub_name)
            tags["name"] = f"Unidade Básica de Saúde {sub_title}"
            tags["short_name"] = f"UBS {sub_title}"

    elif tipo == 20 or "UPA" in fantasia_upper:  # Pronto Atendimento / UPA
        comment = "UPA 24h"
        tags["amenity"] = "clinic"
        tags["healthcare"] = "clinic"
        tags["emergency"] = "yes"
        tags["opening_hours"] = "24/7"
        tags["name"] = "UPA 24 Horas Maria Itália Freddo"
        tags["short_name"] = "UPA 24h"

    elif tipo == 4:  # Reabilitação Física
        comment = "Reabilitação Física"
        tags["amenity"] = "clinic"
        tags["healthcare"] = "rehabilitation"
        tags["name"] = "Serviço de Reabilitação Física Nível Intermediário"

    elif tipo == 36:  # Centros de Especialidades
        if "CEREST" in fantasia_upper:
            comment = "Saúde do Trabalhador (CEREST)"
            tags["amenity"] = "clinic"
            tags["healthcare"] = "occupational_health"
            tags["name"] = "CEREST Macro Centro Sul"
            tags["short_name"] = "CEREST"
        elif "ODONTOLOG" in fantasia_upper or "CEO" in fantasia_upper:
            comment = "Odontologia (CEO)"
            tags["amenity"] = "dentist"
            tags["healthcare"] = "dentist"
            tags["name"] = "Centro de Especialidades Odontológicas (CEO)"
            tags["short_name"] = "CEO"
        elif "REABILITACAO" in fantasia_upper or "CER " in fantasia_upper or fantasia_upper.startswith("CER"):
            comment = "Reabilitação (CER)"
            tags["amenity"] = "clinic"
            tags["healthcare"] = "rehabilitation"
            tags["name"] = "Centro Especializado em Reabilitação (CER)"
            tags["short_name"] = "CER"
        elif "COAS" in fantasia_upper:
            comment = "Apoio Sorológico (COAS)"
            tags["amenity"] = "clinic"
            tags["healthcare"] = "clinic"
            tags["name"] = "Centro de Orientação e Apoio Sorológico (COAS)"
            tags["short_name"] = "COAS"
        elif "MAE PATOBRANQUENSE" in fantasia_upper:
            comment = "Saúde da Mulher & Criança"
            tags["amenity"] = "clinic"
            tags["healthcare"] = "clinic"
            tags["healthcare:speciality"] = "gynaecology;pediatrics"
            tags["name"] = "Unidade Especializada Mãe Patobranquense"
        elif "CONIMS" in fantasia_upper:
            comment = "Consórcio Intermunicipal"
            tags["amenity"] = "clinic"
            tags["healthcare"] = "clinic"
            tags["name"] = "Consórcio Intermunicipal de Saúde (CIS CONIMS)"
            tags["short_name"] = "CIS CONIMS"
        else:
            comment = "Centro de Especialidades"
            tags["amenity"] = "clinic"
            tags["healthcare"] = "clinic"
            tags["name"] = title_case_pt(nome_fantasia)

    elif tipo in (42, 76):  # SAMU / Urgência
        comment = "SAMU 192"
        tags["emergency"] = "ambulance_station"
        tags["emergency_service"] = "technical_rescue"
        tags["opening_hours"] = "24/7"
        if tipo == 76:
            tags["name"] = "Central de Regulação Médica das Urgências (SAMU 192)"
            tags["short_name"] = "Regulação SAMU 192"
        elif "BASICA 1" in fantasia_upper:
            tags["name"] = "Base SAMU 192 - Suporte Básico 1"
            tags["short_name"] = "SAMU USB 1"
        elif "BASICA 2" in fantasia_upper:
            tags["name"] = "Base SAMU 192 - Suporte Básico 2"
            tags["short_name"] = "SAMU USB 2"
        elif "AVANCADO" in fantasia_upper or "AVANCADA" in fantasia_upper:
            tags["name"] = "Base SAMU 192 - Suporte Avançado (USA)"
            tags["short_name"] = "SAMU USA"
        else:
            tags["name"] = "Base SAMU 192"
            tags["short_name"] = "SAMU 192"

    elif tipo == 43:  # Farmácia Pública
        comment = "Farmácia Pública"
        tags["amenity"] = "pharmacy"
        tags["healthcare"] = "pharmacy"
        tags["dispensing"] = "yes"
        tags["name"] = title_case_pt(nome_fantasia)

    elif tipo == 50 or "VIGILANCIA SANITARIA" in fantasia_upper:
        comment = "Vigilância Sanitária"
        tags["office"] = "government"
        tags["government"] = "healthcare"
        tags["name"] = "Vigilância Sanitária Municipal"
        tags["short_name"] = "VISA"

    elif tipo == 68 or "SECRETARIA" in fantasia_upper or "REGIONAL DE SAUDE" in fantasia_upper:
        if "REGIONAL" in fantasia_upper:
            comment = "Regional de Saúde (Estadual)"
            tags["office"] = "government"
            tags["government"] = "healthcare"
            tags["name"] = "7ª Regional de Saúde de Pato Branco (SESA-PR)"
            tags["short_name"] = "7ª RS SESA"
        else:
            comment = "Secretaria Municipal de Saúde"
            tags["office"] = "government"
            tags["government"] = "healthcare"
            tags["name"] = "Secretaria Municipal de Saúde de Pato Branco"
            tags["short_name"] = "SMS Pato Branco"

    elif tipo == 69 or "HEMONUCLEO" in fantasia_upper:
        comment = "Doação de Sangue (HEMEPAR)"
        tags["amenity"] = "blood_donation"
        tags["healthcare"] = "blood_donation"
        tags["name"] = "Hemonúcleo de Pato Branco (HEMEPAR)"
        tags["short_name"] = "Hemepar Pato Branco"

    elif tipo == 70:  # CAPS
        tags["amenity"] = "clinic"
        tags["healthcare"] = "psychiatry"
        tags["healthcare:speciality"] = "psychiatry"
        if "INFANTO" in fantasia_upper or "CAPSI" in fantasia_upper:
            comment = "CAPSi (Infanto-Juvenil)"
            tags["name"] = "Centro de Atenção Psicossocial Infanto-Juvenil (CAPSi)"
            tags["short_name"] = "CAPSi"
        else:
            comment = "CAPS II"
            tags["name"] = "Centro de Atenção Psicossocial (CAPS II)"
            tags["short_name"] = "CAPS II"

    elif tipo == 74:  # Academia da Saúde
        comment = "Academia da Saúde"
        tags["leisure"] = "fitness_centre"
        tags["healthcare"] = "rehabilitation"
        sub_title = title_case_pt(fantasia_upper.replace("ACADEMIA DA SAUDE", "").strip())
        tags["name"] = f"Academia da Saúde {sub_title}"

    elif tipo == 81:  # Regulação / Auditoria
        comment = "Auditoria e Regulação"
        tags["office"] = "government"
        tags["government"] = "healthcare"
        tags["name"] = "Sistema Municipal de Auditoria e Regulação em Saúde"

    elif tipo == 84:  # Central de Abastecimento / Biossegurança / Vigilância Epidem.
        if "EPIDEMIOLOGICA" in fantasia_upper:
            comment = "Vigilância Epidemiológica"
            tags["office"] = "government"
            tags["government"] = "healthcare"
            tags["name"] = "Vigilância Epidemiológica Municipal"
        elif "BIOSSEGURANCA" in fantasia_upper:
            comment = "Biossegurança em Saúde"
            tags["office"] = "government"
            tags["government"] = "healthcare"
            tags["name"] = "Serviço de Biossegurança em Saúde"
        elif "CAF" in fantasia_upper:
            comment = "Abastecimento Farmacêutico (CAF)"
            tags["office"] = "government"
            tags["government"] = "healthcare"
            tags["name"] = "Central de Abastecimento Farmacêutico (CAF)"
            tags["short_name"] = "CAF"
        elif "CAS" in fantasia_upper:
            comment = "Abastecimento de Saúde (CAS)"
            tags["office"] = "government"
            tags["government"] = "healthcare"
            tags["name"] = "Central de Abastecimento da Saúde (CAS)"
            tags["short_name"] = "CAS"
        else:
            comment = "Suprimentos / Logística"
            tags["office"] = "government"
            tags["government"] = "healthcare"
            tags["name"] = title_case_pt(nome_fantasia)

    elif tipo == 85 or "VACINA" in fantasia_upper:  # Sala de Vacinas
        comment = "Sala de Vacinas"
        tags["amenity"] = "clinic"
        tags["healthcare"] = "vaccination"
        tags["name"] = "Sala Central de Vacinas de Pato Branco"
        tags["short_name"] = "Sala de Vacinas"

    elif tipo == 39 or "DIAGNOSTICO" in fantasia_upper:
        comment = "Diagnóstico por Imagem"
        tags["amenity"] = "clinic"
        tags["healthcare"] = "diagnostic_centre"
        tags["name"] = title_case_pt(nome_fantasia)

    else:
        comment = "Outros Serviços de Saúde"
        tags["amenity"] = "clinic"
        tags["healthcare"] = "clinic"
        tags["name"] = title_case_pt(nome_fantasia)

    # Attach the requested 'comment' column
    tags["comment"] = comment

    return comment, tags


def convert_to_osm_geojson(establishments: list, apply_micro_offsets: bool = True) -> dict:
    """
    Converts a list of CNES establishment dictionaries into a JOSM-ready GeoJSON FeatureCollection.
    """
    coord_usage = {}
    features = []

    for estab in sorted(establishments, key=lambda x: (x.get("codigo_tipo_unidade", 0), x.get("nome_fantasia", ""))):
        cnes = estab.get("codigo_cnes")

        if cnes in VERIFIED_COORDINATES:
            lat, lon = VERIFIED_COORDINATES[cnes]
        else:
            lat = estab.get("latitude_estabelecimento_decimo_grau")
            lon = estab.get("longitude_estabelecimento_decimo_grau")

        # Sanity check: fallback to city center if coordinate is missing or off bounds
        if lat is None or lon is None or not (-26.40 <= lat <= -26.00 and -52.90 <= lon <= -52.50):
            lat, lon = (-26.2295, -52.6716)

        # Micro-offset for co-located facilities
        if apply_micro_offsets:
            coord_key = (round(lat, 5), round(lon, 5))
            if coord_key in coord_usage:
                idx = coord_usage[coord_key]
                angle = idx * (2 * math.pi / 6)
                dlat = (3.5 / 111320.0) * math.cos(angle)
                dlon = (3.5 / (111320.0 * math.cos(math.radians(lat)))) * math.sin(angle)
                lat += dlat
                lon += dlon
                coord_usage[coord_key] += 1
            else:
                coord_usage[coord_key] = 1

        _, tags = determine_category_and_tags(estab)

        features.append(
            {
                "type": "Feature",
                "id": cnes,
                "properties": tags,
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(lon, 7), round(lat, 7)],
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "name": "Estabelecimentos Públicos de Saúde - DEMAS / CNES",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": features,
    }
