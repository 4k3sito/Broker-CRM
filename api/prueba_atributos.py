"""Pruebas de `atributos.py` (`npm run probar:api`). No usan la base: `api/probar.sh` corre
cada `prueba_*.py` y a ésta le basta con el módulo. Cada caso salió de un anuncio real.
"""
from __future__ import annotations

import sys

import atributos


def v(tipo, features=None, texto=None) -> dict:
    return {a["clave"]: a["valor"] for a in atributos.de(tipo, features, texto)}


def cada_tipo_ensena_lo_suyo():
    fs = ["Estacionamientos: 4", "Baños: 2", "Elevador"]
    assert [a["clave"] for a in atributos.de("oficina", fs, None)] == ["cajones", "banos", "elevador"]
    assert [a["clave"] for a in atributos.de("local", fs, "8 m de frente")] == ["frente", "banos", "cajones"]
    assert [a["clave"] for a in atributos.de("bodega", fs, "altura de 10 metros")] == ["altura", "cajones"]
    assert atributos.de("terreno", fs, None) == []          # un terreno no tiene baños
    assert [a["clave"] for a in atributos.de(None, fs, None)] == ["cajones", "banos"]


def sin_dato_no_sale_nada():
    assert atributos.de("bodega", None, None) == []
    assert atributos.de("local", [], "") == []


def lo_que_dice_el_portal_gana_a_la_descripcion():
    assert v("bodega", ["estacionamientos: 4"], "12 cajones") == {"cajones": 4}
    assert v("bodega", None, "cuenta con 12 cajones de estacionamiento") == {"cajones": 12}
    assert v("bodega", None, "cinco (5) estacionamientos") == {"cajones": 5}


def estacionamiento_sin_numero_es_que_si_hay():
    assert v("bodega", ["estacionamiento"]) == {"cajones": True}
    assert v("local", ["estacionamiento techado"]) == {"cajones": True}
    assert v("local", ["facilidad para estacionarse"]) == {}
    assert v("local", None, "un estacionamiento amplio") == {}


def cada_medio_bano_cuenta_como_bano():
    assert v("local", ["baños: 2", "medios baños: 1"]) == {"banos": 3}
    assert v("local", ["2 medios baños"]) == {"banos": 2}
    assert v("local", None, "2 baños completos y 1 medio baño") == {"banos": 3}
    assert v("local", None, "2.5 baños") == {"banos": 3}
    assert v("local", None, "1 1/2 baño y 1 lugar") == {"banos": 2}
    assert v("local", None, "cuenta con 1/2 baño") == {}
    assert v("oficina", None, "nivel: 3 baños: 8 cajones: 4").get("banos") is None


def la_altura_es_una_medida_no_un_lugar():
    assert v("bodega", None, "ALTURA LIBRE INTERIOR DE BODEGA 9M") == {"altura": 9}
    assert v("bodega", None, "Altura total: 12.43m") == {"altura": 12.43}
    assert v("bodega", None, "nave de 9 metros de altura") == {"altura": 9}
    assert v("bodega", None, "a la altura de Gonzalitos, a 500 m del metro") == {}
    assert v("bodega", None, "altura 1200 m2") == {}        # es superficie
    assert v("bodega", None, "altura de 200 m") == {}       # fuera de rango
    assert v("bodega", None, "altura minima 9. 14 mts") == {"altura": 9.14}
    assert v("terreno", None, "2.\n24 m de frente") == {"frente": 24}    # un salto de línea no parte un decimal
    assert v("bodega", None, "claro entre columnas de 30 metros") == {}
    assert v("bodega", None, "altura maxima 40 mts de frente x 35 de fondo") == {}
    assert v("bodega", None, "12mts de altura maxima y 9 altura minima 20mts de frente") == {"altura": 12}


def el_frente_es_una_medida_no_una_direccion():
    assert v("terreno", None, "10 m de frente por 30 de fondo") == {"frente": 10}
    assert v("terreno", None, "Frente: 25.5 m") == {"frente": 25.5}
    assert v("terreno", None, "frente de 40 metros") == {"frente": 40}
    assert v("terreno", None, "frente a 200 m del metro") == {}
    assert v("terreno", None, "a 100 metros frente a la plaza") == {}


