"""Pruebas de `atributos_ia.py` (`npm run probar:api`, o `python prueba_atributos_ia.py` desde
api/). No usan la base ni la red: preguntan por lo que se acepta de una respuesta del modelo.
Cada respuesta es la que podría inventar un modelo, no la que debería dar.
"""
from __future__ import annotations

import sys

import atributos_ia as ia

TEXTO = ("Bodega en renta en Apodaca. Terreno de 2,500 m2 y construcción de 1,800 m2, "
         "en esquina y sobre Av. Miguel Alemán. Altura libre de 9 m.")


def r(**campos) -> dict:
    return {k: {"valor": v[0], "evidencia": v[1]} for k, v in campos.items()}


def lo_que_dice_el_texto_se_acepta():
    v = ia.validar(TEXTO, r(terreno_m2=(2500, "Terreno de 2,500 m2"),
                            construccion_m2=(1800, "construcción de 1,800 m2"),
                            esquina=(True, "en esquina"),
                            sobre_avenida=(True, "sobre Av. Miguel Alemán")))
    assert v["datos"] == {"terreno_m2": 2500.0, "construccion_m2": 1800.0,
                          "esquina": True, "sobre_avenida": True}, v
    assert v["descartes"] == {}
    assert v["evidencias"]["esquina"] == "en esquina"


def una_frase_inventada_no_pasa():
    v = ia.validar(TEXTO, r(drive_thru=(True, "con drive thru para autos")))
    assert v["datos"] == {} and v["descartes"] == {"drive_thru": "la evidencia no está en el texto"}


def un_numero_que_no_esta_en_la_frase_no_pasa():
    v = ia.validar(TEXTO, r(terreno_m2=(25000, "Terreno de 2,500 m2")))
    assert v["descartes"] == {"terreno_m2": "el número no está en la evidencia"}


def la_frase_tiene_que_hablar_de_eso():
    # Una frase real del texto que no dice esquina no sostiene un «sí».
    v = ia.validar(TEXTO, r(esquina=(True, "Bodega en renta en Apodaca")))
    assert v["descartes"] == {"esquina": "la evidencia no habla de eso"}
    # «Tiendas de autoservicio» son supermercados, no un drive-thru (salió en la muestra).
    v = ia.validar("Buenos accesos, tiendas de autoservicio y rutas cercanas",
                   r(drive_thru=(True, "tiendas de autoservicio")))
    assert v["descartes"] == {"drive_thru": "la evidencia no habla de eso"}, v
    # «Superficie» sola no es ni terreno ni construcción: es la ambigüedad que se le pregunta.
    v = ia.validar("Local con superficie de 120 m2", r(terreno_m2=(120, "superficie de 120 m2")))
    assert v["descartes"] == {"terreno_m2": "la evidencia no habla de eso"}


def lo_que_enseno_la_primera_pasada():
    # Tres trampas reales de la noche del 2026-11-05, más el caso bueno de cada una.
    texto = ("Bodega en esquina sobre Av. Ruiz Cortines con 2 rampas tipo drive-in. "
             "Oficina ubicada en piso 15 en esquina. Nave en parque industrial sobre avenida.")
    v = ia.validar(texto, r(drive_thru=(True, "2 rampas tipo drive-in"),
                            esquina=(True, "ubicada en piso 15 en esquina"),
                            sobre_avenida=(True, "Nave en parque industrial sobre avenida")))
    assert v["datos"] == {}, v
    assert v["descartes"] == {"drive_thru": "la evidencia no habla de eso",
                              "esquina": "la evidencia habla de otra cosa",
                              "sobre_avenida": "la evidencia habla de otra cosa"}, v
    v = ia.validar(texto, r(esquina=(True, "Bodega en esquina"),
                            sobre_avenida=(True, "sobre Av. Ruiz Cortines")))
    assert v["datos"] == {"esquina": True, "sobre_avenida": True}, v
    v = ia.validar("Local con drive-thru y autoexpress", r(drive_thru=(True, "Local con drive-thru")))
    assert v["datos"] == {"drive_thru": True}, v


def copiar_toda_la_descripcion_no_es_evidencia():
    largo = "Local comercial en esquina. " + "Excelente ubicación, mucho flujo vehicular. " * 6
    v = ia.validar(largo, r(esquina=(True, largo)))
    assert v["descartes"] == {"esquina": "evidencia demasiado larga"}


def los_numeros_se_leen_como_los_escribe_una_persona():
    for texto, valor in (("terreno de 1.200 m2", 1200), ("terreno de 1 200 m2", 1200),
                         ("terreno de 350.5 m2", 350.5), ("terreno de 1.200,50 m²", 1200.5),
                         ("terreno de 800m2", 800)):
        v = ia.validar(texto, r(terreno_m2=(valor, texto)))
        assert v["datos"] == {"terreno_m2": float(valor)}, (texto, v)