def el_frente_que_trae_el_portal():
    assert v("local", ["M² de frente: 48", "M² de fondo: 124"]) == {"frente": 48}


def andenes_con_y_sin_numero():
    assert v("bodega", None, "2 andenes de carga") == {"andenes": 2}
    assert v("bodega", None, "cuenta con dos andenes") == {"andenes": 2}
    assert v("bodega", None, "con andén para tráiler") == {"andenes": True}
    assert v("bodega", None, "sin andén") == {}


def elevador_negado_no_cuenta():
    assert v("oficina", ["elevador: 1"]) == {"elevador": True}
    assert v("oficina", None, "edificio con elevador") == {"elevador": True}
    assert v("oficina", None, "sin elevador") == {}


def lo_que_falta_se_hereda_de_los_hermanos():
    hereda = lambda propios, *hermanos, tipo="bodega": atributos.heredar(tipo, propios, list(hermanos))
    cajones = {"clave": "cajones", "valor": 4}
    assert hereda([cajones], [{"clave": "cajones", "valor": 9}]) == [cajones]    # lo propio gana
    assert hereda([], [cajones]) == [{**cajones, "heredado": True}]
    # Un número de un hermano mejora a un "sí hay" propio.
    assert hereda([{"clave": "andenes", "valor": True}], [{"clave": "andenes", "valor": 3}]) == \
        [{"clave": "andenes", "valor": 3, "heredado": True}]
    # Si los hermanos se contradicen, nadie hereda el número: se queda lo que había.
    assert hereda([], [cajones], [{"clave": "cajones", "valor": 9}]) == []
    assert hereda([{"clave": "cajones", "valor": True}], [cajones], [{"clave": "cajones", "valor": 9}]) == \
        [{"clave": "cajones", "valor": True}]
    assert hereda([], [{"clave": "cajones", "valor": True}]) == [{"clave": "cajones", "valor": True, "heredado": True}]
    assert [a["clave"] for a in hereda([cajones], [{"clave": "altura", "valor": 9.0}])] == ["altura", "cajones"]


def la_superficie_se_lee_del_texto():
    t = atributos.m2_del_texto
    assert t("con 352 m2 de terreno y 285 m2 de construccion") == (352, 285)
    assert t("Terreno: 1,750 m² Construcción: 1,525 m²") == (1750, 1525)
    assert t("1199 mts de construccion y 1471 mts de terreno") == (1471, 1199)
    assert t("superficie de terreno: 22,716 m2 superficie de construccion: 9,296 m2") == (22716, 9296)
    assert t("en un terreno de 1,850.64 m2") == (1850.64, None)
    assert t("8, 400 m2 de terreno") == (8400, None)
    assert t("terreno 200 m2 construccion 150 m2") == (200, 150)


def lo_que_no_es_esa_superficie_no_cuenta():
    t = atributos.m2_del_texto
    assert t("1440 m2 de construccion 80 m2 de oficinas") == (None, 1440)
    assert t("area total de construccion 60 m2 area de oficinas") == (None, None)
    assert t("area total de terreno 9.6 mts de altura") == (None, None)
    assert t("terreno 7 mts altura minima") == (None, None)
    assert t("terreno 200 mts") == (None, None)                 # sin m² y con la palabra antes
    assert t("") == (None, None) and t(None) == (None, None)


def completar_no_toca_lo_que_ya_se_sabe():
    c = atributos.completar_m2
    sin = {"terreno": None, "construccion": None}
    assert c("local", 800, 500, 800, [], "900 m2 de terreno") == {}
    assert c("local", 800, None, 800, [{**sin, "construccion": 500}], None) == \
        {"construccion": {"valor": 500, "origen": "hermano"}}
    assert c("local", 800, None, 800, [], "500 m2 de construccion") == {"construccion": {"valor": 500, "origen": "texto"}}
    # El hermano gana a la descripción: es un dato del portal, no una lectura de texto.
    assert c("local", 800, None, 800, [{**sin, "construccion": 500}], "510 m2 de construccion") == \
        {"construccion": {"valor": 500, "origen": "hermano"}}


def un_numero_repetido_no_se_contagia_y_se_puede_corregir():
    c = atributos.completar_m2
    # El hermano repite el mismo número en los dos campos: no sirve de fuente.
    assert c("local", 800, None, 800, [{"terreno": 800, "construccion": 800}], None) == {}
    # El anuncio los repite y el hermano sí los distingue: se corrige sólo lo que difiere.
    assert c("local", 800, 800, 800, [{"terreno": 800, "construccion": 500}], None) == \
        {"construccion": {"valor": 500, "origen": "hermano"}}
    assert c("local", 800, 800, 800, [], "1000 m2 de terreno, 800 m2 de construccion") == \
        {"terreno": {"valor": 1000, "origen": "texto"}}


def lo_inferido_tiene_que_ser_creible():
    c = atributos.completar_m2
    sin = {"terreno": None, "construccion": None}
    # Los hermanos se contradicen: no hay dato.
    assert c("local", 800, None, 800, [{**sin, "construccion": 500}, {**sin, "construccion": 900}], None) == {}
    assert c("local", 800, None, 800, [{**sin, "construccion": 500}, {**sin, "construccion": 510}], None) == \
        {"construccion": {"valor": 510, "origen": "hermano"}}
    # A más de diez veces de lo que se conoce es otra cosa (el fraccionamiento, el parque).
    assert c("local", 800, None, 800, [], "90000 m2 de construccion") == {}
    assert c("local", None, None, None, [], "90000 m2 de construccion") == {"construccion": {"valor": 90000, "origen": "texto"}}
    # El texto se admite más cerca que un hermano: sus errores son los desproporcionados.
    assert c("local", 800, None, 800, [], "4000 m2 de construccion") == {}
    assert c("local", 800, None, 800, [{**sin, "construccion": 4000}], None) == \
        {"construccion": {"valor": 4000, "origen": "hermano"}}


def el_mismo_numero_con_decimales_no_es_otro_dato():
    c = atributos.completar_m2
    assert c("bodega", 1444, 1444, 1444, [], "1444.3 m2 de construccion") == {}


def a_un_terreno_solo_se_le_completa_el_terreno():
    c = atributos.completar_m2
    assert c("terreno", 7437, None, 7437, [], "37185 m2 de construccion") == {}
    assert c("terreno", 160, 160, 160, [], "20 m2 de terreno") == {}
    assert c("terreno", None, None, None, [], "33911 m2 de terreno") == {"terreno": {"valor": 33911, "origen": "texto"}}


PRUEBAS = [cada_tipo_ensena_lo_suyo, sin_dato_no_sale_nada, lo_que_dice_el_portal_gana_a_la_descripcion,
           estacionamiento_sin_numero_es_que_si_hay, cada_medio_bano_cuenta_como_bano, la_altura_es_una_medida_no_un_lugar,
           el_frente_es_una_medida_no_una_direccion, el_frente_que_trae_el_portal, andenes_con_y_sin_numero, elevador_negado_no_cuenta,
           lo_que_falta_se_hereda_de_los_hermanos, la_superficie_se_lee_del_texto,
           lo_que_no_es_esa_superficie_no_cuenta, completar_no_toca_lo_que_ya_se_sabe,
           un_numero_repetido_no_se_contagia_y_se_puede_corregir, lo_inferido_tiene_que_ser_creible,
           el_mismo_numero_con_decimales_no_es_otro_dato, a_un_terreno_solo_se_le_completa_el_terreno]


def main() -> int:
    fallas = 0
    for prueba in PRUEBAS:
        try:
            prueba()
            print(f"  ok     {prueba.__name__}")
        except Exception as e:
            fallas += 1
            print(f"  FALLA  {prueba.__name__}: {type(e).__name__}: {e}")
    print(f"atributos: {len(PRUEBAS) - fallas} de {len(PRUEBAS)} pruebas pasan")
    return 1 if fallas else 0


if __name__ == "__main__":
    sys.exit(main())