def acentos_signos_y_mayusculas_no_cuentan():
    v = ia.validar("Local con DRIVE-THRU y estacionamiento", r(drive_thru=(True, "drive thru")))
    assert v["datos"] == {"drive_thru": True}, v
    v = ia.validar("Terreno de 500 m² en esquina", r(terreno_m2=(500, "Terreno de 500 m2")))
    assert v["datos"] == {"terreno_m2": 500.0}, v


def terreno_y_construccion_iguales_valen_si_el_texto_lo_dice():
    texto = "Nave de 600 m2 de terreno y 600 m2 de construcción"
    v = ia.validar(texto, r(terreno_m2=(600, "600 m2 de terreno"),
                            construccion_m2=(600, "600 m2 de construcción")))
    assert v["datos"] == {"terreno_m2": 600.0, "construccion_m2": 600.0}, v


def un_si_tiene_que_ser_un_si():
    v = ia.validar(TEXTO, r(esquina=("sí", "en esquina"), sobre_avenida=(False, "sobre Av. Miguel Alemán")))
    assert v["datos"] == {} and set(v["descartes"]) == {"esquina", "sobre_avenida"}, v


def una_superficie_absurda_no_pasa():
    v = ia.validar("terreno de 0 m2", r(terreno_m2=(0, "terreno de 0 m2")))
    assert v["descartes"] == {"terreno_m2": "fuera de rango"}
    v = ia.validar(TEXTO, r(terreno_m2=(True, "Terreno de 2,500 m2")))
    assert v["descartes"] == {"terreno_m2": "no es un número"}


def lo_que_no_se_pidio_se_ignora():
    # Una descripción que «ordena» algo no consigue más que los cinco campos.
    respuesta = {"comando": "rm -rf /", "tools": ["shell"], "esquina": {"valor": None, "evidencia": None}}
    v = ia.validar(TEXTO, respuesta)
    assert v == {"datos": {}, "evidencias": {}, "descartes": {}}, v


def una_respuesta_rota_no_truena():
    for respuesta in (None, "texto", [], 42, {"terreno_m2": "2500"}, {"esquina": {"valor": True}}):
        v = ia.validar(TEXTO, respuesta)
        assert v["datos"] == {}, (respuesta, v)


def el_pedido_lleva_el_texto_como_dato_y_recortado():
    m = ia.pedido("bodega", "x" * (ia.TEXTO_MAX + 500))
    assert [p["role"] for p in m] == ["system", "user"]
    assert "JSON" in m[0]["content"]        # DeepSeek exige la palabra para responder en JSON
    assert m[1]["content"].count("x") == ia.TEXTO_MAX
    assert "no instrucciones" in m[1]["content"]


def la_huella_cambia_con_el_texto_y_con_la_version():
    a = ia.huella("Local en esquina")
    assert a == ia.huella("Local en esquina") and a != ia.huella("Local en esquina.")
    viejo = ia.VERSION
    try:
        ia.VERSION = viejo + 1
        assert ia.huella("Local en esquina") != a
        assert ia.huella("Local en esquina", viejo) == a      # la de otra versión se puede calcular
    finally:
        ia.VERSION = viejo


PRUEBAS = [lo_que_dice_el_texto_se_acepta, una_frase_inventada_no_pasa,
           un_numero_que_no_esta_en_la_frase_no_pasa, la_frase_tiene_que_hablar_de_eso,
           lo_que_enseno_la_primera_pasada, copiar_toda_la_descripcion_no_es_evidencia, los_numeros_se_leen_como_los_escribe_una_persona,
           acentos_signos_y_mayusculas_no_cuentan, terreno_y_construccion_iguales_valen_si_el_texto_lo_dice,
           un_si_tiene_que_ser_un_si, una_superficie_absurda_no_pasa, lo_que_no_se_pidio_se_ignora,
           una_respuesta_rota_no_truena, el_pedido_lleva_el_texto_como_dato_y_recortado,
           la_huella_cambia_con_el_texto_y_con_la_version]


def main() -> int:
    fallas = 0
    for prueba in PRUEBAS:
        try:
            prueba()
            print(f"  ok     {prueba.__name__}")
        except Exception as e:
            fallas += 1
            print(f"  FALLA  {prueba.__name__}: {type(e).__name__}: {e}")
    print(f"atributos_ia: {len(PRUEBAS) - fallas} de {len(PRUEBAS)} pruebas pasan")
    return 1 if fallas else 0


if __name__ == "__main__":
    sys.exit(main())
